import { state } from './state.js';
import { getExportQualityProfile, createTextMeasureCache, clearRenderPreview, updateRenderPreview, formatTime, resolveFilename } from './utils.js';
import { checkOverlappingTiming, showOverlapWarning } from './renderer-shared.js';
import { startKaraokeRender } from './renderer-karaoke.js';
import { startInYourFaceRender } from './renderer-iyf.js';
import { startAmlRender } from './renderer-aml.js';
import { isWebCodecsSupported, shouldUseFastRender, runFastRender } from './encoder_v2.js?v=3';

export async function startRender() {
  if (!state.audioBuffer || !state.spans.length) return;
  const exportStyle = document.getElementById('export-style').value;

  const renderType  = exportStyle === 'karaoke' ? 'karaoke'
                    : exportStyle === 'inyourface' ? 'iyf'
                    : 'birdseye';
  const overlapMsg  = checkOverlappingTiming(renderType);
  if (overlapMsg) {
    const proceed = await showOverlapWarning();
    if (!proceed) return;
  }

  if (exportStyle === 'karaoke')    { startKaraokeRender();    return; }
  if (exportStyle === 'inyourface') { startInYourFaceRender(); return; }
  if (exportStyle === 'aml')        { startAmlRender();        return; }

  startScrollRender();
}

async function startScrollRender() {
  state.renderCancelled  = false;
  state.renderInProgress = true;
  const overlay    = document.getElementById('render-overlay');
  const barFill    = document.getElementById('render-bar-fill');
  const renderSub  = document.getElementById('render-sub');
  overlay.classList.add('active');
  document.getElementById('btn-render').classList.add('rendering');

  const q = getExportQualityProfile();
  const W = q.width, H = q.height, FPS = q.fps;
  const VIDEO_BPS = q.videoBitsPerSecond;
  const FONT_SIZE          = 38,  ADLIB_FONT_SIZE     = 30;
  const LINE_HEIGHT        = 80,  ADLIB_LINE_HEIGHT   = 60;
  const WRAPPED_EXTRA      = 52,  ADLIB_WRAPPED_EXTRA = 42;
  const LEFT_PAD           = 80,  RIGHT_PAD           = 80;
  const MAX_TEXT_W         = W - LEFT_PAD - RIGHT_PAD;
  const JITTER_DUR         = 0.060;
  const SCROLL_LERP        = 4.0;
  const SCROLL_ARRIVE      = 0.75;
  const CENTER_Y           = H / 2 - 20;

  const cs = getComputedStyle(document.documentElement);
  const BG        = cs.getPropertyValue('--bg').trim()          || '#0a0a0f';
  const COL_DIM   = cs.getPropertyValue('--text-dim').trim()    || '#3a3a55';
  const COL_MID   = cs.getPropertyValue('--text-mid').trim()    || '#6a6a9a';
  const COL_BRIGHT= cs.getPropertyValue('--text-bright').trim() || '#c8c8e8';
  const COL_ACTIVE= cs.getPropertyValue('--accent').trim()      || '#e8f440';
  const COL_BORDER= cs.getPropertyValue('--border').trim()      || '#1e1e2e';

  function easeOutExpo(t) { return 1 - Math.pow(1 - t, 3.5); }

  function getSpanY(span, t) {
    if (t < span.begin) return 2;
    if (t >= span.end)  return 0;
    const elapsed = t - span.begin;
    const wordDur = span.end - span.begin;
    if (elapsed < JITTER_DUR) return 2 + 3 * (elapsed / JITTER_DUR);
    const p = Math.min((elapsed - JITTER_DUR) / Math.max(wordDur - JITTER_DUR, 0.001), 1);
    return 5 * (1 - easeOutExpo(p));
  }

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const textCache = createTextMeasureCache(ctx, fs => `${fs}px "DM Mono", monospace`);

  function buildLineSegments(lineEl, lineSpans) {
    const segments = [];
    const spanByEl = new Map(lineSpans.map(s => [s.el, s]));
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent) segments.push({ span: null, text: child.textContent });
        } else if (child.classList && child.classList.contains('lyric-span')) {
          segments.push({ span: spanByEl.get(child), text: child.textContent });
        } else { walk(child); }
      }
    }
    walk(lineEl);
    return segments;
  }

  function wrapSegments(segments, fontSize) {
    function trimRowTrailingSpaces(row) {
      const out = row.slice();
      while (out.length) {
        const last = out[out.length - 1];
        if (last.span === null && /^\s+$/.test(last.text)) {
          out.pop();
          continue;
        }
        break;
      }
      return out;
    }

    const units = [];
    let i = 0;
    while (i < segments.length) {
      const seg = segments[i];
      if (seg.span === null) {
        const tw = textCache.width(fontSize, seg.text);
        units.push({ segs: [{ ...seg, width: tw }], width: tw, isSpace: true });
        i++;
      } else {
        const run = [];
        let runW  = 0;
        while (i < segments.length && segments[i].span !== null) {
          const tw = textCache.width(fontSize, segments[i].text);
          run.push({ ...segments[i], width: tw });
          runW += tw;
          i++;
          if (/\s$/.test(segments[i - 1].text)) break;
        }
        units.push({ segs: run, width: runW, isSpace: false });
      }
    }
    const rows = [];
    let currentRow = [], currentW = 0;
    for (const unit of units) {
      if (currentRow.length === 0 && unit.isSpace) continue;
      if (currentW + unit.width > MAX_TEXT_W && currentRow.length > 0) {
        const trimmed = trimRowTrailingSpaces(currentRow);
        if (trimmed.length) rows.push(trimmed);
        currentRow = [];
        currentW = 0;
        if (unit.isSpace) continue;
      }
      for (const seg of unit.segs) currentRow.push(seg);
      currentW += unit.width;
    }
    if (currentRow.length > 0) {
      const trimmed = trimRowTrailingSpaces(currentRow);
      if (trimmed.length) rows.push(trimmed);
    }
    return rows;
  }

  const layout = [];
  let curY = 0;
  for (let i = 0; i < state.lines.length; i++) {
    const l        = state.lines[i];
    const isAdlib  = l.el.classList.contains('adlib');
    const agent    = l.el.dataset.agent;
    const fs       = isAdlib ? ADLIB_FONT_SIZE   : FONT_SIZE;
    const lh       = isAdlib ? ADLIB_LINE_HEIGHT  : LINE_HEIGHT;
    const wExtra   = isAdlib ? ADLIB_WRAPPED_EXTRA: WRAPPED_EXTRA;
    const lineSpans= state.spans.filter(s => s.lineEl === l.el);
    const segs     = buildLineSegments(l.el, lineSpans);
    const rows     = wrapSegments(segs, fs);
    const totalH   = lh + (rows.length - 1) * wExtra;
    layout.push({ lineObj: l, y: curY, isAdlib, agent, fontSize: fs,
                  lineHeight: lh, wExtra, rows, totalH, i });
    curY += totalH;
    if (state.breakBars.some(b => b.start === l.end)) curY += 56;
  }

  const creditEl   = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? creditEl.textContent : null;
  const creditLines = [];
  if (creditText) {
    const words = creditText.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (textCache.width(14, test) > MAX_TEXT_W && line) {
        creditLines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) creditLines.push(line);
  }

  function getScrollStartTime(idx) {
    if (idx <= 0) return 0;
    const gap = layout[idx].lineObj.begin - layout[idx - 1].lineObj.end;
    return gap > SCROLL_ARRIVE
      ? layout[idx].lineObj.begin - SCROLL_ARRIVE
      : layout[idx].lineObj.begin;
  }

  function getTargetOffset(t) {
    for (const e of layout) { if (t >= e.lineObj.begin && t < e.lineObj.end && !e.isAdlib) return e.y + e.totalH / 2 - CENTER_Y; }
    for (const e of layout) { if (t >= e.lineObj.begin && t < e.lineObj.end) return e.y + e.totalH / 2 - CENTER_Y; }
    for (let i = 0; i < layout.length; i++) {
      if (layout[i].lineObj.begin > t) {
        if (t >= getScrollStartTime(i)) return layout[i].y + layout[i].totalH / 2 - CENTER_Y;
        break;
      }
    }
    for (let i = layout.length - 1; i >= 0; i--) { if (layout[i].lineObj.end <= t) return layout[i].y + layout[i].totalH / 2 - CENTER_Y; }
    return layout.length > 0 ? (layout[0].y + layout[0].totalH / 2 - CENTER_Y) : 0;
  }

  function drawFrame(ctx2d, t, viewOffsetY) {
    ctx2d.fillStyle = BG;
    ctx2d.fillRect(0, 0, W, H);

    for (const entry of layout) {
      const entryTop = entry.y - viewOffsetY;
      if (entryTop + entry.totalH < -10 || entryTop > H + 10) continue;

      const l          = entry.lineObj;
      const isActive   = t >= l.begin && t < l.end;
      const isPastLine = l.end <= t;
      const isRight    = entry.agent === 'v2';

      ctx2d.font         = `${entry.fontSize}px "DM Mono", monospace`;
      ctx2d.textBaseline = 'alphabetic';
      ctx2d.globalAlpha  = entry.isAdlib ? 0.6 : 1.0;

      let rowY = entryTop;
      for (const row of entry.rows) {
        const rowW   = row.reduce((s, seg) => s + seg.width, 0);
        let xCursor  = isRight ? (W - RIGHT_PAD - rowW) : LEFT_PAD;
        for (const seg of row) {
          if (!seg.span) {
            ctx2d.shadowBlur = 0;
            ctx2d.fillStyle  = isPastLine ? COL_BRIGHT : (isActive ? COL_MID : COL_DIM);
            ctx2d.fillText(seg.text, xCursor, rowY + entry.fontSize + 2);
          } else {
            const s          = seg.span;
            const spanActive = t >= s.begin && t < s.end;
            const spanPast   = s.end <= t;
            const ty         = getSpanY(s, t);
            ctx2d.fillStyle  = spanActive
              ? COL_ACTIVE
              : spanPast
                ? COL_BRIGHT
                : (isPastLine || isActive) ? COL_MID : COL_DIM;
            ctx2d.shadowColor = COL_ACTIVE;
            if (spanActive && s.isLong) {
              const phase = ((t - s.begin) / 0.8) % 1;
              const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
              ctx2d.shadowBlur = 10 + 20 * pulse;
            } else {
              ctx2d.shadowBlur  = spanActive ? 18 : 0;
            }
            ctx2d.fillText(seg.text, xCursor, rowY + entry.fontSize + ty);
          }
          xCursor += seg.width;
        }
        rowY += entry.wExtra;
      }

      ctx2d.globalAlpha = 1.0;
      ctx2d.shadowBlur  = 0;

      const nextEntry = layout[entry.i + 1];
      if (nextEntry) {
        const gap = nextEntry.lineObj.begin - l.end;
        if (gap >= 5) {
          const barY = entry.y + entry.totalH - viewOffsetY + 18;
          const barW = MAX_TEXT_W * 0.5;
          ctx2d.fillStyle = COL_BORDER;
          ctx2d.fillRect(LEFT_PAD, barY, barW, 2);
          if (t > l.end && t < nextEntry.lineObj.begin) {
            ctx2d.fillStyle = COL_ACTIVE;
            ctx2d.fillRect(LEFT_PAD, barY, barW * ((t - l.end) / gap), 2);
          } else if (t >= nextEntry.lineObj.begin) {
            ctx2d.fillStyle = COL_ACTIVE;
            ctx2d.fillRect(LEFT_PAD, barY, barW, 2);
          }
          ctx2d.globalAlpha = 0.4;
          ctx2d.font        = `11px "DM Mono", monospace`;
          ctx2d.fillStyle   = COL_BRIGHT;
          ctx2d.fillText(Math.round(gap) + 's', LEFT_PAD + barW + 8, barY + 2);
          ctx2d.globalAlpha = 1.0;
        }
      }
    }

    if (creditLines.length) {
      const lastEntry = layout[layout.length - 1];
      const lastDrawY = lastEntry ? (lastEntry.y + lastEntry.totalH - viewOffsetY) : H - 60;
      if (lastDrawY + 60 > 0 && lastDrawY < H) {
        ctx2d.globalAlpha = 0.4;
        ctx2d.font        = `14px "DM Mono", monospace`;
        ctx2d.fillStyle   = COL_BRIGHT;
        let creditY = lastDrawY + 40;
        for (const line of creditLines) {
          ctx2d.fillText(line, LEFT_PAD, creditY);
          creditY += 20;
        }
        ctx2d.globalAlpha = 1.0;
      }
    }
  }

  // ── Fast path: WebCodecs offline encoder ─────────────────────────────────
  if (shouldUseFastRender()) {
    let viewOffsetY = layout.length > 0 ? (layout[0].y + layout[0].totalH / 2 - CENTER_Y) : 0;
    const LERP_PER_FRAME = 1 - Math.exp(-SCROLL_LERP / FPS);
    clearRenderPreview();
    await runFastRender((ctx2d, t, _W, _H) => {
      const target = getTargetOffset(t);
      viewOffsetY += (target - viewOffsetY) * LERP_PER_FRAME;
      drawFrame(ctx2d, t, viewOffsetY);
    }, 'scroll');
    return;
  }

  // ── Slow path: real-time MediaRecorder fallback ───────────────────────────
  clearRenderPreview();

  const canvasStream  = canvas.captureStream(FPS);
  const renderACtx    = new AudioContext();
  const dest          = renderACtx.createMediaStreamDestination();
  const audioSource   = renderACtx.createBufferSource();
  audioSource.buffer  = state.audioBuffer;
  audioSource.connect(dest);
  const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mimeTypes      = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType       = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const recorder       = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: VIDEO_BPS });
  const chunks         = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  state.stableRecorder = recorder;
  state.stableAudioCtx = renderACtx;

  recorder.start(100);
  audioSource.start(0);
  state.startTime = Date.now();
  document.querySelector(".render-title").textContent = "Rendering";
  const audioStartTime = renderACtx.currentTime;

  let currentViewOffsetY = layout.length > 0 ? (layout[0].y + layout[0].totalH / 2 - CENTER_Y) : 0;
  let lastFrameWallMs    = -1;
  const FRAME_MS         = 1000 / FPS;

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
      try { audioSource.stop(); } catch(_) {}
      recorder.stop();
      return;
    }
    const lerpFactor = 1 - Math.exp(-SCROLL_LERP * wallDelta);
    currentViewOffsetY += (getTargetOffset(t) - currentViewOffsetY) * lerpFactor;
    drawFrame(ctx, t, currentViewOffsetY);
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
      let duration = Date.now() - state.startTime;
      const initBlob = new Blob(chunks, { type: mimeType });
      document.querySelector(".render-title").textContent = "Patching";
      window.ysFixWebmDuration(initBlob, duration, blob => {
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = resolveFilename('scroll'); a.click();
        overlay.classList.remove('active');
        document.getElementById('btn-render').classList.remove('rendering');
        state.startTime = null;
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      });
    }
  };
}
