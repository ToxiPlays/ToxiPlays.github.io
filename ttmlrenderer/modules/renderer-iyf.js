import { state } from './state.js';
import { getExportQualityProfile, createTextMeasureCache, clearRenderPreview, updateRenderPreview, formatTime, resolveFilename } from './utils.js';
import { shouldUseFastRender, runFastRender } from './encoder_v2.js?v=3';

export async function startInYourFaceRender() {
  state.renderCancelled  = false;
  state.renderInProgress = true;
  const overlay    = document.getElementById('render-overlay');
  const barFill    = document.getElementById('render-bar-fill');
  const renderSub  = document.getElementById('render-sub');
  overlay.classList.add('active');
  document.getElementById('btn-render').classList.add('rendering');

  // ── Settings ──────────────────────────────────────────────────────────────
  const casingMode  = document.getElementById('iyf-casing')?.value   || 'original';
  const showProgBar = document.getElementById('iyf-show-progress')?.checked !== false;

  function applyCase(str) {
    if (casingMode === 'upper') return str.toUpperCase();
    if (casingMode === 'lower') return str.toLowerCase();
    return str;
  }

  const q = getExportQualityProfile();
  const W = q.width, H = q.height, FPS = q.fps;
  const VIDEO_BPS = q.videoBitsPerSecond;
  const FONT_SIZE    = 72;
  const GHOST_SIZE   = 46;
  const CENTER_X     = W / 2;
  const CENTER_Y     = H / 2;
  const LINE_SPACING = 140;
  const MAX_LINE_PX  = W - 240;  // tighter margin so centering never clips edges
  const JITTER_DUR   = 0.080;
  const EASE_DUR     = 0.35;
  const GAP_SPLIT    = 0.5;
  const ADLIB_FADE   = 0.25;     // fade in/out duration for adlibs
  const LINE_FADE_GAP = 3.0;

  const cs = getComputedStyle(document.documentElement);
  const BG         = cs.getPropertyValue('--bg').trim()          || '#0a0a0f';
  const COL_DIM    = cs.getPropertyValue('--text-dim').trim()    || '#3a3a55';
  const COL_MID    = cs.getPropertyValue('--text-mid').trim()    || '#6a6a9a';
  const COL_BRIGHT = cs.getPropertyValue('--text-bright').trim() || '#c8c8e8';
  const COL_ACTIVE = cs.getPropertyValue('--accent').trim()      || '#e8f440';
  const COL_ACTIVE2= cs.getPropertyValue('--accent2').trim()     || '#ff4d6d';

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  let ctx = canvas.getContext('2d');
  const textCache = createTextMeasureCache(ctx, fs => `bold ${fs}px "DM Mono", monospace`);

  function easeOut(x) { return 1 - Math.pow(1 - x, 3.5); }
  
  function getSpanY_iyf(tok, t) {
    if (t < tok.begin) return 2;
    if (t >= tok.end)  return 0;
    const el = t - tok.begin, dur = tok.end - tok.begin;
    if (el < JITTER_DUR) return 4 + 6 * (el / JITTER_DUR);
    return 10 * (1 - easeOut(Math.min((el - JITTER_DUR) / Math.max(dur - JITTER_DUR, 0.001), 1)));
  }

  let _t = 0;

  // ── Token collection ──────────────────────────────────────────────────────
  // Each token: { text, begin, end, isSpan }
  // Text nodes between spans are kept as { isSpan:false } — they carry the space.
  function collectTokens(lineEl, lineSpans) {
    const spanByEl = new Map(lineSpans.map(s => [s.el, s]));
    const toks = [];
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent) toks.push({ text: child.textContent, begin: null, end: null, isSpan: false });
        } else if (child.classList?.contains('lyric-span')) {
          const s = spanByEl.get(child);
          if (s) toks.push({ text: applyCase(child.textContent), begin: s.begin, end: s.end, isSpan: true });
        } else if (child.childNodes?.length) {
          walk(child);
        }
      }
    }
    walk(lineEl);
    return toks;
  }

  // ── Word grouping ─────────────────────────────────────────────────────────
  // A "word" = run of non-whitespace tokens.
  // Returns: { toks, trailSpace, begin, end, text }[]
  //   toks      = span/punct tokens in this word (no spaces)
  //   trailSpace = the whitespace text that follows ('' if none / last word)
  //   begin/end  = timing from first/last span in the word
  //   text       = joined display text
  function tokensToWords(tokens) {
    const words = [];
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (!tok.isSpan && /^\s+$/.test(tok.text)) { i++; continue; } // skip leading space
      // Collect non-space tokens for this word
      const wordToks = [];
      while (i < tokens.length) {
        const t = tokens[i];
        if (!t.isSpan && /^\s+$/.test(t.text)) break; // space = word boundary
        wordToks.push(t);
        i++;
      }
      // Consume trailing space
      let trailSpace = '';
      if (i < tokens.length && !tokens[i].isSpan && /^\s+$/.test(tokens[i].text)) {
        trailSpace = tokens[i].text;
        i++;
      }
      if (!wordToks.length) continue;
      const spanToks = wordToks.filter(t => t.isSpan);
      words.push({
        toks: wordToks,
        trailSpace,
        text: wordToks.map(t => t.text).join(''),
        begin: spanToks[0]?.begin ?? null,
        end:   spanToks[spanToks.length - 1]?.end ?? null,
      });
    }
    return words;
  }

  // ── Measure a word list's total pixel width (including inter-word spaces) ──
  function measureWords(words, fs) {
    let w = 0;
    for (let i = 0; i < words.length; i++) {
      w += textCache.width(fs, words[i].text);
      if (i < words.length - 1) {
        const space = words[i].trailSpace || ' ';
        w += textCache.width(fs, space);
      }
    }
    return w;
  }

  // ── Splitting ─────────────────────────────────────────────────────────────
  const ARTICLES   = new Set(['a','an','the','and','or','but','of','to','in','on','at','by','for','with','as']);
  const PUNCT_SPLIT = /[?.!"]/;

  function splitIntoChunks(words) {
    if (!words.length) return [];
    // Pass 1: split on gap or punctuation
    const chunks = [[]];
    for (let i = 0; i < words.length; i++) {
      chunks[chunks.length - 1].push(words[i]);
      if (i < words.length - 1) {
        const gap = (words[i].end !== null && words[i + 1].begin !== null)
          ? words[i + 1].begin - words[i].end : 0;
        const lastChar = words[i].text.trimEnd().slice(-1);
        if (gap >= GAP_SPLIT || PUNCT_SPLIT.test(lastChar)) chunks.push([]);
      }
    }
    // Pass 2: further split any chunk that's too wide
    const result = [];
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      if (measureWords(chunk, FONT_SIZE) <= MAX_LINE_PX) {
        result.push(chunk);
      } else {
        result.push(...splitByCount(chunk));
      }
    }
    return result.filter(c => c.length);
  }

  function splitByCount(words) {
    const n = words.length;
    if (n <= 1) return [words];
    const size = n <= 6 ? Math.ceil(n / 2) : Math.min(5, Math.ceil(n / Math.ceil(n / 4)));
    const out = [];
    let i = 0;
    while (i < n) {
      let end = Math.min(i + size, n);
      // Don't end on an article if avoidable
      if (end < n && ARTICLES.has(words[end - 1].text.toLowerCase().replace(/[^a-z]/g, ''))) {
        if (end + 1 <= n) end++;
      }
      out.push(words.slice(i, end));
      i = end;
    }
    // Recurse: any chunk still too wide gets split again
    const final = [];
    for (const chunk of out) {
      if (measureWords(chunk, FONT_SIZE) > MAX_LINE_PX && chunk.length > 1) {
        final.push(...splitByCount(chunk));
      } else {
        final.push(chunk);
      }
    }
    return final;
  }

  // ── Build iyfLines ────────────────────────────────────────────────────────
  // Each iyfLine: { words (word[]), lineBegin, lineEnd, isAdlib }
  // words[] preserves spacing via trailSpace

  const iyfLines = [];
  const lastSpanEnd = state.spans.length ? Math.max(...state.spans.map(s => s.end)) : state.duration;
  const creditEl    = document.querySelector('.songwriter-credit');
  const creditText  = creditEl ? creditEl.textContent?.trim() || null : null;

  for (const l of state.lines) {
    const isAdlib   = l.el.classList.contains('adlib');
    const agent     = l.el.dataset.agent || 'v1';
    const isV2      = agent === 'v2';
    const lineSpans = state.spans.filter(s => s.lineEl === l.el);
    if (!lineSpans.length) continue;

    const tokens = collectTokens(l.el, lineSpans);
    const words  = tokensToWords(tokens);
    if (!words.length) continue;

    const chunks = splitIntoChunks(words);
    for (const chunk of chunks) {
      const spanToks = chunk.flatMap(w => w.toks.filter(t => t.isSpan));
      if (!spanToks.length) continue;
      const begin = spanToks[0]?.begin ?? null;
      const end   = spanToks[spanToks.length - 1]?.end ?? null;
      if (begin === null || end === null) continue;

      iyfLines.push({
        words: chunk,
        lineBegin: begin,
        lineEnd: end,
        isAdlib,
        isV2,
      });
    }
  }

  const nonAdlibs = iyfLines.filter(l => !l.isAdlib);
  const adlibs    = iyfLines.filter(l => l.isAdlib);

  const gapAfter = nonAdlibs.map((curr, idx) => {
    const next = nonAdlibs[idx + 1];
    if (!next) return null;
    const dur = next.lineBegin - curr.lineEnd;
    if (dur < 5) return null;  // Only show gap bar for gaps >= 5s
    return { start: curr.lineEnd, end: next.lineBegin, duration: dur };
  });

  const CREDIT_START = lastSpanEnd;
  const CREDIT_DUR   = 3.0;
  const creditLinesIyf = creditText
    ? creditText.split('\n').map(line => applyCase(line.trim())).filter(l => l)
    : [];

  function getActiveNAPoses(t) {
    const poses = [];
    for (let i = 0; i < nonAdlibs.length; i++) {
      if (t >= nonAdlibs[i].lineBegin && t < nonAdlibs[i].lineEnd) poses.push(i);
    }
    return poses;
  }

  function getFocusNAPos(t) {
    const active = getActiveNAPoses(t);
    if (active.length > 0) return active[active.length - 1]; // Focus on the latest started line
    
    // Find closest preceding non-adlib
    for (let i = nonAdlibs.length - 1; i >= 0; i--) {
      if (t >= nonAdlibs[i].lineBegin) return i;
    }
    return -1;
  }

  function drawLine(line, y, alpha, type, t, isV2, ctx2d = ctx) {
    ctx2d.globalAlpha = alpha;
    ctx2d.textBaseline = 'middle';
    ctx2d.font = `bold ${FONT_SIZE}px "DM Mono", monospace`;
    
    const lineColor = isV2 ? COL_ACTIVE2 : COL_ACTIVE;
    let x = CENTER_X;
    let lineW = measureWords(line.words, FONT_SIZE);
    x -= lineW / 2;

    for (const w of line.words) {
      for (const tok of w.toks) {
        const tw = textCache.width(FONT_SIZE, tok.text);
        
        if (!tok.isSpan) {
          // Non-span tokens: always drawn in COL_DIM
          ctx.globalAlpha = alpha;
          ctx.fillStyle = COL_DIM;
          ctx.shadowBlur = 0;
          ctx.fillText(tok.text, x, y);
        } else {
          // Span tokens: implement color sweep and jitter
          const future = t < tok.begin;
          const past = t >= tok.end;
          const bump = getSpanY_iyf(tok, t);
          
          if (future) {
            // Not yet sung: invisible
            ctx.globalAlpha = 0;
            ctx.fillText(tok.text, x, y);
          } else if (past) {
            // Fully sung: solid color with jitter settling to 0
            ctx.globalAlpha = alpha;
            ctx.fillStyle = lineColor;
            ctx.shadowBlur = 0;
            ctx.fillText(tok.text, x, y + bump);
          } else {
            // Currently singing: dim background + color sweep
            const prog = (t - tok.begin) / Math.max(tok.end - tok.begin, 0.001);
            const sweep = prog * tw;
            
            // Draw dim background
            ctx.globalAlpha = alpha;
            ctx.fillStyle = COL_DIM;
            ctx.shadowBlur = 0;
            ctx.fillText(tok.text, x, y + bump);
            
            // Draw sweep portion in active color
            if (sweep > 0) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(x, y - FONT_SIZE, sweep, FONT_SIZE * 2);
              ctx.clip();
              ctx.fillStyle = lineColor;
              ctx.shadowBlur = 0;
              ctx.fillText(tok.text, x, y + bump);
              ctx.restore();
            }
          }
        }
        x += tw;
      }
      const space = w.trailSpace || ' ';
      x += textCache.width(FONT_SIZE, space);
    }
    ctx.globalAlpha = alpha;
  }

  function drawAdlib(line, y, alpha, t) {
    const ADLIB_MAX_W = MAX_LINE_PX;
    const MIN_FS = Math.round(GHOST_SIZE * 0.80);
    
    // Step 1: find the smallest font size that fits
    let fs = GHOST_SIZE;
    while (fs > MIN_FS && measureWords(line.words, fs) > ADLIB_MAX_W) {
      fs--;
    }
    
    // Step 2: check if it fits at MIN_FS
    const totalW = measureWords(line.words, fs);
    const adlibWords = line.words;
    
    if (totalW <= ADLIB_MAX_W) {
      // Fits on single line — draw with parentheses, no wrapping
      drawAdlibLine(adlibWords, y, fs, alpha, t);
    } else {
      // Only wrap if it still doesn't fit at MIN_FS
      // Wrap: greedily pack words into rows
      const rows = [];
      let curRow = [], curW = 0;
      
      for (let wi = 0; wi < adlibWords.length; wi++) {
        const word = adlibWords[wi];
        const wordW = textCache.width(fs, word.text);
        const gapW = curRow.length > 0 ? textCache.width(fs, word.trailSpace || ' ') : 0;
        
        if (curRow.length > 0 && curW + gapW + wordW > ADLIB_MAX_W) {
          rows.push({ words: curRow, width: curW });
          curRow = [word];
          curW = wordW;
        } else {
          if (curRow.length > 0) curW += gapW;
          curRow.push(word);
          curW += wordW;
        }
      }
      if (curRow.length) rows.push({ words: curRow, width: curW });
      
      // Draw rows centered vertically around y
      const rowH = fs + 6;
      const totalH = rows.length * rowH;
      let rowY = y - (totalH / 2) + rowH / 2;
      
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const isFirst = ri === 0;
        const isLast = ri === rows.length - 1;
        drawAdlibLine(row.words, rowY, fs, alpha, t, isFirst, isLast);
        rowY += rowH;
      }
    }
  }
  
  function drawAdlibLine(words, y, fs, alpha, t, isFirstRow = true, isLastRow = true) {
    ctx.globalAlpha = alpha;
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${fs}px "DM Mono", monospace`;
    
    // Measure content width
    let contentW = 0;
    for (let wi = 0; wi < words.length; wi++) {
      contentW += textCache.width(fs, words[wi].text);
      if (wi < words.length - 1) {
        const sp = words[wi].trailSpace || ' ';
        contentW += textCache.width(fs, sp);
      }
    }
    
    const parenW = textCache.width(fs, '(');
    const totalW = (isFirstRow ? parenW : 0) + contentW + (isLastRow ? parenW : 0);
    let x = CENTER_X - totalW / 2;
    
    // Draw opening paren (only on first row)
    if (isFirstRow) {
      ctx2d.globalAlpha = alpha;
      ctx2d.fillStyle = COL_MID;
      ctx2d.shadowBlur = 0;
      
      // Find first span for opening paren color sweep
      let firstSpan = null;
      for (const w of words) {
        for (const tok of w.toks) {
          if (tok.isSpan) {
            firstSpan = tok;
            break;
          }
        }
        if (firstSpan) break;
      }
      
      // Opening paren color sweep (60% of first span duration, starting ADLIB_FADE before)
      if (firstSpan) {
        const sweepStart = firstSpan.begin - ADLIB_FADE;
        const sweepDur = (firstSpan.end - firstSpan.begin) * 0.6;
        const sweepEnd = firstSpan.begin + sweepDur;
        
        // Draw dim background first
        ctx2d.fillStyle = COL_MID;
        ctx2d.fillText('(', x, y);
        
        // Overlay with bright color if it's been highlighted
        if (t >= sweepStart && t < sweepEnd) {
          // Still sweeping
          const prog = (t - sweepStart) / sweepDur;
          const sweep = prog * parenW;
          ctx2d.save();
          ctx2d.beginPath();
          ctx2d.rect(x, y - fs, sweep, fs * 2);
          ctx2d.clip();
          ctx2d.fillStyle = COL_BRIGHT;
          ctx2d.shadowBlur = 0;
          ctx2d.fillText('(', x, y);
          ctx2d.restore();
        } else if (t >= sweepEnd) {
          // Sweep is done, keep it highlighted
          ctx2d.fillStyle = COL_BRIGHT;
          ctx2d.shadowBlur = 0;
          ctx2d.fillText('(', x, y);
        }
      } else {
        ctx2d.fillText('(', x, y);
      }
      
      x += parenW;
    }
    
    // Draw content with color sweep
    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi];
      for (const tok of word.toks) {
        const tw = textCache.width(fs, tok.text);
        
        if (!tok.isSpan) {
          ctx2d.globalAlpha = alpha;
          ctx2d.fillStyle = COL_MID;
          ctx2d.shadowBlur = 0;
          ctx2d.fillText(tok.text, x, y);
        } else {
          const past = t >= tok.end;
          const prog = (t >= tok.begin && !past)
            ? (t - tok.begin) / Math.max(tok.end - tok.begin, 0.001)
            : (past ? 1 : 0);
          
          ctx2d.globalAlpha = alpha;
          ctx2d.fillStyle = COL_MID;
          ctx2d.shadowBlur = 0;
          ctx2d.fillText(tok.text, x, y);
          
          if (prog > 0) {
            ctx2d.save();
            ctx2d.beginPath();
            ctx2d.rect(x, y - fs, prog * tw, fs * 2);
            ctx2d.clip();
            ctx2d.fillStyle = COL_BRIGHT;
            ctx2d.shadowBlur = 0;
            ctx2d.fillText(tok.text, x, y);
            ctx2d.restore();
          }
        }
        x += tw;
      }
      if (wi < words.length - 1) {
        const sp = word.trailSpace || ' ';
        x += textCache.width(fs, sp);
      }
    }
    
    // Draw closing paren (only on last row)
    if (isLastRow) {
      ctx2d.globalAlpha = alpha;
      ctx2d.fillStyle = COL_MID;
      ctx2d.shadowBlur = 0;
      
      // Find last span for closing paren color sweep
      let lastSpan = null;
      for (let wi = words.length - 1; wi >= 0; wi--) {
        for (let ti = words[wi].toks.length - 1; ti >= 0; ti--) {
          const tok = words[wi].toks[ti];
          if (tok.isSpan) {
            lastSpan = tok;
            break;
          }
        }
        if (lastSpan) break;
      }
      
      // Closing paren color sweep: from last span end, over whichever is shorter:
      // - ADLIB_FADE, OR
      // - time until next adlib starts
      if (lastSpan) {
        const sweepStart = lastSpan.end;
        
        // Find next adlib start time
        const currentAdlib = adlibs.find(a => a.words === words);
        let nextAdlibTime = sweepStart + ADLIB_FADE;
        if (currentAdlib) {
          const nextAdlib = adlibs.find(a => a.lineBegin > currentAdlib.lineEnd);
          if (nextAdlib) {
            nextAdlibTime = nextAdlib.lineBegin;
          }
        }
        
        const sweepDur = Math.min(ADLIB_FADE, nextAdlibTime - sweepStart);
        const sweepEnd = sweepStart + sweepDur;
        
        // Draw dim background first
        ctx.fillStyle = COL_MID;
        ctx.fillText(')', x, y);
        
        // Overlay with bright color if it's in the sweep window
        if (t >= sweepStart && t < sweepEnd) {
          // Still sweeping
          const prog = (t - sweepStart) / sweepDur;
          const sweep = prog * parenW;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y - fs, sweep, fs * 2);
          ctx.clip();
          ctx.fillStyle = COL_BRIGHT;
          ctx.shadowBlur = 0;
          ctx.fillText(')', x, y);
          ctx.restore();
        } else if (t >= sweepEnd) {
          // Sweep is done, keep it highlighted
          ctx.fillStyle = COL_BRIGHT;
          ctx.shadowBlur = 0;
          ctx.fillText(')', x, y);
        }
      } else {
        ctx.fillText(')', x, y);
      }
    }
    
    ctx.globalAlpha = 1;
  }

  function drawCredits(t) {
    if (!creditLinesIyf.length || t < CREDIT_START) return;
    const alpha = Math.min(1, (t - CREDIT_START) / CREDIT_DUR) * 0.85;
    if (alpha <= 0) return;
    ctx.font = `bold 26px "DM Mono", monospace`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillStyle = COL_BRIGHT; ctx.globalAlpha = alpha;
    const lh = 38;
    let y = CENTER_Y - (creditLinesIyf.length - 1) * lh / 2;
    for (const cl of creditLinesIyf) { ctx.fillText(cl, CENTER_X, y); y += lh; }
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // ── Transition state ──────────────────────────────────────────────────────
  let lastNAPos       = -1;
  let transitionStart = -1;
  let bleedLine       = null;

  // ── Main draw ─────────────────────────────────────────────────────────────
  function drawFrame_iyf(t, ctx2d = ctx) {
    _t = t;  // Update global time for getSpanY_iyf and color sweep calculations
    ctx2d.fillStyle = BG;
    ctx2d.fillRect(0, 0, W, H);

    // Credit crossfade: lyrics fade out as credits fade in
    let lyricAlpha = 1;
    if (creditText && t >= CREDIT_START) {
      lyricAlpha = Math.max(0, 1 - (t - CREDIT_START) / 0.8);
    }

    const naPos = getFocusNAPos(t);
    const activeNAPoses = getActiveNAPoses(t);

    // Detect transition to new line
    if (naPos !== lastNAPos) {
      if (lastNAPos >= 0) {
        const prev = nonAdlibs[lastNAPos];
        bleedLine = (t < prev.lineEnd) ? prev : null;
      } else {
        bleedLine = null;
      }
      transitionStart = t;
      lastNAPos = naPos;
    }

    if (bleedLine && t >= bleedLine.lineEnd) bleedLine = null;

    const transAge = transitionStart >= 0 ? Math.min(1, (t - transitionStart) / EASE_DUR) : 1;
    const eased    = easeOut(transAge);

    // Stable ad-lib slot tracking
    if (!state._iyfAdlibSlots) state._iyfAdlibSlots = new Map();
    // Clean up finished ad-libs from slots
    for (const [al, slot] of state._iyfAdlibSlots.entries()) {
      if (t < al.lineBegin - ADLIB_FADE || t >= al.lineEnd + ADLIB_FADE) {
        state._iyfAdlibSlots.delete(al);
      }
    }

    if (naPos >= 0 && lyricAlpha > 0) {
      const curLine  = nonAdlibs[naPos];
      
      // Previous slot: bleed only
      if (bleedLine && !activeNAPoses.includes(nonAdlibs.indexOf(bleedLine))) {
        const prevY     = CENTER_Y - LINE_SPACING * eased;
        const bleedAge  = Math.max(0, (t - bleedLine.lineBegin) / Math.max(bleedLine.lineEnd - bleedLine.lineBegin, 0.001));
        const prevAlpha = Math.max(0, 0.6 * (1 - bleedAge)) * lyricAlpha;
        const isV2 = bleedLine.isV2 || false;
        if (prevAlpha > 0) drawLine(bleedLine, prevY, prevAlpha, 'active', t, isV2, ctx2d);
      }

      // Draw all active non-adlib lines
      const totalActiveH = (activeNAPoses.length - 1) * (LINE_SPACING * 0.8);
      activeNAPoses.forEach((idx, i) => {
        const line = nonAdlibs[idx];
        
        // Vertical stacking if multiple lines are active
        // Center the stack around the current scroll position
        let stackOffset = (i * LINE_SPACING * 0.8) - (totalActiveH / 2);
        const y = CENTER_Y + stackOffset + LINE_SPACING * (1 - eased);

        let alpha = Math.max(0.05, eased) * lyricAlpha;
        if (t >= line.lineEnd) {
          const gap = gapAfter[idx];
          if (gap && gap.duration >= LINE_FADE_GAP) {
            const fadeProgress = (t - line.lineEnd) / Math.min(0.6, gap.duration * 0.15);
            alpha = Math.max(0, 1 - fadeProgress) * lyricAlpha;
          }
        }
        
        if (alpha > 0) drawLine(line, y, alpha, 'active', t, line.isV2, ctx2d);
      });

      // Adlib slot: handle multiple simultaneous adlibs
      const activeAdlibs = adlibs.filter(a => {
        return t >= (a.lineBegin - ADLIB_FADE) && t < (a.lineEnd + ADLIB_FADE);
      });
      
      activeAdlibs.forEach((al) => {
        // Assign stable slot if not already assigned
        if (!state._iyfAdlibSlots.has(al)) {
          const usedSlots = new Set(state._iyfAdlibSlots.values());
          let slot = 0;
          while (usedSlots.has(slot)) slot++;
          state._iyfAdlibSlots.set(al, slot);
        }
        const slot = state._iyfAdlibSlots.get(al);

        // Fade in: starts ADLIB_FADE before lineBegin, reaches full at lineBegin
        const fadeInStart = al.lineBegin - ADLIB_FADE;
        let fadeIn = Math.min(1, Math.max(0, (t - fadeInStart) / ADLIB_FADE));
        
        // Check if another adlib is coming within ADLIB_FADE time
        const nextAdlib = adlibs.find(a => a.lineBegin > al.lineEnd && a.lineBegin - t <= ADLIB_FADE);
        
        // Fade out logic
        let fadeOut = 1;
        if (!nextAdlib) {
          fadeOut = Math.min(1, Math.max(0, (al.lineEnd + ADLIB_FADE - t) / ADLIB_FADE));
        }
        
        const alAlpha = Math.min(fadeIn, fadeOut) * 0.8 * lyricAlpha;
        if (alAlpha > 0) {
          // Use the stable slot for adlibY
          const adlibY = CENTER_Y + LINE_SPACING + (slot * (GHOST_SIZE + 20));
          drawAdlib(al, adlibY, alAlpha, t, ctx2d);
        }
      });
    }

    // ── Progress bar / gap bar ────────────────────────────────────────────
    const BAR_H = 4, BAR_Y = H - 36, BAR_PAD = 80, barW = W - BAR_PAD * 2;
    if (showProgBar && state.duration > 0) {
      ctx2d.globalAlpha = 0.3;
      ctx2d.fillStyle = COL_MID;
      ctx2d.fillRect(BAR_PAD, BAR_Y, barW, BAR_H);
      ctx2d.globalAlpha = 1;
      ctx2d.fillStyle = COL_ACTIVE;
      ctx2d.fillRect(BAR_PAD, BAR_Y, barW * Math.min(t / state.duration, 1), BAR_H);
    } else if (naPos >= 0) {
      const gap = gapAfter[naPos];
      if (gap && t >= gap.start && t < gap.end) {
        const gapProgress = (t - gap.start) / gap.duration;
        ctx2d.globalAlpha = 0.3;
        ctx2d.fillStyle = COL_MID;
        ctx2d.fillRect(BAR_PAD, BAR_Y, barW, BAR_H);
        ctx2d.globalAlpha = 1;
        ctx2d.fillStyle = COL_ACTIVE;
        ctx2d.fillRect(BAR_PAD, BAR_Y, barW * gapProgress, BAR_H);
        ctx2d.globalAlpha = 1;
      }
    }

    drawCredits(t, ctx2d);
  }

  // ── Fast path: WebCodecs offline encoder ─────────────────────────────────
  if (shouldUseFastRender()) {
    clearRenderPreview();
    const originalCtx = ctx;
    await runFastRender((ctx2d, t, _W, _H) => {
      ctx = ctx2d;
      drawFrame_iyf(t);
    }, 'iyf');
    ctx = originalCtx;
    return;
  }

  clearRenderPreview();
  const canvasStream = canvas.captureStream(FPS);
  const renderACtx   = new AudioContext();
  const dest         = renderACtx.createMediaStreamDestination();
  const audioSrc     = renderACtx.createBufferSource();
  audioSrc.buffer    = state.audioBuffer;
  audioSrc.connect(dest);
  const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mimeTypes = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];
  const mimeType  = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const recorder  = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: VIDEO_BPS });
  const chunks    = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  state.stableRecorder = recorder;
  state.stableAudioCtx = renderACtx;

  recorder.start(100);
  audioSrc.start(0);
  state.startTime = Date.now();
  document.querySelector(".render-title").textContent = "Rendering";
  const audioStartTime = renderACtx.currentTime;

  let renderDone   = false;
  let iyfRafId     = null;
  let lastDrawTime = -1;
  const FRAME_MS   = 1000 / FPS;

  function doIYFTick(wallMs) {
    if (state.renderCancelled || renderDone) return;

    if (wallMs - lastDrawTime < FRAME_MS - 1) {
      iyfRafId = requestAnimationFrame(doIYFTick);
      return;
    }
    lastDrawTime = wallMs;

    const t = Math.max(renderACtx.currentTime - audioStartTime, 0);
    const endAt = Math.max(state.duration + 1.5, creditText ? lastSpanEnd + CREDIT_DUR + 2.5 : 0);
    if (t > endAt) {
      renderDone = true;
      try { audioSrc.stop(); } catch(_) {}
      recorder.stop();
      return;
    }
    drawFrame_iyf(t);
    updateRenderPreview(canvas);
    const pct = Math.min(t / (state.duration + 1) * 100, 100);
    barFill.style.width = pct.toFixed(1) + '%';
    renderSub.textContent = formatTime(t) + ' / ' + formatTime(state.duration);
    iyfRafId = requestAnimationFrame(doIYFTick);
  }

  iyfRafId = requestAnimationFrame(doIYFTick);

  recorder.onstop = () => {
    if (iyfRafId) cancelAnimationFrame(iyfRafId);
    state.stableRecorder = null;
    state.stableAudioCtx = null;
    state.renderInProgress = false;
    if (!state.renderCancelled) {
      document.querySelector('.render-title').textContent = "Patching";
      let duration = Date.now() - state.startTime;
      const initBlob = new Blob(chunks, { type: mimeType });
      window.ysFixWebmDuration(initBlob, duration, blob => {
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = resolveFilename('iyf'); a.click();
        overlay.classList.remove('active');
        document.getElementById('btn-render').classList.remove('rendering');
        state.startTime = null;
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      });
    }
  };
}
