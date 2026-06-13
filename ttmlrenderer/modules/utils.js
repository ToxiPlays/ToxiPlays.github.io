import { state } from './state.js';
import { APP_VERSION, FILENAME_DEFAULT, EXPORT_QUALITY_PROFILES } from './constants.js';

export function updateRenderPreview(src, force) {
  const canvas = document.getElementById('render-preview');
  const ctx = canvas.getContext('2d');
  const PREVIEW_THROTTLE_MS = 250;
  
  if (!state._previewLastMs) state._previewLastMs = 0;
  
  const now = performance.now();
  if (!force && now - state._previewLastMs < PREVIEW_THROTTLE_MS) return;
  state._previewLastMs = now;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
}

export function clearRenderPreview() {
  const canvas = document.getElementById('render-preview');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function getExportQualityProfile() {
  const sel = document.getElementById('export-quality');
  const key = sel?.value || 'high';
  
  if (key === 'custom') {
    const w = parseInt(document.getElementById('custom-q-w')?.value) || 1280;
    const h = parseInt(document.getElementById('custom-q-h')?.value) || 720;
    const fps = parseInt(document.getElementById('custom-q-fps')?.value) || 30;
    // Estimate bitrate: roughly 1.5x of 720p for 1080p, scaled by FPS ratio
    const baseBitrate = 8_000_000;
    const pixelRatio = (w * h) / (1280 * 720);
    const fpsRatio = fps / 30;
    const bitrate = Math.round(baseBitrate * pixelRatio * fpsRatio);

    return { width: w, height: h, fps, videoBitsPerSecond: bitrate };
  }

  return EXPORT_QUALITY_PROFILES[key] || EXPORT_QUALITY_PROFILES.high;
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

export function resolveFilename(type, now) {
  const pattern = document.getElementById('export-filename')?.value || FILENAME_DEFAULT;
  if (!now) now = new Date();

  const typeMap = { scroll: 'Scroll', karaoke: 'Kar', iyf: 'IYF', aml: 'AMLL' };
  const typeStr = typeMap[type] || type;

  const pad2 = n => String(n).padStart(2, '0');
  const h24  = now.getHours();
  const h12r = h24 % 12 || 12;
  const ampm = h24 < 12 ? 'a.m.' : 'p.m.';
  const time24 = `${pad2(h24)}-${pad2(now.getMinutes())}`;
  const time12 = `${h12r}-${pad2(now.getMinutes())} ${ampm}`;

  let name = pattern
    .replace(/%VER#%/g,   APP_VERSION)
    .replace(/%TTML%/g,   state.ttmlBaseName  || 'ttml')
    .replace(/%AUDIO%/g,  state.audioBaseName || 'audio')
    .replace(/%EXT%/g,    (state.audioExt || 'webm').toUpperCase())
    .replace(/%YEAR%/g,   now.getFullYear())
    .replace(/%MONTH%/g,  pad2(now.getMonth() + 1))
    .replace(/%DAY%/g,    pad2(now.getDate()))
    .replace(/%TIME24%/g, time24)
    .replace(/%TIME12%/g, time12)
    .replace(/%TYPEU%/g,  typeStr.toUpperCase())
    .replace(/%TYPEL%/g,  typeStr.toLowerCase())
    .replace(/%TYPE%/g,   typeStr);

  name = name.replace(/[/\\:*?"<>|]/g, '_').trim() || FILENAME_DEFAULT;
  const ext = document.getElementById('export-format')?.value || 'webm';
  return name + '.' + ext;
}

export function setPlayIcon(iconState) {
  const playIconPlay = document.getElementById('play-icon-play');
  const playIconPause= document.getElementById('play-icon-pause');
  playIconPlay.style.display  = iconState === 'play'  ? '' : 'none';
  playIconPause.style.display = iconState === 'pause' ? '' : 'none';
}

export function parseTime(str) {
  if (!str) return 0;
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
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  const r = parseInt(hex.substring(0,2),16);
  const g = parseInt(hex.substring(2,4),16);
  const b = parseInt(hex.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function syncAppleMusicPreviewClass() {
  const isAml = document.getElementById('export-style')?.value === 'aml';
  document.querySelector('.lyrics-outer')?.classList.toggle('apple-music', isAml);
  document.querySelectorAll('#lyrics-container .lyric-line')
    .forEach(el => el.classList.toggle('apple-music', isAml));
}
