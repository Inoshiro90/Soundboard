/**
 * export.js — MP3 + WAV Export (Phase 4)
 *
 * MP3 via lamejs (loaded from CDN in index.html).
 * WAV encoding: own implementation (no external deps).
 * Supports: single sound export + timeline mixdown export.
 */

import { APP }  from './state.js';
import { toast } from './notifications.js';
import { bk }   from './utils.js';
import { actx, buildEffectChain, defaultEffects } from './audio.js';
import { idbGet, audioKey, isIdbRef } from './db.js';
import { decodeAudio } from './audio.js';
import { timelineMixdown } from './timeline.js';

// ─── WAV ENCODING ─────────────────────────────────────────────

export function audioBufferToWavBlob(buffer) {
  const numCh   = buffer.numberOfChannels;
  const sr      = buffer.sampleRate;
  const len     = buffer.length;
  const bps     = 16;
  const bpSmp   = bps / 8;
  const block   = numCh * bpSmp;
  const dataSize = len * block;
  const ab      = new ArrayBuffer(44 + dataSize);
  const v       = new DataView(ab);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  wr(0,'RIFF'); v.setUint32(4, 36 + dataSize, true); wr(8,'WAVE'); wr(12,'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * block, true);
  v.setUint16(32, block, true); v.setUint16(34, bps, true);
  wr(36,'data'); v.setUint32(40, dataSize, true);
  let off = 44;
  for (let f = 0; f < len; f++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[f]));
      v.setInt16(off, s < 0 ? s * 32768 : s * 32767, true); off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ─── MP3 ENCODING ─────────────────────────────────────────────

/**
 * Encode an AudioBuffer to MP3 using lamejs.
 * lamejs must be loaded via CDN script tag.
 * @param {AudioBuffer} buffer
 * @param {number} kbps   — 64 | 128 | 192 | 320
 * @returns {Blob}  MP3 blob
 */
export function audioBufferToMp3Blob(buffer, kbps = 128) {
  if (typeof lamejs === 'undefined') {
    toast('lamejs nicht geladen — verwende WAV als Fallback', 'err');
    return null;
  }

  const numCh = Math.min(2, buffer.numberOfChannels);
  const sr    = buffer.sampleRate;
  const mp3enc = new lamejs.Mp3Encoder(numCh, sr, kbps);

  const CHUNK  = 1152; // lamejs frame size
  const data   = [];

  // Convert Float32 → Int16
  const toInt16 = (ch) => {
    const floats = buffer.getChannelData(ch);
    const ints   = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      ints[i] = s < 0 ? s * 32768 : s * 32767;
    }
    return ints;
  };

  const left  = toInt16(0);
  const right = numCh > 1 ? toInt16(1) : left;

  for (let offset = 0; offset < left.length; offset += CHUNK) {
    const l = left.subarray(offset, offset + CHUNK);
    const r = right.subarray(offset, offset + CHUNK);
    const chunk = numCh > 1 ? mp3enc.encodeBuffer(l, r) : mp3enc.encodeBuffer(l);
    if (chunk.length > 0) data.push(chunk);
  }

  const final = mp3enc.flush();
  if (final.length > 0) data.push(final);

  return new Blob(data, { type: 'audio/mpeg' });
}

// ─── RENDER SOUND WITH EFFECTS ────────────────────────────────

async function renderSoundOffline(s, slotIdx) {
  slotIdx = slotIdx ?? (s.curSlot || 0) % Math.max(1, (s.slots || []).length);
  const slot = (s.slots || [])[slotIdx];
  if (!slot || !slot.data) return null;

  let liveBuf = APP.audioBuffers[bk(s.id, slotIdx)];
  if (!liveBuf && isIdbRef(slot.data)) {
    const b64 = await idbGet(audioKey(s.id, slotIdx));
    if (b64) { decodeAudio(bk(s.id, slotIdx), b64); await new Promise(r => setTimeout(r, 150)); }
    liveBuf = APP.audioBuffers[bk(s.id, slotIdx)];
  }
  if (!liveBuf) return null;

  const ts  = slot.trimStart || 0;
  let   te  = slot.trimEnd ?? liveBuf.duration;
  if (te <= ts) te = liveBuf.duration;
  const dur = te - ts;
  if (dur <= 0) return null;

  const hasFx  = s.effects?.enabled;
  const tail   = hasFx ? 3.5 : 0;
  const numCh  = liveBuf.numberOfChannels;
  const sr     = liveBuf.sampleRate;
  const offCtx = new OfflineAudioContext(numCh, Math.ceil((dur + tail) * sr), sr);

  const trimLen = Math.ceil(dur * sr);
  const trimBuf = offCtx.createBuffer(numCh, trimLen, sr);
  for (let ch = 0; ch < numCh; ch++) {
    const s2 = Math.floor(ts * sr);
    const src = liveBuf.getChannelData(ch);
    const dst = trimBuf.getChannelData(ch);
    for (let i = 0; i < trimLen; i++) dst[i] = src[s2 + i] ?? 0;
  }

  const srcNode = offCtx.createBufferSource();
  srcNode.buffer = trimBuf;
  srcNode.playbackRate.value = s.pitch || 1;

  const gain = offCtx.createGain(); gain.gain.value = s.vol || 1;
  const chain = hasFx ? buildEffectChain(offCtx, s.effects) : null;
  if (chain) { srcNode.connect(gain); gain.connect(chain.input); chain.output.connect(offCtx.destination); }
  else { srcNode.connect(gain); gain.connect(offCtx.destination); }
  srcNode.start(0);
  return offCtx.startRendering();
}

// ─── PUBLIC EXPORT FUNCTIONS ──────────────────────────────────

export async function exportSoundWav(s) {
  toast('Rendere WAV…');
  try {
    const buf  = await renderSoundOffline(s);
    if (!buf) { toast('Kein Audio', 'err'); return; }
    _download(audioBufferToWavBlob(buf), (s.name || 'sound') + '.wav');
    toast('WAV Export ✓', 'ok');
  } catch (e) { toast('Export fehlgeschlagen: ' + e.message, 'err'); }
}

export async function exportSoundMp3(s, kbps = 128) {
  toast('Rendere MP3…');
  try {
    const buf  = await renderSoundOffline(s);
    if (!buf) { toast('Kein Audio', 'err'); return; }
    const blob = audioBufferToMp3Blob(buf, kbps);
    if (!blob) { _download(audioBufferToWavBlob(buf), (s.name || 'sound') + '.wav'); return; }
    _download(blob, (s.name || 'sound') + '.mp3');
    toast('MP3 Export ✓', 'ok');
  } catch (e) { toast('Export fehlgeschlagen: ' + e.message, 'err'); }
}

export async function exportTimelineWav() {
  const buf = await timelineMixdown();
  if (!buf) return;
  _download(audioBufferToWavBlob(buf), 'timeline_mixdown.wav');
}

export async function exportTimelineMp3(kbps = 128) {
  const buf = await timelineMixdown();
  if (!buf) return;
  const blob = audioBufferToMp3Blob(buf, kbps);
  if (!blob) { _download(audioBufferToWavBlob(buf), 'timeline_mixdown.wav'); return; }
  _download(blob, 'timeline_mixdown.mp3');
}

function _download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
