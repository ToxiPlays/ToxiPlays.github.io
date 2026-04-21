import { state } from '../state.js';
import { easeOutExpo, getThemeColors, lerp, hexToRGBA, collectLineTokens, tokensToWords } from './base.js';
import { createTextMeasureCache } from '../utils.js';

export function getAmlRenderer(ctx, W, H) {
  const colors = getThemeColors();
  const { BG, COL_DIM, COL_MID, COL_BRIGHT, COL_ACTIVE } = colors;

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
      const chars = [...w.text].map(c => ({ char: c, width: textCache.width(fs, c) }));
      return { spanObj: w.spanObj, chars, width: chars.reduce((sum, c) => sum + c.width, 0) };
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
    let xCursor = W / 2 - entry.width / 2;

    for (const w of entry.words) {
      const s = w.spanObj;
      const isActive = s ? (t >= s.begin && t < s.end) : false;
      const isPast = s ? (t >= s.end) : false;
      let cAlpha = alpha;
      if (mode === 'active' && !isActive && !isPast) cAlpha *= 0.4;
      
      let xOffset = 0;
      for (const c of w.chars) {
        let charX = xCursor + xOffset;
        let charY = y;
        let charA = cAlpha;
        let charScale = 1;
        let bloom = 0;

        if (isActive) {
          const charDur = (s.end - s.begin) / w.chars.length;
          const charIdx = w.chars.indexOf(c);
          const charStart = s.begin + charIdx * charDur;
          if (t >= charStart) {
            const p = Math.min((t - charStart) / Math.min(charDur * 1.5, 0.25), 1);
            const ep = easeOutExpo(p);
            charScale = 0.95 + 0.1 * ep;
            bloom = 15 * ep;
            charA = lerp(cAlpha * 0.4, alpha, ep);
            charY -= 4 * ep;
          }
        } else if (isPast) {
          charA = alpha;
        }

        ctx.globalAlpha = charA;
        if (bloom > 0) {
          ctx.shadowColor = COL_ACTIVE;
          ctx.shadowBlur = bloom;
          ctx.fillStyle = COL_ACTIVE;
        } else if (isActive || isPast) {
          ctx.fillStyle = COL_BRIGHT;
        } else {
          ctx.fillStyle = COL_MID;
        }

        if (charScale !== 1) {
          ctx.save();
          ctx.translate(charX + c.width/2, charY);
          ctx.scale(charScale, charScale);
          ctx.fillText(c.char, -c.width/2, 0);
          ctx.restore();
        } else {
          ctx.fillText(c.char, charX, charY);
        }
        ctx.shadowBlur = 0;
        xOffset += c.width;
      }
      xCursor += w.width;
    }
    ctx.globalAlpha = 1;
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

      const fadeH = 90;
      const topFade = ctx.createLinearGradient(0, CENTER_Y - LINE_SPACING - fadeH, 0, CENTER_Y - LINE_SPACING + 30);
      topFade.addColorStop(0, BG); topFade.addColorStop(1, hexToRGBA(BG, 0));
      const botFade = ctx.createLinearGradient(0, CENTER_Y + LINE_SPACING - 30, 0, CENTER_Y + LINE_SPACING + fadeH);
      botFade.addColorStop(0, hexToRGBA(BG, 0)); botFade.addColorStop(1, BG);
      ctx.fillStyle = topFade; ctx.fillRect(0, 0, W, CENTER_Y);
      ctx.fillStyle = botFade; ctx.fillRect(0, CENTER_Y, W, H - CENTER_Y);
    }
  };
}
