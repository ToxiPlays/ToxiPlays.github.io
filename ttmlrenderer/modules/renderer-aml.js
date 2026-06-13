import { state } from './state.js';
import { getExportQualityProfile, createTextMeasureCache, clearRenderPreview, updateRenderPreview, formatTime, resolveFilename, hexToRGBA } from './utils.js';
import { shouldUseFastRender, runFastRender } from './encoder_v2.js?v=3';

export async function startAmlRender() {
  state.renderCancelled  = false;
  state.renderInProgress = true;
  const overlay    = document.getElementById('render-overlay');
  const barFill    = document.getElementById('render-bar-fill');
  const renderSub  = document.getElementById('render-sub');
  overlay.classList.add('active');
  document.getElementById('btn-render').classList.add('rendering');
  barFill.style.width = '0%';
  renderSub.textContent = 'Preparing AML render…';

  const q = getExportQualityProfile();
  const W = q.width, H = q.height, FPS = q.fps;
  const VIDEO_BPS = q.videoBitsPerSecond;
  const FONT_SIZE       = 42;
  const ADLIB_FONT_SIZE = 32;
  const ROW_GAP         = 18;
  const BLOCK_GAP       = 30;
  const GAP_HEIGHT      = 38;
  const LEFT_PAD        = 92;
  const RIGHT_PAD       = 92;
  const MAX_TEXT_W      = Math.floor(W * 0.76);
  const GAP_THRESHOLD   = 5;
  const FOCUS_Y         = H * 0.34;
  const ADLIB_OFFSET    = 18;
  const ADLIB_FADE_DUR  = 0.20;
  const ADLIB_MARGIN    = 20;
  const JITTER_DUR      = 0.060 * 0;
  const CREDIT_FONT_SIZE = 25;
  const CREDIT_LINE_GAP  = 6;
  const CREDIT_SCROLL_DUR = 1.2;
  const GAP_FADE_IN_DUR = 0.8;
  const GAP_SPACE_ANIM_DUR = 0.5;

  const cs = getComputedStyle(document.documentElement);
  const BG         = cs.getPropertyValue('--bg').trim()          || '#0a0a0f';
  const COL_DIM    = cs.getPropertyValue('--text-dim').trim()    || '#3a3a55';
  const COL_MID    = cs.getPropertyValue('--text-mid').trim()    || '#6a6a9a';
  const COL_BRIGHT = cs.getPropertyValue('--text-bright').trim() || '#c8c8e8';

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  let ctx = canvas.getContext('2d');
  const textCache = createTextMeasureCache(ctx, fs => `700 ${fs}px "SF Pro Display", sans-serif`);

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(t) { return 1 - Math.pow(1 - clamp01(t), 3.5); }
  function easeInOut(t) {
    t = clamp01(t);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function getSpanYOffset(span, t) {
    if (t < span.begin) return 4;
    if (t >= span.end) return 0;
    const p = (t - span.begin) / Math.max(span.end - span.begin, 0.001);
    return 4 * (1 - easeOut(Math.min(p, 1)));
  }

  function collectLineSegments(lineEl, lineSpans) {
    const spanByEl = new Map(lineSpans.map(s => [s.el, s]));
    const segments = [];
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent) segments.push({ span: null, text: child.textContent });
        } else if (child.classList?.contains('lyric-span')) {
          const s = spanByEl.get(child);
          if (s) segments.push({ span: s, text: child.textContent });
        } else if (child.childNodes?.length) {
          walk(child);
        }
      }
    }
    walk(lineEl);
    return segments;
  }

  function wrapLineSegments(segments, fontSize) {
    function trimRowTrailingSpaces(segs) {
      const out = segs.slice();
      while (out.length) {
        const last = out[out.length - 1];
        if (last.span === null && /^\s+$/.test(last.text)) { out.pop(); continue; }
        break;
      }
      const width = out.reduce((sum, seg) => sum + seg.width, 0);
      return { segs: out, rowW: width };
    }
    const units = [];
    let i = 0;
    while (i < segments.length) {
      const seg = segments[i];
      if (seg.span === null) {
        const metric = textCache.metrics(fontSize, seg.text);
        units.push({ segs: [{ ...seg, width: metric.width, metric }], width: metric.width, isSpace: /^\s+$/.test(seg.text) });
        i++; continue;
      }
      const run = [];
      let runWidth = 0;
      while (i < segments.length && segments[i].span !== null) {
        const metric = textCache.metrics(fontSize, segments[i].text);
        run.push({ ...segments[i], width: metric.width, metric });
        runWidth += metric.width;
        i++;
        if (/\s$/.test(segments[i - 1].text)) break;
      }
      const wordBegin = run[0].span?.begin ?? 0;
      const wordEnd   = run[run.length - 1].span?.end ?? wordBegin;
      let wordOffsetX = 0;
      for (const seg of run) {
        seg.wordOffsetX = wordOffsetX; seg.wordW = runWidth;
        seg.wordBegin = wordBegin; seg.wordEnd = wordEnd;
        wordOffsetX += seg.width;
      }
      units.push({ segs: run, width: runWidth, isSpace: false });
    }
    const rows = [];
    let rowSegs = []; let rowW = 0;
    for (const unit of units) {
      if (!rowSegs.length && unit.isSpace) continue;
      if (rowW + unit.width > MAX_TEXT_W && rowSegs.length > 0) {
        const trimmed = trimRowTrailingSpaces(rowSegs);
        if (trimmed.segs.length) rows.push(trimmed);
        rowSegs = []; rowW = 0;
        if (unit.isSpace) continue;
      }
      rowSegs.push(...unit.segs); rowW += unit.width;
    }
    if (rowSegs.length) {
      const trimmed = trimRowTrailingSpaces(rowSegs);
      if (trimmed.segs.length) rows.push(trimmed);
    }
    return rows;
  }

  function buildLineData(lineObj, isAdlib) {
    const lineSpans = state.spans.filter(s => s.lineEl === lineObj.el);
    if (!lineSpans.length) return null;
    const fontSize = isAdlib ? ADLIB_FONT_SIZE : FONT_SIZE;
    const rows = wrapLineSegments(collectLineSegments(lineObj.el, lineSpans), fontSize);
    if (!rows.length) return null;
    const rowAdvance = fontSize + ROW_GAP;
    const totalH = fontSize + (rows.length - 1) * rowAdvance;
    return {
      el: lineObj.el, begin: lineObj.begin, end: lineObj.end,
      isAdlib, isV2: lineObj.el.dataset.agent === 'v2',
      fontSize, rows, rowAdvance, totalH, adlib: null, top: 0, centerY: 0
    };
  }

  const amlEntries = [];
  let pendingMain = null;
  for (const lineObj of state.lines) {
    const isAdlib = lineObj.el.classList.contains('adlib');
    const lineData = buildLineData(lineObj, isAdlib);
    if (!lineData) continue;
    if (isAdlib) { if (pendingMain) pendingMain.adlib = lineData; continue; }
    pendingMain = lineData; amlEntries.push(lineData);
  }

  const layoutItems = [];
  let currentY = 0;
  let leadingGap = null;
  if (amlEntries.length && amlEntries[0].begin > GAP_THRESHOLD) {
    leadingGap = {
      type: 'gap', start: 0, end: amlEntries[0].begin, top: currentY,
      totalH: GAP_HEIGHT, centerY: currentY + GAP_HEIGHT / 2,
      prevEntry: null, nextEntry: amlEntries[0]
    };
    layoutItems.push(leadingGap); currentY += GAP_HEIGHT + BLOCK_GAP;
  }

  for (let i = 0; i < amlEntries.length; i++) {
    const entry = amlEntries[i]; entry.top = currentY; entry.centerY = currentY + entry.totalH / 2;
    layoutItems.push({ type: 'line', entry }); currentY += entry.totalH + BLOCK_GAP;
    const nextEntry = amlEntries[i + 1]; if (!nextEntry) continue;
    const effectiveEnd = (entry.adlib && entry.adlib.end > entry.end) ? entry.adlib.end : entry.end;
    const gapDur = nextEntry.begin - effectiveEnd;
    if (gapDur >= GAP_THRESHOLD) {
      const gapItem = {
        type: 'gap', start: effectiveEnd, end: nextEntry.begin, top: currentY,
        totalH: GAP_HEIGHT, centerY: currentY + GAP_HEIGHT / 2,
        prevEntry: entry, nextEntry
      };
      entry.gapAfter = gapItem; layoutItems.push(gapItem); currentY += GAP_HEIGHT + BLOCK_GAP;
    }
  }
  const gapItems = layoutItems.filter(item => item.type === 'gap').map(item => item);

  const creditEl = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? (creditEl.textContent || '').trim() : '';
  const creditLinesAml = [];
  let creditEntry = null;
  if (creditText) {
    const words = creditText.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (textCache.width(CREDIT_FONT_SIZE, test) > MAX_TEXT_W && line) {
        creditLinesAml.push(line); line = word;
      } else { line = test; }
    }
    if (line) creditLinesAml.push(line);
    if (creditLinesAml.length) {
      const rowAdvance = CREDIT_FONT_SIZE + CREDIT_LINE_GAP;
      const rows = creditLinesAml.map(text => {
        const metric = textCache.metrics(CREDIT_FONT_SIZE, text);
        return { segs: [{ span: null, text, width: metric.width, metric }], rowW: metric.width };
      });
      const totalH = CREDIT_FONT_SIZE + (rows.length - 1) * rowAdvance;
      const creditStart = amlEntries.length ? amlEntries[amlEntries.length - 1].end : 0;
      creditEntry = {
        el: null, begin: creditStart, end: Infinity, isAdlib: false, isV2: false,
        fontSize: CREDIT_FONT_SIZE, rows, rowAdvance, totalH, adlib: null,
        top: currentY, centerY: currentY + totalH / 2, isCredit: true
      };
      layoutItems.push({ type: 'credit', entry: creditEntry }); currentY += totalH + BLOCK_GAP;
    }
  }

  function getEntryFocusStartByIndex(i) {
    if (i <= 0) {
      if (leadingGap) {
        const scrollDur = Math.min(2, Math.max(0.5, leadingGap.end - leadingGap.start));
        return leadingGap.end - scrollDur;
      }
      return 0;
    }
    const entry = amlEntries[i]; const prevEntry = amlEntries[i - 1];
    const gapDur = entry.begin - prevEntry.end;
    if (gapDur <= 0.5) return Math.max(prevEntry.begin, prevEntry.end - 0.5);
    if (gapDur >= GAP_THRESHOLD && prevEntry.gapAfter) {
      const toNextDur = Math.min(2, Math.max(0.5, gapDur * 0.35));
      return entry.begin - toNextDur;
    }
    const scrollDur = Math.min(2, Math.max(0.5, gapDur));
    return Math.max(prevEntry.end, entry.begin - scrollDur);
  }

  for (let i = 0; i < amlEntries.length; i++) amlEntries[i].focusStart = getEntryFocusStartByIndex(i);
  for (let i = 0; i < amlEntries.length; i++) {
    const nextEntry = amlEntries[i + 1];
    amlEntries[i].focusEnd = nextEntry ? nextEntry.focusStart : Infinity;
  }

  function getAdlibReveal(entry, t) {
    if (!entry?.adlib) return 0;
    const earlyReveal = entry.adlib.begin - 0.5;
    const revealStart = Math.min(entry.focusStart ?? entry.begin, earlyReveal);
    const hideStart = entry.adlib.end <= entry.end ? (entry.focusEnd ?? entry.adlib.end) : entry.adlib.end;
    const hideEnd = hideStart + ADLIB_FADE_DUR;
    if (t < revealStart || t >= hideEnd) return 0;
    const fadeIn  = clamp01((t - revealStart) / ADLIB_FADE_DUR);
    const fadeOut = t <= hideStart ? 1 : clamp01((hideEnd - t) / ADLIB_FADE_DUR);
    return easeInOut(Math.min(fadeIn, fadeOut));
  }
  function getAdlibSlotHeight(entry) {
    if (!entry?.adlib) return 0;
    return Math.max(0, ADLIB_OFFSET + entry.adlib.totalH + ADLIB_MARGIN - BLOCK_GAP);
  }
  function getGapSpaceReveal(gapItem, t) {
    if (!gapItem || t < gapItem.start || t >= gapItem.end) return 0;
    const openP = clamp01((t - gapItem.start) / GAP_SPACE_ANIM_DUR);
    const closeP = clamp01((gapItem.end - t) / GAP_SPACE_ANIM_DUR);
    return easeInOut(Math.min(openP, closeP));
  }
  function getGapSlotHeight(gapItem) { return gapItem.totalH + BLOCK_GAP; }

  function getFlowShift(baseTop, t) {
    let shift = 0;
    for (const entry of amlEntries) {
      if (entry.top >= baseTop) break;
      const reveal = getAdlibReveal(entry, t); if (reveal) shift += getAdlibSlotHeight(entry) * reveal;
    }
    for (const gapItem of gapItems) {
      if (gapItem.top >= baseTop) break;
      const reveal = getGapSpaceReveal(gapItem, t); shift += getGapSlotHeight(gapItem) * (reveal - 1);
    }
    return shift;
  }
  function getDynamicCenter(item, t) { return item.centerY + getFlowShift(item.top, t); }

  function getTargetOffset(t) {
    if (!amlEntries.length) return 0;
    if (!leadingGap && t < amlEntries[0].begin) return getDynamicCenter(amlEntries[0], t) - FOCUS_Y;
    if (leadingGap && t < amlEntries[0].begin) {
      const scrollDur = Math.min(2, Math.max(0.5, leadingGap.end - leadingGap.start));
      const scrollStart = leadingGap.end - scrollDur;
      if (t < scrollStart) return getDynamicCenter(leadingGap, t) - FOCUS_Y;
      const p = easeInOut((t - scrollStart) / Math.max(leadingGap.end - scrollStart, 0.001));
      return lerp(getDynamicCenter(leadingGap, t), getDynamicCenter(amlEntries[0], t), p) - FOCUS_Y;
    }
    for (let i = 0; i < amlEntries.length; i++) {
      const entry = amlEntries[i]; const nextEntry = amlEntries[i + 1];
      const prevGap = i > 0 ? amlEntries[i - 1].gapAfter : null;
      if (prevGap && t >= entry.begin && t < entry.end) return getDynamicCenter(prevGap, t) - FOCUS_Y;
      if (nextEntry) {
        const gapDur = nextEntry.begin - entry.end;
        if (gapDur <= 0.5) {
          const preStart = Math.max(entry.begin, entry.end - 0.5); const preEnd = Math.max(nextEntry.begin, entry.end);
          if (t >= preStart && t < preEnd) {
            const p = easeInOut((t - preStart) / Math.max(preEnd - preStart, 0.001));
            return lerp(getDynamicCenter(entry, t), getDynamicCenter(nextEntry, t), p) - FOCUS_Y;
          }
        }
      }
      if (t >= entry.begin && t < entry.end) return getDynamicCenter(entry, t) - FOCUS_Y;
      if (!nextEntry) continue;
      const effectiveEnd = (entry.adlib && entry.adlib.end > entry.end) ? entry.adlib.end : entry.end;
      const gapDur = nextEntry.begin - effectiveEnd;
      if (t >= effectiveEnd && t < nextEntry.begin && gapDur >= GAP_THRESHOLD && entry.gapAfter) {
        const gapItem = entry.gapAfter; const toGapDur = Math.min(0.6, Math.max(0.2, gapDur * 0.2));
        if (t >= effectiveEnd && t < effectiveEnd + toGapDur) {
          const p = easeInOut((t - effectiveEnd) / toGapDur); return lerp(getDynamicCenter(entry, t), getDynamicCenter(gapItem, t), p) - FOCUS_Y;
        }
        return getDynamicCenter(gapItem, t) - FOCUS_Y;
      } else if (t >= entry.end && t < nextEntry.begin) {
        const scrollDur = Math.min(2, Math.max(0.5, nextEntry.begin - effectiveEnd));
        const scrollStart = Math.max(effectiveEnd, nextEntry.begin - scrollDur);
        if (t < scrollStart) return getDynamicCenter(entry, t) - FOCUS_Y;
        if (t >= scrollStart) {
          const p = easeInOut((t - scrollStart) / Math.max(nextEntry.begin - scrollStart, 0.001));
          return lerp(getDynamicCenter(entry, t), getDynamicCenter(nextEntry, t), p) - FOCUS_Y;
        }
      }
    }
    if (creditEntry && amlEntries.length) {
      const lastEntry = amlEntries[amlEntries.length - 1];
      if (t >= lastEntry.end) {
        if (t < lastEntry.end + CREDIT_SCROLL_DUR) {
          const p = easeInOut((t - lastEntry.end) / CREDIT_SCROLL_DUR);
          return lerp(getDynamicCenter(lastEntry, t), getDynamicCenter(creditEntry, t), p) - FOCUS_Y;
        }
        return getDynamicCenter(creditEntry, t) - FOCUS_Y;
      }
    }
    return getDynamicCenter(amlEntries[amlEntries.length - 1], t) - FOCUS_Y;
  }

  function drawGapIndicator(gapItem, t, offsetY) {
    if (t < gapItem.start || t >= gapItem.end) return;
    const y = getDynamicCenter(gapItem, t) - offsetY; if (y < -40 || y > H + 40) return;
    const gapDur = Math.max(gapItem.end - gapItem.start, 0.001);
    const third = gapDur / 3; const phase1End = gapItem.start + third; const phase2End = gapItem.start + third * 2;
    const fadeStart = Math.max(gapItem.start, gapItem.end - 1); const phase3End = Math.max(phase2End, fadeStart);
    const fadeOut = t >= fadeStart ? clamp01((gapItem.end - t) / Math.max(gapItem.end - fadeStart, 0.001)) : 1;
    const fadeIn = clamp01((t - gapItem.start) / GAP_FADE_IN_DUR); const indicatorAlpha = fadeIn * fadeOut;
    const light01 = (start, end, now) => { if (now <= start) return 0; if (now >= end) return 1; return (now - start) / Math.max(end - start, 0.001); };
    const brightLevels = [light01(gapItem.start, phase1End, t), light01(phase1End, phase2End, t), light01(phase2End, phase3End, t)];
    const x0 = LEFT_PAD + 20; const spacing = 34; const radius = 9; ctx.filter = 'none';
    for (let i = 0; i < 3; i++) {
      const cx = x0 + i * spacing; const brightMix = brightLevels[i] * indicatorAlpha;
      ctx.globalAlpha = 0.95 * indicatorAlpha; ctx.fillStyle = COL_DIM; ctx.beginPath(); ctx.arc(cx, y, radius, 0, Math.PI * 2); ctx.fill();
      if (brightMix > 0) {
        ctx.globalAlpha = brightMix; ctx.fillStyle = COL_BRIGHT; ctx.beginPath(); ctx.arc(cx, y, radius, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawSegmentText(text, x, y, progress, baseColor, alpha, shouldGlow, metric, wordX, wordW, wordProgress) {
    if (wordX == null) wordX = x; if (wordW == null) wordW = metric.width; if (wordProgress == null) wordProgress = progress;
    const FEATHER = Math.max(wordW * 0.25, 18); const sweepFrontX = wordX + wordProgress * wordW; const sweptIntoSeg = sweepFrontX - x;
    if (shouldGlow && progress > 0 && progress < 1) {
      const glowT = progress; let glowIntensity = glowT < 0.15 ? glowT / 0.15 : 1 - ((glowT - 0.15) / 0.85); glowIntensity = Math.max(0, glowIntensity);
      metric._glowInnerBlur = 10 + 2 * glowIntensity; metric._glowInnerAlpha = 0.5 + 0.4 * glowIntensity;
      metric._glowOuterBlur = 30 * glowIntensity; metric._glowOuterAlpha = 0.4 * glowIntensity;
    }
    if (shouldGlow && progress > 0 && progress < 1) {
      const spanDur = metric._spanDur || 0.6; const letters = [...text]; const STAGGER_MS = 90; const BLOOM_DUR = spanDur * 2; const BASE_DELAY = 0.060;
      let letterX = x;
      for (let i = 0; i < letters.length; i++) {
        const char = letters[i]; const charW = ctx.measureText(char).width; const letterDelay = BASE_DELAY + (i * STAGGER_MS / 1000);
        const spanElapsed = progress * spanDur; const letterT = Math.max(0, Math.min(spanElapsed - letterDelay, BLOOM_DUR)) / BLOOM_DUR;
        let scale, ty;
        if (letterT <= 0) { scale = 1; ty = 0; }
        else if (letterT < 0.18) { const p = letterT / 0.18; scale = 1 + (1.1 - 0.95) * p; ty = -3 * p; }
        else if (letterT < 0.55) { const p = (letterT - 0.18) / (0.55 - 0.18); scale = 1.1 + (0.95 - 1.1) * p; ty = -3 + (2 * p); }
        else { const p = (letterT - 0.55) / (1 - 0.55); scale = 1.1 + (1 - 1.1) * p; ty = -1 + p; }
        ctx.save(); ctx.globalAlpha = alpha; const baselineX = letterX + charW / 2; ctx.translate(baselineX, y + ty); ctx.scale(scale, scale);
        ctx.fillStyle = baseColor; ctx.shadowBlur = 0; ctx.fillText(char, -charW / 2, 0);
        const gradX1_local = (sweepFrontX - baselineX) / scale; const gradX0_local = (sweepFrontX - FEATHER - baselineX) / scale;
        if (sweepFrontX > letterX) {
          ctx.save(); const localGrad = ctx.createLinearGradient(gradX0_local, 0, gradX1_local, 0); localGrad.addColorStop(0, COL_BRIGHT); localGrad.addColorStop(0.95, hexToRGBA(COL_BRIGHT, 0)); ctx.fillStyle = localGrad;
          if (metric._glowInnerBlur) { ctx.shadowColor = hexToRGBA(COL_BRIGHT, metric._glowInnerAlpha); ctx.shadowBlur = metric._glowInnerBlur / scale; }
          ctx.fillText(char, -charW / 2, 0);
          if (metric._glowOuterBlur > 0.5) { ctx.shadowBlur = metric._glowOuterBlur / scale; ctx.shadowColor = hexToRGBA(COL_BRIGHT, metric._glowOuterAlpha); ctx.globalAlpha = alpha * (metric._glowOuterAlpha / 0.4); ctx.fillText(char, -charW / 2, 0); }
          ctx.restore();
        }
        ctx.restore(); letterX += charW;
      }
      return;
    }
    if (wordProgress <= 0) { ctx.globalAlpha = alpha; ctx.fillStyle = baseColor; ctx.shadowBlur = 0; ctx.fillText(text, x, y); return; }
    if (wordProgress >= 1) { ctx.globalAlpha = alpha; ctx.fillStyle = COL_BRIGHT; ctx.fillText(text, x, y); ctx.shadowBlur = 0; return; }
    ctx.globalAlpha = alpha; ctx.fillStyle = baseColor; ctx.shadowBlur = 0; ctx.fillText(text, x, y);
    if (sweptIntoSeg > 0) {
      const sweepGrad = ctx.createLinearGradient(sweepFrontX - FEATHER, 0, sweepFrontX, 0); sweepGrad.addColorStop(0, COL_BRIGHT); sweepGrad.addColorStop(0.8, hexToRGBA(COL_BRIGHT, 0));
      ctx.globalAlpha = alpha; ctx.fillStyle = sweepGrad; ctx.shadowBlur = 0; ctx.fillText(text, x, y); ctx.shadowBlur = 0;
    }
  }

  function drawLine(entry, t, offsetY, isAdlibRender, alphaMultiplier = 1, forcedTop = null) {
    const baseTop = forcedTop ?? (entry.top + getFlowShift(entry.top, t)); const top = baseTop - offsetY; const centerOnScreen = top + entry.totalH / 2;
    if (top + entry.totalH < -80 || top > H + 80) return;
    const dist = Math.abs(centerOnScreen - FOCUS_Y); let alpha = Math.pow(Math.max(0.04, 1 - dist / 470), 1.35);
    const isActive = t >= entry.begin && t < entry.end; const isPast = t >= entry.end;
    if (isActive && !isAdlibRender) alpha = 1; alpha *= alphaMultiplier; if (alpha <= 0) return;
    ctx.font = `700 ${entry.fontSize}px "SF Pro Display", sans-serif`; ctx.textBaseline = 'alphabetic';
    let activeSpan = null;
    if (isActive) {
      outer: for (const row of entry.rows) { for (const seg of row.segs) { if (seg.span && t >= seg.span.begin && t < seg.span.end) { activeSpan = seg.span; break outer; } } }
    }
    let rowTop = top;
    for (const row of entry.rows) {
      let xCursor = entry.isV2 ? (W - RIGHT_PAD - row.rowW) : LEFT_PAD;
      for (const seg of row.segs) {
        if (!seg.span) { ctx.globalAlpha = alpha; ctx.fillStyle = isPast ? COL_BRIGHT : (isActive ? COL_MID : COL_DIM); ctx.shadowBlur = 0; ctx.fillText(seg.text, xCursor, rowTop + entry.fontSize); xCursor += seg.width; continue; }
        const span = seg.span; const progress = t < span.begin ? 0 : t >= span.end ? 1 : (t - span.begin) / Math.max(span.end - span.begin, 0.001);
        const baseColor = isPast ? COL_BRIGHT : (isActive ? COL_MID : COL_DIM); const yOffset = getSpanYOffset(span, t);
        const shouldGlow = !isAdlibRender && activeSpan === span && span.isLong; const segMetric = seg.metric || textCache.metrics(entry.fontSize, seg.text);
        segMetric._spanDur = span.end - span.begin; const wordX = (seg.wordOffsetX != null) ? (xCursor - seg.wordOffsetX) : xCursor; const wordW = seg.wordW ?? seg.width;
        const wBegin = seg.wordBegin ?? span.begin; const wEnd = seg.wordEnd ?? span.end; const wordProgress = t < wBegin ? 0 : t >= wEnd ? 1 : (t - wBegin) / Math.max(wEnd - wBegin, 0.001);
        drawSegmentText(seg.text, xCursor, rowTop + entry.fontSize + yOffset, progress, baseColor, alpha, shouldGlow, segMetric, wordX, wordW, wordProgress);
        xCursor += seg.width;
      }
      rowTop += entry.rowAdvance;
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  function drawAdlib(entry, mainEntry, t, offsetY) {
    if (!entry) return; const alpha = getAdlibReveal(mainEntry, t) * 0.78; if (alpha <= 0) return;
    const mainTop = mainEntry.top + getFlowShift(mainEntry.top, t); const adlibTop = mainTop + mainEntry.totalH + ADLIB_OFFSET;
    drawLine(entry, t, offsetY, true, alpha, adlibTop);
  }

  function drawFrame(t, offsetY) {
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    for (const item of layoutItems) {
      if (item.type === 'gap') drawGapIndicator(item, t, offsetY);
      else drawLine(item.entry, t, offsetY, false);
    }
    for (const mainEntry of amlEntries) { if (mainEntry.adlib) drawAdlib(mainEntry.adlib, mainEntry, t, offsetY); }
  }

  // ── Fast path: WebCodecs offline encoder ─────────────────────────────────
  if (shouldUseFastRender()) {
    clearRenderPreview();
    const originalCtx = ctx;
    await runFastRender((ctx2d, t, _W, _H) => {
      ctx = ctx2d;
      drawFrame(t, getTargetOffset(t));
    }, 'aml');
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
  const mimeTypes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType  = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const recorder  = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: VIDEO_BPS });
  const chunks    = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  state.stableRecorder = recorder; state.stableAudioCtx = renderACtx;
  recorder.start(100); audioSrc.start(0); state.startTime = Date.now();
  document.querySelector(".render-title").textContent = "Rendering";
  const audioStartTime = renderACtx.currentTime;
  let amlRafId = null; let renderDone = false; let lastDrawMs = -1; const FRAME_MS = 1000 / FPS;
  function doAmlTick(wallMs) {
    if (state.renderCancelled || renderDone) return;
    if (wallMs - lastDrawMs < FRAME_MS - 1) { amlRafId = requestAnimationFrame(doAmlTick); return; }
    lastDrawMs = wallMs; const t = Math.max(renderACtx.currentTime - audioStartTime, 0);
    if (t > state.duration + 0.8) { renderDone = true; try { audioSrc.stop(); } catch (_) {} recorder.stop(); return; }
    drawFrame(t, getTargetOffset(t)); updateRenderPreview(canvas);
    const pct = Math.min((t / Math.max(state.duration, 0.001)) * 100, 100);
    barFill.style.width = pct.toFixed(1) + '%'; renderSub.textContent = formatTime(t) + ' / ' + formatTime(state.duration);
    amlRafId = requestAnimationFrame(doAmlTick);
  }
  amlRafId = requestAnimationFrame(doAmlTick);
  recorder.onstop = () => {
    if (amlRafId) cancelAnimationFrame(amlRafId);
    state.stableRecorder = null; state.stableAudioCtx = null; state.renderInProgress = false;
    if (!state.renderCancelled) {
      let duration = Date.now() - state.startTime; const initBlob = new Blob(chunks, { type: mimeType });
      document.querySelector(".render-title").textContent = "Patching";
      window.ysFixWebmDuration(initBlob, duration, blob => {
        const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = resolveFilename('aml'); a.click();
        overlay.classList.remove('active'); document.getElementById('btn-render').classList.remove('rendering');
        state.startTime = null; setTimeout(() => URL.revokeObjectURL(url), 10_000);
      });
    }
  };
}
