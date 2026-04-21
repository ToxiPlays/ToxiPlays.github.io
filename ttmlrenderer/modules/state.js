/**
 * Centralized state for the TTML Renderer application.
 */
export const state = {
  // Lyrics data
  spans: [],      // { el, begin, end, duration, isLong, lineEl }
  lines: [],      // { el, begin, end, skipRetroactive }
  breakBars: [],  // { el, fillEl, start, end, gap }

  // File info
  ttmlBaseName: '',
  audioBaseName: '',
  audioExt: '',

  // Audio state
  audioBuffer: null,
  duration: 0,
  isPlaying: false,
  pausedAt: 0,    // playback offset when paused
  startedAt: 0,   // actx.currentTime when playback last started
  actx: null,
  sourceNode: null,
  playGeneration: 0,

  // UI / Animation state
  rafId: null,
  activeSpanSet: new Set(),
  activeLineSet: new Set(),

  // Export state
  renderCancelled: false,
  renderInProgress: false,
  startTime: null, // Wall time when render started
};

/**
 * Reset state for a new file upload or fresh start.
 */
export function resetState() {
  state.spans = [];
  state.lines = [];
  state.breakBars = [];
  state.activeSpanSet = new Set();
  state.activeLineSet = new Set();
  state.pausedAt = 0;
  state.isPlaying = false;
  // Note: actx and audioBuffer are usually kept until explicitly replaced
}
