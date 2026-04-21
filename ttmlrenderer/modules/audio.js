import { state } from './state.js';

export function ensureContext() {
  if (!state.actx) {
    state.actx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (state.actx.state === 'suspended') {
    state.actx.resume();
  }
  return state.actx;
}

export function startPlayback(offset, onEnded) {
  ensureContext();
  const gen = ++state.playGeneration;
  
  if (state.sourceNode) {
    try { state.sourceNode.stop(); } catch (e) {}
  }
  
  state.sourceNode = state.actx.createBufferSource();
  state.sourceNode.buffer = state.audioBuffer;
  state.sourceNode.connect(state.actx.destination);
  
  state.sourceNode.onended = () => {
    // Only act if this is still the active playback
    if (gen !== state.playGeneration) return;
    if (onEnded) onEnded();
  };
  
  state.startedAt = state.actx.currentTime - offset;
  state.sourceNode.start(0, offset);
  state.isPlaying = true;
}

export function stopPlayback() {
  if (state.sourceNode) {
    try { state.sourceNode.stop(); } catch (e) {}
    state.sourceNode = null;
  }
  state.isPlaying = false;
  if (state.actx) {
    state.pausedAt = state.actx.currentTime - state.startedAt;
  }
}

export async function decodeAudio(arrayBuffer) {
  const ctx = ensureContext();
  state.audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  state.duration = state.audioBuffer.duration;
  return state.audioBuffer;
}
