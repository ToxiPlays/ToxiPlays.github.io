import { state } from './state.js';
import { APP_VERSION, FILENAME_KEY, FILENAME_DEFAULT, EXPORT_QUALITY_KEY, EXPORT_QUALITY_PROFILES, THEME_KEY, DEFAULTS, PICKER_MAP, OVERLAP_WARNING_MSG } from './constants.js';
import { formatTime, hexToRGBA, resolveFilename } from './utils.js';
import { decodeAudio, startPlayback, stopPlayback } from './audio.js';
import { parseTTML } from './parser.js';
import { seekToTime, syncLoop, clearRenderPreview } from './preview.js';
import { startRender, cancelRender } from './exporter.js';

export function initUI() {
  initPlayerControls();
  initFileUploads();
  initThemeCustomizer();
  initFilenamePanel();
  initExportSettings();
  initContributors();
  
  // Set version display
  document.querySelectorAll('#app-version-display').forEach(el => { el.textContent = APP_VERSION; });
}

function initPlayerControls() {
  const btnPlay = document.getElementById('btn-play');
  const seekBar = document.getElementById('seek-bar');
  const btnRender = document.getElementById('btn-render');
  const renderCancel = document.getElementById('render-cancel');

  btnPlay.addEventListener('click', () => {
    if (state.isPlaying) {
      stopPlayback();
      updatePlayIcon(false);
    } else {
      startPlayback(state.pausedAt, () => {
        stopPlayback();
        state.pausedAt = 0;
        updatePlayIcon(false);
      });
      updatePlayIcon(true);
      if (state.rafId === null) syncLoop();
    }
  });

  btnPlay.addEventListener('playback-ended', () => {
    updatePlayIcon(false);
  });

  seekBar.addEventListener('input', () => {
    seekToTime(parseFloat(seekBar.value));
  });

  btnRender.addEventListener('click', () => {
    if (state.renderInProgress) return;
    
    // Check for overlap
    const hasOverlap = state.spans.some(s => s.el.textContent.includes(';'));
    if (hasOverlap && document.getElementById('export-style').value !== 'birdseye') {
      showOverlapWarning();
    } else {
      beginRenderFlow();
    }
  });

  renderCancel.addEventListener('click', () => {
    cancelRender();
    document.getElementById('render-overlay').classList.remove('active');
    btnRender.classList.remove('rendering');
  });
}

function updatePlayIcon(playing) {
  document.getElementById('play-icon-play').style.display = playing ? 'none' : 'block';
  document.getElementById('play-icon-pause').style.display = playing ? 'block' : 'none';
}

function initFileUploads() {
  const ttmlInput = document.getElementById('ttml-input');
  const audioInput = document.getElementById('audio-input');

  setupDropZone('ttml-drop', ttmlInput, handleTTML);
  setupDropZone('audio-drop', audioInput, handleAudio);

  ttmlInput.addEventListener('change', e => handleTTML(e.target.files[0]));
  audioInput.addEventListener('change', e => handleAudio(e.target.files[0]));
}

function setupDropZone(id, input, handler) {
  const zone = document.getElementById(id);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag');
    if (e.dataTransfer.files.length) handler(e.dataTransfer.files[0]);
  });
  zone.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
}

async function handleTTML(file) {
  if (!file) return;
  state.ttmlBaseName = file.name.replace(/\.[^/.]+$/, "");
  const text = await file.text();
  parseTTML(text, document.getElementById('lyrics-container'), seekToTime);
  document.getElementById('ttml-name').textContent = file.name;
  document.getElementById('ttml-name').style.display = 'block';
  document.getElementById('ttml-hint').style.display = 'none';
  checkReady();
}

async function handleAudio(file) {
  if (!file) return;
  state.audioBaseName = file.name.replace(/\.[^/.]+$/, "");
  state.audioExt = file.name.split('.').pop();
  
  const loadingMsg = document.createElement('div');
  loadingMsg.className = 'audio-loading';
  loadingMsg.textContent = 'Decoding audio…';
  document.getElementById('audio-hint').style.display = 'none';
  document.getElementById('audio-drop').appendChild(loadingMsg);

  try {
    const buffer = await file.arrayBuffer();
    await decodeAudio(buffer);
    document.getElementById('audio-name').textContent = file.name;
    document.getElementById('audio-name').style.display = 'block';
    loadingMsg.remove();
    
    const seekBar = document.getElementById('seek-bar');
    const totalTime = document.getElementById('total-time');
    seekBar.max = state.duration;
    totalTime.textContent = formatTime(state.duration);
    checkReady();
  } catch (e) {
    loadingMsg.textContent = 'Error decoding audio';
    console.error(e);
  }
}

function checkReady() {
  const ready = state.spans.length > 0 && state.audioBuffer;
  document.getElementById('btn-play').disabled = !ready;
  document.getElementById('btn-render').disabled = !ready;
  document.getElementById('seek-bar').disabled = !ready;
}

function beginRenderFlow() {
  const styleSelect = document.getElementById('export-style');
  const qualitySelect = document.getElementById('export-quality');
  const profile = EXPORT_QUALITY_PROFILES[qualitySelect.value] || EXPORT_QUALITY_PROFILES.high;

  const overlay = document.getElementById('render-overlay');
  const barFill = document.getElementById('render-bar-fill');
  const renderSub = document.getElementById('render-sub');
  const btnRender = document.getElementById('btn-render');

  const engineSelect = document.getElementById('export-engine');
  const formatSelect = document.getElementById('export-format');

  const bitrateInput = document.getElementById('export-bitrate-input');

  overlay.classList.add('active');
  btnRender.classList.add('rendering');
  
  startRender({
    engine: engineSelect.value,
    format: formatSelect.value,
    activeStyle: styleSelect.value,
    width: profile.width,
    height: profile.height,
    fps: profile.fps,
    videoBitsPerSecond: parseInt(bitrateInput.value) * 1_000_000,
    ignoreAdlibs: document.getElementById('karaoke-ignore-adlibs')?.checked,
    iyfCasing: document.getElementById('iyf-casing')?.value,
    iyfShowProgress: document.getElementById('iyf-show-progress')?.checked,
    onProgress: (p) => {
      barFill.style.width = p.percent.toFixed(1) + '%';
      renderSub.textContent = formatTime(p.t) + ' / ' + formatTime(p.duration);
    },
    onComplete: () => {
      overlay.classList.remove('active');
      btnRender.classList.remove('rendering');
    }
  });
}

function showOverlapWarning() {
  const overlay = document.getElementById('overlap-warning-overlay');
  const body = document.getElementById('overlap-warning-body');
  const cancelBtn = document.getElementById('overlap-cancel-btn');
  const confirmBtn = document.getElementById('overlap-confirm-btn');

  body.textContent = OVERLAP_WARNING_MSG;
  overlay.style.display = 'flex';

  const close = () => { overlay.style.display = 'none'; };
  cancelBtn.onclick = close;
  confirmBtn.onclick = () => { close(); beginRenderFlow(); };
}

function initThemeCustomizer() {
  const designPanel = document.getElementById('design-panel');
  const designClose = document.getElementById('design-close');
  const btnDesign = document.getElementById('btn-design');
  const designReset = document.getElementById('design-reset');

  btnDesign.addEventListener('click', () => designPanel.classList.toggle('active'));
  designClose.addEventListener('click', () => designPanel.classList.remove('active'));

  // Load saved theme
  try {
    const saved = JSON.parse(localStorage.getItem(THEME_KEY));
    if (saved) {
      Object.entries(saved).forEach(([prop, val]) => {
        document.documentElement.style.setProperty(prop, val);
      });
      Object.entries(PICKER_MAP).forEach(([pickerId, cssVar]) => {
        if (saved[cssVar]) {
          const picker = document.getElementById(pickerId);
          if (picker) picker.value = saved[cssVar];
          const hexEl = document.getElementById(pickerId.replace('pick-', 'hex-'));
          if (hexEl) hexEl.value = saved[cssVar];
        }
      });
      if (saved['--accent']) syncAccentDerived(saved['--accent']);
    }
  } catch (e) {}

  // Bind pickers
  Object.entries(PICKER_MAP).forEach(([pickerId, cssVar]) => {
    const picker = document.getElementById(pickerId);
    const hexInput = document.getElementById(pickerId.replace('pick-', 'hex-'));
    if (!picker || !hexInput) return;

    picker.addEventListener('input', (e) => applyColor(cssVar, e.target.value, pickerId));
    
    hexInput.addEventListener('input', (e) => {
      let val = e.target.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) applyColor(cssVar, val, pickerId);
    });

    hexInput.addEventListener('blur', (e) => {
      let val = e.target.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9a-fA-F]{3}$/.test(val)) {
        val = '#' + val[1] + val[1] + val[2] + val[2] + val[3] + val[3];
        applyColor(cssVar, val, pickerId);
      }
    });
  });

  designReset.addEventListener('click', () => {
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(FILENAME_KEY);
    localStorage.removeItem(EXPORT_QUALITY_KEY);
    Object.entries(DEFAULTS).forEach(([prop, val]) => {
      document.documentElement.style.setProperty(prop, val);
    });
    Object.entries(PICKER_MAP).forEach(([pickerId, cssVar]) => {
      const picker = document.getElementById(pickerId);
      const hexEl = document.getElementById(pickerId.replace('pick-', 'hex-'));
      if (picker) picker.value = DEFAULTS[cssVar];
      if (hexEl) hexEl.value = DEFAULTS[cssVar];
    });
    syncAccentDerived(DEFAULTS['--accent']);
    const fnInput = document.getElementById('export-filename');
    if (fnInput) fnInput.value = FILENAME_DEFAULT;
    const qualitySelect = document.getElementById('export-quality');
    if (qualitySelect) qualitySelect.value = 'high';
  });
}

function applyColor(cssVar, hexVal, pickerId) {
  document.documentElement.style.setProperty(cssVar, hexVal);
  document.getElementById(pickerId).value = hexVal;
  const hexEl = document.getElementById(pickerId.replace('pick-', 'hex-'));
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

function syncAccentDerived(color) {
  document.documentElement.style.setProperty('--active-word', color);
  document.documentElement.style.setProperty('--active-line', hexToRGBA(color, 0.06));
  
  let glowStyleEl = document.getElementById('dynamic-glow-style');
  if (!glowStyleEl) {
    glowStyleEl = document.createElement('style');
    glowStyleEl.id = 'dynamic-glow-style';
    document.head.appendChild(glowStyleEl);
  }
  
  glowStyleEl.textContent = `
    .lyric-span.active {
      text-shadow: 0 0 20px ${hexToRGBA(color, 0.4)} !important;
    }
    .lyric-span.active.long-word {
      animation:
        word-jitter 60ms linear forwards,
        float-up var(--word-dur, 0.3s) cubic-bezier(0.22, 1, 0.36, 1) forwards 60ms,
        word-glow-dynamic 0.8s ease-in-out infinite 60ms !important;
    }
    @keyframes word-glow-dynamic {
      0%   { text-shadow: 0 0 10px ${hexToRGBA(color, 0.5)}; }
      50%  { text-shadow: 0 0 30px ${hexToRGBA(color, 0.9)}, 0 0 60px ${hexToRGBA(color, 0.4)}; }
      100% { text-shadow: 0 0 10px ${hexToRGBA(color, 0.5)}; }
    }
  `;
}

function initFilenamePanel() {
  const input = document.getElementById('export-filename');
  const preview = document.getElementById('filename-preview');
  const toggle = document.getElementById('fn-vars-toggle');
  const panel = document.getElementById('fn-vars-panel');
  const list = document.getElementById('fn-vars-list');

  if (!input || !preview) return;

  try {
    const saved = localStorage.getItem(FILENAME_KEY);
    if (saved !== null) input.value = saved;
  } catch (e) {}

  const updatePreview = () => {
    const val = input.value;
    const hasTwoPercents = (val.match(/%/g) || []).length >= 2;
    const bothFilesLoaded = state.ttmlBaseName && state.audioBaseName;
    if (!hasTwoPercents || !bothFilesLoaded) {
      preview.style.display = 'none';
      return;
    }
    const styleVal = document.getElementById('export-style')?.value || 'birdseye';
    const typeMap = { birdseye: 'scroll', karaoke: 'karaoke', inyourface: 'iyf', aml: 'aml' };
    const resolved = resolveFilename(typeMap[styleVal] || 'scroll', new Date(), {
      ttmlBaseName: state.ttmlBaseName,
      audioBaseName: state.audioBaseName,
      audioExt: state.audioExt,
      pattern: input.value
    });
    preview.textContent = '→ ' + resolved;
    preview.style.display = 'block';
  };

  input.addEventListener('input', () => {
    localStorage.setItem(FILENAME_KEY, input.value);
    if (preview.style.display !== 'none') updatePreview();
  });
  input.addEventListener('mouseenter', updatePreview);
  input.addEventListener('mouseleave', () => { preview.style.display = 'none'; });

  // Variables list
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

  VARS.forEach(({ token, desc }) => {
    const row = document.createElement('div');
    row.className = 'fn-var-row';
    row.style.cssText = 'display:flex;align-items:baseline;gap:0.5rem;padding:0.3rem 0.6rem;cursor:pointer;transition:background 0.15s;border-bottom:1px solid var(--border);';
    row.innerHTML = `
      <span style="font-family:'DM Mono',monospace;font-size:0.62rem;color:var(--accent);flex-shrink:0;letter-spacing:0.04em;">${token}</span>
      <span style="font-size:0.57rem;color:var(--text-mid);letter-spacing:0.03em;">${typeof desc === 'function' ? desc() : desc}</span>
    `;
    row.addEventListener('mouseenter', () => row.style.background = 'var(--surface)');
    row.addEventListener('mouseleave', () => row.style.background = '');
    row.addEventListener('click', () => {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + token + input.value.slice(end);
      input.focus();
      const pos = start + token.length;
      input.setSelectionRange(pos, pos);
      input.dispatchEvent(new Event('input'));
    });
    list.appendChild(row);
  });

  let varsOpen = false;
  toggle.addEventListener('click', () => {
    varsOpen = !varsOpen;
    panel.style.display = varsOpen ? 'block' : 'none';
    toggle.textContent = varsOpen ? 'Variables ▴' : 'Variables ▾';
    toggle.style.borderColor = varsOpen ? 'var(--accent)' : 'var(--border)';
    toggle.style.color = varsOpen ? 'var(--accent)' : 'var(--text-mid)';
  });

  document.addEventListener('click', (e) => {
    if (varsOpen && !panel.contains(e.target) && e.target !== toggle) {
      varsOpen = false;
      panel.style.display = 'none';
      toggle.textContent = 'Variables ▾';
      toggle.style.borderColor = 'var(--border)';
      toggle.style.color = 'var(--text-mid)';
    }
  });
}

function initExportSettings() {
  const styleSelect = document.getElementById('export-style');
  const qualitySelect = document.getElementById('export-quality');
  const engineSelect = document.getElementById('export-engine');
  const formatSelect = document.getElementById('export-format');
  const bitrateSlider = document.getElementById('export-bitrate-slider');
  const bitrateInput = document.getElementById('export-bitrate-input');
  const bitrateDisplay = document.getElementById('bitrate-display');
  const iyfSettings = document.getElementById('iyf-settings');
  const karaokeSettings = document.getElementById('karaoke-settings');

  const syncSettings = () => {
    iyfSettings.style.display = styleSelect.value === 'inyourface' ? '' : 'none';
    karaokeSettings.style.display = styleSelect.value === 'karaoke' ? '' : 'none';
    
    // Apple music class toggle for preview
    const container = document.getElementById('lyrics-container');
    if (styleSelect.value === 'aml') container.classList.add('apple-music');
    else container.classList.remove('apple-music');
  };

  const updateBitrateUI = (mbps) => {
    bitrateSlider.value = mbps;
    bitrateInput.value = mbps;
    bitrateDisplay.textContent = mbps + ' Mbps';
  };

  styleSelect.addEventListener('change', syncSettings);
  syncSettings();

  qualitySelect.addEventListener('change', () => {
    const prof = EXPORT_QUALITY_PROFILES[qualitySelect.value];
    if (prof) {
      updateBitrateUI(Math.round(prof.videoBitsPerSecond / 1_000_000));
      localStorage.setItem(EXPORT_QUALITY_KEY, qualitySelect.value);
    }
  });

  const onBitrateAction = (val) => {
    const mbps = Math.max(1, Math.min(100, parseInt(val) || 1));
    updateBitrateUI(mbps);
    localStorage.setItem('ttml-renderer-bitrate', mbps);
  };
  bitrateSlider.addEventListener('input', (e) => onBitrateAction(e.target.value));
  bitrateInput.addEventListener('change', (e) => onBitrateAction(e.target.value));

  try {
    const savedQ = localStorage.getItem(EXPORT_QUALITY_KEY);
    if (savedQ && EXPORT_QUALITY_PROFILES[savedQ]) {
      qualitySelect.value = savedQ;
    }
    
    const savedB = localStorage.getItem('ttml-renderer-bitrate');
    if (savedB) {
      updateBitrateUI(parseInt(savedB));
    } else {
      const prof = EXPORT_QUALITY_PROFILES[qualitySelect.value];
      updateBitrateUI(Math.round(prof.videoBitsPerSecond / 1_000_000));
    }

    const savedE = localStorage.getItem('export-engine');
    if (savedE) engineSelect.value = savedE;
    
    const savedF = localStorage.getItem('export-format');
    if (savedF) formatSelect.value = savedF;
  } catch (_) {}

  engineSelect.addEventListener('change', () => {
    localStorage.setItem('export-engine', engineSelect.value);
  });
  formatSelect.addEventListener('change', () => {
    localStorage.setItem('export-format', formatSelect.value);
  });
}

function initContributors() {
  const btn = document.getElementById('contributors-btn');
  const menu = document.getElementById('contributors-menu');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));
  menu.addEventListener('click', (e) => e.stopPropagation());
}
