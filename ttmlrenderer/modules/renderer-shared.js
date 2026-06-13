import { state } from './state.js';
import { OVERLAP_WARNING_MSG } from './constants.js';

export function _teardownRender() {
  if (state.stableRecorder) {
    try { if (state.stableRecorder.state !== 'inactive') state.stableRecorder.stop(); } catch(_) {}
    state.stableRecorder = null;
  }
  if (state.stableAudioCtx) {
    try { state.stableAudioCtx.close(); } catch(_) {}
    state.stableAudioCtx = null;
  }
  state.renderInProgress = false;
}

export function checkOverlappingTiming(renderType) {
  if (renderType === 'birdseye') return false;

  let hasSpanOverlap = false;
  for (const l of state.lines) {
    const lineSpans = state.spans.filter(s => s.lineEl === l.el)
      .sort((a, b) => a.begin - b.begin);
    for (let i = 0; i < lineSpans.length - 1; i++) {
      if (lineSpans[i].end > lineSpans[i + 1].begin + 0.001) {
        hasSpanOverlap = true;
        break;
      }
    }
    if (hasSpanOverlap) break;
  }

  if (renderType === 'karaoke') return hasSpanOverlap;

  if (renderType === 'inyourface') {
    if (hasSpanOverlap) return true;
    const nonAdlibLines = state.lines
      .filter(l => !l.el.classList.contains('adlib'))
      .sort((a, b) => a.begin - b.begin);
    for (let i = 0; i < nonAdlibLines.length; i++) {
      const a = nonAdlibLines[i];
      let concurrent = 1;
      for (let j = i + 1; j < nonAdlibLines.length; j++) {
        const b = nonAdlibLines[j];
        if (b.begin >= a.end) break;
        if (Math.min(a.end, b.end) - b.begin > 1.0) {
          if (++concurrent > 2) return true;
        }
      }
    }
  }

  return false;
}

export function showOverlapWarning() {
  return new Promise(resolve => {
    const overlay   = document.getElementById('overlap-warning-overlay');
    const body      = document.getElementById('overlap-warning-body');
    const btnOk     = document.getElementById('overlap-confirm-btn');
    const btnCancel = document.getElementById('overlap-cancel-btn');

    overlay.style.display = 'flex';
    body.innerHTML = OVERLAP_WARNING_MSG.replace(/\n\n/g, '<br><br>');
    overlay.classList.add('visible');

    function cleanup(result) {
      overlay.classList.remove('visible');
      overlay.style.display = 'none';
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk()     { cleanup(true);  }
    function onCancel() { cleanup(false); }
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
  });
}
