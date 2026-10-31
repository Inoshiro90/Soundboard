/**
 * audio/engine/delayline-node.js — Flanger- und Phaser-Knoten (Phase 12c/12d): dünne Hülle um das Worklet `delayline`.
 * Vertrag wie dynamics-node.js: { input, output, update(p), dispose() } oder null, wenn das Worklet im Context nicht geladen ist
 * (Aufrufer: vorher `await ensureWorklets(ctx, ['delayline'])`; Fallback laut Worklet-Registry: nativer Flanger wie bisher, mit Marke).
 * Zeiten kommen in ms (Datenmodell des Flangers) und gehen als Sekunden ins Worklet. Die Glättung macht der Rechenkern (10 ms je Sample),
 * deshalb werden die Werte hier direkt gesetzt.
 */
import { isWorkletReady } from '../context.js';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const cl = (lo, hi, v) => Math.max(lo, Math.min(hi, v));

/** @param {object} p Flanger-Parameter (baseDelay/depth in ms, rate, feedback, mix, waveform, phase in Grad) */
export function makeFlangerNode(ctx, p = {}) {
  if (!isWorkletReady(ctx, 'delayline')) return null;
  // Klemmwerte wie der bisherige native Flanger (_buildModulatedDelay): baseDelay ≥ 0, depth ≥ 0, rate 0,01–10 Hz, feedback 0–0,95, mix 0–1
  const values = q => ({
    mode: 0,
    baseDelay: cl(0, 0.04, num(q.baseDelay, 2) / 1000),
    depth: cl(0, 0.02, num(q.depth, 1.5) / 1000),
    rate: cl(0.01, 10, num(q.rate, 0.2)),
    feedback: cl(0, 0.95, num(q.feedback, 0.5)),
    mix: cl(0, 1, num(q.mix, 0.5)),
    shape: q.waveform === 'triangle' ? 1 : 0,
    phase: cl(0, 180, num(q.phase, 0))
  });
  let node;
  try {
    // Startwerte über `parameterData`: gelten ab dem ersten Block (setValueAtTime greift in der Node-Engine erst einen Block später [S],
    // der Kern würde sonst die Standardwerte als Startzustand übernehmen und erst danach hingleiten).
    node = new AudioWorkletNode(ctx, 'delayline-processor', { numberOfInputs: 1, numberOfOutputs: 1, parameterData: values(p) });   // Ausgangskanäle = Eingangskanäle
  } catch (e) { console.warn('[audio] Delay-Line-Worklet nicht erzeugbar:', e && e.message); return null; }
  const prm = node.parameters;
  const apply = q => {
    const t = ctx.currentTime;
    for (const [name, v] of Object.entries(values(q))) { const a = prm.get(name); if (a && Number.isFinite(v)) a.setValueAtTime(v, t); }
  };
  let disposed = false;
  return {
    input: node, output: node,
    update(np = {}) { if (!disposed) apply(np); },
    dispose() { if (disposed) return; disposed = true; try { node.disconnect(); } catch (e) { /* bereits getrennt */ } try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } }
  };
}

/** Phaser-Stufen (12d): gerade Zahl 2…12 aus dem Datenwert (Text wie die Flankensteilheit). */
export const phaserStages = p => { const v = Math.round(Number(p?.stages) || 4); return Math.max(2, Math.min(12, v - (v % 2))); };

/** @param {object} p Phaser-Parameter (rate, depth 0…1, feedback, stages, center in Hz, mix) */
export function makePhaserNode(ctx, p = {}) {
  if (!isWorkletReady(ctx, 'delayline')) return null;
  const values = q => ({
    mode: 1,
    rate: cl(0.01, 10, num(q.rate, 0.5)),
    sweep: cl(0, 1, num(q.depth, 0.7)),
    feedback: cl(-0.9, 0.9, num(q.feedback, 0)),
    stages: phaserStages(q),
    center: cl(100, 8000, num(q.center, 800)),
    mix: cl(0, 1, num(q.mix, 0.5))
  });
  let node;
  try {
    node = new AudioWorkletNode(ctx, 'delayline-processor', { numberOfInputs: 1, numberOfOutputs: 1, parameterData: values(p) });
  } catch (e) { console.warn('[audio] Delay-Line-Worklet (Phaser) nicht erzeugbar:', e && e.message); return null; }
  const prm = node.parameters;
  const apply = q => {
    const t = ctx.currentTime;
    for (const [name, v] of Object.entries(values(q))) { if (name === 'mode' || name === 'stages') continue; const a = prm.get(name); if (a && Number.isFinite(v)) a.setValueAtTime(v, t); }
  };
  let disposed = false;
  return {
    input: node, output: node,
    update(np = {}) { if (!disposed) apply(np); },
    dispose() { if (disposed) return; disposed = true; try { node.disconnect(); } catch (e) { /* bereits getrennt */ } try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } }
  };
}
