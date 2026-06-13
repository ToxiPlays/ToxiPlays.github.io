import { state } from './state.js';
import { getExportQualityProfile, createTextMeasureCache, clearRenderPreview, updateRenderPreview, formatTime, resolveFilename } from './utils.js';
import { shouldUseFastRender, runFastRender } from './encoder_v2.js?v=3';

export async function startKaraokeRender() {
  state.renderCancelled  = false;
  state.renderInProgress = true;
  const overlay = document.getElementById('render-overlay');
  const barFill = document.getElementById('render-bar-fill');
  const renderSub = document.getElementById('render-sub');
  overlay.classList.add('active');
  document.getElementById('btn-render').classList.add('rendering');

  const q = getExportQualityProfile();
  const W = q.width, H = q.height, FPS = q.fps;
  const VIDEO_BPS = q.videoBitsPerSecond;
  const FONT_SIZE = 52;
  const ADLIB_FONT_SIZE = 38;
  const LINE_H = 80;
  const MAX_LINES = 5;
  const CENTER_X = W / 2;
  const BLOCK_Y_START = H / 2 - ((MAX_LINES * LINE_H) / 2);
  const MAX_LINE_PX = W - 160;

  const cs = getComputedStyle(document.documentElement);
  const BG         = cs.getPropertyValue('--bg').trim()          || '#0a0a0f';
  const COL_DIM    = cs.getPropertyValue('--text-dim').trim()    || '#3a3a55';
  const COL_MID    = cs.getPropertyValue('--text-mid').trim()    || '#6a6a9a';
  const COL_BRIGHT = cs.getPropertyValue('--text-bright').trim() || '#c8c8e8';
  const COL_ACTIVE = cs.getPropertyValue('--accent').trim()      || '#e8f440';
  const COL_ACTIVE2= cs.getPropertyValue('--accent2').trim()     || '#ff4d6d';

  const JITTER_DUR = 0.060;
  function easeOutExpo(x) { return 1 - Math.pow(1 - x, 3.5); }
  function getSpanYOffset(span, t) {
    if (t < span.begin) return 2;
    if (t >= span.end) return 0;
    const elapsed = t - span.begin;
    const wordDur = span.end - span.begin;
    if (elapsed < JITTER_DUR) return 2 + 3 * (elapsed / JITTER_DUR);
    const p = Math.min((elapsed - JITTER_DUR) / Math.max(wordDur - JITTER_DUR, 0.001), 1);
    return 5 * (1 - easeOutExpo(p));
  }

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  let ctx = canvas.getContext('2d');
  const textCache = createTextMeasureCache(ctx, fs => `bold ${fs}px "DM Mono", monospace`);

  function collectLineTokens(lineEl, lineSpans) {
    const spanByEl = new Map(lineSpans.map(s => [s.el, s]));
    const tokens = [];
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent) tokens.push({ type: 'text', text: child.textContent });
        } else if (child.classList && child.classList.contains('lyric-span')) {
          const s = spanByEl.get(child);
          if (s) tokens.push({ type: 'span', begin: s.begin, end: s.end, text: child.textContent });
        } else if (child.childNodes && child.childNodes.length) {
          walk(child);
        }
      }
    }
    walk(lineEl);
    return tokens;
  }

  function tokensToWords(tokens) {
    const words = [];
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.type === 'text') {
        if (/^\s+$/.test(tok.text)) {
          if (words.length) words[words.length - 1].trailSpace += tok.text;
        } else {
          if (words.length) words[words.length - 1].spans[words[words.length-1].spans.length-1].text += tok.text;
        }
        i++;
      } else {
        const wordSpans = [];
        let trailSpace = '';
        while (i < tokens.length) {
          const cur = tokens[i];
          if (cur.type === 'span') {
            wordSpans.push({ begin: cur.begin, end: cur.end, text: cur.text });
            i++;
            if (i < tokens.length) {
              const nxt = tokens[i];
              if (nxt.type === 'text') {
                if (/^\s+$/.test(nxt.text)) {
                  trailSpace = nxt.text;
                  i++;
                  break;
                } else {
                  wordSpans[wordSpans.length - 1].text += nxt.text;
                  i++;
                }
              }
            }
          } else {
            break;
          }
        }
        if (wordSpans.length) {
          words.push({ spans: wordSpans, trailSpace });
        }
      }
    }
    return words;
  }

  function wordListWidth(words, fs) {
    let w = 0;
    for (let i = 0; i < words.length; i++) {
      for (const s of words[i].spans) w += textCache.width(fs, s.text);
      if (i < words.length - 1) w += textCache.width(fs, words[i].trailSpace || ' ');
    }
    return w;
  }

  function findSplitPoint(words, fs) {
    if (wordListWidth(words, fs) <= MAX_LINE_PX) return null;
    const SPLIT_CHARS = /[,?!"]/;
    let punctSplit = -1;
    for (let i = 0; i < words.length - 1; i++) {
      const lastText = words[i].spans[words[i].spans.length - 1].text.trimEnd();
      if (SPLIT_CHARS.test(lastText[lastText.length - 1])) {
        punctSplit = i + 1;
      }
    }
    if (punctSplit > 0) return { splitIdx: punctSplit, isPunctSplit: true };
    if (words.length < 2) return null;
    const mid = Math.floor(words.length / 2);
    return { splitIdx: mid, isPunctSplit: false };
  }

  function rowPixelWidth(words, fs) {
    return wordListWidth(words, fs);
  }

  function capitaliseFirstSpan(words) {
    if (!words.length || !words[0].spans.length) return;
    const s = words[0].spans[0];
    s.text = s.text.charAt(0).toUpperCase() + s.text.slice(1);
  }

  function stripTrailingComma(words) {
    if (!words.length) return;
    const lastWord = words[words.length - 1];
    const lastSpan = lastWord.spans[lastWord.spans.length - 1];
    lastSpan.text = lastSpan.text.replace(/,\s*$/, '');
  }

  function splitIntoKLines(words, lineBegin, lineEnd, isAdlib, isV2, agent, fs, splitGroupId) {
    const split = findSplitPoint(words, fs);
    if (!split) {
      for (const w of words) {
        for (const s of w.spans) s.width = textCache.width(fs, s.text);
        w.trailSpaceWidth = textCache.width(fs, w.trailSpace || '');
      }
      const rowW = rowPixelWidth(words, fs);
      kLines.push({ begin: lineBegin, end: lineEnd, isAdlib, isV2, agent, fs,
                    rows: [{ words, rowW }], appearAt: lineBegin - APPEAR_BEFORE,
                    splitGroupId: splitGroupId ?? null });
      return;
    }

    const { splitIdx, isPunctSplit } = split;
    const part1 = words.slice(0, splitIdx);
    const part2 = words.slice(splitIdx);

    if (isPunctSplit) {
      stripTrailingComma(part1);
      capitaliseFirstSpan(part2);
    }

    const part1End = part1[part1.length - 1].spans[part1[part1.length - 1].spans.length - 1].end;
    const part2Begin = part2[0].spans[0].begin;

    splitIntoKLines(part1, lineBegin, part1End, isAdlib, isV2, agent, fs, splitGroupId);
    splitIntoKLines(part2, part2Begin, lineEnd, isAdlib, isV2, agent, fs, splitGroupId);
  }

  const kLines = [];
  const APPEAR_BEFORE = 1.5;
  let _splitGroupCounter = 0;
  const ignoreAdlibs = document.getElementById('karaoke-ignore-adlibs').checked;

  for (const l of state.lines) {
    const isAdlib = l.el.classList.contains('adlib');
    if (ignoreAdlibs && isAdlib) continue;
    const agent = l.el.dataset.agent || 'v1';
    const isV2 = agent === 'v2';
    const fs = isAdlib ? ADLIB_FONT_SIZE : FONT_SIZE;
    const lineSpans = state.spans.filter(s => s.lineEl === l.el);
    if (!lineSpans.length) continue;
    const tokens = collectLineTokens(l.el, lineSpans);
    let words = tokensToWords(tokens);
    if (!words.length) continue;
    if (isAdlib) {
      words[0].spans[0].text = '(' + words[0].spans[0].text;
      const lw = words[words.length - 1];
      lw.spans[lw.spans.length - 1].text = lw.spans[lw.spans.length - 1].text.trimEnd() + ')';
    }
    const groupId = _splitGroupCounter++;
    splitIntoKLines(words, l.begin, l.end, isAdlib, isV2, agent, fs, groupId);
  }

  const lineSlot    = new Array(kLines.length).fill(-1);
  const slotLastEnd = new Array(MAX_LINES).fill(-Infinity);
  let nextSlot = 0;

  const groupMap = new Map();
  for (let i = 0; i < kLines.length; i++) {
    const g = kLines[i].splitGroupId;
    if (g !== null) {
      if (!groupMap.has(g)) groupMap.set(g, []);
      groupMap.get(g).push(i);
    }
  }
  const groupFirstIdx = new Map();
  const groupPrevSlot = new Map();
  for (const [gid, members] of groupMap) {
    groupFirstIdx.set(gid, members[0]);
  }

  for (let i = 0; i < kLines.length; i++) {
    const kl  = kLines[i];
    const gid = kl.splitGroupId;
    const isSplitNonFirst = gid !== null && groupFirstIdx.get(gid) !== i;
    let chosenSlot;
    if (isSplitNonFirst) {
      const prevSlot = groupPrevSlot.get(gid);
      chosenSlot = (prevSlot + 1) % MAX_LINES;
      nextSlot = (chosenSlot + 1) % MAX_LINES;
    } else {
      let candidate = nextSlot;
      for (let attempt = 0; attempt < MAX_LINES; attempt++) {
        const s = (nextSlot + attempt) % MAX_LINES;
        if (slotLastEnd[s] <= kl.appearAt) {
          candidate = s;
          break;
        }
        if (attempt === MAX_LINES - 1) {
          let best = nextSlot, bestEnd = Infinity;
          for (let ss = 0; ss < MAX_LINES; ss++) {
            const s2 = (nextSlot + ss) % MAX_LINES;
            if (slotLastEnd[s2] < bestEnd) { bestEnd = slotLastEnd[s2]; best = s2; }
          }
          candidate = best;
        }
      }
      chosenSlot = candidate;
      nextSlot = (chosenSlot + 1) % MAX_LINES;
    }
    lineSlot[i] = chosenSlot;
    slotLastEnd[chosenSlot] = kl.end;
    if (gid !== null) groupPrevSlot.set(gid, chosenSlot);
  }

  const COUNTDOWN_GAP = 5;
  const countdowns = [];
  if (kLines.length && kLines[0].begin > 1.0) {
    countdowns.push({ countStart: 0, countEnd: kLines[0].begin, nextLineIdx: 0 });
  }
  for (let i = 0; i < kLines.length - 1; i++) {
    const gap = kLines[i+1].begin - kLines[i].end;
    if (gap >= COUNTDOWN_GAP) {
      countdowns.push({ countStart: kLines[i].end, countEnd: kLines[i+1].begin, nextLineIdx: i+1 });
    }
  }

  const lastSpanEnd = state.spans.length ? Math.max(...state.spans.map(s => s.end)) : state.duration;
  const creditEl = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? creditEl.textContent : null;
  const CREDIT_FADE_START = lastSpanEnd + 0.5;
  const CREDIT_FADE_DUR   = 2.0;
  const LYRIC_FADE_DUR    = 1.0;
  const creditLinesRt = [];
  if (creditText) {
    const maxW = W - 200;
    const words = creditText.split(' ');
    let line = '';
    for (const wd of words) {
      const t2 = line ? line + ' ' + wd : wd;
      if (textCache.width(28, t2) > maxW && line) {
        creditLinesRt.push(line);
        line = wd;
      } else {
        line = t2;
      }
    }
    if (line) creditLinesRt.push(line);
  }

  const FADE_DUR = 0.4;
  function getActiveCountdown_rt(t) {
    return countdowns.find(c => t >= c.countStart && t < c.countEnd) || null;
  }
  function getLastEnteredGap_rt(t) {
    let last = null;
    for (const cd of countdowns) {
      if (cd.countStart <= t && (!last || cd.countStart > last.countStart)) last = cd;
    }
    return last;
  }
  function countdownAlpha_rt(t, cd) {
    return Math.min(Math.min(1, (t - cd.countStart) / FADE_DUR), Math.min(1, (cd.countEnd - t) / FADE_DUR));
  }
  function getVisibleLines_rt(t, gapEnd) {
    const ge = gapEnd ?? -Infinity;
    const slotNow = new Array(MAX_LINES).fill(-1);
    for (let i = 0; i < kLines.length; i++) {
      const kl   = kLines[i];
      const slot = lineSlot[i];
      if (slot === -1 || t < kl.appearAt || kl.begin < ge) continue;
      let evicted = false;
      for (let j = i + 1; j < kLines.length; j++) {
        if (lineSlot[j] === slot && kLines[j].begin >= ge && t >= kLines[j].appearAt) { evicted = true; break; }
      }
      if (!evicted) slotNow[slot] = i;
    }
    return slotNow;
  }
  function slotY(slot) { return BLOCK_Y_START + slot * LINE_H + LINE_H / 2; }

  function drawKaraokeRow_rt(t, kl, slotYCenter, globalAlpha) {
    const fs = kl.fs;
    ctx.font = `bold ${fs}px "DM Mono", monospace`;
    ctx.textBaseline = 'middle';
    const isActive = t >= kl.begin && t < kl.end;
    const isPast   = kl.end <= t;
    let alpha = 1.0;
    if (t < kl.appearAt)   alpha = 0;
    else if (t < kl.begin) alpha = Math.min(1, (t - kl.appearAt) / Math.min(APPEAR_BEFORE, 0.5));
    if (kl.isAdlib) alpha *= 0.75;
    alpha *= globalAlpha;
    if (alpha <= 0) return;
    const sweepColor = kl.isV2 ? COL_ACTIVE2 : COL_ACTIVE;
    const baseColor  = isActive ? COL_MID : (isPast ? COL_BRIGHT : COL_DIM);
    const allSpans = [];
    let cumW = 0;
    const rowOffs = [];
    for (let ri = 0; ri < kl.rows.length; ri++) {
      rowOffs.push(cumW);
      for (let wi = 0; wi < kl.rows[ri].words.length; wi++) {
        const w = kl.rows[ri].words[wi];
        for (const s of w.spans) { allSpans.push({ s, lineOffset: cumW }); cumW += s.width; }
        if (wi < kl.rows[ri].words.length - 1 && w.trailSpace) cumW += (w.trailSpaceWidth || 0);
      }
    }
    let sweepPx;
    if (isPast)        sweepPx = cumW + 1;
    else if (!isActive) sweepPx = -1;
    else {
      sweepPx = 0;
      for (const { s, lineOffset } of allSpans) {
        if (t >= s.end)        sweepPx = lineOffset + s.width;
        else if (t >= s.begin) { sweepPx = lineOffset + (t - s.begin) / Math.max(s.end - s.begin, 0.001) * s.width; break; }
        else break;
      }
    }
    let activeBeg = -1;
    if (isActive) { for (const { s } of allSpans) { if (t >= s.begin && t < s.end) { activeBeg = s.begin; break; } } }
    for (let ri = 0; ri < kl.rows.length; ri++) {
      const row = kl.rows[ri];
      const startX = CENTER_X - row.rowW / 2;
      const rowSweep = sweepPx - rowOffs[ri];
      let xC = startX;
      for (let wi = 0; wi < row.words.length; wi++) {
        const w = row.words[wi];
        for (const s of w.spans) {
          const lx = xC - startX;
          const sp = rowSweep - lx;
          const sf = Math.max(0, Math.min(1, sp / Math.max(s.width, 1)));
          const drawY = slotYCenter + ri * LINE_H + getSpanYOffset(s, t);
          ctx.globalAlpha = alpha;
          if (sf <= 0) { ctx.fillStyle = baseColor; ctx.fillText(s.text, xC, drawY); }
          else if (sf >= 1) { ctx.fillStyle = sweepColor; ctx.fillText(s.text, xC, drawY); }
          else {
            ctx.fillStyle = baseColor; ctx.fillText(s.text, xC, drawY);
            ctx.save(); ctx.beginPath(); ctx.rect(xC, drawY - fs, sp, fs * 2); ctx.clip();
            ctx.shadowColor = sweepColor; ctx.shadowBlur = 14; ctx.fillStyle = sweepColor; ctx.fillText(s.text, xC, drawY);
            ctx.shadowBlur = 0; ctx.restore();
          }
          if (s.begin === activeBeg) {
            ctx.save(); ctx.globalAlpha = alpha * 0.5; ctx.shadowColor = sweepColor; ctx.shadowBlur = 22;
            ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillText(s.text, xC, drawY); ctx.restore();
          }
          xC += s.width;
        }
        if (wi < row.words.length - 1 && w.trailSpace) {
          ctx.globalAlpha = alpha; ctx.fillStyle = baseColor;
          ctx.fillText(w.trailSpace, xC, slotYCenter + ri * LINE_H);
          xC += (w.trailSpaceWidth || 0);
        }
      }
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0; ctx.textBaseline = 'alphabetic';
  }

  function drawCountdown_rt(t, cd, cdAlpha) {
    if (cdAlpha <= 0) return;
    const remaining = cd.countEnd - t;
    const countNum  = Math.ceil(remaining);
    if (countNum <= 0) return;
    const frac  = remaining - Math.floor(remaining);
    const scale = 1 + 0.15 * Math.pow(1 - frac, 3);
    const nA    = (0.4 + 0.6 * Math.pow(1 - frac, 2)) * cdAlpha;
    const prog  = Math.min(1, (t - cd.countStart) / (cd.countEnd - cd.countStart));
    const barX  = CENTER_X - 200, barY = H - 80;
    ctx.globalAlpha = 0.3 * cdAlpha; ctx.fillStyle = COL_MID; ctx.fillRect(barX, barY, 400, 3);
    ctx.globalAlpha = cdAlpha;       ctx.fillStyle = COL_ACTIVE; ctx.fillRect(barX, barY, 400 * prog, 3);
    ctx.save();
    ctx.globalAlpha = nA;
    ctx.font = `bold ${Math.round(120 * scale)}px "DM Mono", monospace`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillStyle = COL_ACTIVE; ctx.shadowColor = COL_ACTIVE; ctx.shadowBlur = 30;
    ctx.fillText(String(countNum), CENTER_X, H / 2);
    ctx.shadowBlur = 0; ctx.restore();
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.globalAlpha = 1;
  }

  function drawCredits_rt(t) {
    if (!creditLinesRt.length || t < CREDIT_FADE_START) return;
    const alpha = Math.min(1, (t - CREDIT_FADE_START) / CREDIT_FADE_DUR) * 0.9;
    if (alpha <= 0) return;
    ctx.font = `bold 28px "DM Mono", monospace`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillStyle = COL_BRIGHT; ctx.globalAlpha = alpha;
    const cls = creditLinesRt;
    const lh = 42;
    let cy = H / 2 - cls.length * lh / 2 + lh / 2;
    for (const cl of cls) { ctx.fillText(cl, CENTER_X, cy); cy += lh; }
    ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  function drawFrame_rt(t) {
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    let lyricAlpha = 1;
    if (creditText && t >= CREDIT_FADE_START) lyricAlpha = Math.max(0, 1 - (t - CREDIT_FADE_START) / LYRIC_FADE_DUR);
    const cd      = getActiveCountdown_rt(t);
    const lastGap = getLastEnteredGap_rt(t);
    if (cd) {
      const cdA  = countdownAlpha_rt(t, cd);
      const lyrA = Math.min(1, (1 - (t - cd.countStart) / FADE_DUR)) * lyricAlpha;
      if (lyrA > 0) {
        const slotNow = getVisibleLines_rt(t, cd.countEnd);
        for (let slot = 0; slot < MAX_LINES; slot++) {
          const idx = slotNow[slot];
          if (idx !== -1 && kLines[idx].appearAt <= t) drawKaraokeRow_rt(t, kLines[idx], slotY(slot), lyrA);
        }
      }
      drawCountdown_rt(t, cd, cdA);
    } else {
      const gapEnd = lastGap ? lastGap.countEnd : -Infinity;
      if (lyricAlpha > 0) {
        const slotNow = getVisibleLines_rt(t, gapEnd);
        for (let slot = 0; slot < MAX_LINES; slot++) {
          const idx = slotNow[slot];
          if (idx !== -1) drawKaraokeRow_rt(t, kLines[idx], slotY(slot), lyricAlpha);
        }
      }
    }
    if (t >= CREDIT_FADE_START) drawCredits_rt(t);
  }

  // ── Fast path: WebCodecs offline encoder ─────────────────────────────────
  if (shouldUseFastRender()) {
    clearRenderPreview();
    const originalCtx = ctx;
    await runFastRender((ctx2d, t, _W, _H) => {
      ctx = ctx2d;
      drawFrame_rt(t);
    }, 'karaoke');
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

  let renderDone    = false;
  let karaokeRafId  = null;
  let lastDrawTime  = -1;
  const FRAME_MS    = 1000 / FPS;

  function doKaraokeTick(wallMs) {
    if (state.renderCancelled || renderDone) return;
    if (wallMs - lastDrawTime < FRAME_MS - 1) {
      karaokeRafId = requestAnimationFrame(doKaraokeTick);
      return;
    }
    lastDrawTime = wallMs;
    const t = Math.max(renderACtx.currentTime - audioStartTime, 0);
    if (t > state.duration + 3.5) {
      renderDone = true;
      try { audioSrc.stop(); } catch(_) {}
      recorder.stop();
      return;
    }
    drawFrame_rt(t);
    updateRenderPreview(canvas);
    const pct = Math.min(t / (state.duration + 3) * 100, 100);
    barFill.style.width = pct.toFixed(1) + '%';
    renderSub.textContent = formatTime(t) + ' / ' + formatTime(state.duration);
    karaokeRafId = requestAnimationFrame(doKaraokeTick);
  }

  karaokeRafId = requestAnimationFrame(doKaraokeTick);

  recorder.onstop = () => {
    if (karaokeRafId) cancelAnimationFrame(karaokeRafId);
    state.stableRecorder = null;
    state.stableAudioCtx = null;
    state.renderInProgress = false;
    if (!state.renderCancelled) {
      let duration = Date.now() - state.startTime;
      const initBlob = new Blob(chunks, { type: mimeType });
      document.querySelector(".render-title").textContent = "Patching";
      window.ysFixWebmDuration(initBlob, duration, blob => {   
        overlay.classList.remove('active');
        document.getElementById('btn-render').classList.remove('rendering');
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = resolveFilename('karaoke'); a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        state.startTime = null;
      });
    }
  };
}
