import { state } from './state.js';
import { formatTime } from './utils.js';
import { startPlayback } from './audio.js';

let _previewCanvas, _previewCtx, _previewLastMs = 0;
const PREVIEW_THROTTLE_MS = 10000;

export function initPreview(canvasId) {
  _previewCanvas = document.getElementById(canvasId);
  if (_previewCanvas) {
    _previewCtx = _previewCanvas.getContext('2d');
  }
}

export function updateRenderPreview(src, force = false) {
  if (!_previewCtx) return;
  const now = performance.now();
  if (!force && now - _previewLastMs < PREVIEW_THROTTLE_MS) return;
  _previewLastMs = now;
  _previewCtx.drawImage(src, 0, 0, _previewCanvas.width, _previewCanvas.height);
}

export function clearRenderPreview() {
  if (!_previewCtx) return;
  _previewCtx.clearRect(0, 0, _previewCanvas.width, _previewCanvas.height);
}

export function seekToTime(t) {
  state.pausedAt = Math.max(0, Math.min(t, state.duration));
  state.activeSpanSet = new Set();
  state.activeLineSet = new Set();
  
  // Reset highlights
  state.spans.forEach(s => {
    s.el.classList.remove('active', 'long-word');
    if (s.el.querySelector('.lyric-letter')) {
      s.el.textContent = s.el.textContent;
    }
    if (s.end <= state.pausedAt) s.el.classList.add('past');
    else s.el.classList.remove('past');
  });
  
  state.lines.forEach(l => l.el.classList.remove('active-line'));
  state.breakBars.forEach(b => {
    b.fillEl.style.width = '0%';
    b.el.style.opacity = '0.3';
  });
  
  const seekBar = document.getElementById('seek-bar');
  const currentTime = document.getElementById('current-time');
  if (seekBar) seekBar.value = state.pausedAt;
  if (currentTime) currentTime.textContent = formatTime(state.pausedAt);
  
  if (state.isPlaying) {
    startPlayback(state.pausedAt, onPlaybackEnded);
  }
}

function onPlaybackEnded() {
  state.isPlaying = false;
  state.pausedAt = 0;
  // This will be coordinated by the main app/ui module
  const btnPlay = document.getElementById('btn-play');
  if (btnPlay) {
    // We'll need a way to update the icon, maybe a custom event?
    btnPlay.dispatchEvent(new CustomEvent('playback-ended'));
  }
}

export function syncLoop() {
  const t = state.isPlaying ? (state.actx.currentTime - state.startedAt) : state.pausedAt;

  // Spans
  const newActiveSpans = new Set();
  for (let i = 0; i < state.spans.length; i++) {
    if (t >= state.spans[i].begin && t < state.spans[i].end) newActiveSpans.add(i);
  }

  for (const i of state.activeSpanSet) {
    if (!newActiveSpans.has(i)) {
      state.spans[i].el.classList.remove('active', 'long-word');
      if (t >= state.spans[i].end) {
        state.spans[i].el.classList.add('past');
        if (state.spans[i].el.querySelector('.lyric-letter')) {
          state.spans[i].el.textContent = state.spans[i].el.textContent;
        }
      }
    }
  }

  for (const i of newActiveSpans) {
    if (!state.activeSpanSet.has(i)) {
      const s = state.spans[i];
      s.el.classList.add('active');
      s.el.classList.remove('past');
      if (s.isLong) {
        s.el.classList.add('long-word');
        const text = s.el.textContent;
        s.el.innerHTML = '';
        [...text].forEach((char, idx) => {
          const letterEl = document.createElement('span');
          letterEl.className = 'lyric-letter';
          letterEl.textContent = char;
          letterEl.style.setProperty('--letter-index', idx);
          s.el.appendChild(letterEl);
        });
      }
      
      const lineEntry = state.lines.find(l => l.el === s.lineEl);
      if (!lineEntry || !lineEntry.skipRetroactive) {
        for (let j = 0; j < i; j++) {
          if (state.spans[j].lineEl === s.lineEl && !newActiveSpans.has(j)) {
            state.spans[j].el.classList.remove('active', 'long-word');
            state.spans[j].el.classList.add('past');
          }
        }
      }
    }
  }
  state.activeSpanSet = newActiveSpans;

  // Lines
  const newActiveLines = new Set();
  for (let i = 0; i < state.lines.length; i++) {
    if (t >= state.lines[i].begin && t < state.lines[i].end) newActiveLines.add(i);
  }

  for (const i of state.activeLineSet) {
    if (!newActiveLines.has(i)) {
      state.lines[i].el.classList.remove('active-line');
    }
  }

  let scrollTarget = null;
  for (const i of newActiveLines) {
    if (!state.activeLineSet.has(i)) {
      state.lines[i].el.classList.add('active-line');
      if (scrollTarget === null) {
        const isAdlib = state.lines[i].el.classList.contains('adlib');
        const hasActiveNonAdlib = [...newActiveLines].some(
          j => j !== i && !state.lines[j].el.classList.contains('adlib')
        );
        if (!isAdlib || !hasActiveNonAdlib) {
          scrollTarget = state.lines[i].el;
        }
      }
    }
  }

  if (scrollTarget) {
    const container = document.getElementById('lyrics-container');
    const containerRect = container.getBoundingClientRect();
    const lineRect = scrollTarget.getBoundingClientRect();
    const offset = lineRect.top - containerRect.top - (container.clientHeight / 2) + (lineRect.height / 2);
    container.scrollTop += offset;
  }
  state.activeLineSet = newActiveLines;

  // Break bars
  for (const bar of state.breakBars) {
    if (t >= bar.start && t <= bar.end) {
      const pct = ((t - bar.start) / bar.gap) * 100;
      bar.fillEl.style.width = pct.toFixed(2) + '%';
      bar.el.style.opacity = '1';
    } else if (t > bar.end) {
      bar.fillEl.style.width = '100%';
      bar.el.style.opacity = '0.3';
    } else {
      bar.fillEl.style.width = '0%';
      bar.el.style.opacity = '0.3';
    }
  }

  // Progress UI
  if (state.duration > 0) {
    const seekBar = document.getElementById('seek-bar');
    const currentTime = document.getElementById('current-time');
    if (seekBar) seekBar.value = t;
    if (currentTime) currentTime.textContent = formatTime(t);
  }

  state.rafId = requestAnimationFrame(syncLoop);
}
