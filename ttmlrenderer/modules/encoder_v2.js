/**
 * encoder.js — WebCodecs-based offline fast render engine.
 *
 * Strategy:
 *  1. Render every video frame to a canvas as fast as possible (no rAF, plain loop).
 *  2. Encode each frame with VideoEncoder (WebCodecs API).
 *  3. Mux the resulting EncodedVideoChunks + raw PCM audio into a WebM container
 *     using a minimal in-memory binary muxer.
 *  4. Download the result.
 *
 * Falls back to null if WebCodecs is unavailable, letting the caller use MediaRecorder.
 */

import { state } from './state.js';
import { getExportQualityProfile, formatTime, resolveFilename, updateRenderPreview } from './utils.js';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

console.log('[encoder] Loaded v2 with addVideoChunkRaw support');

export function isWebCodecsSupported() {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame   !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof AudioData    !== 'undefined'
  );
}

/**
 * Returns true if the fast WebCodecs encoder should be used,
 * based on the user's render-method preference in the design panel.
 */
export function shouldUseFastRender() {
  const method = document.getElementById('render-method')?.value ?? 'fast';
  if (method === 'screen') return false;
  return isWebCodecsSupported();
}

/**
 * runFastRender(drawFrame, filenameSuffix)
 *   drawFrame(ctx, t, W, H) — synchronous frame draw callback
 *   filenameSuffix           — 'scroll' | 'karaoke' | 'iyf' | 'aml'
 */
export async function runFastRender(drawFrame, filenameSuffix) {
  const overlay   = document.getElementById('render-overlay');
  const barFill   = document.getElementById('render-bar-fill');
  const renderSub = document.getElementById('render-sub');
  const titleEl   = document.querySelector('.render-title');

  overlay.classList.add('active');
  document.getElementById('btn-render').classList.add('rendering');
  barFill.style.width = '0%';
  renderSub.textContent = 'Encoding…';
  titleEl.textContent = 'Fast Render';
  state.renderInProgress = true;

  const q   = getExportQualityProfile();
  const W   = q.width, H = q.height, FPS = q.fps;
  const totalFrames = Math.ceil((state.duration + 0.5) * FPS);
  const frameDur_us = Math.round(1_000_000 / FPS);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  const format = document.getElementById('export-format')?.value || 'webm';
  const isMP4  = format === 'mp4';

  // Shared error state — either encoder dying stops the whole render
  let encoderError = null;

  // --- Video encoder setup ---
  const videoChunks = [];
  let videoDecoderConfig = null;

  const videoEncoder = new VideoEncoder({
    output(chunk, metadata) {
      if (metadata.decoderConfig) videoDecoderConfig = metadata.decoderConfig;
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      videoChunks.push({
        type:      chunk.type,
        timestamp: chunk.timestamp,
        duration:  chunk.duration ?? frameDur_us,
        data:      buf,
      });
    },
    error(e) {
      console.error('[encoder] VideoEncoder error:', e);
      encoderError = e;
    },
  });

  let videoCodec = isMP4 ? 'avc1.42E01F' : 'vp09.00.10.08';
  const videoConfig = {
    codec:       videoCodec,
    width:       W,
    height:      H,
    framerate:   FPS,
    bitrate:     q.videoBitsPerSecond,
    bitrateMode: 'variable',
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
  };

  try {
    const support = await VideoEncoder.isConfigSupported(videoConfig);
    if (!support.supported) throw new Error(`${videoCodec} not supported`);
    videoEncoder.configure(videoConfig);
  } catch (e) {
    console.warn(`[encoder] ${videoCodec} failed, falling back:`, e);
    videoCodec = isMP4 ? 'avc1.42E01E' : 'vp8';
    videoEncoder.configure({
      codec:       videoCodec,
      width:       W,
      height:      H,
      framerate:   FPS,
      bitrate:     q.videoBitsPerSecond,
      bitrateMode: 'variable',
      latencyMode: 'realtime',
    });
  }

  // --- Audio encoder setup ---
  const audioChunks = [];
  const sampleRate  = state.audioBuffer.sampleRate;
  const numChannels = state.audioBuffer.numberOfChannels;

  const audioEncoder = new AudioEncoder({
    output(chunk) {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      audioChunks.push({ timestamp: chunk.timestamp, duration: chunk.duration, data: buf });
    },
    error(e) {
      console.error('[encoder] AudioEncoder error:', e);
      // Audio error is non-fatal — we'll mux without audio if needed
    },
  });

  const OPUS_FRAME_SAMPLES = 960;
  const OPUS_SR = 48000;
  let audioConfigured = false;

  try {
    const check = await AudioEncoder.isConfigSupported({
      codec: 'opus', sampleRate: OPUS_SR,
      numberOfChannels: Math.min(numChannels, 2), bitrate: 128_000,
    });
    if (check.supported) {
      audioEncoder.configure({
        codec: 'opus', sampleRate: OPUS_SR,
        numberOfChannels: Math.min(numChannels, 2), bitrate: 128_000,
      });
      audioConfigured = true;
    }
  } catch {}

  // --- Wrap everything in try/catch so UI always cleans up ---
  try {
    // --- Encode audio first (fast, synchronous queue) ---
    if (audioConfigured) {
      let pcmL, pcmR;
      if (sampleRate === OPUS_SR) {
        pcmL = state.audioBuffer.getChannelData(0);
        pcmR = numChannels > 1 ? state.audioBuffer.getChannelData(1) : pcmL;
      } else {
        const ratio  = OPUS_SR / sampleRate;
        const outLen = Math.ceil(state.audioBuffer.length * ratio);
        pcmL = new Float32Array(outLen);
        pcmR = new Float32Array(outLen);
        const srcL = state.audioBuffer.getChannelData(0);
        const srcR = numChannels > 1 ? state.audioBuffer.getChannelData(1) : srcL;
        for (let i = 0; i < outLen; i++) {
          const srcIdx = i / ratio;
          const lo = Math.floor(srcIdx), hi = Math.min(lo + 1, srcL.length - 1);
          const frac = srcIdx - lo;
          pcmL[i] = srcL[lo] + (srcL[hi] - srcL[lo]) * frac;
          pcmR[i] = srcR[lo] + (srcR[hi] - srcR[lo]) * frac;
        }
      }
      const total = pcmL.length;
      for (let offset = 0; offset < total; offset += OPUS_FRAME_SAMPLES) {
        const end      = Math.min(offset + OPUS_FRAME_SAMPLES, total);
        const nSamples = end - offset;
        const planeBuf = new Float32Array(nSamples * 2);
        planeBuf.set(pcmL.subarray(offset, end), 0);
        planeBuf.set(pcmR.subarray(offset, end), nSamples);
        const audioData = new AudioData({
          format: 'f32-planar', sampleRate: OPUS_SR,
          numberOfFrames: nSamples, numberOfChannels: 2,
          timestamp: Math.round(offset / OPUS_SR * 1_000_000),
          data: planeBuf,
        });
        audioEncoder.encode(audioData);
        audioData.close();
      }
      try { await audioEncoder.flush(); } catch (e) {
        console.warn('[encoder] Audio flush failed (continuing without audio):', e);
        audioChunks.length = 0;
      }
    }

    // --- Video frame encode loop ---
    const PREVIEW_INTERVAL = Math.max(1, Math.round(FPS * 0.25));
    const YIELD_EVERY      = 4;   // yield more often to keep queue drained
    const MAX_QUEUE_SIZE   = 8;   // pause submission when queue exceeds this
    const encodeStartMs    = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      // Stop if cancelled or encoder errored
      if (state.renderCancelled) break;
      if (encoderError) throw encoderError;

      // Back-pressure: wait until the encoder's internal queue drains
      while (videoEncoder.encodeQueueSize > MAX_QUEUE_SIZE) {
        await new Promise(r => setTimeout(r, 4));
        if (state.renderCancelled || encoderError) break;
      }
      if (state.renderCancelled) break;
      if (encoderError) throw encoderError;

      const t         = f / FPS;
      const timestamp = Math.round(t * 1_000_000);

      drawFrame(ctx, t, W, H);

      const frame = new VideoFrame(canvas, { timestamp, duration: frameDur_us });
      const isKey = (f % (FPS * 2)) === 0;

      try {
        videoEncoder.encode(frame, { keyFrame: isKey });
      } catch (e) {
        frame.close();
        throw e;
      }
      frame.close();

      if (f % YIELD_EVERY === 0) {
        await new Promise(r => setTimeout(r, 0));

        const elapsedSec = (performance.now() - encodeStartMs) / 1000;
        const speedX     = elapsedSec > 0.1 ? (t / elapsedSec) : 0;
        const speedStr   = speedX >= 1 ? speedX.toFixed(1) + '×' : '…';
        const pct        = Math.min((f / totalFrames) * 100, 100);
        barFill.style.width = pct.toFixed(1) + '%';
        renderSub.textContent = speedStr + ' — ' + formatTime(t) + ' / ' + formatTime(state.duration);

        if (f % PREVIEW_INTERVAL === 0) updateRenderPreview(canvas);
      }
    }

    if (state.renderCancelled) {
      try { videoEncoder.close(); } catch {}
      _cleanup(overlay, titleEl);
      state.renderInProgress = false;
      return;
    }

    titleEl.textContent = 'Muxing…';
    renderSub.textContent = 'Finalizing video…';

    try {
      await videoEncoder.flush();
    } catch (e) {
      console.warn('[encoder] Video flush warning:', e);
    }
    try { videoEncoder.close(); } catch {}

    const blob = isMP4
      ? muxMP4(videoChunks, audioChunks, W, H, videoDecoderConfig)
      : muxWebM(videoChunks, audioChunks, W, H, FPS, videoCodec);

    barFill.style.width = '100%';
    renderSub.textContent = 'Downloading…';

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = resolveFilename(filenameSuffix);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

  } catch (err) {
    console.error('[encoder] Fast render failed:', err);
    renderSub.textContent = 'Render failed — see console';
    barFill.style.background = 'var(--accent2)';
    try { videoEncoder.close(); } catch {}
    await new Promise(r => setTimeout(r, 3000));
    barFill.style.background = '';
  } finally {
    videoChunks.length = 0;
    audioChunks.length = 0;

    _cleanup(overlay, titleEl);
    state.renderInProgress = false;
  }
}

function _cleanup(overlay, titleEl) {
  overlay.classList.remove('active');
  document.getElementById('btn-render').classList.remove('rendering');
  titleEl.textContent = 'Rendering';
}

function muxMP4(videoChunks, audioChunks, W, H, videoDecoderConfig) {
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: {
      codec: 'avc',
      width: W,
      height: H,
    },
    audio: audioChunks.length > 0 ? {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 2
    } : undefined,
    fastStart: 'fragmented'
  });

  console.log(`[encoder] Muxing ${videoChunks.length} video chunks and ${audioChunks.length} audio chunks`);
  for (const chunk of videoChunks) {
    try {
      muxer.addVideoChunkRaw(
        chunk.data,
        chunk.type,
        chunk.timestamp,
        chunk.duration,
        { decoderConfig: videoDecoderConfig }
      );
    } catch (e) {
      console.error('[encoder] Error adding video chunk:', e);
      throw e;
    }
  }

  for (const chunk of audioChunks) {
    try {
      muxer.addAudioChunkRaw(
        chunk.data,
        'key',
        chunk.timestamp,
        chunk.duration
      );
    } catch (e) {
      console.error('[encoder] Error adding audio chunk:', e);
      throw e;
    }
  }

  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal WebM muxer — binary-safe, no array spreading of large payloads.
// All EBML metadata is written as small Uint8Arrays. Large frame data is
// referenced directly. Everything is assembled via Blob (zero-copy concat).
// ─────────────────────────────────────────────────────────────────────────────

function muxWebM(videoChunks, audioChunks, W, H, FPS, videoCodec) {
  const durationMs = videoChunks.length > 0
    ? (videoChunks[videoChunks.length - 1].timestamp + videoChunks[videoChunks.length - 1].duration) / 1000
    : 0;

  const codecId = videoCodec.startsWith('vp09') ? 'V_VP9' : 'V_VP8';

  // ── Binary writer ──────────────────────────────────────────────────────────
  const parts = [];

  function pushU8(arr) {
    if (arr instanceof Uint8Array) parts.push(arr);
    else parts.push(new Uint8Array(arr));
  }

  function vint(n) {
    if (n < 0x7F)       return new Uint8Array([n | 0x80]);
    if (n < 0x3FFF)     return new Uint8Array([(n >> 8) | 0x40, n & 0xFF]);
    if (n < 0x1FFFFF)   return new Uint8Array([(n >> 16) | 0x20, (n >> 8) & 0xFF, n & 0xFF]);
    if (n < 0x0FFFFFFF) return new Uint8Array([(n >> 24) | 0x10, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
    const hi = Math.floor(n / 0x100000000);
    return new Uint8Array([0x08, hi & 0xFF, (n >> 24) & 0xFF, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
  }

  const UNKNOWN_SIZE = new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

  function writeId(id) { pushU8(new Uint8Array(id)); }

  function uint(n, bytes) {
    const buf = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) { buf[i] = n & 0xFF; n = Math.floor(n / 256); }
    return buf;
  }

  function float64(n) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, n, false);
    return new Uint8Array(buf);
  }

  function strBytes(s) {
    return new Uint8Array([...s].map(c => c.charCodeAt(0)));
  }

  function elBytes(id, data) {
    const idU8   = new Uint8Array(id);
    const dataU8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const sizeU8 = vint(dataU8.length);
    const out    = new Uint8Array(idU8.length + sizeU8.length + dataU8.length);
    out.set(idU8, 0);
    out.set(sizeU8, idU8.length);
    out.set(dataU8, idU8.length + sizeU8.length);
    return out;
  }

  function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out   = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  // ── EBML Header ───────────────────────────────────────────────────────────
  pushU8(elBytes([0x1A, 0x45, 0xDF, 0xA3], concat(
    elBytes([0x42, 0x86], uint(1, 1)),      // EBMLVersion
    elBytes([0x42, 0xF7], uint(1, 1)),      // EBMLReadVersion
    elBytes([0x42, 0xF2], uint(4, 1)),      // EBMLMaxIDLength
    elBytes([0x42, 0xF3], uint(8, 1)),      // EBMLMaxSizeLength
    elBytes([0x42, 0x82], strBytes('webm')),// DocType
    elBytes([0x42, 0x87], uint(4, 1)),      // DocTypeVersion
    elBytes([0x42, 0x85], uint(2, 1)),      // DocTypeReadVersion
  )));

  // ── Segment ───────────────────────────────────────────────────────────────
  writeId([0x18, 0x53, 0x80, 0x67]);
  pushU8(UNKNOWN_SIZE);

  // ── Segment Info ──────────────────────────────────────────────────────────
  pushU8(elBytes([0x15, 0x49, 0xA9, 0x66], concat(
    elBytes([0x2A, 0xD7, 0xB1], uint(1_000_000, 4)),
    elBytes([0x44, 0x89], float64(durationMs)),
    elBytes([0x4D, 0x80], strBytes('ToxiRenderer')),
    elBytes([0x57, 0x41], strBytes('ToxiRenderer')),
  )));

  // ── Tracks ────────────────────────────────────────────────────────────────
  const videoTrackEntry = elBytes([0xAE], concat(
    elBytes([0xD7], uint(1, 1)),
    elBytes([0x73, 0xC5], uint(1, 8)),
    elBytes([0x83], uint(1, 1)),
    elBytes([0x9C], uint(0, 1)),
    elBytes([0x86], strBytes(codecId)),
    elBytes([0xE0], concat(
      elBytes([0xB0], uint(W, 2)),
      elBytes([0xBA], uint(H, 2)),
    )),
  ));

  const hasAudio = audioChunks.length > 0;
  const audioTrackEntry = hasAudio ? elBytes([0xAE], concat(
    elBytes([0xD7], uint(2, 1)),
    elBytes([0x73, 0xC5], uint(2, 8)),
    elBytes([0x83], uint(2, 1)),
    elBytes([0x9C], uint(0, 1)),
    elBytes([0x86], strBytes('A_OPUS')),
    elBytes([0xE1], concat(
      elBytes([0xB5], float64(48000)),
      elBytes([0x9F], uint(2, 1)),
    )),
  )) : new Uint8Array(0);

  pushU8(elBytes([0x16, 0x54, 0xAE, 0x6B], concat(videoTrackEntry, audioTrackEntry)));

  // ── Clusters ──────────────────────────────────────────────────────────────
  const allBlocks = [];
  for (const vc of videoChunks) {
    allBlocks.push({ tsMs: vc.timestamp / 1000, track: 1, data: vc.data, isKey: vc.type === 'key' });
  }
  for (const ac of audioChunks) {
    allBlocks.push({ tsMs: ac.timestamp / 1000, track: 2, data: ac.data, isKey: true });
  }
  allBlocks.sort((a, b) => a.tsMs - b.tsMs);

  const CLUSTER_DURATION_MS = 1000;
  let clusterStart   = -1;
  let clusterBlocks  = [];

  function flushCluster() {
    if (clusterBlocks.length === 0) return;
    const timecodeEl = elBytes([0xE7], uint(clusterStart, 4));
    let bodySize = timecodeEl.length;
    for (const b of clusterBlocks) bodySize += b.length;
    pushU8(concat(new Uint8Array([0x1F, 0x43, 0xB6, 0x75]), vint(bodySize), timecodeEl));
    for (const b of clusterBlocks) pushU8(b);
    clusterBlocks = [];
  }

  for (const block of allBlocks) {
    const tsMs = Math.round(block.tsMs);
    if (clusterStart < 0 || tsMs - clusterStart >= CLUSTER_DURATION_MS) {
      flushCluster();
      clusterStart = tsMs;
    }
    const relTs   = tsMs - clusterStart;
    const trackVint = block.track === 1 ? new Uint8Array([0x81]) : new Uint8Array([0x82]);
    const sbHeader = new Uint8Array([trackVint[0], (relTs >> 8) & 0xFF, relTs & 0xFF, block.isKey ? 0x80 : 0x00]);
    clusterBlocks.push(concat(new Uint8Array([0xA3]), vint(sbHeader.length + block.data.length), sbHeader));
    clusterBlocks.push(block.data);
  }
  flushCluster();

  return new Blob(parts, { type: 'video/webm' });
}
