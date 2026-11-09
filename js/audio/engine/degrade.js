/**
 * audio/engine/degrade.js — Degradation anwenden (AE-16, Phase 3a). REIN: erzeugt aus einem Plan einen NEUEN Plan mit
 * abgesenkten Parametern; der Original-Plan und die gespeicherten Effektdaten bleiben unberührt (Invariante 3).
 * Reihenfolge der Stufen und deren Wahl: voices.js (DEGRADE_LEVELS). Der Aufrufer baut den Graphen aus dem NEUEN Plan.
 *   equalPower → spatial.equalPower = true (Panner nutzt 'equalpower' statt HRTF; effect-graph.js)
 *   oversample → distortion.oversample höchstens auf diese Stufe
 *   irMax      → reverb.duration ≤ irMax; irReverb.irMax = irMax (IR wird gekürzt; ir-data.js getIRBuffer)
 *                (P19a: `reverb` mit neuer Synthese bekommt statt der Dauer das Laufzeitfeld irMax — die Nachhallzeit bleibt, die IR wird gekürzt)
 *                (P19e: nicht für `reverb` im Modus `reverse` — live gibt es dort keine Faltung, die Variante ist schon gerendert;
 *                 eine gekürzte IR passte nicht mehr zur Signatur der Variante und ließe das Wet-Signal verstummen)
 *   shimmer:false → reverb im Modus `shimmer` baut wie `room` (P19d, E5: spart das Pitch-Worklet; nur in der Kopie des Plans).
 *                Degradiert werden nur Board-Sounds; sie bekommen kein update(), der Modus der Kopie bleibt also bis zum Ende stehen.
 * Die Reihenfolge der Schritte/Layer ändert sich nie.
 */
import { reverbIsLegacy, reverbIRSeconds } from '../ir-synth.js';   // P19a
import { reverbBuiltMode, SPLIT_KEYS, splitBranches } from './registry.js';   // P19d; P22: Zweige

const OS = ['none', '2x', '4x'];

function _degradeParams(src, degrade) {
  const params = { ...src };
  const d = params.distortion;
  if (d && degrade.oversample && OS.indexOf(d.oversample ?? '4x') > OS.indexOf(degrade.oversample)) params.distortion = { ...d, oversample: degrade.oversample };
  if (degrade.equalPower && params.spatial?.enabled) params.spatial = { ...params.spatial, equalPower: true };
  if (Number.isFinite(degrade.irMax)) {
    if (params.reverb && reverbBuiltMode(params.reverb) === 'reverse') { /* P19e: nichts zu kürzen */ }
    else if (params.reverb && !reverbIsLegacy(params.reverb)) { if (reverbIRSeconds(params.reverb) > degrade.irMax) params.reverb = { ...params.reverb, irMax: degrade.irMax }; }   // P19a
    else if (params.reverb && (params.reverb.duration ?? 2.2) > degrade.irMax) params.reverb = { ...params.reverb, duration: degrade.irMax };
    if (params.irReverb) params.irReverb = { ...params.irReverb, irMax: degrade.irMax };
  }
  if (degrade.shimmer === false && params.reverb && reverbBuiltMode(params.reverb) === 'shimmer') params.reverb = { ...params.reverb, mode: 'room' };   // P19d
  return params;
}

export function applyDegrade(plan, degrade) {
  if (!degrade) return plan;
  const steps = plan.steps.map(step => {
    const params = _degradeParams(step.params, degrade);
    // P22: Zweigketten der Splitter mit denselben Stufen (Tiefe 1; nur in der Kopie des Plans).
    for (const key of SPLIT_KEYS) {
      const m = params[key];
      if (!m?.enabled) continue;
      let nm = null;
      for (const b of splitBranches(key, m)) {
        const c = m[b]?.chain;
        if (!c || typeof c !== 'object') continue;
        const nc = _degradeParams(c, degrade);
        if (!nm) nm = { ...m };
        nm[b] = { ...m[b], chain: nc };
      }
      if (nm) params[key] = nm;
    }
    return { ...step, params };
  });
  return { ...plan, steps, degraded: degrade };
}
