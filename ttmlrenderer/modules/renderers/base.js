import { hexToRGBA } from '../utils.js';

export function easeOutExpo(t) {
  return 1 - Math.pow(1 - t, 3.5);
}

export function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function easeInOut(t) {
  t = clamp01(t);
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export { hexToRGBA };

/**
 * Common color and theme fetching from computed styles.
 */
export function getThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    BG: cs.getPropertyValue('--bg').trim() || '#0a0a0f',
    COL_DIM: cs.getPropertyValue('--text-dim').trim() || '#3a3a55',
    COL_MID: cs.getPropertyValue('--text-mid').trim() || '#6a6a9a',
    COL_BRIGHT: cs.getPropertyValue('--text-bright').trim() || '#c8c8e8',
    COL_ACTIVE: cs.getPropertyValue('--accent').trim() || '#e8f440',
    COL_ACTIVE2: cs.getPropertyValue('--accent2').trim() || '#ff4d6d',
    COL_BORDER: cs.getPropertyValue('--border').trim() || '#1e1e2e',
  };
}

/**
 * Iterates through a line element and its spans to collect all text and timing tokens.
 */
export function collectLineTokens(lineEl, lineSpans) {
  const spanByEl = new Map(lineSpans.map(s => [s.el, s]));
  const tokens = [];
  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) tokens.push({ type: 'text', text: child.textContent });
      } else if (child.classList && child.classList.contains('lyric-span')) {
        const s = spanByEl.get(child);
        if (s) tokens.push({ type: 'span', begin: s.begin, end: s.end, text: child.textContent, spanObj: s });
      } else if (child.childNodes && child.childNodes.length) {
        walk(child);
      }
    }
  }
  walk(lineEl);
  return tokens;
}

/**
 * Converts raw tokens into a list of words, where each word includes its spaces.
 */
export function tokensToWords(tokens) {
  const words = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === 'text') {
      if (/^\s+$/.test(tok.text)) {
        if (words.length) words[words.length - 1].text += tok.text;
        else words.push({ text: tok.text, spanObj: null }); 
      } else {
        if (words.length) words[words.length - 1].text += tok.text;
        else words.push({ text: tok.text, spanObj: null });
      }
      i++;
    } else {
      words.push({ text: tok.text, spanObj: tok.spanObj });
      i++;
    }
  }
  return words;
}
