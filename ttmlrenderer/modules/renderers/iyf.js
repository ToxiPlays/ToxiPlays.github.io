import { state } from '../state.js';
import { easeOutExpo, getThemeColors, hexToRGBA, collectLineTokens, tokensToWords } from './base.js';
import { createTextMeasureCache } from '../utils.js';

export function getIyfRenderer(ctx, W, H, { casing, showProgBar }) {
  const colors = getThemeColors();
  const { BG, COL_MID, COL_BRIGHT, COL_ACTIVE } = colors;

  const FONT_SIZE = 48;
  const LINE_SPACING = 84;
  const CENTER_Y = H / 2 - 20;
  const EASE_DUR = 0.65;
  const ADLIB_FADE = 0.5;
  const LINE_FADE_GAP = 3.0;

  const textCache = createTextMeasureCache(ctx, fs => `600 ${fs}px "Outfit", sans-serif`);

  const layout = state.lines.map((l, idx) => {
    const isAdlib = l.el.classList.contains('adlib');
    const fs = isAdlib ? 32 : FONT_SIZE;
    const lineSpans = state.spans.filter(s => s.lineEl === l.el);
    const tokens = collectLineTokens(l.el, lineSpans);
    const words = tokensToWords(tokens).map(w => {
      let text = w.text;
      if (casing === 'lower') text = text.toLowerCase();
      else if (casing === 'upper') text = text.toUpperCase();
      return { spanObj: w.spanObj, text, width: textCache.width(fs, text) };
    });
    return { lineObj: l, words, width: words.reduce((sum, w) => sum + w.width, 0), isAdlib, fontSize: fs, idx };
  });

  const nonAdlibs = layout.filter(e => !e.isAdlib);
  const gapAfter = nonAdlibs.map((e, idx) => {
    const next = nonAdlibs[idx + 1];
    if (next) {
      const start = e.lineObj.end, end = next.lineObj.begin, dur = end - start;
      return { start, end, duration: dur };
    }
    return null;
  });

  let transitionStart = -1, lastNAPos = -1, bleedLine = null;

  function drawLine(entry, y, alpha, mode, t) {
    if (alpha <= 0) return;
    const fs = entry.fontSize;
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${fs}px "Outfit", sans-serif`;
    ctx.globalAlpha = alpha;

    let xCursor = W / 2 - entry.width / 2;
    for (const w of entry.words) {
      const s = w.spanObj;
      const isActive = s ? (t >= s.begin && t < s.end) : false;
      const isPast = s ? (t >= s.end) : false;

      if (isActive) {
        ctx.fillStyle = COL_ACTIVE;
        ctx.shadowColor = COL_ACTIVE;
        ctx.shadowBlur = 15;
      } else if (isPast) {
        ctx.fillStyle = COL_BRIGHT;
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = COL_MID;
        ctx.shadowBlur = 0;
      }

      let ty = 0;
      if (isActive) {
        const elapsed = t - s.begin;
        const wordDur = s.end - s.begin;
        const JITTER_DUR = 0.06;
        if (elapsed < JITTER_DUR) ty = 2 + 3 * (elapsed / JITTER_DUR);
        else {
          const p = Math.min((elapsed - JITTER_DUR) / Math.max(wordDur - JITTER_DUR, 0.001), 1);
          ty = 5 * (1 - easeOutExpo(p));
        }
      }

      ctx.fillText(w.text, xCursor, y + ty);
      xCursor += w.width;
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function getAdlibsAt(t) {
    return layout.filter(e => e.isAdlib && t >= e.lineObj.begin && t < e.lineObj.end);
  }

  return {
    drawFrame(t) {
      ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
      
      let naPos = -1;
      for (let i = 0; i < nonAdlibs.length; i++) {
        if (t >= nonAdlibs[i].lineObj.begin && (i === nonAdlibs.length - 1 || t < nonAdlibs[i+1].lineObj.begin)) { naPos = i; break; }
      }

      if (naPos !== lastNAPos) {
        if (lastNAPos >= 0) bleedLine = (t < nonAdlibs[lastNAPos].lineObj.end) ? nonAdlibs[lastNAPos] : null;
        else bleedLine = null;
        transitionStart = t; lastNAPos = naPos;
      }
      if (bleedLine && t >= bleedLine.lineObj.end) bleedLine = null;

      const transAge = transitionStart >= 0 ? Math.min(1, (t - transitionStart) / EASE_DUR) : 1;
      const eased = easeOutExpo(transAge);

      if (naPos >= 0) {
        const curLine = nonAdlibs[naPos];
        const curY = CENTER_Y + LINE_SPACING * (1 - eased);
        let curAlpha = Math.max(0.05, eased);
        if (t >= curLine.lineObj.end) {
          const gap = gapAfter[naPos];
          if (gap && gap.duration >= LINE_FADE_GAP) {
            const fp = (t - curLine.lineObj.end) / Math.min(0.6, gap.duration * 0.15);
            curAlpha = Math.max(0, 1 - fp);
          }
        }
        if (bleedLine) {
          const prevY = CENTER_Y - LINE_SPACING * eased;
          const bleedAge = Math.max(0, (t - bleedLine.lineObj.begin) / Math.max(bleedLine.lineObj.end - bleedLine.lineObj.begin, 0.001));
          const prevAlpha = Math.max(0, 0.6 * (1 - bleedAge));
          if (prevAlpha > 0) drawLine(bleedLine, prevY, prevAlpha, 'active', t);
        }
        if (curAlpha > 0) drawLine(curLine, curY, curAlpha, 'active', t);

        const activeAdlibs = getAdlibsAt(t);
        if (activeAdlibs.length) {
          const al = activeAdlibs[0];
          const fi = Math.min(1, (t - al.lineObj.begin) / ADLIB_FADE);
          const fo = Math.min(1, (al.lineObj.end - t) / ADLIB_FADE);
          const alAlpha = Math.min(fi, fo) * 0.8;
          if (alAlpha > 0) drawLine(al, CENTER_Y + LINE_SPACING, alAlpha, 'adlib', t);
        }
      }

      // Edge fades
      const fadeH = 90;
      const topFade = ctx.createLinearGradient(0, CENTER_Y - LINE_SPACING - fadeH, 0, CENTER_Y - LINE_SPACING + 30);
      topFade.addColorStop(0, BG); topFade.addColorStop(1, hexToRGBA(BG, 0));
      const botFade = ctx.createLinearGradient(0, CENTER_Y + LINE_SPACING - 30, 0, CENTER_Y + LINE_SPACING + fadeH);
      botFade.addColorStop(0, hexToRGBA(BG, 0)); botFade.addColorStop(1, BG);
      ctx.fillStyle = topFade; ctx.fillRect(0, 0, W, CENTER_Y);
      ctx.fillStyle = botFade; ctx.fillRect(0, CENTER_Y, W, H - CENTER_Y);

      // Progress bar
      if (showProgBar && state.duration > 0) {
        const BAR_H = 4, BAR_Y = H - 36, BAR_PAD = 80, barW = W - BAR_PAD * 2;
        ctx.globalAlpha = 0.3; ctx.fillStyle = COL_MID; ctx.fillRect(BAR_PAD, BAR_Y, barW, BAR_H);
        ctx.globalAlpha = 1; ctx.fillStyle = COL_ACTIVE; ctx.fillRect(BAR_PAD, BAR_Y, barW * Math.min(t / state.duration, 1), BAR_H);
      }
    }
  };
}
