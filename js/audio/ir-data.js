/**
 * audio/ir-data.js — Impulsantwort-Generierung für Reverb
 * Ausgelagert aus audio.js (Phase 3 der Refaktorierung).
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

// Exportiert (Phase 3): _buildReverb() in audio/effect-graph.js nutzt
// _buildIR() für den generischen (nicht-benannten) Reverb-Algorithmus,
// getIRBuffer() (oben) für die benannten IR-Presets. Reine Sichtbarkeits-
// Erweiterung durch den Datei-Split, keine Verhaltensänderung.
export function _buildIR(ctx, p) {
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
