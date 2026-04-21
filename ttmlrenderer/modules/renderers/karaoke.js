import { state } from '../state.js';
import { easeOutExpo, getThemeColors } from './base.js';
import { createTextMeasureCache } from '../utils.js';

export function getKaraokeRenderer(ctx, W, H, { ignoreAdlibs }) {
  const colors = getThemeColors();
  const { BG, COL_DIM, COL_MID, COL_BRIGHT, COL_ACTIVE, COL_ACTIVE2 } = colors;
  
  const FONT_SIZE = 52;
  const ADLIB_FONT_SIZE = 38;
  const LINE_H = 80;
  const MAX_LINES = 5;
  const CENTER_X = W / 2;
  const BLOCK_Y_START = H / 2 - ((MAX_LINES * LINE_H) / 2);
  const MAX_LINE_PX = W - 160;
  const APPEAR_BEFORE = 1.5;
  const JITTER_DUR = 0.060;

  const textCache = createTextMeasureCache(ctx, fs => `bold ${fs}px "DM Mono", monospace`);

  // Build kLines
  const kLines = [];
  let _splitGroupCounter = 0;

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
    splitIntoKLines(words, l.begin, l.end, isAdlib, isV2, agent, fs, groupId, kLines, textCache, MAX_LINE_PX, APPEAR_BEFORE);
  }

  // Slot assignment
  const lineSlot = new Array(kLines.length).fill(-1);
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
    const kl = kLines[i];
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

  // Countdown logic
  const countdowns = [];
  if (kLines.length && kLines[0].begin > 1.0) {
    countdowns.push({ countStart: 0, countEnd: kLines[0].begin, nextLineIdx: 0 });
  }
  for (let i = 0; i < kLines.length - 1; i++) {
    const gap = kLines[i+1].begin - kLines[i].end;
    if (gap >= 5) {
      countdowns.push({ countStart: kLines[i].end, countEnd: kLines[i+1].begin, nextLineIdx: i+1 });
    }
  }

  // Credits logic
  const lastSpanEnd = state.spans.length ? Math.max(...state.spans.map(s => s.end)) : state.duration;
  const creditEl = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? creditEl.textContent : null;
  const CREDIT_FADE_START = lastSpanEnd + 0.5;
  const CREDIT_FADE_DUR = 2.0;
  const LYRIC_FADE_DUR = 1.0;
  const creditLines = [];
  if (creditText) {
    const maxW = W - 200;
    const words = creditText.split(' ');
    let line = '';
    for (const wd of words) {
      const t2 = line ? line + ' ' + wd : wd;
      if (textCache.width(28, t2) > maxW && line) {
        creditLines.push(line);
        line = wd;
      } else {
        line = t2;
      }
    }
    if (line) creditLines.push(line);
  }

  function getSpanYOffset(span, t) {
    if (t < span.begin) return 2;
    if (t >= span.end) return 0;
    const elapsed = t - span.begin;
    const wordDur = span.end - span.begin;
    if (elapsed < JITTER_DUR) return 2 + 3 * (elapsed / JITTER_DUR);
    const p = Math.min((elapsed - JITTER_DUR) / Math.max(wordDur - JITTER_DUR, 0.001), 1);
    return 5 * (1 - easeOutExpo(p));
  }

  return {
    drawFrame(t) {
      ctx.clearRect(0, 0, W, H); ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
      let lyricAlpha = 1;
      if (creditText && t >= CREDIT_FADE_START) lyricAlpha = Math.max(0, 1 - (t - CREDIT_FADE_START) / LYRIC_FADE_DUR);

      const cd = countdowns.find(c => t >= c.countStart && t < c.countEnd) || null;
      let lastEnteredGap = null;
      for (const gapCD of countdowns) {
        if (gapCD.countStart <= t && (!lastEnteredGap || gapCD.countStart > lastEnteredGap.countStart)) lastEnteredGap = gapCD;
      }

      if (cd) {
        const cdA = Math.min(Math.min(1, (t - cd.countStart) / 0.4), Math.min(1, (cd.countEnd - t) / 0.4));
        const lyrA = Math.min(1, (1 - (t - cd.countStart) / 0.4)) * lyricAlpha;
        if (lyrA > 0) {
          const slotNow = getVisibleLines(t, cd.countEnd, kLines, lineSlot, MAX_LINES, APPEAR_BEFORE);
          for (let slot = 0; slot < MAX_LINES; slot++) {
            const idx = slotNow[slot];
            if (idx !== -1 && kLines[idx].appearAt <= t) {
              drawKaraokeRow(ctx, t, kLines[idx], BLOCK_Y_START + slot * LINE_H + LINE_H / 2, lyrA, CENTER_X, LINE_H, COL_MID, COL_BRIGHT, COL_DIM, COL_ACTIVE, COL_ACTIVE2, getSpanYOffset);
            }
          }
        }
        drawCountdown(ctx, t, cd, cdA, CENTER_X, H, COL_MID, COL_ACTIVE);
      } else {
        const gapEnd = lastEnteredGap ? lastEnteredGap.countEnd : -Infinity;
        if (lyricAlpha > 0) {
          const slotNow = getVisibleLines(t, gapEnd, kLines, lineSlot, MAX_LINES, APPEAR_BEFORE);
          for (let slot = 0; slot < MAX_LINES; slot++) {
            const idx = slotNow[slot];
            if (idx !== -1) {
              drawKaraokeRow(ctx, t, kLines[idx], BLOCK_Y_START + slot * LINE_H + LINE_H / 2, lyricAlpha, CENTER_X, LINE_H, COL_MID, COL_BRIGHT, COL_DIM, COL_ACTIVE, COL_ACTIVE2, getSpanYOffset);
            }
          }
        }
      }
      if (t >= CREDIT_FADE_START) drawCredits(ctx, t, creditLines, CREDIT_FADE_START, CREDIT_FADE_DUR, CENTER_X, H, COL_BRIGHT);
    }
  };
}

// Helpers
function getVisibleLines(t, gapEnd, kLines, lineSlot, MAX_LINES, APPEAR_BEFORE) {
  const ge = gapEnd ?? -Infinity;
  const slotNow = new Array(MAX_LINES).fill(-1);
  for (let i = 0; i < kLines.length; i++) {
    const kl = kLines[i];
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

function drawKaraokeRow(ctx, t, kl, slotYCenter, globalAlpha, CENTER_X, LINE_H, COL_MID, COL_BRIGHT, COL_DIM, COL_ACTIVE, COL_ACTIVE2, getSpanYOffset) {
  const fs = kl.fs;
  ctx.font = `bold ${fs}px "DM Mono", monospace`;
  ctx.textBaseline = 'middle';
  const isActive = t >= kl.begin && t < kl.end;
  const isPast = kl.end <= t;
  let alpha = 1.0;
  if (t < kl.appearAt) alpha = 0;
  else if (t < kl.begin) alpha = Math.min(1, (t - kl.appearAt) / Math.min(1.5, 0.5));
  if (kl.isAdlib) alpha *= 0.75;
  alpha *= globalAlpha;
  if (alpha <= 0) return;

  const sweepColor = kl.isV2 ? COL_ACTIVE2 : COL_ACTIVE;
  const baseColor = isActive ? COL_MID : (isPast ? COL_BRIGHT : COL_DIM);

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
  if (isPast) sweepPx = cumW + 1;
  else if (!isActive) sweepPx = -1;
  else {
    sweepPx = 0;
    for (const { s, lineOffset } of allSpans) {
      if (t >= s.end) sweepPx = lineOffset + s.width;
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

function drawCountdown(ctx, t, cd, cdAlpha, CENTER_X, H, COL_MID, COL_ACTIVE) {
  if (cdAlpha <= 0) return;
  const remaining = cd.countEnd - t;
  const countNum = Math.ceil(remaining);
  if (countNum <= 0) return;
  const frac = remaining - Math.floor(remaining);
  const scale = 1 + 0.15 * Math.pow(1 - frac, 3);
  const nA = (0.4 + 0.6 * Math.pow(1 - frac, 2)) * cdAlpha;
  const prog = Math.min(1, (t - cd.countStart) / (cd.countEnd - cd.countStart));
  const barX = CENTER_X - 200, barY = H - 80;
  ctx.globalAlpha = 0.3 * cdAlpha; ctx.fillStyle = COL_MID; ctx.fillRect(barX, barY, 400, 3);
  ctx.globalAlpha = cdAlpha; ctx.fillStyle = COL_ACTIVE; ctx.fillRect(barX, barY, 400 * prog, 3);
  ctx.save(); ctx.globalAlpha = nA;
  ctx.font = `bold ${Math.round(120 * scale)}px "DM Mono", monospace`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillStyle = COL_ACTIVE; ctx.shadowColor = COL_ACTIVE; ctx.shadowBlur = 30;
  ctx.fillText(String(countNum), CENTER_X, H / 2);
  ctx.shadowBlur = 0; ctx.restore();
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.globalAlpha = 1;
}

function drawCredits(ctx, t, creditLines, offset, duration, CENTER_X, H, COL_BRIGHT) {
  const alpha = Math.min(1, (t - offset) / duration) * 0.9;
  if (alpha <= 0) return;
  ctx.font = `bold 28px "DM Mono", monospace`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillStyle = COL_BRIGHT; ctx.globalAlpha = alpha;
  const lh = 42;
  let cy = H / 2 - creditLines.length * lh / 2 + lh / 2;
  for (const cl of creditLines) { ctx.fillText(cl, CENTER_X, cy); cy += lh; }
  ctx.globalAlpha = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

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
      if (/^\s+$/.test(tok.text)) { if (words.length) words[words.length - 1].trailSpace += tok.text; }
      else { if (words.length) words[words.length - 1].spans[words[words.length-1].spans.length-1].text += tok.text; }
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
              if (/^\s+$/.test(nxt.text)) { trailSpace = nxt.text; i++; break; }
              else { wordSpans[wordSpans.length - 1].text += nxt.text; i++; }
            }
          }
        } else { break; }
      }
      if (wordSpans.length) { words.push({ spans: wordSpans, trailSpace }); }
    }
  }
  return words;
}

function findSplitPoint(words, fs, textCache, MAX_LINE_PX) {
  let w = 0;
  for (let i = 0; i < words.length; i++) {
    for (const s of words[i].spans) w += textCache.width(fs, s.text);
    if (i < words.length - 1) w += textCache.width(fs, words[i].trailSpace || ' ');
  }
  if (w <= MAX_LINE_PX) return null;

  const SPLIT_CHARS = /[,?!"]/;
  let punctSplit = -1;
  for (let i = 0; i < words.length - 1; i++) {
    const lastText = words[i].spans[words[i].spans.length - 1].text.trimEnd();
    if (SPLIT_CHARS.test(lastText[lastText.length - 1])) punctSplit = i + 1;
  }
  if (punctSplit > 0) return { splitIdx: punctSplit, isPunctSplit: true };
  if (words.length < 2) return null;
  return { splitIdx: Math.floor(words.length / 2), isPunctSplit: false };
}

function splitIntoKLines(words, lineBegin, lineEnd, isAdlib, isV2, agent, fs, splitGroupId, kLines, textCache, MAX_LINE_PX, APPEAR_BEFORE) {
  const split = findSplitPoint(words, fs, textCache, MAX_LINE_PX);
  if (!split) {
    for (const w of words) {
      for (const s of w.spans) s.width = textCache.width(fs, s.text);
      w.trailSpaceWidth = textCache.width(fs, w.trailSpace || '');
    }
    let rowW = 0;
    for (let j = 0; j < words.length; j++) {
      for (const s of words[j].spans) rowW += s.width;
      if (j < words.length - 1) rowW += words[j].trailSpaceWidth;
    }
    kLines.push({ begin: lineBegin, end: lineEnd, isAdlib, isV2, agent, fs,
                  rows: [{ words, rowW }], appearAt: lineBegin - APPEAR_BEFORE,
                  splitGroupId: splitGroupId ?? null });
    return;
  }
  const { splitIdx, isPunctSplit } = split;
  const part1 = words.slice(0, splitIdx);
  const part2 = words.slice(splitIdx);
  if (isPunctSplit) {
    const lastWord = part1[part1.length - 1];
    lastWord.spans[lastWord.spans.length - 1].text = lastWord.spans[lastWord.spans.length - 1].text.replace(/,\s*$/, '');
    if (part2.length && part2[0].spans.length) {
      const s = part2[0].spans[0];
      s.text = s.text.charAt(0).toUpperCase() + s.text.slice(1);
    }
  }
  const part1End = part1[part1.length - 1].spans[part1[part1.length - 1].spans.length - 1].end;
  const part2Begin = part2[0].spans[0].begin;
  splitIntoKLines(part1, lineBegin, part1End, isAdlib, isV2, agent, fs, splitGroupId, kLines, textCache, MAX_LINE_PX, APPEAR_BEFORE);
  splitIntoKLines(part2, part2Begin, lineEnd, isAdlib, isV2, agent, fs, splitGroupId, kLines, textCache, MAX_LINE_PX, APPEAR_BEFORE);
}
