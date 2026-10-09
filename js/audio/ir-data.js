/**
 * audio/ir-data.js — Impulsantwort-Generierung für Reverb
 */

import { APP } from '../core/state.js';

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

/**
 * Gültige Impulsantwort-Namen für irReverb.impulse, zur Wiederverwendung bei der
 * Validierung importierter Presets (siehe presets.js normalizeEffectsObject()).
 * 'default' bewusst ausgeschlossen — kein eigener wählbarer Name in der UI (fxIrImpulse).
 */
export const IR_IMPULSE_NAMES = Object.keys(IR_PARAMS).filter(k => k !== 'default');

/**
 * Dauer (Sekunden) einer benannten Impulsantwort — für die Tail-Schätzung der Pipeline
 * (audio/fx-pipeline.js estimateTail()). Unbekannte/leere Namen verhalten sich wie getIRBuffer(): 'default'.
 */
export function getIRDuration(name) {
  const p = IR_PARAMS[name || 'default'] || IR_PARAMS.default;
  return (p.pre ?? 0) + (p.duration ?? 2.2);
}

// Cache-Schlüssel enthält die Sample-Rate: ein ConvolverNode akzeptiert nur Buffer mit der Rate seines
// Contexts (sonst NotSupportedError). Live (AudioContext) und Export (OfflineAudioContext mit der Rate
// der Quelldatei) können unterschiedliche Raten haben.
export function getIRBuffer(ctx, name) {
  const key = name || 'default';
  const ck  = ctx.sampleRate + ':' + key;
  if (APP.irCache[ck]) return APP.irCache[ck];
  const p   = IR_PARAMS[key] || IR_PARAMS.default;
  const buf = _buildIR(ctx, p);
  APP.irCache[ck] = buf;
  return buf;
}

/** Generische (unbenannte) Reverb-IR, gecacht nach (Rate, Dauer, Decay) — _buildIR() ist deterministisch. */
export function getGenericIR(ctx, p) {
  const ck = `${ctx.sampleRate}:g:${p.duration ?? 2.2}:${p.decay ?? 2.0}`;
  if (APP.irCache[ck]) return APP.irCache[ck];
  const buf = _buildIR(ctx, p);
  APP.irCache[ck] = buf;
  return buf;
}

// Seeded PRNG (mulberry32): Live-Wiedergabe, Preview und Export erzeugen für gleiche Parameter
// dieselbe Impulsantwort — vorher Math.random(), daher klang jeder Aufbau minimal anders.
function _mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _seedFor(p) {
  const str = `${p.duration ?? 2.2}|${p.decay ?? 2.0}|${p.pre ?? 0.005}`;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Exportiert: _buildReverb() in audio/effect-graph.js nutzt _buildIR() für den
// generischen (nicht-benannten) Reverb-Algorithmus, getIRBuffer() (oben) für die
// benannten IR-Presets.
export function _buildIR(ctx, p) {
  const sr    = ctx.sampleRate;
  const pre   = Math.floor((p.pre  ?? 0.005) * sr);
  const body  = Math.floor((p.duration ?? 2.2) * sr);
  const total = pre + body;
  const decay = p.decay ?? 2.0;
  const buf   = ctx.createBuffer(2, total, sr);
  const rnd   = _mulberry32(_seedFor(p));
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < pre;  i++) d[i] = 0;
    for (let i = 0; i < body; i++) {
      const env  = Math.pow(1 - i / body, decay);
      const rand = (rnd() * 2 - 1) + (ch === 1 ? (rnd() - 0.5) * 0.1 : 0);
      d[pre + i] = rand * env;
    }
  }
  return buf;
}
