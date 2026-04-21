import { state } from './state.js';
import { formatTime, resolveFilename } from './utils.js';
import { clearRenderPreview, updateRenderPreview } from './preview.js';
import { getScrollRenderer } from './renderers/scroll.js';
import { getKaraokeRenderer } from './renderers/karaoke.js';
import { getAmlRenderer } from './renderers/aml.js';
import { getIyfRenderer } from './renderers/iyf.js';

let _stableRecorder = null;
let _stableAudioCtx = null;
let _turboCancelled = false;

export function cancelRender() {
  state.renderCancelled = true;
  _turboCancelled = true;
  if (_stableRecorder) {
    try { _stableRecorder.stop(); } catch (_) {}
    _stableRecorder = null;
  }
  if (_stableAudioCtx) {
    try { _stableAudioCtx.close(); } catch (_) {}
    _stableAudioCtx = null;
  }
}

export async function startRender(config) {
  const { engine } = config;
  if (engine === 'turbo') {
    return startTurboRender(config);
  } else {
    return startStandardRender(config);
  }
}

async function startStandardRender(config) {
  const {
    activeStyle,
    width: W,
    height: H,
    fps: FPS,
    videoBitsPerSecond: VIDEO_BPS,
    ignoreAdlibs,
    iyfCasing: casing,
    iyfShowProgress: showProgBar,
    onProgress,
    onComplete
  } = config;

  state.renderInProgress = true;
  state.renderCancelled = false;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  let renderer;
  if (activeStyle === 'birdseye') renderer = getScrollRenderer(ctx, W, H);
  else if (activeStyle === 'karaoke') renderer = getKaraokeRenderer(ctx, W, H, { ignoreAdlibs });
  else if (activeStyle === 'aml') renderer = getAmlRenderer(ctx, W, H);
  else if (activeStyle === 'inyourface') renderer = getIyfRenderer(ctx, W, H, { casing, showProgBar });

  if (!renderer) {
    state.renderInProgress = false;
    return;
  }

  clearRenderPreview();
  const canvasStream = canvas.captureStream(FPS);
  const renderACtx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = renderACtx.createMediaStreamDestination();
  const audioSrc = renderACtx.createBufferSource();
  audioSrc.buffer = state.audioBuffer;
  audioSrc.connect(dest);

  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks()
  ]);

  const mimeTypes = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
  const recorder = new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: VIDEO_BPS });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  _stableRecorder = recorder;
  _stableAudioCtx = renderACtx;

  recorder.start(100);
  audioSrc.start(0);
  state.startTime = Date.now();
  const audioStartTime = renderACtx.currentTime;

  let renderDone = false;
  let rafId = null;
  let lastDrawTime = -1;
  const FRAME_MS = 1000 / FPS;

  const lastSpanEnd = state.spans.length ? Math.max(...state.spans.map(s => s.end)) : state.duration;
  const creditEl = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? creditEl.textContent : null;
  const endAt = Math.max(state.duration + 1.5, creditText ? lastSpanEnd + 4.5 : 0);

  let viewOffs = 0;

  function doTick(wallMs) {
    if (state.renderCancelled || renderDone) return;
    if (wallMs - lastDrawTime < FRAME_MS - 1) {
      rafId = requestAnimationFrame(doTick);
      return;
    }
    lastDrawTime = wallMs;
    const t = Math.max(renderACtx.currentTime - audioStartTime, 0);
    if (t > endAt) {
      renderDone = true;
      try { audioSrc.stop(); } catch (_) {}
      recorder.stop();
      return;
    }
    if (activeStyle === 'birdseye') {
      const target = renderer.getTargetOffset(t);
      viewOffs += (target - viewOffs) * (renderer.SCROLL_LERP / FPS);
      renderer.drawFrame(t, viewOffs);
    } else {
      renderer.drawFrame(t);
    }
    updateRenderPreview(canvas);
    if (onProgress) {
      onProgress({ t, duration: state.duration, percent: Math.min(t / endAt * 100, 100) });
    }
    rafId = requestAnimationFrame(doTick);
  }
  rafId = requestAnimationFrame(doTick);

  recorder.onstop = () => {
    if (rafId) cancelAnimationFrame(rafId);
    state.renderInProgress = false;
    _stableRecorder = null;
    _stableAudioCtx = null;
    if (!state.renderCancelled) {
      const durationMs = Date.now() - state.startTime;
      const initBlob = new Blob(chunks, { type: mimeType });
      if (window.ysFixWebmDuration) {
        window.ysFixWebmDuration(initBlob, durationMs, blob => finalizeExport(blob, activeStyle, 'webm', onComplete));
      } else {
        finalizeExport(initBlob, activeStyle, 'webm', onComplete);
      }
    }
  };
}

async function startTurboRender(config) {
  const {
    activeStyle, width: W, height: H, fps: FPS,
    videoBitsPerSecond: VIDEO_BPS, format,
    ignoreAdlibs, iyfCasing: casing, iyfShowProgress: showProgBar,
    onProgress, onComplete
  } = config;

  state.renderInProgress = true;
  state.renderCancelled = false;
  _turboCancelled = false;

  // Sanitize dimensions (must be even for many hardware encoders)
  const finalW = W % 2 === 0 ? W : W + 1;
  const finalH = H % 2 === 0 ? H : H + 1;

  const canvas = document.createElement('canvas');
  canvas.width = finalW; canvas.height = finalH;
  const ctx = canvas.getContext('2d', { alpha: false });

  let renderer;
  if (activeStyle === 'birdseye') renderer = getScrollRenderer(ctx, finalW, finalH);
  else if (activeStyle === 'karaoke') renderer = getKaraokeRenderer(ctx, finalW, finalH, { ignoreAdlibs });
  else if (activeStyle === 'aml') renderer = getAmlRenderer(ctx, finalW, finalH);
  else if (activeStyle === 'inyourface') renderer = getIyfRenderer(ctx, finalW, finalH, { casing, showProgBar });

  if (!renderer) {
    state.renderInProgress = false;
    return;
  }

  const renderOverlay = document.getElementById('render-overlay');
  const renderSub = document.getElementById('render-sub');

  const handleError = (err) => {
    console.error('Turbo Export Error:', err);
    _turboCancelled = true;
    state.renderInProgress = false;
    renderSub.textContent = 'Error: ' + (err.message || 'Encoder failed');
    renderSub.style.color = '#ff4d4d';
    setTimeout(() => {
      document.getElementById('render-overlay').classList.remove('active');
      document.getElementById('btn-render').classList.remove('rendering');
      renderSub.style.color = '';
    }, 4000);
  };

  // Load Muxer
  let MuxerMod;
  try {
    const isMp4 = format === 'mp4';
    MuxerMod = await import(`./lib/${isMp4 ? 'mp4-muxer' : 'webm-muxer'}.mjs`);
  } catch (e) {
    return handleError(new Error('Failed to load muxer libraries.'));
  }
  
  const isMp4 = format === 'mp4';
  const Muxer = MuxerMod.Muxer;
  const ArrayBufferTarget = MuxerMod.ArrayBufferTarget;

  try {
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: isMp4 ? 'avc' : 'V_VP9',
        width: finalW,
        height: finalH,
        frameRate: FPS
      },
      audio: {
        codec: isMp4 ? 'aac' : 'A_OPUS',
        numberOfChannels: state.audioBuffer.numberOfChannels,
        sampleRate: state.audioBuffer.sampleRate
      },
      fastStart: isMp4 ? 'in-memory' : false
    });

    const vEncoder = new VideoEncoder({
      output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
      error: handleError
    });
    vEncoder.configure({
      codec: isMp4 ? 'avc1.640028' : 'vp09.00.10.08',
      width: finalW,
      height: finalH,
      bitrate: VIDEO_BPS,
      framerate: FPS,
      latencyMode: 'quality',
      hardwareAcceleration: 'prefer-software'
    });

    const aEncoder = new AudioEncoder({
      output: (chunk, metadata) => muxer.addAudioChunk(chunk, metadata),
      error: handleError
    });
    aEncoder.configure({
      codec: isMp4 ? 'mp4a.40.2' : 'opus',
      numberOfChannels: state.audioBuffer.numberOfChannels,
      sampleRate: state.audioBuffer.sampleRate,
      bitrate: 128_000
    });

  const lastSpanEnd = state.spans.length ? Math.max(...state.spans.map(s => s.end)) : state.duration;
  const creditEl = document.querySelector('.songwriter-credit');
  const creditText = creditEl ? creditEl.textContent : null;
  const endAt = Math.max(state.duration + 1.5, creditText ? lastSpanEnd + 4.5 : 0);

  // Encode Audio
  const totalSamples = state.audioBuffer.length;
  const channelData = [];
  for (let i = 0; i < state.audioBuffer.numberOfChannels; i++) {
    channelData.push(state.audioBuffer.getChannelData(i));
  }

  // Encode Video Frames
  let currentTime = 0;
  const frameDuration = 1 / FPS;
  let viewOffs = 0;
  let frameCount = 0;

  clearRenderPreview();

  // Audio needs to be fed in chunks
  const audioChunkSize = 8192;
  let audioSampleOffset = 0;

  while (currentTime <= endAt && !_turboCancelled) {
    // 1. Draw Frame
    if (activeStyle === 'birdseye') {
      const target = renderer.getTargetOffset(currentTime);
      viewOffs += (target - viewOffs) * (renderer.SCROLL_LERP / FPS);
      renderer.drawFrame(currentTime, viewOffs);
    } else {
      renderer.drawFrame(currentTime);
    }

    // 2. Encode Frame
    while (vEncoder.encodeQueueSize > 30 && !_turboCancelled) {
      await new Promise(r => setTimeout(r, 10));
    }
    const frame = new VideoFrame(canvas, { timestamp: Math.round(currentTime * 1_000_000) });
    vEncoder.encode(frame, { keyFrame: frameCount % 150 === 0 });
    frame.close();

    // 3. Encode Audio up to this point
    const targetAudioSample = Math.min(Math.floor(currentTime * state.audioBuffer.sampleRate), totalSamples);
    while (audioSampleOffset < targetAudioSample && !_turboCancelled) {
      const remaining = targetAudioSample - audioSampleOffset;
      const size = Math.min(remaining, audioChunkSize);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: state.audioBuffer.sampleRate,
        numberOfFrames: size,
        numberOfChannels: state.audioBuffer.numberOfChannels,
        timestamp: Math.round((audioSampleOffset / state.audioBuffer.sampleRate) * 1_000_000),
        data: (() => {
          const combined = new Float32Array(size * state.audioBuffer.numberOfChannels);
          for (let c = 0; c < state.audioBuffer.numberOfChannels; c++) {
            combined.set(channelData[c].subarray(audioSampleOffset, audioSampleOffset + size), c * size);
          }
          return combined;
        })()
      });
      aEncoder.encode(audioData);
      audioData.close();
      audioSampleOffset += size;
    }

    currentTime += frameDuration;
    frameCount++;

    if (frameCount % 30 === 0) { // Yield less often for pure speed
      updateRenderPreview(canvas, true);
      if (onProgress) {
        onProgress({ t: currentTime, duration: state.duration, percent: Math.min(currentTime / endAt * 100, 100) });
      }
      await new Promise(r => setTimeout(r, 0));
    }
  }

  if (_turboCancelled) {
    try { vEncoder.close(); } catch(e){}
    try { aEncoder.close(); } catch(e){}
    state.renderInProgress = false;
    return;
  }

  await vEncoder.flush();
  await aEncoder.flush();
  muxer.finalize();

  const blob = new Blob([muxer.target.buffer], { type: isMp4 ? 'video/mp4' : 'video/webm' });
  finalizeExport(blob, activeStyle, format, onComplete);
  state.renderInProgress = false;
} catch (err) {
  handleError(err);
}
}

function finalizeExport(blob, activeStyle, format, onComplete) {
  const typeMap = { birdseye: 'scroll', karaoke: 'karaoke', inyourface: 'iyf', aml: 'aml' };
  const filename = resolveFilename(typeMap[activeStyle] || 'scroll', new Date(), {
    ttmlBaseName: state.ttmlBaseName,
    audioBaseName: state.audioBaseName,
    audioExt: state.audioExt,
    pattern: document.getElementById('export-filename')?.value || '',
    format
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  if (onComplete) onComplete();
}
