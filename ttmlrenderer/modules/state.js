export const state = {
  spans: [], // { el, begin, end, duration, isLong, lineEl }
  lines: [], // { el, begin, end }
  breakBars: [], // { el, fillEl, start, end, gap }
  rafId: null,

  // Uploaded file name tracking
  ttmlBaseName: '',
  audioBaseName: '',
  audioExt: '',

  // Web Audio state
  actx: null,
  audioBuffer: null,
  sourceNode: null,
  isPlaying: false,
  startedAt: 0,
  pausedAt: 0,
  duration: 0,
  playGeneration: 0,

  // Sync state
  activeSpanSet: new Set(),
  activeLineSet: new Set(),

  // Render state
  renderCancelled: false,
  renderInProgress: false,
  stableRecorder: null,
  stableAudioCtx: null,
  startTime: null,
};
