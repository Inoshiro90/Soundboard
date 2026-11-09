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

/**
 * Kamm-Bank (Phase 21a): Prozessor `combbank-processor` im Worklet `delayline` (Rechenkern dsp-lib/combbank.js). Nimmt die Kernwerte
 * { f0, ratios[8], decay, fb, damp, spread, mix, out[, wg, lim] } (registry.js combKernel bzw. resonatorKernel, 21b) und setzt sie als k-rate-Parameter.
 * Startwerte über `parameterData` (gelten ab dem ersten Block), Live-Werte per setValueAtTime; die Glättung (10 ms) macht der Kern.
 * Kanäle wie timebuffer-node.js: Eingang über einen StereoPanner bei pan 0 (M-3: Mono → L = R mit −3,01 dB, Stereo unverändert), Worklet fest
 * stereo (channelCount 2 'explicit', outputChannelCount [2]). Grund [S, Node]: ein kanalerhaltender Ausgang fällt nach dem Ende der Quelle auf
 * einen Kanal zurück; der terminale Panner senkte den Nachklang dann um 3 dB ab (Pipeline ≠ Kern ab dem Quellenende).
 * null, wenn das Worklet nicht geladen ist (Aufrufer überspringt das Modul, Fallback 'none').
 */
export function makeCombBankNode(ctx, kv = {}) {
  if (!isWorkletReady(ctx, 'delayline')) return null;
  const values = q => {
    const o = { f0: num(q.f0, 220), decay: num(q.decay, 0), fb: num(q.fb, 0), damp: num(q.damp, 0), spread: num(q.spread, 0), mix: num(q.mix, 1), out: num(q.out, 1),
      wg: num(q.wg, 1), lim: num(q.lim, 0) };   // 21b: Resonator-Kompensation; fehlen sie (comb), gelten die Standardwerte (Rechenweg wie 21a)
    for (let j = 0; j < 8; j++) o['r' + j] = Math.max(0, num(q.ratios?.[j], 0));
    return o;
  };
  let node, up;
  try {
    up = ctx.createStereoPanner();
    up.pan.value = 0;
    node = new AudioWorkletNode(ctx, 'combbank-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      parameterData: values(kv)
    });
    up.connect(node);
  } catch (e) { console.warn('[audio] Kamm-Bank-Worklet nicht erzeugbar:', e && e.message); try { up?.disconnect(); } catch { /* */ } return null; }
  const prm = node.parameters;
  const apply = q => {
    const t = ctx.currentTime;
    for (const [name, v] of Object.entries(values(q))) { const a = prm.get(name); if (a && Number.isFinite(v)) a.setValueAtTime(v, t); }
  };
  let disposed = false;
  return {
    input: up, output: node,
    update(nk = {}) { if (!disposed) apply(nk); },
    dispose() {
      if (disposed) return; disposed = true;
      try { up.disconnect(); } catch (e) { /* bereits getrennt */ }
      try { node.disconnect(); } catch (e) { /* bereits getrennt */ }
      try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ }
    }
  };
}
