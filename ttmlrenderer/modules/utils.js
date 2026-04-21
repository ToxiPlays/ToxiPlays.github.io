import { APP_VERSION } from './constants.js';

export function parseTime(str) {
  if (!str) return 0;
  // formats: HH:MM:SS.mmm  MM:SS.mmm  SS.mmm
  const parts = str.split(':');
  let secs = 0;
  if (parts.length === 3) {
    secs = (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    secs = (+parts[0]) * 60 + parseFloat(parts[1]);
  } else {
    secs = parseFloat(parts[0]);
  }
  return secs;
}

export function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function hexToRGBA(hex, alpha) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function resolveFilename(type, now, { ttmlBaseName, audioBaseName, audioExt, pattern, format }) {
  // type: 'scroll' | 'karaoke' | 'iyf' | 'aml'
  if (!now) now = new Date();
  const ext = format || 'webm';

  const typeMap = { scroll: 'Scroll', karaoke: 'Kar', iyf: 'IYF', aml: 'AMLL' };
  const typeStr = typeMap[type] || type;

  const pad2 = n => String(n).padStart(2, '0');
  const h24 = now.getHours();
  const time24 = `${pad2(h24)}-${pad2(now.getMinutes())}`;
  const h12r = h24 % 12 || 12;
  const ampm = h24 < 12 ? 'a.m.' : 'p.m.';
  const time12 = `${h12r}-${pad2(now.getMinutes())} ${ampm}`;

  let name = pattern
    .replace(/%VER#%/g, APP_VERSION)
    .replace(/%TTML%/g, ttmlBaseName || 'ttml')
    .replace(/%AUDIO%/g, audioBaseName || 'audio')
    .replace(/%EXT%/g, (audioExt || 'webm').toUpperCase())
    .replace(/%YEAR%/g, now.getFullYear())
    .replace(/%MONTH%/g, pad2(now.getMonth() + 1))
    .replace(/%DAY%/g, pad2(now.getDate()))
    .replace(/%TIME24%/g, time24)
    .replace(/%TIME12%/g, time12)
    .replace(/%TYPEU%/g, typeStr.toUpperCase())
    .replace(/%TYPEL%/g, typeStr.toLowerCase())
    .replace(/%TYPE%/g, typeStr);

  // Strip characters invalid in filenames
  name = name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'export';
  return name + '.' + ext;
}

export function createTextMeasureCache(ctx, fontBuilder) {
  const widthCache = new Map();
  const metricsCache = new Map();
  const keyOf = (fontSize, text) => `${fontSize}|${text}`;

  function width(fontSize, text) {
    const key = keyOf(fontSize, text);
    if (widthCache.has(key)) return widthCache.get(key);
    ctx.font = fontBuilder(fontSize);
    const w = ctx.measureText(text).width;
    widthCache.set(key, w);
    return w;
  }

  function metrics(fontSize, text) {
    const key = keyOf(fontSize, text);
    if (metricsCache.has(key)) return metricsCache.get(key);
    ctx.font = fontBuilder(fontSize);
    const m = ctx.measureText(text);
    const measured = {
      width: m.width,
      ascent: m.actualBoundingBoxAscent || fontSize * 0.8,
      descent: m.actualBoundingBoxDescent || fontSize * 0.2,
    };
    metricsCache.set(key, measured);
    widthCache.set(key, measured.width);
    return measured;
  }

  return { width, metrics };
}
