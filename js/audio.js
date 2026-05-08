/**
 * audio.js — Audio Engine (Phase 1-5, Bugfix Edition)
 *
 * Bugfixes:
 *  - AudioContext lazy: NEVER created before user gesture
 *  - decodeAudio: Promise-based, always .slice(0), proper error handling
 *  - getOrDecodeBuffer: all playback paths use audioCache.js
 *  - playSound preview mode: uses full effect chain
 *  - _connectAndPlay extracted to avoid duplication
 */

import { APP, CItems } from './state.js';
import { bk, sleep }   from './utils.js';
import { toast }       from './notifications.js';
import { idbGet, audioKey, IDB_SENTINEL, isIdbRef, openDB } from './db.js';
import { getOrDecodeBuffer, invalidateBuffer } from './audioCache.js';

// ─── AUDIO CONTEXT ───────────────────────────────────────────
// BUGFIX: ctx is NEVER created automatically on module load.
// It is only created on the first call to actx(), which must
// happen inside a user-gesture event handler.

let _ctx = null;

export function actx() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if browser auto-suspended it
  if (_ctx.state === 'suspended') {
    _ctx.resume().catch(e => console.warn('[audio] ctx.resume():', e));
  }
  return _ctx;
}

/** True only after the user has interacted and actx() has been called. */
export function hasAudioContext() { return _ctx !== null; }

// ─── WORKLET INIT ────────────────────────────────────────────

let _workletLoading = false;

export async function ensurePitchWorklet() {
  if (APP.pitchWorkletReady || _workletLoading) return;
  _workletLoading = true;
  try {
    const ctx = actx();
    await ctx.audioWorklet.addModule('./js/worklets/pitch-processor.js');
    APP.pitchWorkletReady = true;
  } catch (e) {
    console.warn('[audio] PitchWorklet unavailable:', e.message);
    APP.pitchWorkletReady = false;
  }
  _workletLoading = false;
}

// ─── IR REVERB ───────────────────────────────────────────────

const IR_PARAMS = {
  small_room:  { duration: 0.6,  decay: 4.5, pre: 0.001 },
  hallway:     { duration: 1.0,  decay: 3.2, pre: 0.003 },
  bathroom:    { duration: 0.75, decay: 4.0, pre: 0.002 },
  cave:        { duration: 3.5,  decay: 1.8, pre: 0.010 },
  tunnel:      { duration: 1.8,  decay: 2.2, pre: 0.008 },
  cathedral:   { duration: 5.0,  decay: 1.2, pre: 0.020 },
  plate:       { duration: 2.2,  decay: 2.5, pre: 0.000 },
  huge_hall:   { duration: 4.5,  decay: 1.0, pre: 0.015 },
  tight_room:  { duration: 0.35, decay: 5.0, pre: 0.001 },
  default:     { duration: 2.2,  decay: 2.0, pre: 0.005 }
};

export function getIRBuffer(ctx, name) {
  const key = name || 'default';
  if (APP.irCache[key]) return APP.irCache[key];
  const p   = IR_PARAMS[key] || IR_PARAMS.default;
  const buf = _buildIR(ctx, p);
  APP.irCache[key] = buf;
  return buf;
}

function _buildIR(ctx, p) {
  const sr    = ctx.sampleRate;
  const pre   = Math.floor((p.pre  ?? 0.005) * sr);
  const body  = Math.floor((p.duration ?? 2.2) * sr);
  const total = pre + body;
  const decay = p.decay ?? 2.0;
  const buf   = ctx.createBuffer(2, total, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < pre;  i++) d[i] = 0;
    for (let i = 0; i < body; i++) {
      const env  = Math.pow(1 - i / body, decay);
      const rand = (Math.random() * 2 - 1) + (ch === 1 ? (Math.random() - 0.5) * 0.1 : 0);
      d[pre + i] = rand * env;
    }
  }
  return buf;
}

// ─── PRESETS ─────────────────────────────────────────────────

export const EFFECT_PRESETS = {
  cave:        { lowpass: { enabled: true, frequency: 4000, Q: 0.8 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.55, duration: 3.5, decay: 1.8 }, delay: { enabled: true, time: 0.08, feedback: 0.35, wet: 0.25 }, eq: { enabled: false, low: 0, mid: 0, high: 0 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'cave', wet: 0.60 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  behind_wall: { lowpass: { enabled: true, frequency: 350, Q: 1.2 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.25, duration: 0.4, decay: 3.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: false, low: 0, mid: 0, high: 0 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  tunnel:      { lowpass: { enabled: true, frequency: 6000, Q: 0.5 }, highpass: { enabled: true, frequency: 120, Q: 1.2 }, pan: 0, reverb: { enabled: true, amount: 0.45, duration: 1.8, decay: 2.2 }, delay: { enabled: true, time: 0.15, feedback: 0.50, wet: 0.35 }, eq: { enabled: false, low: 0, mid: 0, high: 0 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'tunnel', wet: 0.50 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  bathroom:    { lowpass: { enabled: false, frequency: 20000, Q: 0.7 }, highpass: { enabled: true, frequency: 200, Q: 0.5 }, pan: 0, reverb: { enabled: true, amount: 0.60, duration: 0.8, decay: 3.5 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: false, low: 0, mid: 0, high: 0 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'bathroom', wet: 0.55 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  metal_room:  { lowpass: { enabled: false, frequency: 20000, Q: 0.7 }, highpass: { enabled: true, frequency: 400, Q: 1.5 }, pan: 0, reverb: { enabled: true, amount: 0.50, duration: 1.0, decay: 4.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -3, mid: 4, high: 6 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  phone:       { lowpass: { enabled: true, frequency: 3400, Q: 1.5 }, highpass: { enabled: true, frequency: 300, Q: 0.9 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -6, mid: 3, high: -4 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -18, knee: 20, ratio: 8, attack: 0.002, release: 0.15 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 15, oversample: '2x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  underwater:  { lowpass: { enabled: true, frequency: 220, Q: 2.0 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.40, duration: 1.2, decay: 1.5 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: 6, mid: -8, high: -12 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  radio:       { lowpass: { enabled: true, frequency: 3200, Q: 1.2 }, highpass: { enabled: true, frequency: 250, Q: 0.9 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -8, mid: 5, high: -6 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -20, knee: 15, ratio: 10, attack: 0.002, release: 0.12 }, limiter: { enabled: true, threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 25, oversample: '2x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  lofi:        { lowpass: { enabled: true, frequency: 4500, Q: 0.8 }, highpass: { enabled: true, frequency: 80, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.15, duration: 0.6, decay: 2.5 }, delay: { enabled: true, time: 0.12, feedback: 0.20, wet: 0.15 }, eq: { enabled: true, low: 4, mid: -2, high: -8 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -22, knee: 25, ratio: 6, attack: 0.010, release: 0.40 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 20, oversample: 'none' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  megaphone:   { lowpass: { enabled: true, frequency: 4000, Q: 1.8 }, highpass: { enabled: true, frequency: 500, Q: 1.5 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -10, mid: 8, high: -5 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -12, knee: 5, ratio: 15, attack: 0.001, release: 0.10 }, limiter: { enabled: true, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 45, oversample: '2x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  monster:     { lowpass: { enabled: true, frequency: 8000, Q: 0.6 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.40, duration: 2.0, decay: 1.5 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: 12, mid: -4, high: -6 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -16, knee: 20, ratio: 8, attack: 0.005, release: 0.30 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 55, oversample: '4x' }, pitchShift: { enabled: true, semitones: -5 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  dark_cave:   { lowpass: { enabled: true, frequency: 2500, Q: 0.7 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.75, duration: 5.0, decay: 1.2 }, delay: { enabled: true, time: 0.12, feedback: 0.50, wet: 0.30 }, eq: { enabled: true, low: 3, mid: -5, high: -10 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'cave', wet: 0.75 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  huge_hall:   { lowpass: { enabled: false, frequency: 20000, Q: 0.7 }, highpass: { enabled: true, frequency: 60, Q: 0.5 }, pan: 0, reverb: { enabled: true, amount: 0.85, duration: 4.5, decay: 1.0 }, delay: { enabled: true, time: 0.20, feedback: 0.45, wet: 0.35 }, eq: { enabled: true, low: -2, mid: 0, high: 3 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -28, knee: 40, ratio: 4, attack: 0.010, release: 0.50 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'huge_hall', wet: 0.80 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  vintage_tape:{ lowpass: { enabled: true, frequency: 8000, Q: 0.6 }, highpass: { enabled: true, frequency: 60, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.12, duration: 0.5, decay: 3.0 }, delay: { enabled: true, time: 0.08, feedback: 0.15, wet: 0.10 }, eq: { enabled: true, low: 3, mid: -1, high: -5 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -18, knee: 30, ratio: 5, attack: 0.012, release: 0.45 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 12, oversample: 'none' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'plate', wet: 0.15 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  tight_room:  { lowpass: { enabled: false, frequency: 20000, Q: 0.7 }, highpass: { enabled: true, frequency: 100, Q: 0.8 }, pan: 0, reverb: { enabled: true, amount: 0.25, duration: 0.35, decay: 4.5 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -2, mid: 2, high: 1 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -20, knee: 20, ratio: 6, attack: 0.004, release: 0.20 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'tight_room', wet: 0.30 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  dreamy_echo: { lowpass: { enabled: true, frequency: 9000, Q: 0.5 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.55, duration: 2.8, decay: 1.8 }, delay: { enabled: true, time: 0.33, feedback: 0.55, wet: 0.45 }, eq: { enabled: true, low: 2, mid: -3, high: 4 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'hallway', wet: 0.40 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  broken_speaker:{ lowpass: { enabled: true, frequency: 6000, Q: 2.5 }, highpass: { enabled: true, frequency: 150, Q: 2.0 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -5, mid: 10, high: -8 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -10, knee: 5, ratio: 20, attack: 0.001, release: 0.05 }, limiter: { enabled: true, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 80, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } }
};

// ─── DEFAULT EFFECTS ─────────────────────────────────────────

export function defaultEffects() {
  return {
    enabled: false, preset: null,
    lowpass:  { enabled: false, frequency: 20000, Q: 0.7 },
    highpass: { enabled: false, frequency: 20,    Q: 0.7 },
    pan: 0,
    reverb:   { enabled: false, amount: 0.35, duration: 2.2, decay: 2.0 },
    delay:    { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 },
    eq:       { enabled: false, low: 0, mid: 0, high: 0 },
    eq10:     { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] },
    compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
    limiter:    { enabled: false, threshold: -1,  knee: 0,  ratio: 20, attack: 0.001, release: 0.08 },
    distortion: { enabled: false, amount: 40, oversample: '4x' },
    pitchShift: { enabled: false, semitones: 0 },
    irReverb:   { enabled: false, impulse: null, wet: 0.35 },
    envelope:   { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 },
    analyzer:   { enabled: false },
    spatial:    { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 },
    noiseGate:  { enabled: false, threshold: -50 }
  };
}

// ─── NODE BUILDERS ───────────────────────────────────────────

const EQ10_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function _buildEQ10(ctx, p) {
  const bands = p.bands || new Array(10).fill(0);
  const nodes = EQ10_FREQS.map((freq, i) => {
    const n = ctx.createBiquadFilter();
    n.type  = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
    n.frequency.value = freq;
    if (n.type === 'peaking') n.Q.value = 1.4;
    n.gain.value = Math.max(-18, Math.min(18, bands[i] ?? 0));
    return n;
  });
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return { input: nodes[0], output: nodes[nodes.length - 1] };
}

function _buildEQ3(ctx, p) {
  const ls = ctx.createBiquadFilter(); ls.type = 'lowshelf';  ls.frequency.value = 200;  ls.gain.value = Math.max(-18, Math.min(18, p.low  ?? 0));
  const mp = ctx.createBiquadFilter(); mp.type = 'peaking';   mp.frequency.value = 1000; mp.Q.value = 1.0; mp.gain.value = Math.max(-18, Math.min(18, p.mid ?? 0));
  const hs = ctx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 4000; hs.gain.value = Math.max(-18, Math.min(18, p.high ?? 0));
  ls.connect(mp); mp.connect(hs);
  return { input: ls, output: hs };
}

function _buildCompressor(ctx, p) {
  const n = ctx.createDynamicsCompressor();
  n.threshold.value = p.threshold ?? -24;
  n.knee.value      = p.knee      ?? 30;
  n.ratio.value     = Math.min(20, p.ratio ?? 12);
  n.attack.value    = p.attack    ?? 0.003;
  n.release.value   = p.release   ?? 0.25;
  return n;
}

function _buildDistortionCurve(amount) {
  const n = 512; const curve = new Float32Array(n); const k = Math.max(0.1, amount);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x)); }
  return curve;
}

function _buildReverb(ctx, p) {
  const wet = Math.max(0, Math.min(1, p.amount ?? 0.35));
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const conv = ctx.createConvolver();
  dry.gain.value = 1 - wet; wetG.gain.value = wet;
  conv.buffer = _buildIR(ctx, p);
  inp.connect(dry); inp.connect(conv); conv.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return { input: inp, output: out };
}

function _buildIRReverb(ctx, p) {
  const wet = Math.max(0, Math.min(1, p.wet ?? 0.35));
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const conv = ctx.createConvolver();
  dry.gain.value = 1 - wet; wetG.gain.value = wet;
  conv.buffer = getIRBuffer(ctx, p.impulse);
  inp.connect(dry); inp.connect(conv); conv.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return { input: inp, output: out };
}

function _buildDelay(ctx, p) {
  const time = Math.max(0.01, Math.min(2.0, p.time ?? 0.22));
  const fb   = Math.max(0, Math.min(0.95, p.feedback ?? 0.35));
  const wet  = Math.max(0, Math.min(0.95, p.wet ?? 0.35));
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const del  = ctx.createDelay(5.0); const fbG = ctx.createGain();
  del.delayTime.value = time; fbG.gain.value = fb;
  dry.gain.value = 1 - wet; wetG.gain.value = wet;
  del.connect(fbG); fbG.connect(del);
  inp.connect(dry); inp.connect(del); del.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return { input: inp, output: out };
}

function _buildPitchNode(ctx, p) {
  const semitones = p.semitones ?? 0;
  if (semitones === 0) return null;
  if (APP.pitchWorkletReady) {
    try {
      const n = new AudioWorkletNode(ctx, 'pitch-shifter-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      n.parameters.get('pitchFactor').setValueAtTime(Math.pow(2, semitones / 12), ctx.currentTime);
      return { input: n, output: n };
    } catch (e) { console.warn('[audio] PitchWorklet node failed:', e.message); }
  }
  return null; // caller uses src.detune as fallback
}

function _buildPanner(ctx, effects) {
  if (effects.spatial?.enabled) {
    try {
      const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
      if (p.positionX) { p.positionX.value = effects.spatial.x ?? 0; p.positionY.value = effects.spatial.y ?? 0; p.positionZ.value = effects.spatial.z ?? -1; }
      else p.setPosition(effects.spatial.x ?? 0, effects.spatial.y ?? 0, effects.spatial.z ?? -1);
      p.rolloffFactor = effects.spatial.rolloff ?? 1; p.maxDistance = effects.spatial.maxDistance ?? 10000; p.refDistance = effects.spatial.refDistance ?? 1;
      p.coneInnerAngle = effects.spatial.coneInnerAngle ?? 360; p.coneOuterAngle = effects.spatial.coneOuterAngle ?? 360; p.coneOuterGain = effects.spatial.coneOuterGain ?? 0;
      return { input: p, output: p };
    } catch(e) { /* fall through to stereo */ }
  }
  try {
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, effects.pan ?? 0)); return { input: p, output: p };
  } catch(e) { return null; }
}

/**
 * Build the full effect chain for a given context.
 * Returns { input, output } or null.
 * BUGFIX: used in both playback AND preview — same engine for both.
 */
export function buildEffectChain(ctx, effects) {
  if (!effects || !effects.enabled) return null;
  const segs = [];

  if (effects.highpass?.enabled) {
    const n = ctx.createBiquadFilter(); n.type = 'highpass';
    n.frequency.value = Math.max(20, Math.min(5000, effects.highpass.frequency ?? 20));
    n.Q.value = Math.max(0.1, Math.min(10, effects.highpass.Q ?? 0.7));
    segs.push({ input: n, output: n });
  }
  if (effects.lowpass?.enabled) {
    const n = ctx.createBiquadFilter(); n.type = 'lowpass';
    n.frequency.value = Math.max(100, Math.min(20000, effects.lowpass.frequency ?? 20000));
    n.Q.value = Math.max(0.1, Math.min(10, effects.lowpass.Q ?? 0.7));
    segs.push({ input: n, output: n });
  }
  if (effects.eq10?.enabled)       segs.push(_buildEQ10(ctx, effects.eq10));
  else if (effects.eq?.enabled)    segs.push(_buildEQ3(ctx, effects.eq));

  if (effects.limiter?.enabled)    { const n = _buildCompressor(ctx, effects.limiter);    segs.push({ input: n, output: n }); }
  else if (effects.compressor?.enabled) { const n = _buildCompressor(ctx, effects.compressor); segs.push({ input: n, output: n }); }

  if (effects.distortion?.enabled) {
    const s = ctx.createWaveShaper();
    s.curve = _buildDistortionCurve(effects.distortion.amount ?? 40);
    s.oversample = ['none','2x','4x'].includes(effects.distortion.oversample) ? effects.distortion.oversample : '4x';
    segs.push({ input: s, output: s });
  }

  if (effects.irReverb?.enabled)   segs.push(_buildIRReverb(ctx, effects.irReverb));
  else if (effects.reverb?.enabled) segs.push(_buildReverb(ctx, effects.reverb));

  if (effects.delay?.enabled)      segs.push(_buildDelay(ctx, effects.delay));

  const panner = _buildPanner(ctx, effects);
  if (panner) segs.push(panner);

  if (!segs.length) return null;
  for (let i = 0; i < segs.length - 1; i++) segs[i].output.connect(segs[i + 1].input);
  return { input: segs[0].input, output: segs[segs.length - 1].output };
}

// ─── ENVELOPE ────────────────────────────────────────────────

function _applyEnvelope(ctx, gainNode, env, baseGain, dur) {
  const t0  = ctx.currentTime;
  const att = Math.max(0.001, env.attack  ?? 0.01);
  const dec = Math.max(0.001, env.decay   ?? 0.15);
  const sus = Math.max(0, Math.min(1, env.sustain ?? 0.8));
  const rel = Math.max(0.001, env.release ?? 0.25);
  gainNode.gain.cancelScheduledValues(t0);
  gainNode.gain.setValueAtTime(0, t0);
  gainNode.gain.linearRampToValueAtTime(baseGain, t0 + att);
  gainNode.gain.linearRampToValueAtTime(baseGain * sus, t0 + att + dec);
  const relStart = Math.max(t0 + att + dec, t0 + dur - rel);
  gainNode.gain.setValueAtTime(baseGain * sus, relStart);
  gainNode.gain.linearRampToValueAtTime(0, relStart + rel);
}

// ─── ANALYZER ────────────────────────────────────────────────

export function createAnalyzerSplit(ctx) {
  const a = ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0.8; return a;
}

export function stopAnalyzer() {
  if (APP.analyzer.rafId) { cancelAnimationFrame(APP.analyzer.rafId); APP.analyzer.rafId = null; }
  APP.analyzer.active = false;
}

export function startAnalyzerLoop(analyserNode, canvas, mode) {
  stopAnalyzer(); APP.analyzer.node = analyserNode; APP.analyzer.canvas = canvas;
  APP.analyzer.mode = mode || 'bars'; APP.analyzer.active = true;
  const bufLen = analyserNode.frequencyBinCount;
  const dataF  = new Uint8Array(bufLen); const dataT = new Uint8Array(analyserNode.fftSize);
  function draw() {
    if (!APP.analyzer.active) return;
    APP.analyzer.rafId = requestAnimationFrame(draw);
    const cv = APP.analyzer.canvas; if (!cv || !cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1; const W = cv.offsetWidth; const H = cv.offsetHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext('2d'); c.scale(dpr, dpr);
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue('--color-accent').trim() || '#0075de';
    const bg     = cs.getPropertyValue('--bg-warm').trim() || '#1a1a1a';
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    if (APP.analyzer.mode === 'bars') {
      analyserNode.getByteFrequencyData(dataF);
      const barW = W / bufLen * 2.5;
      for (let i = 0; i < bufLen; i++) { const v = dataF[i] / 255; c.fillStyle = `hsl(${200 + v * 60},80%,${40 + v * 30}%)`; c.fillRect(i * barW * 0.8, H - v * H, barW * 0.75, v * H); }
    } else if (APP.analyzer.mode === 'line') {
      analyserNode.getByteFrequencyData(dataF); c.beginPath(); c.strokeStyle = accent; c.lineWidth = 2;
      for (let i = 0; i < bufLen; i++) { const x = (i / bufLen) * W; const y = H - (dataF[i] / 255) * H; if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); } c.stroke();
    } else {
      analyserNode.getByteTimeDomainData(dataT); c.beginPath(); c.strokeStyle = accent; c.lineWidth = 2;
      for (let i = 0; i < dataT.length; i++) { const x = (i / dataT.length) * W; const y = ((dataT[i] / 128) - 1) * (H / 2) + H / 2; if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); } c.stroke();
    }
  }
  draw();
}

// ─── DECODE (legacy compat) ───────────────────────────────────

/** @deprecated Use getOrDecodeBuffer from audioCache.js instead. */
export function decodeAudio(key, b64) {
  if (!_ctx) return; // BUGFIX: never auto-create ctx
  try {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    _ctx.decodeAudioData(arr.buffer.slice(0), buf => { APP.audioBuffers[key] = buf; }, err => { console.error('[audio] decodeAudio error:', err); });
  } catch(e) { console.error('[audio] decodeAudio setup error:', e); }
}

/** Promise-based decode, uses central cache. */
export async function decodeAudioSmart(soundId, slotIdx, slotData) {
  if (!slotData || !_ctx) return null;
  return getOrDecodeBuffer(soundId, slotIdx, slotData, _ctx);
}

// ─── CORE CONNECT + PLAY HELPER ──────────────────────────────

/**
 * Wire src → [pitchNode] → [effectChain] → [analyser] → gain → destination.
 * BUGFIX: preview now uses the same code path as playback.
 */
function _wire(ctx, src, effects, gainNode, { isPreview = false } = {}) {
  let pitchNode = null;
  if (effects?.pitchShift?.enabled && effects.pitchShift.semitones !== 0) {
    pitchNode = _buildPitchNode(ctx, effects.pitchShift);
    if (!pitchNode) src.detune.value = (effects.pitchShift.semitones ?? 0) * 100;
  }
  const chain    = buildEffectChain(ctx, effects);
  let analyser   = null;
  if (!isPreview && effects?.analyzer?.enabled) analyser = createAnalyzerSplit(ctx);

  let node = src;
  if (pitchNode) { node.connect(pitchNode.input); node = pitchNode.output; }
  if (chain)     { node.connect(chain.input);     node = chain.output; }
  if (analyser)  node.connect(analyser);
  node.connect(gainNode);
  gainNode.connect(ctx.destination);
  return analyser;
}

function _applyFades(ctx, gainNode, slot, s, dur, baseGain) {
  if (s.effects?.envelope?.enabled) {
    _applyEnvelope(ctx, gainNode, s.effects.envelope, baseGain, dur); return;
  }
  if (s.fade && !s.loop) {
    const fs = Math.max(0, dur - 0.8);
    gainNode.gain.setValueAtTime(baseGain, ctx.currentTime + fs);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
  }
  const fi = slot.fadeIn || 0; const fo = slot.fadeOut || 0;
  if (fi > 0 && !s.loop) {
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(baseGain, ctx.currentTime + Math.min(fi, dur * 0.5));
  }
  if (fo > 0 && !s.loop && !s.fade) {
    const foStart = Math.max(ctx.currentTime, ctx.currentTime + dur - fo);
    gainNode.gain.setValueAtTime(baseGain, foStart);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
  }
}

// ─── PLAYBACK ────────────────────────────────────────────────

export function playItem(id, callStack = []) {
  const item = CItems().find(x => x.id === id);
  if (!item || item.type === 'placeholder') return;
  if (item.type === 'sound') playSound(item);
  else runMacro(item, callStack);
}

export function playSound(s, opts = {}) {
  const slots = s.slots || [];
  let idx = s.random ? Math.floor(Math.random() * slots.length) : (s.curSlot || 0) % slots.length;
  if (!s.random) s.curSlot = (idx + 1) % slots.length;

  const slot = slots[idx];
  if (!slot || !slot.data) { toast('Slot ' + (idx + 1) + ' leer'); return; }

  const buf = APP.audioBuffers[bk(s.id, idx)];
  if (!buf) {
    // Lazy-load then retry
    toast('Audio lädt…');
    const ctx = _ctx; if (!ctx) { toast('Bitte zuerst einen Sound starten', 'err'); return; }
    decodeAudioSmart(s.id, idx, slot.data).then(decoded => { if (decoded) playSound(s, opts); });
    return;
  }

  const gs       = APP.globalSettings;
  const ctx      = actx();
  if (!gs.overlap && !opts.isPreview) stopAll();

  const baseGain = (s.vol ?? 1) * (opts.isPreview ? 1 : (gs.masterVol ?? 1));
  const gainNode = ctx.createGain(); gainNode.gain.value = baseGain;

  const src      = ctx.createBufferSource();
  src.buffer     = buf;
  src.playbackRate.value = s.pitch || 1;
  src.loop       = !opts.isPreview && !!s.loop;

  const ts = slot.trimStart || 0;
  let   te = slot.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  const dur = te - ts;

  // BUGFIX: preview uses same engine as playback (same _wire call)
  const analyser = _wire(ctx, src, s.effects, gainNode, opts);

  _applyFades(ctx, gainNode, slot, s, dur, baseGain);

  if (!APP.activeAudio[s.id]) APP.activeAudio[s.id] = [];
  APP.activeAudio[s.id].push({ src, gain: gainNode, dur });

  src.start(0, ts, src.loop ? undefined : dur);
  src.onended = () => {
    if (APP.activeAudio[s.id]) {
      APP.activeAudio[s.id] = APP.activeAudio[s.id].filter(x => x.src !== src);
      if (!APP.activeAudio[s.id].length) { delete APP.activeAudio[s.id]; _setPlaying(s.id, false); }
    }
    _updateStatusDot(); refreshRotBadge(s.id);
    if (analyser && !APP.activeAudio[s.id]?.length) stopAnalyzer();
  };

  _setPlaying(s.id, true); _updateStatusDot();
  animProg(s.id, dur); refreshRotBadge(s.id);

  if (analyser) {
    const cv = document.getElementById('analyzerCanvas');
    if (cv) startAnalyzerLoop(analyser, cv, s.effects?.analyzer?.mode || 'bars');
  }
}

export function playSoundAndWait(s) {
  return new Promise(resolve => {
    const slots = s.slots || [];
    let idx = s.random ? Math.floor(Math.random() * slots.length) : (s.curSlot || 0) % slots.length;
    if (!s.random) s.curSlot = (idx + 1) % slots.length;
    const slot = slots[idx]; if (!slot?.data) { resolve(); return; }
    const buf  = APP.audioBuffers[bk(s.id, idx)]; if (!buf) { resolve(); return; }
    const gs = APP.globalSettings; const ctx = actx();
    const baseGain = (s.vol ?? 1) * (gs.masterVol ?? 1);
    const gainNode = ctx.createGain(); gainNode.gain.value = baseGain;
    const src      = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = s.pitch || 1;
    const ts = slot.trimStart || 0; let te = slot.trimEnd ?? buf.duration; if (te <= ts) te = buf.duration;
    const dur = te - ts;
    _wire(ctx, src, s.effects, gainNode);
    _applyFades(ctx, gainNode, slot, s, dur, baseGain);
    if (!APP.activeAudio[s.id]) APP.activeAudio[s.id] = [];
    APP.activeAudio[s.id].push({ src, gain: gainNode, dur });
    src.start(0, ts, dur);
    src.onended = () => {
      if (APP.activeAudio[s.id]) {
        APP.activeAudio[s.id] = APP.activeAudio[s.id].filter(x => x.src !== src);
        if (!APP.activeAudio[s.id].length) { delete APP.activeAudio[s.id]; _setPlaying(s.id, false); }
      }
      _updateStatusDot(); refreshRotBadge(s.id); resolve();
    };
    _setPlaying(s.id, true); _updateStatusDot(); animProg(s.id, dur); refreshRotBadge(s.id);
  });
}

/** Preview: uses full effect chain (BUGFIX). */
export async function previewSound(s, slotIdx) {
  slotIdx = slotIdx ?? 0;
  const slot = s.slots?.[slotIdx]; if (!slot?.data) return;
  const ctx  = actx();
  let   buf  = APP.audioBuffers[bk(s.id, slotIdx)];
  if (!buf)  buf = await getOrDecodeBuffer(s.id, slotIdx, slot.data, ctx);
  if (!buf)  { toast('Audio konnte nicht geladen werden', 'err'); return; }

  // Temporarily stop any existing preview for this sound
  stopItem(s.id);
  playSound(s, { isPreview: true });
}

export function stopItem(id) {
  (APP.activeAudio[id] || []).forEach(a => { try { a.src.stop(); } catch(e) {} });
  delete APP.activeAudio[id]; _setPlaying(id, false); _updateStatusDot();
}

export function stopAll() { Object.keys(APP.activeAudio).forEach(stopItem); }

/**
 * Plays an AudioBuffer directly (used for slot preview in the edit modal).
 * Respects trimStart/trimEnd from the slot object.
 * Does NOT use the effect chain — raw buffer playback only.
 * Returns the BufferSourceNode so the caller can stop it if needed.
 *
 * @param {AudioBuffer} buf
 * @param {object}      slot   — { trimStart, trimEnd }
 * @param {number}      vol    — gain (0..1+)
 * @param {number}      pitch  — playbackRate multiplier
 * @returns {AudioBufferSourceNode}
 */
export function playBufferPreview(buf, slot, vol, pitch) {
  if (!buf) { console.warn('[audio] playBufferPreview: no buffer'); return null; }
  const ctx      = actx();
  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0, vol ?? 1);
  gainNode.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer              = buf;
  src.playbackRate.value  = Math.max(0.1, pitch ?? 1);

  const ts  = slot?.trimStart || 0;
  let   te  = slot?.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  const dur = Math.max(0.01, te - ts);

  src.connect(gainNode);
  src.start(0, ts, dur);
  return src;
}

// ─── MACRO RUNNER ────────────────────────────────────────────

const MAX_DEPTH = 8;

export async function runMacro(m, callStack = []) {
  if (callStack.length >= MAX_DEPTH) { toast('Makro-Tiefe erreicht', 'err'); return; }
  if (callStack.includes(m.id))      { toast('Zirkulärer Makro!',    'err'); return; }
  const stack = [...callStack, m.id]; _setPlaying(m.id, true);
  const mode  = m.playMode || 'parallel';

  for (let r = 0; r < (m.repeat || 1); r++) {
    let steps = [...(m.steps || [])];
    if (mode === 'random') steps = steps.sort(() => Math.random() - 0.5);

    // ── startTime-based scheduling (Timeline-Makros) ──────────
    // If any step carries a startTime, use absolute setTimeout scheduling so
    // the playback matches exactly what the macro timeline canvas previews.
    const hasStartTimes = steps.some(s => s.startTime != null && s.startTime > 0);
    if (hasStartTimes) {
      const sorted = [...steps].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
      const t0 = performance.now();
      await new Promise(resolve => {
        let pending = sorted.length;
        if (!pending) { resolve(); return; }
        sorted.forEach(step => {
          const delayMs = Math.max(0, Math.round((step.startTime || 0) * 1000));
          setTimeout(async () => {
            const action = step.action || 'play';
            if (action === 'stop_all') {
              stopAll();
            } else if (action === 'stop') {
              const t = CItems().find(x => x.id === step.targetId);
              if (t) stopItem(t.id);
            } else if (action === 'play' || !action) {
              const t = CItems().find(x => x.id === step.targetId);
              if (t) {
                if (t.type === 'sound') {
                  if (mode === 'sequential') await playSoundAndWait(t);
                  else playSound(t);
                } else if (t.type === 'macro') {
                  await runMacro(t, stack);
                }
              }
            } else if (action === 'volume') {
              APP.globalSettings.masterVol = Math.max(0, Math.min(1, step.volumeVal ?? APP.globalSettings.masterVol));
              const el = document.getElementById('masterVol'); if (el) el.value = APP.globalSettings.masterVol;
            } else if (action === 'fadeout') {
              const t = CItems().find(x => x.id === step.targetId);
              if (t) {
                const fadeDur = (step.fadeDuration || 1000) / 1000;
                (APP.activeAudio[t.id] || []).forEach(a => {
                  try { const ctx = actx(); a.gain.gain.cancelScheduledValues(ctx.currentTime); a.gain.gain.setValueAtTime(a.gain.gain.value, ctx.currentTime); a.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDur); setTimeout(() => { try { a.src.stop(); } catch(e) {} }, fadeDur * 1000 + 50); } catch(e) {}
                });
              }
            }
            if (--pending === 0) resolve();
          }, delayMs);
        });
      });

    // ── Legacy delay-based scheduling (alte Makros ohne startTime) ──
    } else {
      for (const step of steps) {
        const action = step.action || 'play';
        if (action === 'stop_all') { stopAll(); }
        else if (action === 'stop')    { const t = CItems().find(x => x.id === step.targetId); if (t) stopItem(t.id); }
        else if (action === 'play' || !action) {
          const t = CItems().find(x => x.id === step.targetId);
          if (t) {
            if (t.type === 'sound')  { if (mode === 'sequential') await playSoundAndWait(t); else playSound(t); }
            else if (t.type === 'macro') await runMacro(t, stack);
          }
        } else if (action === 'volume') {
          APP.globalSettings.masterVol = Math.max(0, Math.min(1, step.volumeVal ?? APP.globalSettings.masterVol));
          const el = document.getElementById('masterVol'); if (el) el.value = APP.globalSettings.masterVol;
        } else if (action === 'fadeout') {
          const t = CItems().find(x => x.id === step.targetId);
          if (t) {
            const fadeDur = (step.fadeDuration || 1000) / 1000;
            (APP.activeAudio[t.id] || []).forEach(a => {
              try { const ctx = actx(); a.gain.gain.cancelScheduledValues(ctx.currentTime); a.gain.gain.setValueAtTime(a.gain.gain.value, ctx.currentTime); a.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDur); setTimeout(() => { try { a.src.stop(); } catch(e) {} }, fadeDur * 1000 + 50); } catch(e) {}
            });
          }
        }
        if (step.delay > 0) await sleep(step.delay);
      }
    }

    if (r < (m.repeat || 1) - 1) await sleep(m.repeatDelay || 500);
  }
  _setPlaying(m.id, false); _updateStatusDot();
}

// ─── WAV EXPORT ──────────────────────────────────────────────

function _bufToWav(buffer) {
  const numCh = buffer.numberOfChannels; const sr = buffer.sampleRate; const len = buffer.length;
  const bps = 16; const block = numCh * bps / 8; const dataSize = len * block;
  const ab = new ArrayBuffer(44 + dataSize); const v = new DataView(ab);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wr(0,'RIFF'); v.setUint32(4, 36 + dataSize, true); wr(8,'WAVE'); wr(12,'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * block, true);
  v.setUint16(32, block, true); v.setUint16(34, bps, true);
  wr(36,'data'); v.setUint32(40, dataSize, true);
  let off = 44;
  for (let f = 0; f < len; f++) for (let ch = 0; ch < numCh; ch++) { const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[f])); v.setInt16(off, s < 0 ? s * 32768 : s * 32767, true); off += 2; }
  return ab;
}

export async function exportSoundToWav(s) {
  const slotIdx = (s.curSlot || 0) % Math.max(1, (s.slots || []).length);
  const slot    = (s.slots || [])[slotIdx]; if (!slot?.data) { toast('Kein Audio', 'err'); return; }
  let liveBuf   = APP.audioBuffers[bk(s.id, slotIdx)];
  if (!liveBuf && _ctx) liveBuf = await getOrDecodeBuffer(s.id, slotIdx, slot.data, _ctx);
  if (!liveBuf) { toast('Audio nicht geladen', 'err'); return; }
  const ts = slot.trimStart || 0; let te = slot.trimEnd ?? liveBuf.duration; if (te <= ts) te = liveBuf.duration;
  const dur = te - ts; if (dur <= 0) { toast('Ungültige Trim-Punkte', 'err'); return; }
  toast('Exportiere WAV…');
  try {
    const hasFx = s.effects?.enabled; const numCh = liveBuf.numberOfChannels; const sr = liveBuf.sampleRate;
    const offCtx = new OfflineAudioContext(numCh, Math.ceil((dur + (hasFx ? 3.5 : 0)) * sr), sr);
    const trimLen = Math.ceil(dur * sr); const trimBuf = offCtx.createBuffer(numCh, trimLen, sr);
    for (let ch = 0; ch < numCh; ch++) { const src = liveBuf.getChannelData(ch); const dst = trimBuf.getChannelData(ch); const ss = Math.floor(ts * sr); for (let i = 0; i < trimLen; i++) dst[i] = src[ss + i] ?? 0; }
    const srcNode = offCtx.createBufferSource(); srcNode.buffer = trimBuf; srcNode.playbackRate.value = s.pitch || 1;
    if (s.effects?.pitchShift?.enabled && !APP.pitchWorkletReady) srcNode.detune.value = (s.effects.pitchShift.semitones ?? 0) * 100;
    const gain = offCtx.createGain(); gain.gain.value = s.vol || 1;
    const chain = hasFx ? buildEffectChain(offCtx, s.effects) : null;
    if (chain) { srcNode.connect(gain); gain.connect(chain.input); chain.output.connect(offCtx.destination); }
    else { srcNode.connect(gain); gain.connect(offCtx.destination); }
    srcNode.start(0); const rendered = await offCtx.startRendering();
    const blob = new Blob([_bufToWav(rendered)], { type: 'audio/wav' });
    const url  = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;
    a.download = (s.name || 'sound').replace(/[^a-zA-Z0-9äöüÄÖÜß _-]/g, '') + '.wav'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000); toast('WAV exportiert ✓', 'ok');
  } catch(err) { console.error('[audio] WAV Export:', err); toast('Export fehlgeschlagen: ' + err.message, 'err'); }
}

// ─── UI SYNC ─────────────────────────────────────────────────

function _setPlaying(id, on) {
  const wrap = document.querySelector(`.tile-wrap[data-id="${id}"]`);
  if (wrap) wrap.querySelector('.tile')?.classList.toggle('is-playing', on);
}

function _updateStatusDot() {
  const n = Object.keys(APP.activeAudio).length;
  const dot = document.getElementById('sdot'); const stxt = document.getElementById('stxt');
  if (dot)  dot.classList.toggle('is-active', n > 0);
  if (stxt) stxt.textContent = n > 0 ? `${n} AKTIV` : 'BEREIT';
}

export function animProg(id, dur) {
  const bar = document.querySelector(`.tile-wrap[data-id="${id}"] .tile__progress`);
  if (!bar || !dur) return;
  const t0 = performance.now();
  function step(t) { const p = Math.min(100, ((t - t0) / (dur * 1000)) * 100); bar.style.width = p + '%'; if (p < 100 && APP.activeAudio[id]) requestAnimationFrame(step); else bar.style.width = '0%'; }
  requestAnimationFrame(step);
}

export function refreshRotBadge(id) {
  const s = CItems().find(x => x.id === id && x.type === 'sound'); if (!s) return;
  const wrap = document.querySelector(`.tile-wrap[data-id="${id}"]`); if (!wrap) return;
  const badge = wrap.querySelector('.tile__slot-badge'); const tile = wrap.querySelector('.tile');
  if (!badge || !tile) return;
  const total = (s.slots || []).length;
  if (total > 1) { badge.textContent = `${((s.curSlot || 0) % total) + 1}/${total}`; tile.classList.add('has-multi-slots'); }
  else { badge.textContent = ''; tile.classList.remove('has-multi-slots'); }
}
