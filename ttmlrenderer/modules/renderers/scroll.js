import { state } from '../state.js';
import { easeOutExpo, getThemeColors } from './base.js';
import { createTextMeasureCache } from '../utils.js';

export function getScrollRenderer(ctx, W, H) {
  const colors = getThemeColors();
  const { BG, COL_DIM, COL_MID, COL_BRIGHT, COL_ACTIVE, COL_BORDER } = colors;
  
  const FONT_SIZE = 38;
  const LINE_HEIGHT = 80;
  const WRAPPED_EXTRA = 52;
  const LEFT_PAD = 80;
  const RIGHT_PAD = 80;
  const MAX_TEXT_W = W - LEFT_PAD - RIGHT_PAD;
  const JITTER_DUR = 0.060;
  const SCROLL_LERP = 4.0;
  const SCROLL_ARRIVE = 0.75;
  const CENTER_Y = H / 2 - 20;

  const textCache = createTextMeasureCache(ctx, fs => `${fs}px "DM Mono", monospace`);

  // Build Layout
  const layout = [];
  let curY = 0;
  for (let i = 0; i < state.lines.length; i++) {
    const l = state.lines[i];
    const isAdlib = l.el.classList.contains('adlib');
    const agent = l.el.dataset.agent;
    const fs = isAdlib ? 30 : FONT_SIZE;
    const lh = isAdlib ? 60 : LINE_HEIGHT;
    const wExtra = isAdlib ? 42 : WRAPPED_EXTRA;
    const lineSpans = state.spans.filter(s => s.lineEl === l.el);
    const segs = buildLineSegments(l.el, lineSpans);
    const rows = wrapSegments(segs, fs, MAX_TEXT_W, textCache);
    const totalH = lh + (rows.length - 1) * wExtra;
    layout.push({ lineObj: l, y: curY, isAdlib, agent, fontSize: fs,
                  lineHeight: lh, wExtra, rows, totalH, i });
    curY += totalH;
    if (state.breakBars.some(b => b.start === l.end)) curY += 56;
  }

  // Credit logic
  const creditEl = document.querySelector('.songwriter-credit');
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

  function getSpanY(span, t) {
    if (t < span.begin) return 2;
    if (t >= span.end)  return 0;
    const elapsed = t - span.begin;
    const wordDur = span.end - span.begin;
    if (elapsed < JITTER_DUR) return 2 + 3 * (elapsed / JITTER_DUR);
    const p = Math.min((elapsed - JITTER_DUR) / Math.max(wordDur - JITTER_DUR, 0.001), 1);
    return 5 * (1 - easeOutExpo(p));
  }

  return {
    layout,
    drawFrame(t, viewOffsetY) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);

      for (const entry of layout) {
        const entryTop = entry.y - viewOffsetY;
        if (entryTop + entry.totalH < -10 || entryTop > H + 10) continue;

        const l = entry.lineObj;
        const isActive = t >= l.begin && t < l.end;
        const isPastLine = l.end <= t;
        const isRight = entry.agent === 'v2';

        ctx.font = `${entry.fontSize}px "DM Mono", monospace`;
        ctx.textBaseline = 'alphabetic';
        ctx.globalAlpha = entry.isAdlib ? 0.6 : 1.0;

        let rowY = entryTop;
        for (const row of entry.rows) {
          const rowW = row.reduce((s, seg) => s + seg.width, 0);
          let xCursor = isRight ? (W - RIGHT_PAD - rowW) : LEFT_PAD;
          for (const seg of row) {
            if (!seg.span) {
              ctx.shadowBlur = 0;
              ctx.fillStyle = isPastLine ? COL_BRIGHT : (isActive ? COL_MID : COL_DIM);
              ctx.fillText(seg.text, xCursor, rowY + entry.fontSize + 2);
            } else {
              const s = seg.span;
              const spanActive = t >= s.begin && t < s.end;
              const spanPast = s.end <= t;
              const ty = getSpanY(s, t);
              ctx.fillStyle = spanActive
                ? COL_ACTIVE
                : spanPast
                  ? COL_BRIGHT
                  : (isPastLine || isActive) ? COL_MID : COL_DIM;
              ctx.shadowColor = COL_ACTIVE;
              if (spanActive && s.isLong) {
                const phase = ((t - s.begin) / 0.8) % 1;
                const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
                ctx.shadowBlur = 10 + 20 * pulse;
              } else {
                ctx.shadowBlur = spanActive ? 18 : 0;
              }
              ctx.fillText(seg.text, xCursor, rowY + entry.fontSize + ty);
            }
            xCursor += seg.width;
          }
          rowY += entry.wExtra;
        }

        ctx.globalAlpha = 1.0;
        ctx.shadowBlur = 0;

        const nextEntry = layout[entry.i + 1];
        if (nextEntry) {
          const gap = nextEntry.lineObj.begin - l.end;
          if (gap >= 5) {
            const barY = entry.y + entry.totalH - viewOffsetY + 18;
            const barW = MAX_TEXT_W * 0.5;
            ctx.fillStyle = COL_BORDER;
            ctx.fillRect(LEFT_PAD, barY, barW, 2);
            if (t > l.end && t < nextEntry.lineObj.begin) {
              ctx.fillStyle = COL_ACTIVE;
              ctx.fillRect(LEFT_PAD, barY, barW * ((t - l.end) / gap), 2);
            } else if (t >= nextEntry.lineObj.begin) {
              ctx.fillStyle = COL_ACTIVE;
              ctx.fillRect(LEFT_PAD, barY, barW, 2);
            }
            ctx.globalAlpha = 0.4;
            ctx.font = `11px "DM Mono", monospace`;
            ctx.fillStyle = COL_BRIGHT;
            ctx.fillText(Math.round(gap) + 's', LEFT_PAD + barW + 8, barY + 2);
            ctx.globalAlpha = 1.0;
          }
        }
      }

      if (creditLines.length) {
        const lastEntry = layout[layout.length - 1];
        const lastDrawY = lastEntry ? (lastEntry.y + lastEntry.totalH - viewOffsetY) : H - 60;
        if (lastDrawY + 60 > 0 && lastDrawY < H) {
          ctx.globalAlpha = 0.4;
          ctx.font = `14px "DM Mono", monospace`;
          ctx.fillStyle = COL_BRIGHT;
          let creditY = lastDrawY + 40;
          for (const line of creditLines) {
            ctx.fillText(line, LEFT_PAD, creditY);
            creditY += 20;
          }
          ctx.globalAlpha = 1.0;
        }
      }
    },
    getTargetOffset,
    SCROLL_LERP
  };
}

// Helpers duplicated from main.js for now, clean up later if possible
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

function wrapSegments(segments, fontSize, maxW, textCache) {
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
    if (currentW + unit.width > maxW && currentRow.length > 0) {
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
