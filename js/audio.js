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
import { renderSoundGraph, scheduleFadeCurve } from './renderPipeline.js';
// P2 Auto Duck: zirkulärer Import (ambient.js importiert umgekehrt actx/
// hasAudioContext/buildEffectChain aus audio.js) — funktioniert für reine
// Funktionsreferenzen, die erst zur Laufzeit (nicht beim Modul-Ladevorgang)
// aufgerufen werden, siehe bereits bestehendes renderPipeline.js-Muster oben.
import { duckAmbient } from './ambient.js';

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
// BUGFIX (Pitch-Export-Konsistenz): das Pitch-Worklet-Modul muss pro
// BaseAudioContext einzeln registriert werden (AudioWorklet-Module sind
// context-gebunden). Der frühere globale `APP.pitchWorkletReady`-Flag
// bezog sich implizit NUR auf den einen Live-AudioContext — dadurch wurde
// beim WAV/MP3-Export (der einen eigenen OfflineAudioContext nutzt) nie
// geprüft/geladen, ob DAS Modul in diesem Context verfügbar ist, obwohl
// der globale Flag "true" meldete. Ergebnis: Pitch-Shift wurde beim
// Export stillschweigend ignoriert. Fix: readiness wird jetzt pro Context
// in einem WeakSet verfolgt, und jeder Aufrufer (Live ODER Offline) MUSS
// vor dem Bau eines Pitch-Nodes `ensurePitchWorkletFor(ctx)` aufrufen.

const _pitchWorkletReadyContexts = new WeakSet();

/**
 * Lädt das Pitch-Worklet-Modul für EINEN gegebenen Context (Live- oder
 * OfflineAudioContext) und merkt sich das Ergebnis pro Context.
 * Muss vor jedem `buildPitchNode(ctx, …)`-Aufruf für diesen Context
 * ausgeführt worden sein, sonst bleibt der Worklet-Pfad inaktiv und
 * `buildPitchNode()` liefert `null` (Aufrufer nutzt dann den
 * `detune`-Fallback).
 * @returns {Promise<boolean>} true, wenn das Modul in diesem Context bereit ist
 */
export async function ensurePitchWorkletFor(ctx) {
  if (!ctx || !ctx.audioWorklet) return false;
  if (_pitchWorkletReadyContexts.has(ctx)) return true;
  try {
    await ctx.audioWorklet.addModule('./js/worklets/pitch-processor.js');
    _pitchWorkletReadyContexts.add(ctx);
    return true;
  } catch (e) {
    console.warn('[audio] PitchWorklet unavailable for context:', e.message);
    return false;
  }
}

let _workletLoading = false;

/** Lädt das Pitch-Worklet für den (Lazy-erzeugten) Live-AudioContext. */
export async function ensurePitchWorklet() {
  if (APP.pitchWorkletReady || _workletLoading) return;
  _workletLoading = true;
  APP.pitchWorkletReady = await ensurePitchWorkletFor(actx());
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

/** Preset-Erweiterung: gültige Impulsantwort-Namen für irReverb.impulse,
 *  zur Wiederverwendung bei der Validierung importierter Presets
 *  (siehe presets.js normalizeEffectsObject()). 'default' bewusst
 *  ausgeschlossen — kein eigener wählbarer Name in der UI (fxIrImpulse). */
export const IR_IMPULSE_NAMES = Object.keys(IR_PARAMS).filter(k => k !== 'default');

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
  broken_speaker:{ lowpass: { enabled: true, frequency: 6000, Q: 2.5 }, highpass: { enabled: true, frequency: 150, Q: 2.0 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -5, mid: 10, high: -8 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -10, knee: 5, ratio: 20, attack: 0.001, release: 0.05 }, limiter: { enabled: true, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 80, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },

  // ── Erweiterung (Preset-Bibliothek Kap. 22): akustisch eigenständige,
  // nicht-redundante Transformationen, die zugleich bislang von keinem
  // Preset genutzte Effektmodule sinnvoll einsetzen (ringmod, notch,
  // wahwah, chorus, flanger, tremolo, envelope, spatial). Nur die hier
  // gesetzten Felder weichen vom Default ab — fehlende Module werden von
  // der generischen Preset-Anwendung (presets.js applyPresetEffects())
  // automatisch mit defaultEffects() aufgefüllt, exakt wie bei den 17
  // bestehenden Presets oben. Metadaten (Name/Kategorie/Beschreibung)
  // stehen in presets.js (BUILTIN_PRESET_META), nicht hier — reine
  // Effektparameter bleiben, wie bei den bestehenden Presets, hier in
  // audio.js (Audio-Engine-Zuständigkeit).
  possessed: {
    lowpass:    { enabled: true,  frequency: 7000, Q: 0.8 },
    notch:      { enabled: true,  frequency: 1000, Q: 8 },
    ringmod:    { enabled: true,  frequency: 55,   mix: 0.35 },
    distortion: { enabled: true,  mode: 'hardClip', amount: 20, oversample: '2x' },
    pitchShift: { enabled: true,  semitones: -3 },
    reverb:     { enabled: true,  amount: 0.30, duration: 1.2, decay: 2.0 }
  },
  portal_warp: {
    wahwah:     { enabled: true, frequency: 600, depth: 0.8, rate: 3.5, resonance: 8 },
    flanger:    { enabled: true, baseDelay: 2, depth: 2, rate: 0.4, feedback: 0.6, mix: 0.6 },
    pitchShift: { enabled: true, semitones: 2 },
    reverb:     { enabled: true, amount: 0.40, duration: 1.5, decay: 2.0 }
  },
  phantom_choir: {
    chorus:     { enabled: true, baseDelay: 20, depth: 10, rate: 0.6, mix: 0.45 },
    highpass:   { enabled: true, frequency: 300, Q: 0.7 },
    pitchShift: { enabled: true, semitones: 1 },
    irReverb:   { enabled: true, impulse: 'cathedral', wet: 0.55 }
  },
  signal_dropout: {
    highpass:   { enabled: true, frequency: 400,  Q: 0.9 },
    lowpass:    { enabled: true, frequency: 3000, Q: 0.7 },
    tremolo:    { enabled: true, rate: 7, depth: 0.8, waveform: 'square' },
    distortion: { enabled: true, mode: 'bitcrush', amount: 45, oversample: 'none' },
    noiseGate:  { enabled: true, threshold: -35 }
  },
  distant: {
    lowpass: { enabled: true, frequency: 1800, Q: 0.6 },
    eq:      { enabled: true, low: -2, mid: -3, high: -6 },
    reverb:  { enabled: true, amount: 0.20, duration: 1.0, decay: 1.5 },
    spatial: { enabled: true, x: 0, y: 0, z: -6, rolloff: 2, maxDistance: 60, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }
  },
  dying_breath: {
    envelope:   { enabled: true, attack: 0.25, decay: 0.4, sustain: 0.6, release: 1.2 },
    pitchShift: { enabled: true, semitones: -2 },
    lowpass:    { enabled: true, frequency: 3500, Q: 0.7 },
    reverb:     { enabled: true, amount: 0.45, duration: 3.0, decay: 1.5 }
  },

  // ── Erweiterung Runde 2 (Nutzer-Vorlage, Kap. 22): 17 weitere Presets.
  // WICHTIG: Die Vorlage beschreibt teils Effekte, die es in dieser
  // Audio-Engine nicht gibt (echte Bandpass-/Peaking-/Highshelf-Filter,
  // Oszillatoren/Rauschgeneratoren, Stereo-Haas-Delay mit getrennten L/R-
  // Zeiten, Multi-Tap-Delay, Auto-Pan-LFO, Phaser, parallele Pitch-Kopien,
  // benutzerdefinierte AudioWorklets). Diese wurden NICHT nachgebaut,
  // sondern mit den tatsächlich vorhandenen Modulen klanglich angenähert:
  // Bandpass  -> highpass+lowpass eng gestapelt
  // Peaking/Highshelf -> eq10-Band möglichst nah an der Zielfrequenz
  // Phaser    -> wahwah (LFO-modulierter Filter) mit sehr langsamer Rate
  // Haas/Stereo-Delay -> chorus (kurze modulierte Verzögerung = Breite)
  // Multi-Tap/parallele Pitch-Kopien -> chorus (mehrstimmiger Eindruck)
  // Oszillator/Rauschen/Worklets -> ringmod (Ring-Artefakt) bzw. weggelassen
  // Gain-Boost/-Reduction -> eq/eq10 (kein separater Ausgangsgain im Preset)
  // Siehe presets.js BUILTIN_PRESET_META für Namen/Kategorie/Beschreibung.
  cathedral_sanctum: {
    lowpass:  { enabled: true, frequency: 12000, Q: 0.7 },
    highpass: { enabled: true, frequency: 80, Q: 0.7 },
    reverb:   { enabled: true, amount: 0.60, duration: 6.0, decay: 0.9 },
    irReverb: { enabled: true, impulse: 'cathedral', wet: 0.55 }
  },
  narrow_vent: {
    highpass: { enabled: true, frequency: 700, Q: 2.0 },
    lowpass:  { enabled: true, frequency: 1400, Q: 2.0 },
    reverb:   { enabled: true, amount: 0.30, duration: 0.3, decay: 3.0 },
    flanger:  { enabled: true, baseDelay: 2, depth: 1.5, rate: 8, feedback: 0.5, mix: 0.4 },
    eq10:     { enabled: true, bands: [0, 0, 0, 0, 0, 4, 0, 0, 0, 0] }
  },
  endless_abyss: {
    lowpass:  { enabled: true, frequency: 3000, Q: 0.6 },
    highpass: { enabled: true, frequency: 120, Q: 0.7 },
    reverb:   { enabled: true, amount: 0.70, duration: 8.0, decay: 0.8 },
    delay:    { enabled: true, time: 0.45, feedback: 0.65, wet: 0.40 },
    eq:       { enabled: true, low: 2, mid: -4, high: -8 }
  },
  heavy_barricade: {
    lowpass:    { enabled: true, frequency: 250, Q: 1.0 },
    distortion: { enabled: true, mode: 'softClip', amount: 15, oversample: '2x' }
  },
  dense_canopy: {
    lowpass:    { enabled: true, frequency: 2000, Q: 0.7 },
    highpass:   { enabled: true, frequency: 120, Q: 0.7 },
    reverb:     { enabled: true, amount: 0.08, duration: 0.4, decay: 3.0 },
    compressor: { enabled: true, threshold: -24, knee: 10, ratio: 4, attack: 0.01, release: 0.3 }
  },
  distant_horizon: {
    lowpass: { enabled: true, frequency: 4000, Q: 0.8 },
    delay:   { enabled: true, time: 0.6, feedback: 0.30, wet: 0.25 },
    eq:      { enabled: true, low: 0, mid: -2, high: -6 },
    spatial: { enabled: true, x: 0, y: 0, z: -8, rolloff: 2.5, maxDistance: 80, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }
  },
  intercom_bunker: {
    lowpass:    { enabled: true, frequency: 3500, Q: 1.2 },
    highpass:   { enabled: true, frequency: 400, Q: 0.9 },
    delay:      { enabled: true, time: 0.045, feedback: 0.15, wet: 0.30 },
    distortion: { enabled: true, mode: 'hardClip', amount: 35, oversample: '2x' },
    compressor: { enabled: true, threshold: -16, knee: 10, ratio: 10, attack: 0.002, release: 0.15 }
  },
  surveillance_bug: {
    highpass:   { enabled: true, frequency: 1000, Q: 2.0 },
    lowpass:    { enabled: true, frequency: 6000, Q: 0.7 },
    compressor: { enabled: true, threshold: -30, knee: 5, ratio: 15, attack: 0.001, release: 0.1 },
    limiter:    { enabled: true, threshold: -6, knee: 0, ratio: 20, attack: 0.001, release: 0.05 },
    noiseGate:  { enabled: true, threshold: -45 }
  },
  phonograph_horn: {
    highpass:   { enabled: true, frequency: 500, Q: 1.5 },
    lowpass:    { enabled: true, frequency: 2800, Q: 1.8 },
    distortion: { enabled: true, mode: 'bitcrush', amount: 35, oversample: 'none' },
    tremolo:    { enabled: true, rate: 0.5, depth: 0.25, waveform: 'sine' },
    eq:         { enabled: true, low: -6, mid: 6, high: -10 }
  },
  ear_ringing: {
    lowpass:   { enabled: true, frequency: 150, Q: 0.7 },
    ringmod:   { enabled: true, frequency: 3800, mix: 0.15 },
    noiseGate: { enabled: true, threshold: -40 }
  },
  drunk_dizzy: {
    reverb: { enabled: true, amount: 0.30, duration: 2.5, decay: 1.8 },
    wahwah: { enabled: true, frequency: 800, depth: 0.5, rate: 0.2, resonance: 4 }
  },
  asphyxiation: {
    highpass: { enabled: true, frequency: 200, Q: 0.7 },
    eq10:     { enabled: true, bands: [0, 0, 0, 0, 6, 0, 0, 0, 0, 0] },
    reverb:   { enabled: true, amount: 0.45, duration: 0.2, decay: 5.0 }
  },
  mind_control: {
    chorus:     { enabled: true, baseDelay: 15, depth: 8, rate: 0.3, mix: 0.6 },
    compressor: { enabled: true, threshold: -10, knee: 3, ratio: 12, attack: 0.001, release: 0.08 }
  },
  shadow_realm: {
    eq:         { enabled: true, low: 2, mid: -2, high: -6 },
    reverb:     { enabled: true, amount: 0.45, duration: 5.0, decay: 1.1 },
    chorus:     { enabled: true, baseDelay: 18, depth: 12, rate: 1.5, mix: 0.35 },
    pitchShift: { enabled: true, semitones: -2 }
  },
  fairy_pixie: {
    highpass:   { enabled: true, frequency: 300, Q: 0.7 },
    eq10:       { enabled: true, bands: [0, 0, 0, 0, 0, 0, 0, 0, 5, 0] },
    reverb:     { enabled: true, amount: 0.20, duration: 1.2, decay: 2.0 },
    pitchShift: { enabled: true, semitones: 7 }
  },
  hive_mind: {
    eq:      { enabled: true, low: -3, mid: 4, high: 3 },
    flanger: { enabled: true, baseDelay: 1, depth: 1.5, rate: 14, feedback: 0.4, mix: 0.5 },
    chorus:  { enabled: true, baseDelay: 10, depth: 6, rate: 2, mix: 0.4 },
    delay:   { enabled: true, time: 0.045, feedback: 0.25, wet: 0.30 }
  },
  stone_statue: {
    eq10:       { enabled: true, bands: [0, 0, 8, 0, 0, 0, 0, 0, 0, 0] },
    compressor: { enabled: true, threshold: -14, knee: 4, ratio: 10, attack: 0.001, release: 0.12 },
    reverb:     { enabled: true, amount: 0.35, duration: 0.6, decay: 2.5 },
    delay:      { enabled: true, time: 0.035, feedback: 0.30, wet: 0.25 },
    pitchShift: { enabled: true, semitones: -4 }
  }
};

// ─── DEFAULT EFFECTS ─────────────────────────────────────────

export function defaultEffects() {
  return {
    enabled: false, preset: null,
    lowpass:  { enabled: false, frequency: 20000, Q: 0.7 },
    highpass: { enabled: false, frequency: 20,    Q: 0.7 },
    notch:    { enabled: false, frequency: 50, Q: 10 },
    wahwah:   { enabled: false, frequency: 800, depth: 0.7, rate: 2, resonance: 5 },
    pan: 0,
    reverb:   { enabled: false, amount: 0.35, duration: 2.2, decay: 2.0 },
    delay:    { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 },
    chorus:   { enabled: false, baseDelay: 15, depth: 8,   rate: 0.8, mix: 0.3 },
    flanger:  { enabled: false, baseDelay: 2,  depth: 1.5, rate: 0.2, feedback: 0.5, mix: 0.5 },
    tremolo:  { enabled: false, rate: 5, depth: 0.5, waveform: 'sine' },
    eq:       { enabled: false, low: 0, mid: 0, high: 0 },
    eq10:     { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] },
    compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
    limiter:    { enabled: false, threshold: -1,  knee: 0,  ratio: 20, attack: 0.001, release: 0.08 },
    // mode: P2-Erweiterung (softClip = bisheriges, unverändertes Verhalten;
    // hardClip/bitcrush neu). Presets ohne "mode"-Feld fallen über den
    // switch-default in _buildDistortionCurve() weiterhin auf softClip
    // zurück — kein Migrationsschritt für bestehende Presets nötig.
    distortion: { enabled: false, mode: 'softClip', amount: 40, oversample: '4x' },
    ringmod:    { enabled: false, frequency: 440, mix: 1 },
    pitchShift: { enabled: false, semitones: 0 },
    irReverb:   { enabled: false, impulse: null, wet: 0.35 },
    envelope:   { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 },
    analyzer:   { enabled: false },
    spatial:    { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 },
    // attack/release: Stufe-A-Compressor-Approximation (siehe buildEffectChain).
    // Bestehende Presets ohne diese Felder funktionieren unverändert weiter,
    // da buildEffectChain() sie mit `?? 5`/`?? 150` defaultet.
    noiseGate:  { enabled: false, threshold: -50, attack: 5, release: 150 }
  };
}

/**
 * "Wiedergabe & Verhalten": nicht-destruktive Wiedergabeparameter eines
 * Sounds — im Gegensatz zu slot.fadeIn/slot.fadeOut (dauerhafte, im Editor
 * gebrannte Bearbeitung, s. editor.js editFadeIn()/editFadeOut()) verändern
 * diese Werte nie die gespeicherte Audiodatei, sondern werden erst beim
 * Abspielen angewendet (renderPipeline.js). Eigener Namensraum (`playback`)
 * bewusst getrennt von den bestehenden Legacy-Feldern `s.loop`/`s.fade`/
 * `s.random`, um Namenskonflikte mit den Slot-Fades zu vermeiden.
 */
export function defaultPlayback() {
  return {
    fadeIn:    { enabled: false, duration: 0.5, curve: 'linear' },
    fadeOut:   { enabled: false, duration: 0.5, curve: 'linear' },
    crossfade: { enabled: false, duration: 1,   curve: 'linear' }
  };
}

// ─── NODE BUILDERS ───────────────────────────────────────────

export const EQ10_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * P3: bands[i] kann sowohl das alte Format (reine Zahl = Gain, fester
 * Q=1.4) als auch das neue Format ({freq, gain, Q}) sein — volle
 * Rückwärtskompatibilität mit alten Presets/gespeicherten Sounds, die
 * noch das Flat-Array-Format nutzen (u.a. alle 17 mitgelieferten
 * FX-Presets).
 */
function _buildEQ10(ctx, p) {
  const bands = p.bands || new Array(10).fill(0);
  const nodes = EQ10_FREQS.map((defaultFreq, i) => {
    const n = ctx.createBiquadFilter();
    n.type  = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
    const b = bands[i];
    const isObj = typeof b === 'object' && b !== null;
    const gain = isObj ? (b.gain ?? 0) : (b ?? 0);
    const freq = isObj && b.freq ? b.freq : defaultFreq;
    const q    = isObj && b.Q    ? b.Q    : 1.4;
    n.frequency.value = freq;
    n.Q.value = Math.max(0.3, Math.min(10, q));
    n.gain.value = Math.max(-18, Math.min(18, gain));
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

/**
 * P2-Erweiterung: mehrere Verzerrungs-Kurvenformen statt nur der einen
 * bisherigen weichen Sättigungskurve.
 * WICHTIG: der 'softClip'/default-Zweig verwendet BEWUSST die exakte,
 * bereits bestehende Formel (Math.PI-basiert, nicht die im Plan
 * vorgeschlagene vereinfachte (1+k)-Variante) — alle 17 FX-Presets sind
 * auf genau diese Kurve abgestimmt; ein Formelwechsel hätte deren Klang
 * unbeabsichtigt verändert.
 */
function _buildDistortionCurve(mode, amount) {
  const n = 512; const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1; // -1..1
    switch (mode) {
      case 'hardClip': {
        const threshold = Math.max(0.05, Math.min(1, amount / 100)); // amount 0-100 -> threshold 1-0.05
        curve[i] = Math.max(-threshold, Math.min(threshold, x)) / threshold; // normalisiert
        break;
      }
      case 'bitcrush': {
        const bitDepth = Math.max(1, Math.min(16, Math.round(16 - (amount / 100) * 14))); // amount -> 1..16 bit
        const steps = Math.pow(2, bitDepth);
        curve[i] = Math.round(x * steps) / steps;
        break;
      }
      case 'softClip':
      default: {
        const k = Math.max(0.1, amount);
        curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
      }
    }
  }
  return curve;
}

/** P2: schmalbandige Frequenzunterdrückung, primär gegen Netzbrummen (50/60Hz). */
function _buildNotch(ctx, p) {
  const n = ctx.createBiquadFilter();
  n.type = 'notch';
  n.frequency.value = Math.max(20, Math.min(20000, p.frequency ?? 50));
  n.Q.value = Math.max(0.5, Math.min(30, p.Q ?? 10));
  return { input: n, output: n };
}

/**
 * P2: klassische Lautstärke-Modulation. Gain = dcOffset + LFO*lfoGain,
 * pendelt zwischen [1-depth, 1] (depth=0 → konstant 1, kein Effekt;
 * depth=1 → pendelt zwischen 0 und 1). Siehe Plan-Funktionsbeispiel.
 */
function _buildTremolo(ctx, p) {
  const lfo = ctx.createOscillator();
  lfo.type = ['sine', 'triangle', 'square'].includes(p.waveform) ? p.waveform : 'sine';
  lfo.frequency.value = Math.max(0.1, Math.min(20, p.rate ?? 5));

  const lfoGain = ctx.createGain();
  lfoGain.gain.value = Math.max(0, Math.min(1, p.depth ?? 0.5)) * 0.5; // auf ±0.5 skaliert

  const dcOffset = ctx.createConstantSource();
  dcOffset.offset.value = 1 - lfoGain.gain.value; // Basispegel, damit Gain nie negativ wird

  const outGain = ctx.createGain();
  outGain.gain.value = 0; // wird ausschließlich per LFO+DC moduliert
  lfo.connect(lfoGain).connect(outGain.gain);
  dcOffset.connect(outGain.gain);
  lfo.start(); dcOffset.start();

  return { input: outGain, output: outGain };
}

/**
 * P2: modulierte Delay-Line, gemeinsame Basis für Chorus (lang, kein
 * Feedback) und Flanger (kurz, mit Feedback) — siehe _buildChorus/
 * _buildFlanger. `maxDelay` (Sekunden) begrenzt den DelayNode-Puffer und
 * muss baseDelay+depth mit Sicherheitsabstand abdecken, sonst würde die
 * LFO-Modulation bei hohen depth-Werten den erlaubten Bereich verlassen.
 */
function _buildModulatedDelay(ctx, p, { withFeedback, maxDelay = 0.05 }) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(maxDelay);
  delay.delayTime.value = Math.max(0, (p.baseDelay ?? 15) / 1000);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = Math.max(0.01, Math.min(10, p.rate ?? 0.8));
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = Math.max(0, (p.depth ?? 8) / 1000); // ms -> s
  lfo.connect(lfoGain).connect(delay.delayTime);
  lfo.start();

  const wetGain = ctx.createGain(); wetGain.gain.value = Math.max(0, Math.min(1, p.mix ?? 0.3));
  const dryGain = ctx.createGain(); dryGain.gain.value = 1 - wetGain.gain.value;
  const output = ctx.createGain();

  input.connect(dryGain).connect(output);
  input.connect(delay);
  if (withFeedback) {
    const fb = ctx.createGain(); fb.gain.value = Math.max(0, Math.min(0.95, p.feedback ?? 0.5));
    delay.connect(fb).connect(delay);
  }
  delay.connect(wetGain).connect(output);

  return { input, output };
}

// Chorus: lange Basis-Delay-Zeit (10-30ms), kein Feedback — "mehrere
// leicht verstimmte Stimmen". Flanger: sehr kurze Basis-Delay-Zeit
// (0.5-5ms) MIT Feedback — Kammfilter-/"Jet"-Effekt.
// maxDelay-Puffer bewusst mit Sicherheitsabstand über dem theoretischen
// Maximum von baseDelay+depth (Chorus: 40+20=60ms, Flanger: 5+20=25ms aus
// den jeweiligen Parametertabellen) gewählt — DelayNode moduliert additiv
// (delayTime-AudioParam + LFO-Signal), ein zu knapper Puffer würde die
// LFO-Modulation bei hohen depth-Werten stillschweigend kappen.
function _buildChorus(ctx, p)  { return _buildModulatedDelay(ctx, p, { withFeedback: false, maxDelay: 0.08 }); }
function _buildFlanger(ctx, p) { return _buildModulatedDelay(ctx, p, { withFeedback: true,  maxDelay: 0.04 }); }

/**
 * P3: Wahwah — LFO-modulierter Bandpass, klassischer "Wah"-Sweep-Klang.
 * depthHz proportional zur Basisfrequenz skaliert (siehe Plan-Formel),
 * damit "depth" bei jeder Basisfrequenz einen vergleichbar hörbaren
 * Sweep-Bereich ergibt (ein fixer Hz-Wert würde bei niedrigem baseFreq
 * unverhältnismäßig groß wirken).
 */
function _buildWahwah(ctx, p) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  const baseFreq = Math.max(100, Math.min(5000, p.frequency ?? 800));
  const depthHz  = Math.max(0, Math.min(1, p.depth ?? 0.7)) * baseFreq * 3;
  filter.frequency.value = baseFreq;
  filter.Q.value = Math.max(1, Math.min(20, p.resonance ?? 5));

  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  lfo.frequency.value = Math.max(0.1, Math.min(10, p.rate ?? 2));
  const lfoGain = ctx.createGain(); lfoGain.gain.value = depthHz;
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start();

  return { input: filter, output: filter };
}

/**
 * P3: Ring Modulation — Träger-Oszillator moduliert direkt den Gain
 * des Eingangssignals (Web-Audio-Parameter-Modulation als pragmatische
 * Näherung an echte Signal-Multiplikation, siehe Plan-Hinweis: bei
 * Oszillator-Amplitude ±1 und Gain-Basiswert 0 entspricht das einer
 * Multiplikation Input×Träger — technisch keine exakte Ring-Modulation
 * wie mit einem dedizierten AudioWorklet, klanglich aber der
 * charakteristische metallische/oktavierte Effekt).
 */
function _buildRingMod(ctx, p) {
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = Math.max(20, Math.min(5000, p.frequency ?? 440));
  const ringGain = ctx.createGain(); ringGain.gain.value = 0; // Träger moduliert direkt den Gain
  carrier.connect(ringGain.gain);
  carrier.start();

  const wet = ctx.createGain(); wet.gain.value = Math.max(0, Math.min(1, p.mix ?? 1));
  const dry = ctx.createGain(); dry.gain.value = 1 - wet.gain.value;
  const input = ctx.createGain(); const output = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(ringGain).connect(wet).connect(output);

  return { input, output };
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

/**
 * Baut einen Pitch-Shift-Node für GENAU den übergebenen Context.
 * BUGFIX (Pitch-Export-Konsistenz): prüft die Context-spezifische
 * Worklet-Readiness (`_pitchWorkletReadyContexts`) statt des globalen,
 * nur für den Live-Context gültigen `APP.pitchWorkletReady`-Flags. Damit
 * liefert dieselbe Funktion für Live-AudioContext UND OfflineAudioContext
 * (Export) ein konsistentes Ergebnis, sofern der Aufrufer zuvor
 * `ensurePitchWorkletFor(ctx)` ausgeführt hat.
 * Exportiert, damit export.js denselben Baustein wiederverwenden kann
 * (keine zweite, abweichende Pitch-Node-Implementierung für den Export).
 *
 * @param {number} [numChannels=2] Kanalzahl der Quelle (buffer.numberOfChannels).
 *   Stereo-fähiger Worklet (P1): `channelCountMode:'explicit'` +
 *   `channelInterpretation:'discrete'` verhindert, dass der Browser bei
 *   Mono-Quellen automatisch hoch- bzw. bei Multi-Channel-Quellen
 *   heruntermischt, BEVOR der Worklet die Kanäle sieht — jeder Kanal
 *   bekommt im Prozessor eine eigene, unabhängige Overlap-Add-Instanz.
 */
export function buildPitchNode(ctx, p, numChannels = 2) {
  const semitones = p.semitones ?? 0;
  if (semitones === 0) return null;
  if (_pitchWorkletReadyContexts.has(ctx)) {
    try {
      const ch = Math.max(1, Math.min(2, numChannels || 2));
      const n = new AudioWorkletNode(ctx, 'pitch-shifter-processor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        channelCount: ch,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        outputChannelCount: [ch]
      });
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
  if (effects.notch?.enabled)      segs.push(_buildNotch(ctx, effects.notch));
  if (effects.wahwah?.enabled)     segs.push(_buildWahwah(ctx, effects.wahwah));
  if (effects.eq10?.enabled)       segs.push(_buildEQ10(ctx, effects.eq10));
  else if (effects.eq?.enabled)    segs.push(_buildEQ3(ctx, effects.eq));

  if (effects.limiter?.enabled)    { const n = _buildCompressor(ctx, effects.limiter);    segs.push({ input: n, output: n }); }
  else if (effects.compressor?.enabled) { const n = _buildCompressor(ctx, effects.compressor); segs.push({ input: n, output: n }); }

  if (effects.distortion?.enabled) {
    const s = ctx.createWaveShaper();
    s.curve = _buildDistortionCurve(effects.distortion.mode, effects.distortion.amount ?? 40);
    s.oversample = ['none','2x','4x'].includes(effects.distortion.oversample) ? effects.distortion.oversample : '4x';
    segs.push({ input: s, output: s });
  }
  if (effects.ringmod?.enabled)    segs.push(_buildRingMod(ctx, effects.ringmod));

  // Chorus/Flanger: Modulationseffekte, bewusst vor Reverb/Delay platziert
  // (typische Effektketten-Reihenfolge: Filter → Verzerrung → Modulation →
  // Zeitbasierte Effekte). Gegenseitig exklusiv wie EQ/EQ10 wäre unnötig
  // einschränkend (Chorus+Flanger gleichzeitig ist klanglich sinnvoll),
  // daher hier — anders als z.B. bei eq/eq10 — KEIN else-if.
  if (effects.chorus?.enabled)     segs.push(_buildChorus(ctx, effects.chorus));
  if (effects.flanger?.enabled)    segs.push(_buildFlanger(ctx, effects.flanger));

  if (effects.irReverb?.enabled)   segs.push(_buildIRReverb(ctx, effects.irReverb));
  else if (effects.reverb?.enabled) segs.push(_buildReverb(ctx, effects.reverb));

  if (effects.delay?.enabled)      segs.push(_buildDelay(ctx, effects.delay));

  // Tremolo: bewusst NACH dem Delay-Block platziert (Plan-Vorgabe) —
  // moduliert damit auch die Delay-Wiederholungen mit, nicht nur das
  // Trockensignal.
  if (effects.tremolo?.enabled)    segs.push(_buildTremolo(ctx, effects.tremolo));

  // BUGFIX (Noise-Gate P0, Stufe A): `effects.noiseGate` wurde bisher an
  // keiner Stelle in buildEffectChain() ausgelesen — der UI-Regler
  // (fxNoiseGateEnabled/-Threshold) hatte dadurch NULL Audiowirkung.
  // Sofortmaßnahme: Compressor-Approximation. Das ist AUSDRÜCKLICH kein
  // echtes Gate (ein DynamicsCompressorNode dämpft oberhalb, nicht
  // unterhalb des Thresholds) — nur "irgendeine hörbare Wirkung", damit
  // der Regler nicht mehr wirkungslos ist. Zielarchitektur (P1): echter
  // Envelope-Follower-Gate als AudioWorkletNode (analog pitch-processor.js).
  if (effects.noiseGate?.enabled) {
    const g = ctx.createDynamicsCompressor();
    g.threshold.value = Math.max(-100, Math.min(0, effects.noiseGate.threshold ?? -45));
    g.ratio.value = 20;        // maximal mögliches Ratio der Web Audio API
    g.knee.value = 0;          // harte Kennlinie, Annäherung an Gate-Verhalten
    g.attack.value = Math.max(0.001, (effects.noiseGate.attack ?? 5) / 1000);
    g.release.value = Math.max(0.01, (effects.noiseGate.release ?? 150) / 1000);
    segs.push({ input: g, output: g });
  }

  const panner = _buildPanner(ctx, effects);
  if (panner) segs.push(panner);

  if (!segs.length) return null;
  for (let i = 0; i < segs.length - 1; i++) segs[i].output.connect(segs[i + 1].input);
  return { input: segs[0].input, output: segs[segs.length - 1].output };
}

// ─── ENVELOPE ────────────────────────────────────────────────
// BUGFIX (P1 Render-Pipeline): Envelope-/Fade-Kurvenberechnung lebt jetzt
// zentral in renderPipeline.js (renderSoundGraph()), auf getrennten,
// in Serie geschalteten Gain-Nodes statt konkurrierend auf demselben Node
// (siehe Plan Abschnitt 1.5). Die frühere _applyEnvelope()/_applyFades()/
// _wire() hier in audio.js sind damit überflüssig geworden und entfallen
// — playSound()/playSoundAndWait() rufen jetzt renderSoundGraph() auf.

// ─── ANALYZER ────────────────────────────────────────────────

export function createAnalyzerSplit(ctx) {
  const a = ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0.8; return a;
}

export function stopAnalyzer() {
  if (APP.analyzer.rafId) { cancelAnimationFrame(APP.analyzer.rafId); APP.analyzer.rafId = null; }
  APP.analyzer.active = false;
  updateAnalyzerIdleHint();
}

export function startAnalyzerLoop(analyserNode, canvas, mode) {
  stopAnalyzer(); APP.analyzer.node = analyserNode; APP.analyzer.canvas = canvas;
  APP.analyzer.mode = mode || 'bars'; APP.analyzer.active = true;
  updateAnalyzerIdleHint();
  const bufLen = analyserNode.frequencyBinCount;
  const dataF  = new Uint8Array(bufLen); const dataT = new Uint8Array(analyserNode.fftSize);
  // Abschnitt 25: Canvas-Backing-Store (cv.width/height) und die Theme-
  // Farben nur bei tatsächlicher Änderung neu lesen/setzen, nicht bei
  // jedem der ~60 Frames/Sekunde — cv.width/height-Zuweisung löscht und
  // realloziert intern die gesamte Canvas-Bitmap, und getComputedStyle()
  // erzwingt einen Style-Recalc; beides pro Frame ist unnötige Last,
  // gerade auf Mobile (Abschnitt 26).
  let lastW = 0, lastH = 0, lastDpr = 0;
  let accent = '#0075de', bg = '#1a1a1a';
  function _refreshThemeColors() {
    const cs = getComputedStyle(document.documentElement);
    accent = cs.getPropertyValue('--color-accent').trim() || accent;
    bg     = cs.getPropertyValue('--bg-warm').trim()     || bg;
  }
  _refreshThemeColors();
  function draw() {
    if (!APP.analyzer.active) return;
    APP.analyzer.rafId = requestAnimationFrame(draw);
    const cv = APP.analyzer.canvas; if (!cv || !cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1; const W = cv.offsetWidth; const H = cv.offsetHeight;
    if (!W || !H) return;
    if (W !== lastW || H !== lastH || dpr !== lastDpr) {
      cv.width = W * dpr; cv.height = H * dpr;
      lastW = W; lastH = H; lastDpr = dpr;
    }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
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

// ─── AUTO DUCK (P2) ──────────────────────────────────────────
// Senkt die Ambient-Ebene automatisch ab, sobald ein Soundboard-Sound
// aktiv ist. Wirkungsbereich bewusst GLOBAL (ein "mindestens ein Sound
// läuft"-Zustand), NICHT pro Sound/Szene — siehe Plan-Begründung:
// Pro-Sound-Ducking würde bei vielen kurzen, häufig getriggerten Sounds
// zu unruhigem Auf-und-Ab-Pumpen führen.

/** Bei Start eines Sounds: Ambient duckt Richtung (1-amount). */
export function notifyDuckTrigger() {
  const duckSettings = APP.globalSettings?.autoDuck;
  if (!duckSettings?.enabled) return;
  const amount = Math.min(1, Math.max(0, duckSettings.amount ?? 0.7));
  const targetFactor = 1 - amount;
  // Zeitkonstante so gewählt, dass ~95% des Zielwerts nach `attack`ms erreicht sind (≈3τ).
  const timeConstant = Math.max(0.001, (duckSettings.attack ?? 150) / 1000 / 3);
  duckAmbient(targetFactor, timeConstant);
}

/** Bei Ende eines Sounds, NUR wenn wirklich kein anderer Sound mehr aktiv ist: Ambient released auf 1.0. */
export function notifyDuckRelease() {
  if (Object.keys(APP.activeAudio).length > 0) return; // noch andere Sounds aktiv → nicht releasen
  const duckSettings = APP.globalSettings?.autoDuck;
  if (!duckSettings?.enabled) return;
  const timeConstant = Math.max(0.001, (duckSettings.release ?? 500) / 1000 / 3);
  duckAmbient(1.0, timeConstant);
}

// ─── PLAYBACK ────────────────────────────────────────────────

export function playItem(id, callStack = []) {
  const item = CItems().find(x => x.id === id);
  if (!item || item.type === 'placeholder') return;
  if (item.type === 'sound') playSound(item);
  else runMacro(item, callStack);
}

export async function playSound(s, opts = {}) {
  const slots = s.slots || [];
  // Abschnitt 11: ein Sound kann jetzt gültig ganz ohne Audioslot existieren
  // (letzter Slot im Editor entfernt) — ohne diese Prüfung würde `% slots.length`
  // hier zu `% 0` (NaN) führen, statt der bereits an anderer Stelle etablierten
  // "Keine Audio-Dateien geladen"-Meldung (siehe btnPreviewSound).
  if (!slots.length) { toast('Keine Audio-Dateien geladen', 'err'); return; }
  let idx = s.random ? Math.floor(Math.random() * slots.length) : (s.curSlot || 0) % slots.length;
  if (!s.random) s.curSlot = (idx + 1) % slots.length;
  return playSelectedSlot(s, idx, opts);
}

/**
 * Bugfix (Ursache 3 / Testfälle C, D, J): Spielt EXPLIZIT den übergebenen
 * Slot-Index ab, unabhängig davon, was `s.curSlot` inzwischen ist.
 *
 * Vorher rief playSound() bei einem Cache-Miss nach dem Lazy-Decode
 * erneut `playSound(s, opts)` auf — das wählt den Slot aber NEU (über
 * s.curSlot/Zufall), der zuvor bereits für nicht-Zufall-Wiedergabe auf
 * idx+1 weitergeschaltet worden war. Der lazy-geladene Slot idx wurde
 * dadurch nie tatsächlich abgespielt, sondern ein anderer (evtl. wieder
 * ungeladener) Slot — sichtbar als endloses "Audio lädt…" oder als
 * Wiedergabe des falschen Slots. playSelectedSlot() behält die
 * Slot-Identität über den kompletten Lazy-Load hinweg bei, indem der
 * Retry nach dem Decode erneut GENAU denselben `idx` anfordert.
 */
export async function playSelectedSlot(s, idx, opts = {}) {
  const slots = s.slots || [];
  const slot  = slots[idx];
  if (!slot || !slot.data) { toast('Slot ' + (idx + 1) + ' leer'); return; }

  let buf = APP.audioBuffers[bk(s.id, idx)];
  if (!buf) {
    // Lazy-load, dann GENAU diesen Slot (idx) weiterverwenden — nie
    // erneut über playSound()/curSlot neu bestimmen lassen.
    toast('Audio lädt…');
    actx(); // stellt sicher, dass der AudioContext existiert (User-Gesture)
    buf = await decodeAudioSmart(s.id, idx, slot.data);
    if (!buf) { toast('Audio konnte nicht geladen werden', 'err'); return; }
  }

  const gs       = APP.globalSettings;
  const ctx      = actx();

  // "Wiedergabe & Verhalten" — Crossfade: nur sinnvoll bei einem
  // tatsächlichen Übergang zwischen zwei GLEICHZEITIG laufenden Instanzen
  // DESSELBEN Sounds — das setzt Overlap voraus (sonst hat stopAll() unten
  // ohnehin bereits alles beendet) und mindestens eine bereits aktive
  // Instanz dieses Sounds (ein Retrigger, kein Erststart). Preview nimmt
  // bewusst nicht teil (isolierter Lifecycle, s. APP.audioPreview-Doku).
  const cf = s.playback?.crossfade;
  const existingInstances = APP.activeAudio[s.id] || [];
  const doCrossfade = !!(cf?.enabled) && cf.duration > 0 && !!gs.overlap && !opts.isPreview && existingInstances.length > 0;

  if (!gs.overlap && !opts.isPreview) stopAll();

  if (doCrossfade) {
    // Alte Instanz(en) desselben Sounds über die Crossfade-Dauer ausblenden
    // und danach stoppen — identische Technik wie der bestehende Makro-
    // "fadeout"-Action-Handler (cancelScheduledValues + Rampe + verzögertes
    // stop()), hier nur mit wählbarer Kurvenform statt fest linear.
    existingInstances.forEach(a => {
      try {
        a.gain.gain.cancelScheduledValues(ctx.currentTime);
        a.gain.gain.setValueAtTime(a.gain.gain.value, ctx.currentTime);
        scheduleFadeCurve(a.gain, cf.curve || 'linear', a.gain.gain.value, 0, ctx.currentTime, cf.duration);
        setTimeout(() => { try { a.src.stop(); } catch (e) {} }, cf.duration * 1000 + 50);
      } catch (e) {}
    });
  }

  // P1 Render-Pipeline (renderPipeline.js): identischer Graph-Aufbau wie
  // Export — behebt strukturell die im P0-Audit beschriebenen Divergenzen
  // (Pitch/Noise-Gate) und eine bei der Vereinheitlichung zusätzlich
  // entdeckte: Fades/Envelope fehlten bisher komplett im Export-Pfad.
  const graph = await renderSoundGraph(ctx, buf, slot, s, {
    mode: opts.isPreview ? 'preview' : 'live',
    destination: ctx.destination,
    masterVol: gs.masterVol ?? 1,
    crossfadeIn: doCrossfade ? { duration: cf.duration, curve: cf.curve || 'linear' } : null
  });
  const { src, masterGain, analyser, dur } = graph;

  if (!APP.activeAudio[s.id]) APP.activeAudio[s.id] = [];
  APP.activeAudio[s.id].push({ src, gain: masterGain, dur });
  notifyDuckTrigger(); // P2 Auto Duck

  graph.start(0);
  src.onended = () => {
    if (APP.activeAudio[s.id]) {
      APP.activeAudio[s.id] = APP.activeAudio[s.id].filter(x => x.src !== src);
      if (!APP.activeAudio[s.id].length) { delete APP.activeAudio[s.id]; _setPlaying(s.id, false); }
    }
    _updateStatusDot(); refreshRotBadge(s.id);
    if (analyser && !APP.activeAudio[s.id]?.length) stopAnalyzer();
    notifyDuckRelease(); // P2 Auto Duck — no-op, falls noch andere Sounds aktiv sind
  };

  _setPlaying(s.id, true); _updateStatusDot();
  animProg(s.id, dur); refreshRotBadge(s.id);

  if (analyser) {
    const cv = document.getElementById('analyzerCanvas');
    if (cv) startAnalyzerLoop(analyser, cv, s.effects?.analyzer?.mode || 'bars');
  }
}

export function playSoundAndWait(s) {
  return new Promise(async resolve => {
    const slots = s.slots || [];
    // Wie playSound() oben: ein Sound ganz ohne Audioslot ist seit Abschnitt 11
    // ein gültiger Zustand — hier einfach überspringen (gleiches Verhalten wie
    // ein leerer Einzel-Slot weiter unten: resolve() ohne Wiedergabe).
    if (!slots.length) { resolve(); return; }
    let idx = s.random ? Math.floor(Math.random() * slots.length) : (s.curSlot || 0) % slots.length;
    if (!s.random) s.curSlot = (idx + 1) % slots.length;
    const slot = slots[idx]; if (!slot?.data) { resolve(); return; }
    // Bugfix (Konsistenz aller Playback-Wege, Abschnitt 6): auch die
    // sequenzielle Makro-Wiedergabe muss denselben Lazy-Load-Pfad wie
    // normales Playback nutzen, statt bei einem Cache-Miss den Slot
    // stillschweigend zu überspringen (führte zu "fehlenden" Sounds in
    // Makros direkt nach einem Bulk-Import, bevor der Cache warmgelaufen war).
    actx();
    let buf = APP.audioBuffers[bk(s.id, idx)];
    if (!buf) buf = await decodeAudioSmart(s.id, idx, slot.data);
    if (!buf) { resolve(); return; }
    const gs = APP.globalSettings; const ctx = actx();

    // allowLoop:false — Bestandsverhalten bewusst beibehalten: sequenzielle
    // Makro-Wiedergabe darf NIE loopen, sonst würde `onended` nie feuern
    // und die await-Kette der Makro-Sequenz für immer hängen bleiben.
    const graph = await renderSoundGraph(ctx, buf, slot, s, {
      mode: 'live',
      destination: ctx.destination,
      masterVol: gs.masterVol ?? 1,
      allowLoop: false
    });
    const { src, masterGain, dur } = graph;

    if (!APP.activeAudio[s.id]) APP.activeAudio[s.id] = [];
    APP.activeAudio[s.id].push({ src, gain: masterGain, dur });
    notifyDuckTrigger(); // P2 Auto Duck
    graph.start(0);
    src.onended = () => {
      if (APP.activeAudio[s.id]) {
        APP.activeAudio[s.id] = APP.activeAudio[s.id].filter(x => x.src !== src);
        if (!APP.activeAudio[s.id].length) { delete APP.activeAudio[s.id]; _setPlaying(s.id, false); }
      }
      _updateStatusDot(); refreshRotBadge(s.id);
      notifyDuckRelease(); // P2 Auto Duck
      resolve();
    };
    _setPlaying(s.id, true); _updateStatusDot(); animProg(s.id, dur); refreshRotBadge(s.id);
  });
}

/* ═══════════════ EFFEKT-EDITOR-PREVIEW (isolierter Lifecycle) ═══════════
 * Läuft komplett NEBEN der normalen Soundboard-Wiedergabe: eigener State
 * (APP.audioPreview statt APP.activeAudio), kein _setPlaying()/kein
 * Tile-Highlight, kein Auto-Duck, keine Rotation-/Fortschrittsanzeige,
 * kein stopAll()/stopItem() auf echte Sounds. Nutzt aber dieselbe
 * renderSoundGraph()-Pipeline wie Live-Playback/Export (Abschnitt 28) —
 * dieselben Effekte, derselbe Analyzer-Aufbau, keine zweite Engine.
 *
 * previewSound() ist der öffentliche Einstiegspunkt (Bestandsname/-signatur
 * beibehalten, Abschnitt 30) und togglet intern zwischen
 * startEffectPreview()/stopEffectPreview().
 * ══════════════════════════════════════════════════════════════════════ */

function _stopPreviewSourceOnly() {
  const p = APP.audioPreview;
  if (p.src) {
    // Abschnitt 14: mehrfaches/zu spätes .stop() (Quelle bereits von selbst
    // beendet) darf nie zu einem sichtbaren Fehler führen.
    try { p.src.onended = null; p.src.stop(); } catch (e) { /* bereits beendet — ignorieren */ }
  }
}

/**
 * Zentrale, einzige Cleanup-Stelle für die Effekt-Editor-Preview
 * (Abschnitt 35). Wird aufgerufen bei: Stop-Klick, natürlichem Ende,
 * Start einer neuen Preview (ersetzt die alte), Modal-Schließen,
 * Speichern und Abbrechen.
 */
export function stopEffectPreview() {
  const p = APP.audioPreview;
  p.token++; // entwertet jede noch wartende startEffectPreview()-Anfrage (Decode/Graph-Aufbau)
  _stopPreviewSourceOnly();
  if (p.analyser) stopAnalyzer();
  p.playing = false; p.loading = false;
  p.src = null; p.masterGain = null; p.analyser = null;
  p.soundId = null; p.slotIdx = null;
  _updatePreviewButton();
}

async function startEffectPreview(s, slotIdx) {
  const p = APP.audioPreview;
  stopEffectPreview(); // Abschnitt 15: eine evtl. laufende/ladende Preview immer zuerst sauber beenden
  const myToken = p.token; // stopEffectPreview() hat token bereits erhöht — dieser Aufruf "besitzt" ihn jetzt

  const slot = s.slots?.[slotIdx];
  if (!slot?.data) { toast('Slot ' + (slotIdx + 1) + ' leer'); return; }

  p.loading = true; _updatePreviewButton();
  actx(); // stellt AudioContext innerhalb der User-Geste sicher (Abschnitt 21/22)
  const ctx = actx();

  // Abschnitt 19: bestehenden Cache verwenden, nicht unnötig neu dekodieren.
  let buf = APP.audioBuffers[bk(s.id, slotIdx)];
  if (!buf) {
    try {
      buf = await getOrDecodeBuffer(s.id, slotIdx, slot.data, ctx);
    } catch (e) {
      console.error('[audio] Preview-Decode-Fehler:', e);
      buf = null;
    }
  }
  if (myToken !== p.token) return; // zwischenzeitlich gestoppt/durch neue Preview ersetzt

  if (!buf) {
    toast('Audio konnte nicht geladen werden', 'err');
    p.loading = false; _updatePreviewButton();
    return;
  }

  let graph;
  try {
    // mode:'preview' — dieselbe Pipeline wie Live/Export (Abschnitt 28/29),
    // erzeugt seit dem P3-Fix auch hier einen Analyser, falls in den
    // aktuellen Effekten aktiviert (Abschnitt 3/8).
    graph = await renderSoundGraph(ctx, buf, slot, s, { mode: 'preview', destination: ctx.destination });
  } catch (e) {
    console.error('[audio] Preview-Graph-Fehler:', e);
    graph = null;
  }
  if (myToken !== p.token) {
    // Zwischenzeitlich gestoppt/durch neue Preview ersetzt, während der
    // Graph aufgebaut wurde — src wurde noch nie gestartet, daher
    // disconnect() statt stop() (stop() vor start() wirft InvalidStateError).
    try { graph?.src.disconnect(); } catch (e) {}
    return;
  }

  if (!graph) {
    toast('Vorschau-Fehler', 'err');
    p.loading = false; _updatePreviewButton();
    return;
  }

  const { src, masterGain, analyser, dur } = graph;
  p.loading = false; p.playing = true;
  p.src = src; p.masterGain = masterGain; p.analyser = analyser;
  p.soundId = s.id; p.slotIdx = slotIdx;

  src.onended = () => {
    // Abschnitt 13/15: onended kann auch von einer bereits ERSETZTEN
    // Quelle nachträglich feuern — nur reagieren, wenn es noch DIESE ist.
    if (APP.audioPreview.src !== src) return;
    stopEffectPreview();
  };

  graph.start(0);
  _updatePreviewButton();

  if (analyser) {
    const cv = document.getElementById('analyzerCanvas');
    if (cv) startAnalyzerLoop(analyser, cv, s.effects?.analyzer?.mode || 'bars');
  }
  void dur; // (aktuell ungenutzt — Preview braucht keine Fortschrittsanzeige)
}

/**
 * Öffentlicher Einstiegspunkt: togglet die Effekt-Editor-Preview für Sound
 * `s`, Slot `slotIdx`. Läuft bereits eine Preview (spielend oder ladend),
 * wird sie gestoppt (Abschnitt 5/14) — Argumente werden dann ignoriert.
 * Sonst wird eine neue gestartet (ersetzt automatisch eine evtl. andere
 * laufende Preview, Abschnitt 15).
 */
export async function previewSound(s, slotIdx) {
  if (APP.audioPreview.playing || APP.audioPreview.loading) { stopEffectPreview(); return; }
  await startEffectPreview(s, slotIdx ?? 0);
}

/**
 * Abschnitt 38: "Analyzer AUS ≠ Preview AUS" — reagiert auf die
 * Spektrum-Analyzer-Checkbox im FX-Dialog, OHNE eine laufende Preview zu
 * beenden. Beim Deaktivieren wird nur die Visualisierungsschleife
 * gestoppt (stopAnalyzer()); beim Reaktivieren wird — sofern gerade eine
 * Preview läuft — ein neuer AnalyserNode LIVE in den bereits laufenden
 * Graph gespleißt (masterGain → Analyser → Destination), da der Graph
 * ohne Analyzer aufgebaut wurde, falls dieser bei Preview-Start
 * deaktiviert war. Ohne laufende Preview ist dies ein No-op — die
 * nächste Preview erzeugt den Analyser dann regulär über renderSoundGraph().
 */
export function syncPreviewAnalyzer(enabled) {
  const p = APP.audioPreview;
  if (!p.playing || !p.masterGain) { updateAnalyzerIdleHint(); return; }
  if (!enabled) { if (p.analyser) stopAnalyzer(); return; }

  const ctx = actx();
  try { p.masterGain.disconnect(); } catch (e) {}
  const analyser = createAnalyzerSplit(ctx);
  p.masterGain.connect(analyser);
  analyser.connect(ctx.destination);
  p.analyser = analyser;
  const cv = document.getElementById('analyzerCanvas');
  const mode = document.getElementById('fxAnalyzerMode')?.value || 'bars';
  if (cv) startAnalyzerLoop(analyser, cv, mode);
}

function _updatePreviewButton() {
  const p = APP.audioPreview;
  // Abschnitt 5: zwei Buttons steuern dieselbe Preview — #btnPreviewSound
  // (Sticky-Bar des Sound-Editors) und #btnPreviewFx (Footer von
  // "Audio-Effekte"). Beide müssen denselben Zustand zeigen.
  ['btnPreviewSound', 'btnPreviewFx'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const icon = btn.querySelector('i');
    btn.disabled = p.loading;
    if (p.loading) {
      if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
      btn.setAttribute('aria-label', 'Vorschau wird geladen…');
    } else if (p.playing) {
      if (icon) icon.className = 'fa-solid fa-stop u-text-accent';
      btn.setAttribute('aria-label', 'Vorschau stoppen');
    } else {
      if (icon) icon.className = 'fa-solid fa-play u-text-accent';
      btn.setAttribute('aria-label', 'Vorschau');
    }
  });
  updateAnalyzerIdleHint();
}

/**
 * Abschnitt 24: dezenter Hinweis auf dem Analyzer-Canvas, solange der
 * Analyzer aktiviert, aber gerade nichts zu visualisieren ist (keine
 * laufende Preview) — sonst wirkt das Canvas nur leer/defekt. No-op außerhalb
 * des Audio-Effekt-Dialogs (Elemente existieren dann schlicht nicht im DOM).
 */
export function updateAnalyzerIdleHint() {
  const wrap = document.getElementById('analyzerCanvasWrap');
  if (!wrap) return;
  const enabled = !!document.getElementById('fxAnalyzerEnabled')?.checked;
  wrap.classList.toggle('is-idle', enabled && !APP.analyzer.active);
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
    const hasFx = s.effects?.enabled;
    const numCh = liveBuf.numberOfChannels; const sr = liveBuf.sampleRate;
    // Tail-Puffer für Reverb/Delay-Ausklang (Bestandsverhalten unverändert).
    const offCtx = new OfflineAudioContext(numCh, Math.ceil((dur + (hasFx ? 3.5 : 0)) * sr), sr);

    // P1 Render-Pipeline (renderPipeline.js): derselbe Graph-Aufbau wie
    // Live-Playback/Preview. Trim geschieht per start(when, offset, duration)
    // direkt auf dem UNGETRIMMTEN liveBuf — die manuelle Trim-Buffer-Kopie
    // entfällt dadurch (AudioBufferSourceNode.start() mit offset/duration
    // funktioniert für OfflineAudioContext identisch wie live). Als
    // Nebeneffekt der Vereinheitlichung werden jetzt AUCH Fades/Envelope
    // korrekt mitgerendert, die im alten Export-Code komplett fehlten.
    const graph = await renderSoundGraph(offCtx, liveBuf, slot, s, {
      mode: 'export',
      destination: offCtx.destination
    });
    graph.start(0);
    const rendered = await offCtx.startRendering();

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
