/**
 * audio/engine/degrade.js — Degradation anwenden (AE-16, Phase 3a). REIN: erzeugt aus einem Plan einen NEUEN Plan mit
 * abgesenkten Parametern; der Original-Plan und die gespeicherten Effektdaten bleiben unberührt (Invariante 3).
 * Reihenfolge der Stufen und deren Wahl: voices.js (DEGRADE_LEVELS). Der Aufrufer baut den Graphen aus dem NEUEN Plan.
 *   equalPower → spatial.equalPower = true (Panner nutzt 'equalpower' statt HRTF; effect-graph.js)
 *   oversample → distortion.oversample höchstens auf diese Stufe
 *   irMax      → reverb.duration ≤ irMax; irReverb.irMax = irMax (IR wird gekürzt; ir-data.js getIRBuffer)
 * Die Reihenfolge der Schritte/Layer ändert sich nie.
 */
const OS = ['none', '2x', '4x'];

export function applyDegrade(plan, degrade) {
  if (!degrade) return plan;
  const steps = plan.steps.map(step => {
    const params = { ...step.params };
    const d = params.distortion;
    if (d && degrade.oversample && OS.indexOf(d.oversample ?? '4x') > OS.indexOf(degrade.oversample)) params.distortion = { ...d, oversample: degrade.oversample };
    if (degrade.equalPower && params.spatial?.enabled) params.spatial = { ...params.spatial, equalPower: true };
    if (Number.isFinite(degrade.irMax)) {
      if (params.reverb && (params.reverb.duration ?? 2.2) > degrade.irMax) params.reverb = { ...params.reverb, duration: degrade.irMax };
      if (params.irReverb) params.irReverb = { ...params.irReverb, irMax: degrade.irMax };
    }
    return { ...step, params };
  });
  return { ...plan, steps, degraded: degrade };
}
