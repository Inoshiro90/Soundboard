/**
 * audio/engine/modsources.js — Modulationsquellen (Phase 5): LFO und Hüllkurvenfolger als Steuersignal.
 * ----------------------------------------------------------------------------------------------------
 * Bausteine für Module ab P10/P12 (Auto-Filter, Auto-Wah, Phaser, Auto-Pan …). Bestehende Module (Tremolo, Chorus,
 * Flanger, Wah-Wah, Ringmod) bauen weiter ihre eigenen Oszillatoren; sie werden NICHT umgestellt (klangneutral, Goldens).
 *
 * Gemeinsamer Vertrag (wie EffectInstance, AE-04′): `output` (AudioNode, anschließbar an einen AudioParam),
 * `update(params)`, `dispose()`. Oszillatoren werden bei dispose() gestoppt und getrennt (B-24).
 * Sample&Hold ist bewusst nicht enthalten (kommt mit P20, Addendum/Phasenplan P12).
 */
import { isWorkletReady } from '../context.js';

const SHAPES = { sine: 'sine', triangle: 'triangle', square: 'square', saw: 'sawtooth' };
export const LFO_SHAPES = Object.keys(SHAPES);

const RATE_RANGE = [0.01, 40];    // Hz
const SMOOTH_TC = 0.02;           // s, wie bei den übrigen Live-Updates

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Bipolarer LFO: Oszillator → Gain(depth). `depth` ist der Spitzenwert in der Einheit des Ziel-AudioParams
 * (z. B. Hz bei `frequency`). Der Basiswert des Ziels bleibt beim Aufrufer.
 * @param {BaseAudioContext} ctx
 * @param {{shape?: 'sine'|'triangle'|'square'|'saw', rate?: number, depth?: number}} [p]
 * @returns {{output: GainNode, osc: OscillatorNode, update(p:object):void, start(when?:number):void, dispose():void}}
 */
export function makeLfo(ctx, p = {}) {
  const osc = ctx.createOscillator();
  const out = ctx.createGain();
  osc.type = SHAPES[p.shape] || 'sine';
  osc.frequency.value = clamp(Number.isFinite(p.rate) ? p.rate : 1, RATE_RANGE[0], RATE_RANGE[1]);
  out.gain.value = Number.isFinite(p.depth) ? p.depth : 1;
  osc.connect(out);
  let started = false, disposed = false;
  return {
    output: out,
    osc,
    /** Form (Neustart-frei) sowie Rate/Tiefe (geglättet). */
    update(np = {}) {
      if (disposed) return;
      const t = ctx.currentTime;
      if (np.shape && SHAPES[np.shape]) osc.type = SHAPES[np.shape];
      if (Number.isFinite(np.rate)) osc.frequency.setTargetAtTime(clamp(np.rate, RATE_RANGE[0], RATE_RANGE[1]), t, SMOOTH_TC);
      if (Number.isFinite(np.depth)) out.gain.setTargetAtTime(np.depth, t, SMOOTH_TC);
    },
    start(when) { if (!started && !disposed) { started = true; osc.start(when ?? 0); } },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { if (started) osc.stop(); } catch (e) { /* war bereits gestoppt */ }
      try { osc.disconnect(); out.disconnect(); } catch (e) { /* bereits getrennt */ }
    }
  };
}

/**
 * Hüllkurvenfolger als Steuersignal (Worklet `envfollower`). `null`, wenn das Worklet im Context nicht geladen ist
 * (Aufrufer: vorher `await ensureWorklets(ctx, ['envfollower'])`; Fallback laut Worklet-Registry: Baustein überspringen).
 * @param {BaseAudioContext} ctx
 * @param {{attack?: number, release?: number, mode?: 'peak'|'rms'}} [p]  attack/release in Sekunden
 * @returns {{input: AudioWorkletNode, output: AudioWorkletNode, update(p:object):void, dispose():void}|null}
 */
export function makeEnvelopeFollower(ctx, p = {}) {
  if (!isWorkletReady(ctx, 'envfollower')) return null;
  let node;
  try {
    node = new AudioWorkletNode(ctx, 'envelope-follower-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 2, channelCountMode: 'max'
    });
  } catch (e) { console.warn('[audio] Envelope-Follower nicht erzeugbar:', e && e.message); return null; }
  const prm = node.parameters;
  const apply = (np, smooth) => {
    const t = ctx.currentTime, set = (a, v) => { if (!a || !Number.isFinite(v)) return; smooth ? a.setTargetAtTime(v, t, SMOOTH_TC) : a.setValueAtTime(v, t); };
    set(prm.get('attack'), np.attack);
    set(prm.get('release'), np.release);
    if (np.mode) prm.get('mode').setValueAtTime(np.mode === 'rms' ? 1 : 0, t);
  };
  apply(p, false);
  let disposed = false;
  return {
    input: node, output: node,
    update(np = {}) { if (!disposed) apply(np, true); },
    dispose() { if (disposed) return; disposed = true; try { node.disconnect(); } catch (e) { /* bereits getrennt */ } try { node.port.postMessage('dispose'); } catch (e) { /* Port schon zu */ } }   // Prozessor beenden (Fix A)
  };
}
