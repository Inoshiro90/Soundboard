/**
 * crusher.js — AudioWorklet Processor (Phase 15c): Bitcrusher mit echter Sample-Rate-Reduktion (B-21).
 * Registriert als: 'crusher-processor'
 *
 * Ein Eingang, ein Ausgang, Ausgangskanäle = Eingangskanäle (Mono bleibt Mono, M-3). Parameter (k-rate): bits 1–16, rate (Zielrate in Hz),
 * jitter 0…1, mix 0…1. Rechenkern: audio/dsp-lib/crusher.js (per `import`, wie delayline.js: Chrome/Firefox/Node [S], Safari/iOS offen [H]).
 * Ohne Eingang (Quelle beendet) wird Stille ausgegeben. 'dispose' über den Port beendet den Prozessor.
 */
import { Crusher } from '../audio/dsp-lib/crusher.js';

const K = 'k-rate';
class CrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits',   defaultValue: 8,     minValue: 1,  maxValue: 16,    automationRate: K },
      { name: 'rate',   defaultValue: 11025, minValue: 50, maxValue: 192000, automationRate: K },
      { name: 'jitter', defaultValue: 0,     minValue: 0,  maxValue: 1,     automationRate: K },
      { name: 'mix',    defaultValue: 1,     minValue: 0,  maxValue: 1,     automationRate: K }
    ];
  }

  constructor() {
    super();
    this._alive = true;
    this.port.onmessage = e => { if (e && e.data === 'dispose') this._alive = false; };
    this._k = new Crusher(sampleRate, 2);
    this._p = { bits: 8, rate: 11025, jitter: 0, mix: 1 };
    this._zero = [new Float32Array(128)];
  }

  process(inputs, outputs, params) {
    if (!this._alive) return false;
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    let inp = inputs[0];
    if (!inp || !inp.length) { if (this._zero[0].length < n) this._zero = [new Float32Array(n)]; inp = this._zero; }
    const p = this._p;
    p.bits = params.bits[0]; p.rate = params.rate[0]; p.jitter = params.jitter[0]; p.mix = params.mix[0];
    this._k.process(inp, out, n, p);
    return true;
  }
}

registerProcessor('crusher-processor', CrusherProcessor);
