/**
 * audio/engine/dynamics-node.js — Gate/Expander-Knoten (Phase 11a): dünne Hülle um das Worklet `dynamics`.
 * Vertrag wie modsources.js: { input, output, update(p), dispose() } oder null, wenn das Worklet im Context nicht geladen ist
 * (Aufrufer: vorher `await ensureWorklets(ctx, ['dynamics'])`; Fallback laut Worklet-Registry: Baustein überspringen, mit Hinweis).
 * Zeiten kommen in ms (wie noiseGate/expander im Datenmodell) und gehen als Sekunden ins Worklet.
 */
import { isWorkletReady } from '../context.js';

const SMOOTH_TC = 0.02;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** @param {'gate'|'expander'} kind  @param {object} p Modulparameter (threshold, range, attack, hold, release, hysteresis, ratio, scHp) */
export function makeDynamicsNode(ctx, kind, p = {}) {
  if (!isWorkletReady(ctx, 'dynamics')) return null;
  let node;
  try {
    node = new AudioWorkletNode(ctx, 'dynamics-processor', { numberOfInputs: 1, numberOfOutputs: 1 });   // Ausgangskanäle = Eingangskanäle
  } catch (e) { console.warn('[audio] Dynamics-Worklet nicht erzeugbar:', e && e.message); return null; }
  const prm = node.parameters;
  const apply = (q, smooth) => {
    const t = ctx.currentTime;
    const set = (name, v) => { const a = prm.get(name); if (!a || !Number.isFinite(v)) return; smooth ? a.setTargetAtTime(v, t, SMOOTH_TC) : a.setValueAtTime(v, t); };
    set('threshold', num(q.threshold, kind === 'gate' ? -50 : -40));
    set('range', num(q.range, kind === 'gate' ? -80 : -40));
    set('attack', Math.max(0.0001, num(q.attack, 5) / 1000));
    set('release', Math.max(0.0001, num(q.release, 150) / 1000));
    set('hold', kind === 'gate' ? Math.max(0, num(q.hold, 50) / 1000) : 0);
    set('hysteresis', kind === 'gate' ? num(q.hysteresis, 3) : 0);
    set('ratio', kind === 'gate' ? 2 : num(q.ratio, 2));
    set('scHp', num(q.scHp, 20));
  };
  prm.get('mode').setValueAtTime(kind === 'gate' ? 0 : 1, ctx.currentTime);
  apply(p, false);
  let disposed = false;
  return {
    input: node, output: node,
    update(np = {}) { if (!disposed) apply(np, true); },
    dispose() { if (disposed) return; disposed = true; try { node.disconnect(); } catch (e) { /* bereits getrennt */ } try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } }   // Prozessor beenden (Fix A)
  };
}
