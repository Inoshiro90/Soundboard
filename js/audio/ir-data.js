/**
 * audio/ir-data.js — Impulsantwort-Generierung für Reverb
 */

import { APP } from '../core/state.js';
import { reverbIsLegacy, reverbIRKey, synthReverbIR } from './ir-synth.js';   // P19a

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
export function getIRBuffer(ctx, name, maxDur) {
  const key = name || 'default';
  const base = IR_PARAMS[key] || IR_PARAMS.default;
  // Degradation (Phase 3a, AE-16): `maxDur` kürzt die IR (eigener Cache-Eintrag); ohne Obergrenze unverändert.
  const cut = Number.isFinite(maxDur) && maxDur > 0 && base.duration > maxDur;
  const ck  = ctx.sampleRate + ':' + key + (cut ? '@' + maxDur : '');
  if (APP.irCache[ck]) return APP.irCache[ck];
  const p   = cut ? { ...base, duration: maxDur } : base;
  const buf = _buildIR(ctx, p);
  APP.irCache[ck] = buf;
  return buf;
}

/**
 * Generische (unbenannte) Reverb-IR. Altdaten (ir-synth.js reverbIsLegacy): _buildIR(), gecacht nach (Rate, Dauer, Decay, Vorlauf) —
 * deterministisch. P19a (Befund 7): der Vorlauf `pre` gehört zum Schlüssel, weil _buildIR und der Seed ihn verwenden; vorher teilten
 * sich IRs mit verschiedenem `pre` einen Eintrag (der erste gewann). Ohne `pre` im Datensatz ist der Klang unverändert.
 * Neue Synthese (P19a): ir-synth.js synthReverbIR(), eigener LRU-Cache mit Byte-Deckel (s. unten).
 */
export function getGenericIR(ctx, p) {
  if (!reverbIsLegacy(p)) return _getSynthIR(ctx, p);
  const ck = `${ctx.sampleRate}:g:${p.duration ?? 2.2}:${p.decay ?? 2.0}:${p.pre ?? 0.005}`;
  if (APP.irCache[ck]) return APP.irCache[ck];
  const buf = _buildIR(ctx, p);
  APP.irCache[ck] = buf;
  return buf;
}

// ─── P19a: Cache der synthetisierten IRs ───────────────────────────────────────────────────────────
// Jeder Reglerwert ergibt eine eigene IR (bis ≈ 6 MB bei 15 s Stereo @ 48 kHz). Deshalb LRU nach Byte-Größe (Länge × Kanäle × 4),
// getrennt vom bisherigen APP.irCache (dessen Einträge bleiben unbegrenzt wie bisher). Ein verdrängter Buffer bleibt gültig,
// solange ein Convolver ihn hält; er wird beim nächsten Bedarf neu (identisch) synthetisiert.
export const IR_SYNTH_CAP_BYTES = 48 * 1024 * 1024;
let _synthCap = IR_SYNTH_CAP_BYTES;
const _synth = new Map();   // Schlüssel → { buf, bytes }; Einfügereihenfolge = LRU
let _synthBytes = 0;
function _getSynthIR(ctx, p) {
  const ck = `${ctx.sampleRate}:${reverbIRKey(p)}`;
  const hit = _synth.get(ck);
  if (hit) { _synth.delete(ck); _synth.set(ck, hit); return hit.buf; }
  const [l, r] = synthReverbIR(p, ctx.sampleRate);
  const buf = ctx.createBuffer(2, l.length, ctx.sampleRate);
  buf.getChannelData(0).set(l); buf.getChannelData(1).set(r);
  const bytes = l.length * 2 * 4;
  if (bytes <= _synthCap) {
    _synth.set(ck, { buf, bytes }); _synthBytes += bytes;
    for (const [k, e] of _synth) { if (_synthBytes <= _synthCap) break; _synth.delete(k); _synthBytes -= e.bytes; }
  }
  return buf;
}
/** Diagnose/Tests: { entries, bytes, cap }. */
export function irSynthStats() { return { entries: _synth.size, bytes: _synthBytes, cap: _synthCap }; }
/** Tests: Deckel setzen (Bytes; ohne Argument Standard) und auf ihn kürzen. */
export function setIrSynthCap(bytes = IR_SYNTH_CAP_BYTES) {
  _synthCap = Math.max(0, bytes);
  for (const [k, e] of _synth) { if (_synthBytes <= _synthCap) break; _synth.delete(k); _synthBytes -= e.bytes; }
}
/** Tests: Cache leeren. */
export function clearIrSynthCache() { _synth.clear(); _synthBytes = 0; }

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
