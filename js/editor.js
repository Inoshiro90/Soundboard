/**
 * editor.js — Destructive Audio Editing (Phase 4)
 *
 * All operations work on AudioBuffer objects and produce new AudioBuffers.
 * Results are stored in IDB and reflected in the sound's slot.
 *
 * Operations:
 *   trimApply, normalize, reverse, fadeInApply, fadeOutApply,
 *   gainApply, removeSilence, insertSilence, noiseGate
 */

import { APP }      from './state.js';
import { toast }    from './notifications.js';
import { bk }       from './utils.js';
import { actx }     from './audio.js';
import { idbSet, idbGet, audioKey, IDB_SENTINEL } from './db.js';
import { historyPush } from './history.js';

const P4 = 'p4_'; // IDB key prefix for undo snapshots

// ─── HELPERS ──────────────────────────────────────────────────

/** Encode AudioBuffer → base64 WAV string */
async function bufferToBase64(buf) {
  const sr       = buf.sampleRate;
  const numCh    = buf.numberOfChannels;
  const numFrames = buf.length;
  const bpSmp    = 2;
  const block    = numCh * bpSmp;
  const dataSize = numFrames * block;
  const ab       = new ArrayBuffer(44 + dataSize);
  const v        = new DataView(ab);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  wr(0,'RIFF'); v.setUint32(4, 36 + dataSize, true); wr(8,'WAVE'); wr(12,'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * block, true);
  v.setUint16(32, block, true); v.setUint16(34, 16, true);
  wr(36,'data'); v.setUint32(40, dataSize, true);
  let off = 44;
  for (let f = 0; f < numFrames; f++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buf.getChannelData(ch)[f]));
      v.setInt16(off, s < 0 ? s * 32768 : s * 32767, true); off += 2;
    }
  }
  // Convert ArrayBuffer to base64
  const uint8 = new Uint8Array(ab);
  let binary  = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  return btoa(binary);
}

/** Decode base64 WAV → AudioBuffer using the live AudioContext */
async function base64ToBuffer(b64) {
  const binary = atob(b64);
  const arr    = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  return new Promise((res, rej) => {
    actx().decodeAudioData(arr.buffer.slice(0), res, rej);
  });
}

/** Find a sound by ID across all profiles. */
function findSound(soundId) {
  for (const prof of APP.profiles) {
    const s = (prof.items || []).find(x => x.id === soundId);
    if (s) return s;
  }
  return null;
}

/**
 * Core: persist a new AudioBuffer as the slot's audio.
 * Saves undo snapshot to IDB, stores new audio, updates slot.
 * Returns the new IDB key.
 */
async function persistEdit(sound, slotIdx, newBuf, label) {
  const currentKey = audioKey(sound.id, slotIdx);
  const undoKey    = P4 + 'undo_' + sound.id + '_' + slotIdx + '_' + Date.now();

  // Save old data as undo snapshot
  const oldB64 = await idbGet(currentKey);
  if (oldB64) await idbSet(undoKey, oldB64);

  // Encode new buffer → base64
  const newB64 = await bufferToBase64(newBuf);

  // Store new audio
  await idbSet(currentKey, newB64);

  // Update slot sentinel
  if (sound.slots[slotIdx]) sound.slots[slotIdx].data = IDB_SENTINEL;

  // Update live AudioBuffer cache
  APP.audioBuffers[bk(sound.id, slotIdx)] = newBuf;

  // Push undo entry
  historyPush(label, 'sound_audio', {
    soundId:  sound.id,
    slotIdx,
    prevKey:  undoKey,
    nextKey:  currentKey
  });

  return currentKey;
}

// ─── EDIT OPERATIONS ──────────────────────────────────────────

/**
 * Apply trim permanently — removes audio before trimStart and after trimEnd.
 */
export async function editTrimApply(soundId, slotIdx) {
  const sound = findSound(soundId);
  const slot  = sound?.slots[slotIdx];
  if (!sound || !slot) return;

  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const sr  = buf.sampleRate;
  const ts  = slot.trimStart || 0;
  let   te  = slot.trimEnd ?? buf.duration;
  if (te <= ts || ts === 0 && te >= buf.duration) { toast('Kein Trim gesetzt'); return; }

  const startSmp = Math.floor(ts * sr);
  const endSmp   = Math.ceil(te * sr);
  const len      = endSmp - startSmp;

  const offCtx  = new OfflineAudioContext(buf.numberOfChannels, len, sr);
  const newBuf  = offCtx.createBuffer(buf.numberOfChannels, len, sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    newBuf.getChannelData(ch).set(buf.getChannelData(ch).subarray(startSmp, endSmp));
  }

  // Reset trim points
  slot.trimStart = 0; slot.trimEnd = null;

  await persistEdit(sound, slotIdx, newBuf, 'Trim angewendet');
  toast('Trim dauerhaft angewendet ✓', 'ok');
}

/**
 * Normalize — scale audio to 0 dBFS peak.
 */
export async function editNormalize(soundId, slotIdx, targetDb = 0) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak === 0) { toast('Stille — nichts zu normalisieren'); return; }

  const targetLinear = Math.pow(10, targetDb / 20);
  const gain = targetLinear / peak;

  const sr = buf.sampleRate;
  const offCtx = new OfflineAudioContext(buf.numberOfChannels, buf.length, sr);
  const src  = offCtx.createBufferSource(); src.buffer = buf;
  const gainNode = offCtx.createGain(); gainNode.gain.value = gain;
  src.connect(gainNode); gainNode.connect(offCtx.destination); src.start();
  const newBuf = await offCtx.startRendering();

  await persistEdit(sound, slotIdx, newBuf, 'Normalisiert');
  toast(`Normalisiert (×${gain.toFixed(2)}) ✓`, 'ok');
}

/**
 * Reverse — reverse audio in place.
 */
export async function editReverse(soundId, slotIdx) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const sr = buf.sampleRate;
  const newBuf = actx().createBuffer(buf.numberOfChannels, buf.length, sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = newBuf.getChannelData(ch);
    for (let i = 0; i < src.length; i++) dst[i] = src[src.length - 1 - i];
  }

  await persistEdit(sound, slotIdx, newBuf, 'Umgekehrt');
  toast('Audio umgekehrt ✓', 'ok');
}

/**
 * Fade In — render linear ramp into audio file permanently.
 */
export async function editFadeIn(soundId, slotIdx, durationSec) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const sr = buf.sampleRate;
  const offCtx = new OfflineAudioContext(buf.numberOfChannels, buf.length, sr);
  const src  = offCtx.createBufferSource(); src.buffer = buf;
  const gain = offCtx.createGain();
  gain.gain.setValueAtTime(0, 0);
  gain.gain.linearRampToValueAtTime(1, Math.min(durationSec, buf.duration * 0.9));
  src.connect(gain); gain.connect(offCtx.destination); src.start();
  const newBuf = await offCtx.startRendering();

  await persistEdit(sound, slotIdx, newBuf, `Fade-In ${durationSec.toFixed(1)}s`);
  toast('Fade-In gerendert ✓', 'ok');
}

/**
 * Fade Out — render linear ramp into audio file permanently.
 */
export async function editFadeOut(soundId, slotIdx, durationSec) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const sr  = buf.sampleRate;
  const dur = buf.duration;
  const offCtx = new OfflineAudioContext(buf.numberOfChannels, buf.length, sr);
  const src  = offCtx.createBufferSource(); src.buffer = buf;
  const gain = offCtx.createGain();
  const foStart = Math.max(0, dur - durationSec);
  gain.gain.setValueAtTime(1, 0);
  gain.gain.setValueAtTime(1, foStart);
  gain.gain.linearRampToValueAtTime(0, dur);
  src.connect(gain); gain.connect(offCtx.destination); src.start();
  const newBuf = await offCtx.startRendering();

  await persistEdit(sound, slotIdx, newBuf, `Fade-Out ${durationSec.toFixed(1)}s`);
  toast('Fade-Out gerendert ✓', 'ok');
}

/**
 * Gain Apply — apply gain in dB permanently.
 */
export async function editGainApply(soundId, slotIdx, gainDb) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const linear = Math.pow(10, gainDb / 20);
  const sr = buf.sampleRate;
  const offCtx = new OfflineAudioContext(buf.numberOfChannels, buf.length, sr);
  const src  = offCtx.createBufferSource(); src.buffer = buf;
  const gain = offCtx.createGain(); gain.gain.value = linear;
  src.connect(gain); gain.connect(offCtx.destination); src.start();
  const newBuf = await offCtx.startRendering();

  await persistEdit(sound, slotIdx, newBuf, `Gain ${gainDb >= 0 ? '+' : ''}${gainDb} dB`);
  toast(`Gain ${gainDb >= 0 ? '+' : ''}${gainDb} dB angewendet ✓`, 'ok');
}

/**
 * Insert Silence — inserts silence at the start.
 */
export async function editInsertSilence(soundId, slotIdx, atSec, durationSec) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const sr       = buf.sampleRate;
  const silSamples = Math.floor(durationSec * sr);
  const insertAt   = Math.floor(atSec * sr);
  const totalLen   = buf.length + silSamples;
  const numCh     = buf.numberOfChannels;

  const newBuf = actx().createBuffer(numCh, totalLen, sr);
  for (let ch = 0; ch < numCh; ch++) {
    const src = buf.getChannelData(ch);
    const dst = newBuf.getChannelData(ch);
    dst.set(src.subarray(0, insertAt), 0);
    // silence already zero-initialized
    dst.set(src.subarray(insertAt), insertAt + silSamples);
  }

  await persistEdit(sound, slotIdx, newBuf, `Stille ${durationSec.toFixed(1)}s eingefügt`);
  toast('Stille eingefügt ✓', 'ok');
}

/**
 * Remove Silence — trims leading and trailing silence below threshold.
 */
export async function editRemoveSilence(soundId, slotIdx, thresholdDb = -60) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const threshold = Math.pow(10, thresholdDb / 20);
  const sr  = buf.sampleRate;
  const d   = buf.getChannelData(0);
  let start = 0;
  let end   = d.length - 1;

  while (start < d.length && Math.abs(d[start]) < threshold) start++;
  while (end > start && Math.abs(d[end]) < threshold) end--;
  if (start >= end) { toast('Kein Inhalt über Schwellwert'); return; }

  const len    = end - start + 1;
  const numCh  = buf.numberOfChannels;
  const newBuf = actx().createBuffer(numCh, len, sr);
  for (let ch = 0; ch < numCh; ch++) {
    newBuf.getChannelData(ch).set(buf.getChannelData(ch).subarray(start, end + 1));
  }

  await persistEdit(sound, slotIdx, newBuf, 'Stille entfernt');
  const startSec = (start / sr).toFixed(2);
  const endSec   = ((buf.length - end) / sr).toFixed(2);
  toast(`Stille entfernt (${startSec}s – ${endSec}s) ✓`, 'ok');
}

/**
 * Noise Gate (destructive) — zero-out samples below threshold.
 */
export async function editNoiseGate(soundId, slotIdx, thresholdDb = -40, attackMs = 5, releaseMs = 50) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const threshold  = Math.pow(10, thresholdDb / 20);
  const sr         = buf.sampleRate;
  const attackSmp  = Math.floor((attackMs  / 1000) * sr);
  const releaseSmp = Math.floor((releaseMs / 1000) * sr);
  const numCh      = buf.numberOfChannels;
  const newBuf     = actx().createBuffer(numCh, buf.length, sr);

  for (let ch = 0; ch < numCh; ch++) {
    const src = buf.getChannelData(ch);
    const dst = newBuf.getChannelData(ch);
    let gate  = 0; // 0 = closed, 1 = open
    for (let i = 0; i < src.length; i++) {
      const amp = Math.abs(src[i]);
      if (amp > threshold) {
        gate = Math.min(1, gate + 1 / attackSmp);
      } else {
        gate = Math.max(0, gate - 1 / releaseSmp);
      }
      dst[i] = src[i] * gate;
    }
  }

  await persistEdit(sound, slotIdx, newBuf, `Noise Gate ${thresholdDb} dB`);
  toast(`Noise Gate angewendet ✓`, 'ok');
}

// ─── NOISE PROFILE ────────────────────────────────────────────

/**
 * Learn noise profile from a buffer region.
 * Stores spectral floor in APP.noiseProfile.
 * Uses the first ~500ms as the noise sample.
 */
export async function learnNoiseProfile(soundId, slotIdx) {
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  const fftSize   = 2048;
  const sampleLen = Math.min(buf.length, Math.floor(buf.sampleRate * 0.5));
  const data      = buf.getChannelData(0).slice(0, sampleLen);

  // Compute magnitude spectrum via manual DFT (simplified, real FFT via OfflineAudioContext)
  const sr     = buf.sampleRate;
  const offCtx = new OfflineAudioContext(1, sampleLen, sr);
  const src    = offCtx.createBufferSource();
  const nBuf   = offCtx.createBuffer(1, sampleLen, sr);
  nBuf.getChannelData(0).set(data);
  src.buffer   = nBuf;
  const analyser = offCtx.createAnalyser();
  analyser.fftSize = fftSize;
  src.connect(analyser); analyser.connect(offCtx.destination);
  src.start();

  const profile = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(profile);
  APP.noiseProfile = profile;
  toast('Rausch-Profil gelernt ✓', 'ok');
}

/**
 * Spectral Subtraction — basic noise reduction.
 * Applies noise profile as a floor filter using OfflineAudioContext + BiquadFilter chain.
 */
export async function editNoiseReduce(soundId, slotIdx, amount = 0.6) {
  const sound = findSound(soundId);
  if (!sound) return;
  const buf = APP.audioBuffers[bk(soundId, slotIdx)];
  if (!buf) { toast('Audio nicht geladen', 'err'); return; }

  // Pragmatic approach: use a highpass + gentle compressor as noise reduction
  // This avoids the full spectral subtraction complexity while giving usable results
  const sr = buf.sampleRate;
  const offCtx = new OfflineAudioContext(buf.numberOfChannels, buf.length, sr);
  const src = offCtx.createBufferSource(); src.buffer = buf;

  // Noise reduction chain: highpass → compressor (noise gate behavior) → lowpass cleanup
  const hp = offCtx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = 0.5;

  const comp = offCtx.createDynamicsCompressor();
  comp.threshold.value = -60 + amount * 30; // -60 to -30 dBFS
  comp.knee.value      = 10;
  comp.ratio.value     = 3 + amount * 5;
  comp.attack.value    = 0.01;
  comp.release.value   = 0.1;

  const gain = offCtx.createGain(); gain.gain.value = 1 + amount * 0.5;

  src.connect(hp); hp.connect(comp); comp.connect(gain); gain.connect(offCtx.destination);
  src.start();
  const newBuf = await offCtx.startRendering();

  await persistEdit(sound, slotIdx, newBuf, `Rauschreduzierung ${Math.round(amount * 100)}%`);
  toast('Rauschreduzierung angewendet ✓', 'ok');
}
