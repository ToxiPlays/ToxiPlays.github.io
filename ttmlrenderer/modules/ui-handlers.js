import { state } from './state.js';
import { 
  APP_VERSION, FILENAME_KEY, FILENAME_DEFAULT, EXPORT_QUALITY_KEY, EXPORT_FORMAT_KEY, RENDER_METHOD_KEY,
  CUSTOM_QUALITY_W_KEY, CUSTOM_QUALITY_H_KEY, CUSTOM_QUALITY_FPS_KEY,
  EXPORT_QUALITY_PROFILES, THEME_KEY, PICKER_MAP, DEFAULTS, EXPORT_FORMAT_DEFAULT 
} from './constants.js';
import { 
  formatTime, resolveFilename, setPlayIcon, syncAppleMusicPreviewClass, hexToRGBA 
} from './utils.js';
import { parseTTML } from './parser.js';
import { ensureContext, startPlayback } from './audio.js';
import { seekToTime, syncLoop } from './sync.js';
import { startRender } from './renderer-scroll.js?v=3';
import { _teardownRender } from './renderer-shared.js';

export function initUI() {
  const ttmlInput  = document.getElementById('ttml-input');
  const ttmlDrop   = document.getElementById('ttml-drop');
  const audioInput = document.getElementById('audio-input');
  const audioDrop  = document.getElementById('audio-drop');
  const btnPlay    = document.getElementById('btn-play');
  const seekBar    = document.getElementById('seek-bar');
  const btnRender  = document.getElementById('btn-render');
  const cancelBtn  = document.getElementById('render-cancel');

  // --- Filename Vars ---
  initFnVars();
  initFilename();
  initExportQuality();
  initExportFormat();
  initRenderMethod();
  initContributors();
  initTheme();

  // --- TTML Upload ---
  ttmlInput.addEventListener('change', e => handleTTML(e.target.files[0]));
  ttmlDrop.addEventListener('dragover', e => { e.preventDefault(); ttmlDrop.classList.add('drag-over'); });
  ttmlDrop.addEventListener('dragleave', () => ttmlDrop.classList.remove('drag-over'));
  ttmlDrop.addEventListener('drop', e => {
    e.preventDefault();
    ttmlDrop.classList.remove('drag-over');
    handleTTML(e.dataTransfer.files[0]);
  });

  async function handleTTML(file) {
    console.log('handleTTML', file?.name);
    if (!file) return;
    state.ttmlBaseName = file.name.replace(/\.[^/.]+$/, "");
    document.getElementById('ttml-name').textContent = file.name;
    document.getElementById('ttml-name').style.display = 'block';
    document.getElementById('ttml-hint').style.display = 'none';
    const text = await file.text();
    parseTTML(text);
    checkReady();
    ttmlInput.value = '';
  }

  // --- Audio Upload ---
  audioInput.addEventListener('change', e => handleAudio(e.target.files[0]));
  audioDrop.addEventListener('dragover', e => { e.preventDefault(); audioDrop.classList.add('drag-over'); });
  audioDrop.addEventListener('dragleave', () => audioDrop.classList.remove('drag-over'));
  audioDrop.addEventListener('drop', e => {
    e.preventDefault();
    audioDrop.classList.remove('drag-over');
    handleAudio(e.dataTransfer.files[0]);
  });

  async function handleAudio(file) {
    console.log('handleAudio', file?.name);
    if (!file) return;
    document.getElementById('total-time').textContent = '?:??';
    ensureContext();
    state.audioBaseName = file.name.replace(/\.[^/.]+$/, "");
    state.audioExt = file.name.split('.').pop();
    document.getElementById('audio-name').textContent = file.name;
    document.getElementById('audio-name').style.display = 'block';
    document.getElementById('audio-hint').style.display = 'none';

    const arrayBuffer = await file.arrayBuffer();
    state.audioBuffer = await state.actx.decodeAudioData(arrayBuffer);
    state.duration = state.audioBuffer.duration;
    document.getElementById('total-time').textContent = formatTime(state.duration);
    seekBar.max = state.duration;
    seekBar.disabled = false;
    checkReady();
    audioInput.value = '';
  }

  function checkReady() {
    if (state.spans.length > 0 && state.audioBuffer) {
      btnPlay.disabled = false;
      btnRender.disabled = false;
    }
  }

  // --- Controls ---
  btnPlay.addEventListener('click', () => {
    if (state.isPlaying) {
      state.pausedAt = state.actx.currentTime - state.startedAt;
      state.sourceNode.stop();
      state.isPlaying = false;
      setPlayIcon('play');
    } else {
      startPlayback(state.pausedAt);
      setPlayIcon('pause');
      if (!state.rafId) state.rafId = requestAnimationFrame(syncLoop);
    }
  });

  seekBar.addEventListener('input', e => seekToTime(parseFloat(e.target.value)));

  // --- Render ---
  btnRender.addEventListener('click', () => {
    if (state.renderInProgress) return;
    startRender();
  });

  cancelBtn.addEventListener('click', () => {
    state.renderCancelled = true;
    _teardownRender();
    document.getElementById('render-overlay').classList.remove('active');
    document.getElementById('btn-render').classList.remove('rendering');
  });

  const styleSelect = document.getElementById('export-style');
  const iyfSettings = document.getElementById('iyf-settings');
  const karaokeSettings = document.getElementById('karaoke-settings');
  styleSelect.addEventListener('change', () => {
    iyfSettings.style.display = styleSelect.value === 'inyourface' ? '' : 'none';
    karaokeSettings.style.display = styleSelect.value === 'karaoke' ? '' : 'none';
    syncAppleMusicPreviewClass();
  });
}

function initFnVars() {
  const VARS = [
    { token: '%TTML%',   desc: 'TTML filename (no extension)' },
    { token: '%AUDIO%',  desc: 'Audio filename (no extension)' },
    { token: '%EXT%',    desc: 'Audio extension in CAPS (MP3, FLAC…)' },
    { token: '%VER#%',   desc: () => `App version (${APP_VERSION})` },
    { token: '%YEAR%',   desc: 'Current year' },
    { token: '%MONTH%',  desc: 'Current month (01–12)' },
    { token: '%DAY%',    desc: 'Current day (01–31)' },
    { token: '%TIME24%', desc: 'Export time, 24h (14:07)' },
    { token: '%TIME12%', desc: 'Export time, 12h (2:07 p.m.)' },
    { token: '%TYPE%',   desc: 'Export type: Scroll, Kar, or IYF' },
    { token: '%TYPEU%',  desc: 'Export type in ALL CAPS' },
    { token: '%TYPEL%',  desc: 'Export type in full lowercase' },
  ];

  const toggle = document.getElementById('fn-vars-toggle');
  const panel  = document.getElementById('fn-vars-panel');
  const list   = document.getElementById('fn-vars-list');
  const input  = document.getElementById('export-filename');
  if (!toggle || !panel || !list || !input) return;

  VARS.forEach(({ token, desc }) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:baseline;gap:0.5rem;padding:0.3rem 0.6rem;cursor:pointer;transition:background 0.15s;border-bottom:1px solid var(--border);';
    row.innerHTML = `
      <span style="font-family:'DM Mono',monospace;font-size:0.62rem;color:var(--accent);flex-shrink:0;letter-spacing:0.04em;">${token}</span>
      <span style="font-size:0.57rem;color:var(--text-mid);letter-spacing:0.03em;">${typeof desc === 'function' ? desc() : desc}</span>
    `;
    row.addEventListener('mouseenter', () => row.style.background = 'var(--surface)');
    row.addEventListener('mouseleave', () => row.style.background = '');
    row.addEventListener('click', () => {
      const start = input.selectionStart ?? input.value.length;
      const end   = input.selectionEnd   ?? input.value.length;
      input.value = input.value.slice(0, start) + token + input.value.slice(end);
      input.focus();
      const pos = start + token.length;
      input.setSelectionRange(pos, pos);
      input.dispatchEvent(new Event('input'));
    });
    list.appendChild(row);
  });

  let open = false;
  toggle.addEventListener('click', () => {
    open = !open;
    panel.style.display = open ? 'block' : 'none';
    toggle.textContent  = open ? 'Variables ▴' : 'Variables ▾';
    toggle.style.borderColor = open ? 'var(--accent)' : 'var(--border)';
    toggle.style.color        = open ? 'var(--accent)' : 'var(--text-mid)';
  });

  document.addEventListener('click', (e) => {
    if (open && !panel.contains(e.target) && e.target !== toggle) {
      open = false;
      panel.style.display = 'none';
      toggle.textContent  = 'Variables ▾';
      toggle.style.borderColor = 'var(--border)';
      toggle.style.color        = 'var(--text-mid)';
    }
  });
}

function initFilename() {
  document.querySelectorAll('#app-version-display').forEach(el => { el.textContent = APP_VERSION; });
  const input   = document.getElementById('export-filename');
  const preview = document.getElementById('filename-preview');
  if (!input) return;

  try {
    const saved = localStorage.getItem(FILENAME_KEY);
    if (saved !== null) input.value = saved;
  } catch(e) {}

  input.addEventListener('input', () => {
    try { localStorage.setItem(FILENAME_KEY, input.value); } catch(e) {}
    updatePreview();
  });

  function updatePreview() {
    if (!preview) return;
    const val = input.value;
    const hasTwoPercents = (val.match(/%/g) || []).length >= 2;
    const bothFilesLoaded = state.ttmlBaseName && state.audioBaseName;
    if (!hasTwoPercents || !bothFilesLoaded) { preview.style.display = 'none'; return; }
    const styleVal = document.getElementById('export-style')?.value || 'birdseye';
    const typeMap  = { birdseye: 'scroll', karaoke: 'karaoke', inyourface: 'iyf', aml: 'aml' };
    const resolved = resolveFilename(typeMap[styleVal] || 'scroll', new Date());
    preview.textContent = '→ ' + resolved;
    preview.style.display = 'block';
  }

  input.addEventListener('mouseenter', updatePreview);
  input.addEventListener('mouseleave', () => { if (preview) preview.style.display = 'none'; });
  input.addEventListener('input', () => { if (preview && preview.style.display !== 'none') updatePreview(); });
  document.getElementById('export-style')?.addEventListener('change', () => { if (preview && preview.style.display !== 'none') updatePreview(); });
  document.getElementById('export-format')?.addEventListener('change', () => { if (preview && preview.style.display !== 'none') updatePreview(); });
}

function initExportQuality() {
  const select = document.getElementById('export-quality');
  const customGroup = document.getElementById('custom-quality-group');
  const customW = document.getElementById('custom-q-w');
  const customH = document.getElementById('custom-q-h');
  const customFPS = document.getElementById('custom-q-fps');

  const updateCustomVisibility = () => {
    customGroup.style.display = select.value === 'custom' ? 'block' : 'none';
  };

  try {
    const saved = localStorage.getItem(EXPORT_QUALITY_KEY);
    if (saved) {
      if (EXPORT_QUALITY_PROFILES[saved] || saved === 'custom') {
        select.value = saved;
      }
    }
    // Restore custom values
    const sW = localStorage.getItem(CUSTOM_QUALITY_W_KEY);
    const sH = localStorage.getItem(CUSTOM_QUALITY_H_KEY);
    const sF = localStorage.getItem(CUSTOM_QUALITY_FPS_KEY);
    if (sW) customW.value = sW;
    if (sH) customH.value = sH;
    if (sF) customFPS.value = sF;
  } catch (_) {}

  updateCustomVisibility();

  select.addEventListener('change', () => {
    try { localStorage.setItem(EXPORT_QUALITY_KEY, select.value); } catch (_) {}
    updateCustomVisibility();
  });

  [customW, customH, customFPS].forEach(el => {
    el.addEventListener('input', () => {
      try {
        localStorage.setItem(CUSTOM_QUALITY_W_KEY, customW.value);
        localStorage.setItem(CUSTOM_QUALITY_H_KEY, customH.value);
        localStorage.setItem(CUSTOM_QUALITY_FPS_KEY, customFPS.value);
      } catch (_) {}
    });
  });
}

function initExportFormat() {
  const select = document.getElementById('export-format');
  if (!select) return;

  try {
    const saved = localStorage.getItem(EXPORT_FORMAT_KEY);
    if (saved && ['webm', 'mp4'].includes(saved)) select.value = saved;
  } catch (_) {}

  select.addEventListener('change', () => {
    try { localStorage.setItem(EXPORT_FORMAT_KEY, select.value); } catch (_) {}
  });
}

function initRenderMethod() {
  const group  = document.getElementById('render-method-group');
  const select = document.getElementById('render-method');
  if (!group || !select) return;

  // Hide entirely if WebCodecs is not available in this browser
  const webCodecsAvailable = (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame   !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof AudioData    !== 'undefined'
  );
  if (!webCodecsAvailable) {
    group.style.display = 'none';
    return;
  }

  try {
    const saved = localStorage.getItem(RENDER_METHOD_KEY);
    if (saved && ['fast', 'screen'].includes(saved)) select.value = saved;
  } catch (_) {}

  select.addEventListener('change', () => {
    try { localStorage.setItem(RENDER_METHOD_KEY, select.value); } catch (_) {}
  });
}

function initContributors() {
  const contribBtn = document.getElementById('contributors-btn');
  const contribMenu = document.getElementById('contributors-menu');
  contribBtn.addEventListener('click', (e) => { e.stopPropagation(); contribMenu.classList.toggle('open'); });
  document.addEventListener('click', () => contribMenu.classList.remove('open'));
  contribMenu.addEventListener('click', (e) => e.stopPropagation());
}

function initTheme() {
  const glowStyleEl = document.createElement('style');
  glowStyleEl.id = 'dynamic-glow';
  document.head.appendChild(glowStyleEl);

  function syncAccentDerived(color) {
    document.documentElement.style.setProperty('--active-word', color);
    document.documentElement.style.setProperty('--active-line', hexToRGBA(color, 0.06));
    glowStyleEl.textContent = `
      .lyric-span.active { text-shadow: 0 0 20px ${hexToRGBA(color, 0.4)} !important; }
      .lyric-span.active.long-word {
        animation: word-jitter 60ms linear forwards, float-up var(--word-dur, 0.3s) cubic-bezier(0.22, 1, 0.36, 1) forwards 60ms, word-glow-dynamic 0.8s ease-in-out infinite 60ms !important;
      }
      @keyframes word-glow-dynamic {
        0%   { text-shadow: 0 0 10px ${hexToRGBA(color, 0.5)}; }
        50%  { text-shadow: 0 0 30px ${hexToRGBA(color, 0.9)}, 0 0 60px ${hexToRGBA(color, 0.4)}; }
        100% { text-shadow: 0 0 10px ${hexToRGBA(color, 0.5)}; }
      }
    `;
  }

  function applyColor(cssVar, hexVal, pickerId) {
    document.documentElement.style.setProperty(cssVar, hexVal);
    document.getElementById(pickerId).value = hexVal;
    const hexEl = document.getElementById(pickerId.replace('pick-','hex-'));
    if (hexEl) hexEl.value = hexVal;
    if (cssVar === '--accent') syncAccentDerived(hexVal);
    saveTheme();
  }

  function saveTheme() {
    const theme = {};
    Object.values(PICKER_MAP).forEach(prop => {
      theme[prop] = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    });
    localStorage.setItem(THEME_KEY, JSON.stringify(theme));
  }

  function bindPicker(pickerId, cssVar) {
    const hexId = pickerId.replace('pick-','hex-');
    document.getElementById(pickerId).addEventListener('input', (e) => applyColor(cssVar, e.target.value, pickerId));
    const hexInput = document.getElementById(hexId);
    hexInput.addEventListener('input', (e) => {
      let val = e.target.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) applyColor(cssVar, val, pickerId);
    });
    hexInput.addEventListener('blur', (e) => {
      let val = e.target.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9a-fA-F]{3}$/.test(val)) {
        val = '#'+val[1]+val[1]+val[2]+val[2]+val[3]+val[3];
        applyColor(cssVar, val, pickerId);
      }
    });
  }

  Object.entries(PICKER_MAP).forEach(([pickerId, cssVar]) => bindPicker(pickerId, cssVar));

  try {
    const saved = JSON.parse(localStorage.getItem(THEME_KEY));
    if (saved) {
      Object.entries(saved).forEach(([prop, val]) => document.documentElement.style.setProperty(prop, val));
      Object.entries(PICKER_MAP).forEach(([pickerId, cssVar]) => {
        if (saved[cssVar]) {
          document.getElementById(pickerId).value = saved[cssVar];
          const hexEl = document.getElementById(pickerId.replace('pick-','hex-'));
          if (hexEl) hexEl.value = saved[cssVar];
        }
      });
      if (saved['--accent']) syncAccentDerived(saved['--accent']);
    }
  } catch(e) {}

  document.getElementById('btn-design').addEventListener('click', () => document.getElementById('design-panel').classList.toggle('active'));
  document.getElementById('design-close').addEventListener('click', () => document.getElementById('design-panel').classList.remove('active'));
  document.getElementById('design-reset').addEventListener('click', () => {
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(FILENAME_KEY);
    localStorage.removeItem(EXPORT_QUALITY_KEY);
    localStorage.removeItem(EXPORT_FORMAT_KEY);
    localStorage.removeItem(RENDER_METHOD_KEY);
    localStorage.removeItem(CUSTOM_QUALITY_W_KEY);
    localStorage.removeItem(CUSTOM_QUALITY_H_KEY);
    localStorage.removeItem(CUSTOM_QUALITY_FPS_KEY);
    Object.entries(DEFAULTS).forEach(([prop, val]) => document.documentElement.style.setProperty(prop, val));
    Object.entries(PICKER_MAP).forEach(([pickerId, cssVar]) => {
      document.getElementById(pickerId).value = DEFAULTS[cssVar];
      document.getElementById(pickerId.replace('pick-','hex-')).value = DEFAULTS[cssVar];
    });
    syncAccentDerived(DEFAULTS['--accent']);
    const fnInput = document.getElementById('export-filename');
    if (fnInput) fnInput.value = FILENAME_DEFAULT;
    const qSel = document.getElementById('export-quality');
    if (qSel) qSel.value = 'high';
    const fSel = document.getElementById('export-format');
    if (fSel) fSel.value = EXPORT_FORMAT_DEFAULT;
  });
}
