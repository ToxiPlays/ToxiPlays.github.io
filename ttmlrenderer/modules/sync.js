import { state } from './state.js';
import { formatTime, setPlayIcon } from './utils.js';
import { startPlayback } from './audio.js';

export function seekToTime(t) {
  state.pausedAt = Math.max(0, Math.min(t, state.duration));
  state.activeSpanSet = new Set();
  state.activeLineSet = new Set();
  
  state.spans.forEach(s => {
    s.el.classList.remove('active', 'long-word');
    if (s.el.querySelector('.lyric-letter')) {
      s.el.textContent = s.el.textContent;
    }
    if (s.end <= state.pausedAt) s.el.classList.add('past');
    else s.el.classList.remove('past');
  });
  state.lines.forEach(l => l.el.classList.remove('active-line'));
  state.breakBars.forEach(b => { b.fillEl.style.width = '0%'; b.el.style.opacity = '0.3'; });
  
  document.getElementById('seek-bar').value = state.pausedAt;
  document.getElementById('current-time').textContent = formatTime(state.pausedAt);
  if (state.isPlaying) startPlayback(state.pausedAt);
}

export function syncLoop() {
  const t = state.isPlaying ? (state.actx.currentTime - state.startedAt) : state.pausedAt;

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

  if (state.duration > 0) {
    document.getElementById('seek-bar').value = t;
    document.getElementById('current-time').textContent = formatTime(t);
  }

  state.rafId = requestAnimationFrame(syncLoop);
}
