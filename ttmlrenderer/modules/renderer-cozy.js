import { state } from './state.js';
import { getExportQualityProfile, createTextMeasureCache, clearRenderPreview, updateRenderPreview, formatTime, resolveFilename } from './utils.js';
import { shouldUseFastRender, runFastRender } from './encoder_v2.js?v=3';

function clampVal(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

async function preloadCozyFonts(isTTML) {
  const hasAdlib = state.lines.some(l => l.isAdlib);
  const primaryAgent = state.lines.find(l => !l.isAdlib)?.agent || state.lines[0]?.agent || 'v1';
  const middleMode = !isTTML;
  const duetLines = middleMode ? state.lines.filter(l => l.agent !== primaryAgent) : [];
  const hasDuet = duetLines.length > 0;
  const hasDuetAdlib = duetLines.some(l => l.isAdlib);

  const variants = ['500 16px Pliant']; // Pliant-Medium: always needed
  if (hasAdlib) variants.push('400 16px Pliant'); // Pliant-Regular
  if (hasDuet) variants.push('italic 500 16px Pliant'); // Pliant-MediumItalic
  if (hasDuetAdlib) variants.push('italic 400 16px Pliant'); // Pliant-Italic

  try {
    await Promise.all(variants.map(v => document.fonts.load(v)));
    await document.fonts.ready;
  } catch (_) {
    console.error(_);
  }
}

function getCozyDisplayMode() {
  const selector = document.getElementById('cozy-display');
  const mode = selector ? selector.value : 'middle';
  const agents = new Set(state.lines.map(l => l.agent || 'v1'));
  return mode === 'ttml' && agents.size > 1 ? 'ttml' : 'middle';
}

function buildCozyLineSegments(lineEl, lineSpans) {
  const spanByEl = new Map(lineSpans.map(s => [s.el, s]));
  const segments = [];

  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) segments.push({ span: null, text: child.textContent });
      } else if (child.classList && child.classList.contains('lyric-span')) {
        const span = spanByEl.get(child);
        if (span && span.initialRotation === undefined) {
          span.initialRotation = (Math.random() * 20 - 10) * Math.PI / 180;
        }
        segments.push({ span, text: child.textContent });
      } else {
        walk(child);
      }
    }
  }

  walk(lineEl);
  return segments;
}

function wrapCozySegments(segments, fontSize, maxWidth, textCache) {
  const units = [];
  let currentWord = null;

  function flushWord() {
    if (!currentWord) return;
    units.push(currentWord);
    currentWord = null;
  }

  function pushSpace() {
    flushWord();
    const spaceWidth = textCache.width(fontSize, ' ');
    if (!units.length || units[units.length - 1].type !== 'space') {
      units.push({ type: 'space', text: ' ', width: spaceWidth });
    }
  }

  function tokenizeSeg(seg) {
    const tokens = [];
    const parts = seg.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      const isSpace = /^\s+$/.test(part);
      tokens.push({ span: isSpace ? null : seg.span, text: part });
    }
    return tokens;
  }

  for (const seg of segments) {
    for (const token of tokenizeSeg(seg)) {
      const isSpace = !token.span && /^\s*$/.test(token.text);
      if (isSpace) {
        pushSpace();
        continue;
      }

      const KERN_BUFFER = textCache.width(fontSize, ' ') * 0.35;
      const tokenWidth = textCache.width(fontSize, token.text) + KERN_BUFFER;
      if (!currentWord) {
        currentWord = { type: 'word', parts: [{ ...token, width: tokenWidth }], width: tokenWidth };
        continue;
      }

      const prevPart = currentWord.parts[currentWord.parts.length - 1];
      const prevEndsWithSpace = prevPart.span ? false : /\s$/.test(prevPart.text);
      const currStartsWithSpace = token.span ? false : /^\s/.test(token.text);

      if (!prevEndsWithSpace && !currStartsWithSpace) {
        currentWord.parts.push({ ...token, width: tokenWidth });
        currentWord.width += tokenWidth;
      } else {
        flushWord();
        currentWord = { type: 'word', parts: [{ ...token, width: tokenWidth }], width: tokenWidth };
      }
    }
  }

  flushWord();

  const rows = [];
  let currentRow = [];
  let currentW = 0;

  function pushRow(row) {
    const trimmed = row.slice();
    while (trimmed.length) {
      const last = trimmed[trimmed.length - 1];
      if (last.type === 'space') trimmed.pop();
      else break;
    }
    if (trimmed.length) rows.push(trimmed);
  }

  for (const unit of units) {
    if (unit.type === 'space' && !currentRow.length) continue;
    if (currentW + unit.width > maxWidth && currentRow.length > 0) {
      pushRow(currentRow);
      currentRow = [];
      currentW = 0;
      if (unit.type === 'space') continue;
    }
    currentRow.push(unit);
    currentW += unit.width;
  }

  if (currentRow.length) pushRow(currentRow);
  return rows;
}

function findNearestMainLine(line) {
  const mains = state.lines.filter(l => !l.isAdlib);
  if (!mains.length) return null;
  let best = mains[0];
  let bestDelta = Math.abs(line.begin - best.begin);
  for (const candidate of mains) {
    const delta = Math.abs(line.begin - candidate.begin);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  return best;
}

function shouldUseTTMLMode() {
  return getCozyDisplayMode() === 'ttml';
}

function buildActiveEntryOrder(activeEntries) {
  const mains = activeEntries.filter(e => !e.isAdlib).sort((a, b) => a.begin - b.begin);
  const adlibs = activeEntries.filter(e => e.isAdlib);
  const remaining = new Set(adlibs);
  const ordered = [];

  for (const main of mains) {
    const before = adlibs
      .filter(a => a.partner === main && a.begin < main.begin)
      .sort((a, b) => a.begin - b.begin);
    before.forEach(a => { ordered.push(a); remaining.delete(a); });

    ordered.push(main);

    const after = adlibs
      .filter(a => a.partner === main && a.begin >= main.begin)
      .sort((a, b) => a.begin - b.begin);
    after.forEach(a => { ordered.push(a); remaining.delete(a); });
  }

  const leftover = [...remaining].sort((a, b) => a.begin - b.begin);
  ordered.push(...leftover);
  if (!mains.length) return ordered.sort((a, b) => a.begin - b.begin);
  return ordered;
}

export async function startCozyRender() {
  state.renderCancelled = false;
  state.renderInProgress = true;
  const overlay = document.getElementById('render-overlay');
  const barFill = document.getElementById('render-bar-fill');
  const renderSub = document.getElementById('render-sub');
  overlay.classList.add('active');
  document.getElementById('btn-render').classList.add('rendering');

  const q = getExportQualityProfile();
  const W = q.width, H = q.height, FPS = q.fps;
  const VIDEO_BPS = q.videoBitsPerSecond;
  const isTTML = shouldUseTTMLMode();
  await preloadCozyFonts(isTTML);
  const maxTextW = Math.floor(W * (isTTML ? 0.70 : 0.85));
  const LEFT_PAD = Math.round(W * 0.08);
  const RIGHT_PAD = Math.round(W * 0.08);
  const CENTER_X = W / 2;
  const CENTER_Y = H / 2;
  const MAIN_FONT_SIZE = Math.round(Math.max(54, Math.min(84, W * 0.052)));
  const ADLIB_FONT_SIZE = Math.round(Math.max(34, Math.min(54, W * 0.034)));
  const MAIN_LINE_HEIGHT = Math.round(MAIN_FONT_SIZE * 1.2);
  const ADLIB_LINE_HEIGHT = Math.round(ADLIB_FONT_SIZE * 1.2);
  const ROW_GAP = Math.round(MAIN_FONT_SIZE * 0.25);

  const cs = getComputedStyle(document.documentElement);
  const BG = cs.getPropertyValue('--bg').trim() || '#0a0a0f';
  const COL_DIM = cs.getPropertyValue('--text-dim').trim() || '#3a3a55';
  const COL_MID = cs.getPropertyValue('--text-mid').trim() || '#6a6a9a';
  const COL_BRIGHT = cs.getPropertyValue('--text-bright').trim() || '#c8c8e8';
  const COL_ACTIVE = cs.getPropertyValue('--accent').trim() || '#e8f440';

  const introText = document.getElementById('cozy-intro')?.value.trim() || '';
  const firstBegin = state.lines.length ? Math.min(...state.lines.map(l => l.begin)) : 0;
  const INTRO_COMPACT_THRESHOLD = 2;
  const introCompact = firstBegin < INTRO_COMPACT_THRESHOLD;
  const INTRO_COMPACT_FADE_IN = 0.25;
  const INTRO_COMPACT_HOLD = 1.0;
  const INTRO_COMPACT_FADE_OUT = 0.4;
  const introCompactEnd = INTRO_COMPACT_FADE_IN + INTRO_COMPACT_HOLD + INTRO_COMPACT_FADE_OUT;
  const introFadeDuration = introCompact
    ? INTRO_COMPACT_FADE_OUT
    : Math.min(3, Math.max(1, Math.min(firstBegin * 0.5, 3)));
  const introFadeStart = introCompact
    ? INTRO_COMPACT_FADE_IN + INTRO_COMPACT_HOLD
    : Math.max(0, firstBegin - introFadeDuration);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const textCache = createTextMeasureCache(ctx, fs => `${fs}px Pliant, sans-serif`);

  const primaryAgent = state.lines.find(l => !l.isAdlib)?.agent || state.lines[0]?.agent || 'v1';

  const lines = state.lines.map(line => {
    const lineSpans = state.spans.filter(s => s.lineEl === line.el);
    const segments = buildCozyLineSegments(line.el, lineSpans);
    const fontSize = line.isAdlib ? ADLIB_FONT_SIZE : MAIN_FONT_SIZE;
    const lineHeight = line.isAdlib ? ADLIB_LINE_HEIGHT : MAIN_LINE_HEIGHT;
    const rows = wrapCozySegments(segments, fontSize, maxTextW, textCache);
    const partner = line.isAdlib ? findNearestMainLine(line) : null;

    const align = isTTML
      ? (line.agent === primaryAgent ? 'left' : 'right')
      : 'center';

    const style = !isTTML && line.agent !== primaryAgent ? 'italic' : 'normal';
    const weight = line.isAdlib ? 400 : 500;

    const totalHeight = rows.length * lineHeight + Math.max(0, rows.length - 1) * ROW_GAP;

    return {
      line,
      segments,
      rows,
      fontSize,
      lineHeight,
      totalHeight,
      align,
      style,
      weight,
      isAdlib: line.isAdlib,
      agent: line.agent,
      begin: line.begin,
      end: line.end,
      partner,
      fadeDuration: 0,
      fadeEnd: line.end,
      currentY: null,
    };
  });

  const sortedLines = [...lines].sort((a, b) => a.begin - b.begin);
  const MIN_FADE_DURATION = 0.2;
  for (let i = 0; i < sortedLines.length; i++) {
    const entry = sortedLines[i];
    const next = sortedLines[i + 1];
    const gap = next ? next.begin - entry.end : 0;
    if (gap > 0.8) {
      entry.holdDuration = 0;
      entry.fadeDuration = gap - 0.5;
    } else if (gap > 0) {
      entry.fadeDuration = Math.min(gap, MIN_FADE_DURATION);
      entry.holdDuration = gap - entry.fadeDuration;
    } else {
      entry.holdDuration = 0;
      entry.fadeDuration = 0;
    }
    entry.fadeEnd = entry.end + entry.holdDuration + entry.fadeDuration;
  }

  const gapThreshold = 5;
  const gaps = [];
  if (sortedLines.length) {
    if (sortedLines[0].begin >= gapThreshold) {
      gaps.push({
        start: 0,
        end: sortedLines[0].begin,
        duration: sortedLines[0].begin,
      });
    }
    for (let i = 0; i < sortedLines.length - 1; i++) {
      const gap = sortedLines[i + 1].begin - sortedLines[i].end;
      if (gap >= gapThreshold) {
        gaps.push({
          start: sortedLines[i].end,
          end: sortedLines[i + 1].begin,
          duration: gap,
        });
      }
    }
  }

  const creditEl = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? creditEl.textContent : null;
  const creditLines = [];
  if (creditText) {
    const creditMaxW = Math.floor(W * 0.75);
    const words = creditText.split(' ');
    let line = '';
    for (const wd of words) {
      const test = line ? `${line} ${wd}` : wd;
      if (textCache.width(28, test) > creditMaxW && line) {
        creditLines.push(line);
        line = wd;
      } else {
        line = test;
      }
    }
    if (line) creditLines.push(line);
  }

  function getGapAtTime(t) {
    return gaps.find(g => t >= g.start && t < g.end) || null;
  }

  function drawGapCircle(t) {
    const gap = getGapAtTime(t);
    if (!gap) return;
    const progress = clampVal((t - gap.start) / Math.max(gap.duration, 0.001), 0, 1);
    const fadeWindow = 0.15;
    const alphaIn = Math.min(1, progress / fadeWindow);
    const alphaOut = Math.min(1, (1 - progress) / fadeWindow);
    const alpha = Math.max(0, Math.min(alphaIn, alphaOut));
    if (alpha <= 0) return;

    const radius = Math.min(90, W * 0.08);
    const sweep = Math.max(0.001, progress * Math.PI * 2);
    ctx.save();
    ctx.translate(CENTER_X, CENTER_Y);
    ctx.globalAlpha = alpha * 0.75;
    ctx.fillStyle = COL_ACTIVE;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + sweep, false);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.5})`;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const lastLineEnd = sortedLines.length ? Math.max(...sortedLines.map(e => e.end)) : 0;
  const creditFadeStart = lastLineEnd + 0.5;
  const creditFadeDur = 2.0;

  function drawIntro(t) {
    if (!introText || t < 0) return;
    if (introCompact) {
      if (t >= introCompactEnd) return;
      const alpha = t < INTRO_COMPACT_FADE_IN
        ? clampVal(t / INTRO_COMPACT_FADE_IN, 0, 1)
        : (t < introFadeStart ? 1 : clampVal(1 - (t - introFadeStart) / introFadeDuration, 0, 1));
      if (alpha <= 0) return;
      drawIntroText(alpha, true);
      return;
    }
    if (t >= firstBegin) return;
    const alpha = t < introFadeStart ? 1 : clampVal(1 - (t - introFadeStart) / introFadeDuration, 0, 1);
    if (alpha <= 0) return;
    drawIntroText(alpha, false);
  }

  function drawIntroText(alpha, compact) {
    const textSize = compact
      ? Math.round(Math.max(24, Math.min(36, W * 0.022)))
      : Math.round(Math.max(42, Math.min(64, W * 0.038)));
    const textY = compact ? Math.round(H * 0.12) : CENTER_Y;
    ctx.font = `400 ${textSize}px Pliant, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL_BRIGHT;
    ctx.globalAlpha = alpha;
    ctx.fillText(introText, CENTER_X, textY);
    ctx.globalAlpha = 1;
  }

  function drawEntry(entry, t, yStart, scale) {
    const fadeStart = entry.end + (entry.holdDuration || 0);
    const fadeOut = entry.fadeDuration > 0 && t > fadeStart;
    const fadeAlpha = fadeOut ? clampVal(1 - (t - fadeStart) / entry.fadeDuration, 0, 1) : 1;
    if (fadeAlpha <= 0) return;
    if (!entry.rows.length) return;

    const alpha = fadeAlpha;
    const fontSize = entry.fontSize * scale;
    const lineHeight = entry.lineHeight * scale;
    const gap = ROW_GAP * scale;
    ctx.font = `${entry.style} ${entry.weight} ${fontSize}px Pliant, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    for (let rowIndex = 0; rowIndex < entry.rows.length; rowIndex++) {
      const row = entry.rows[rowIndex];
      const rowWidth = row.reduce((sum, unit) => sum + unit.width, 0) * scale;
      let x = entry.align === 'center'
        ? Math.round((W - rowWidth) / 2)
        : entry.align === 'left'
          ? LEFT_PAD
          : W - RIGHT_PAD - rowWidth;
      const rowY = yStart + rowIndex * (lineHeight + gap) + fontSize;

      for (const unit of row) {
        if (unit.type === 'space') {
          ctx.globalAlpha = alpha;
          ctx.fillStyle = COL_MID;
          ctx.fillText(unit.text, x, rowY);
          x += unit.width * scale;
          continue;
        }

        for (const part of unit.parts) {
          if (!part.span) {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = COL_MID;
            ctx.fillText(part.text, x, rowY);
            x += part.width * scale;
            continue;
          }

          const span = part.span;
          if (t < span.begin) {
            x += part.width * scale;
            continue;
          }

          const spanProgress = clampVal((t - span.begin) / Math.max(span.duration, 0.001), 0, 1);
          const rotation = span.isLong ? 0 : span.initialRotation * (1 - easeOutCubic(spanProgress));
          const spanActive = t < span.end;
          const fill = spanActive ? COL_ACTIVE : COL_BRIGHT;

          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.textAlign = 'left';
          const drawX = x + part.width * scale / 2;
          const drawY = rowY;
          ctx.translate(drawX, drawY);
          if (!span.isLong) ctx.rotate(rotation);

          if (span.isLong) {
            const clipWidth = Math.max(1, part.width * scale * spanProgress);
            ctx.beginPath();
            ctx.rect(-part.width * scale / 2, -fontSize, clipWidth, fontSize * 1.2);
            ctx.clip();
          }

          ctx.fillStyle = fill;
          ctx.fillText(part.text, -part.width * scale / 2, 0);
          ctx.restore();
          x += part.width * scale;
        }
      }
    }
  }

  function drawFrame(ctx2d, t) {
    ctx2d.fillStyle = BG;
    ctx2d.fillRect(0, 0, W, H);
    ctx2d.shadowBlur = 0;

    drawIntro(t);
    drawGapCircle(t);

    const active = sortedLines.filter(e => t >= e.begin && t <= e.fadeEnd);
    const ordered = buildActiveEntryOrder(active);
    if (ordered.length) {
      const entryHeights = ordered.map(entry => entry.totalHeight);
      const totalHeight = entryHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, ordered.length - 1) * ROW_GAP;
      const availableHeight = H * 0.88;
      const scale = Math.min(1, availableHeight / totalHeight);
      const gap = ROW_GAP * scale;
      const batchHeight = ordered.reduce((sum, entry) => sum + entry.totalHeight * scale, 0) + Math.max(0, ordered.length - 1) * gap;
      let yCursor = CENTER_Y - batchHeight / 2;

      for (const entry of ordered) {
        const targetY = yCursor;
        if (entry.currentY === null || entry.currentY === undefined) {
          entry.currentY = targetY;
        } else {
          const dy = targetY - entry.currentY;
          entry.currentY += Math.abs(dy) < 1 ? dy : dy * 0.28;
        }
        drawEntry(entry, t, entry.currentY, scale);
        yCursor += entry.totalHeight * scale + gap;
      }
    }

    if (creditLines.length && t >= creditFadeStart) {
      const alpha = clampVal((t - creditFadeStart) / creditFadeDur, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.font = `400 28px Pliant, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COL_BRIGHT;
      const textHeight = creditLines.length * 34;
      let y = H - 80 - textHeight / 2;
      for (const line of creditLines) {
        ctx.fillText(line, CENTER_X, y);
        y += 34;
      }
      ctx.globalAlpha = 1;
    }
  }

  if (shouldUseFastRender()) {
    clearRenderPreview();
    await runFastRender((ctx2d, t) => {
      drawFrame(ctx2d, t);
    }, 'cozy');
    return;
  }

  clearRenderPreview();
  const canvasStream = canvas.captureStream(FPS);
  const renderACtx = new AudioContext();
  const dest = renderACtx.createMediaStreamDestination();
  const audioSource = renderACtx.createBufferSource();
  audioSource.buffer = state.audioBuffer;
  audioSource.connect(dest);
  const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mimeTypes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: VIDEO_BPS });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  state.stableRecorder = recorder;
  state.stableAudioCtx = renderACtx;

  recorder.start(100);
  audioSource.start(0);
  state.startTime = Date.now();
  document.querySelector('.render-title').textContent = 'Rendering';
  const audioStartTime = renderACtx.currentTime;

  let lastFrameWallMs = -1;
  const FRAME_MS = 1000 / FPS;

  function doStableTick(wallMs) {
    if (state.renderCancelled) return;
    if (wallMs - lastFrameWallMs < FRAME_MS - 1) {
      requestAnimationFrame(doStableTick);
      return;
    }
    const wallDelta = lastFrameWallMs < 0 ? 1 / FPS : Math.min((wallMs - lastFrameWallMs) / 1000, 0.1);
    lastFrameWallMs = wallMs;

    const t = Math.max(renderACtx.currentTime - audioStartTime, 0);
    if (t > state.duration + 0.5) {
      try { audioSource.stop(); } catch (_) {}
      recorder.stop();
      return;
    }

    drawFrame(ctx, t);
    updateRenderPreview(canvas);

    const pct = Math.min(t / (state.duration + 0.5) * 100, 100);
    barFill.style.width = pct.toFixed(1) + '%';
    renderSub.textContent = formatTime(t) + ' / ' + formatTime(state.duration);
    requestAnimationFrame(doStableTick);
  }

  requestAnimationFrame(doStableTick);

  recorder.onstop = () => {
    state.stableRecorder = null;
    state.stableAudioCtx = null;
    state.renderInProgress = false;
    if (!state.renderCancelled) {
      const duration = Date.now() - state.startTime;
      const initBlob = new Blob(chunks, { type: mimeType });
      document.querySelector('.render-title').textContent = 'Patching';
      window.ysFixWebmDuration(initBlob, duration, blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = resolveFilename('cozy'); a.click();
        overlay.classList.remove('active');
        document.getElementById('btn-render').classList.remove('rendering');
        state.startTime = null;
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      });
    }
  };
}