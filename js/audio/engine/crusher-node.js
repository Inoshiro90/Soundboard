/**
 * audio/engine/crusher-node.js — Bitcrusher-Knoten (Phase 15c): dünne Hülle um das Worklet `crusher`.
 * Vertrag wie delayline-node.js: { input, output, update(p), dispose() } oder null, wenn das Worklet im Context nicht geladen ist
 * (Aufrufer: vorher `await ensureWorklets(ctx, ['crusher'])`; Fallback laut Worklet-Registry: native Quantisierungskurve ohne Sample-Rate-Reduktion).
 */
import { isWorkletReady } from '../context.js';
import { crusherValues } from './registry.js';

export function makeCrusherNode(ctx, p = {}) {
  if (!isWorkletReady(ctx, 'crusher')) return null;
  let node;
  try {
    // Startwerte über `parameterData` (gelten ab dem ersten Block, wie beim Flanger)
    node = new AudioWorkletNode(ctx, 'crusher-processor', { numberOfInputs: 1, numberOfOutputs: 1, parameterData: crusherValues(p) });
  } catch (e) { console.warn('[audio] Crusher-Worklet nicht erzeugbar:', e && e.message); return null; }
  const prm = node.parameters;
  const apply = q => {
    const t = ctx.currentTime;
    for (const [name, v] of Object.entries(crusherValues(q))) { const a = prm.get(name); if (a && Number.isFinite(v)) a.setValueAtTime(v, t); }
  };
  let disposed = false;
  return {
    input: node, output: node,
    update(np = {}) { if (!disposed) apply(np); },
    dispose() { if (disposed) return; disposed = true; try { node.disconnect(); } catch (e) { /* bereits getrennt */ } try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } }
  };
}
