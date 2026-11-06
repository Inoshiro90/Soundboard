/**
 * audio/engine/dynamics-node.js — Gate/Expander-/Limiter-/Transient-Knoten (Phase 11a/11b/11d): dünne Hülle um das Worklet `dynamics`.
 * Vertrag wie modsources.js: { input, output, update(p), dispose() } oder null, wenn das Worklet im Context nicht geladen ist
 * (Aufrufer: vorher `await ensureWorklets(ctx, ['dynamics'])`; Fallback laut Worklet-Registry: Baustein überspringen, mit Hinweis).
 * Zeiten kommen in ms (wie noiseGate/expander im Datenmodell) und gehen als Sekunden ins Worklet. Ausnahme Limiter: `release` liegt im Datenmodell
 * seit jeher in Sekunden (Altdaten 0,08), `lookahead` in ms. `lookahead` gilt nur bei der Erzeugung (Änderung = neuer Knoten, siehe
 * effect-graph.js `_buildLimiter`); `latencySamples` meldet die Latenz der Instanz.
 * Seitenkette (Nachbesserung 19a, Teil 5, Gate/Expander): Option `{ sidechain: true }` → zweiter Eingang, zurückgegeben als
 * `sidechain` = { node, input } (Anschluss: `src.connect(node, 0, input)`); er steuert die Erkennung, der Sidechain-Hochpass `scHp` wirkt
 * auf ihn. Ausgang dann fest stereo. Ohne Option unverändert (ein Eingang, `sidechain` = null).
 */
import { isWorkletReady } from '../context.js';

const SMOOTH_TC = 0.02;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** @param {'gate'|'expander'|'limiter'|'transient'} kind  @param {object} p Modulparameter (Gate/Expander: threshold, range, attack, hold, release, hysteresis, ratio, scHp; Limiter: threshold = Ceiling, inputGain, release in s, lookahead in ms) */
export function makeDynamicsNode(ctx, kind, p = {}, { sidechain = false } = {}) {
  if (!isWorkletReady(ctx, 'dynamics')) return null;
  const lookaheadMs = Math.min(20, Math.max(1, num(p.lookahead, 5)));
  // Parameterwerte je Art (Namen = AudioParams des Prozessors). Unverändert gegenüber Phase 11, nur als Objekt statt Einzelaufrufen.
  const values = q => {
    if (kind === 'transient') {                         // Phase 11d: attack/sustain in dB, sensitivity/mix 0…1, release in ms
      return { tAttack: num(q.attack, 0), tSustain: num(q.sustain, 0), sensitivity: num(q.sensitivity, 0.5),
        release: Math.max(0.005, num(q.release, 150) / 1000), mix: num(q.mix, 1) };
    }
    if (kind === 'limiter') {
      return { threshold: num(q.threshold, -1), inputGain: num(q.inputGain, 0), release: Math.max(0.0001, num(q.release, 0.08)) };
    }
    return {
      threshold: num(q.threshold, kind === 'gate' ? -50 : -40),
      range: num(q.range, kind === 'gate' ? -80 : -40),
      attack: Math.max(0.0001, num(q.attack, 5) / 1000),
      release: Math.max(0.0001, num(q.release, 150) / 1000),
      hold: kind === 'gate' ? Math.max(0, num(q.hold, 50) / 1000) : 0,
      hysteresis: kind === 'gate' ? num(q.hysteresis, 3) : 0,
      ratio: kind === 'gate' ? 2 : num(q.ratio, 2),
      scHp: num(q.scHp, 20)
    };
  };
  const finite = o => Object.fromEntries(Object.entries(o).filter(([, v]) => Number.isFinite(v)));
  // Startwerte (Phase 12e) über `parameterData`: gelten ab dem ersten Block. Bis Phase 12 kamen sie per setValueAtTime, und das
  // greift in der Node-Engine erst einen Block später [S, 12c] — der erste Block lief dort mit den Standardwerten des Prozessors (Modus 0 = Gate).
  const start = finite({
    mode: kind === 'gate' ? 0 : kind === 'expander' ? 1 : kind === 'limiter' ? 2 : 3,
    ...(kind === 'limiter' ? { lookahead: lookaheadMs / 1000 } : {}),
    ...values(p)
  });
  const sc = !!sidechain && (kind === 'gate' || kind === 'expander');
  let node;
  try {
    node = new AudioWorkletNode(ctx, 'dynamics-processor', sc
      // Zwei Eingänge: Die Ausgangskanalzahl folgt dann nicht mehr dem Eingang (Spezifikation: sonst 1) → fest stereo; Mono-Eingang
      // verteilt das Worklet auf beide Kanäle (wie das Up-Mix „speakers“ Mono → Stereo).
      ? { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], parameterData: start, processorOptions: { sidechain: true } }
      : { numberOfInputs: 1, numberOfOutputs: 1, parameterData: start });   // Ausgangskanäle = Eingangskanäle
  } catch (e) { console.warn('[audio] Dynamics-Worklet nicht erzeugbar:', e && e.message); return null; }
  const prm = node.parameters;
  // Live-Änderungen geglättet (wie bisher).
  const apply = q => {
    const t = ctx.currentTime;
    for (const [name, v] of Object.entries(finite(values(q)))) { const a = prm.get(name); if (a) a.setTargetAtTime(v, t, SMOOTH_TC); }
  };
  let disposed = false;
  // Seitenkette: Anschluss per `src.connect(sidechain.node, 0, sidechain.input)`.
  const sidechainIn = sc ? { node, input: 1 } : null;
  return {
    input: node, output: node, sidechain: sidechainIn,
    latencySamples: kind === 'limiter' ? Math.min(Math.ceil(ctx.sampleRate * 0.02), Math.max(1, Math.round(lookaheadMs / 1000 * ctx.sampleRate))) : 0,
    update(np = {}) { if (!disposed) apply(np); },
    dispose() { if (disposed) return; disposed = true; try { node.disconnect(); } catch (e) { /* bereits getrennt */ } try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } }   // Prozessor beenden (Fix A)
  };
}
