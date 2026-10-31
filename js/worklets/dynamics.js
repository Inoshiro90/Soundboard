/**
 * dynamics.js — AudioWorklet Processor (Phase 11a/11b/11d): Gate, Expander, Limiter und Transient Shaper.
 * Registriert als: 'dynamics-processor'
 *
 * Ein Eingang, ein Ausgang, gleiche Kanalzahl wie der Eingang (Mono bleibt Mono — die Pegelbilanz der Kette ändert sich nicht, M-3).
 * Parameter (k-rate): mode 0 = Gate, 1 = Expander, 3 = Transient Shaper (tAttack/tSustain in dB, sensitivity/mix 0…1, release in s; keine Latenz), 2 = Limiter (threshold = Ceiling, release in s, inputGain in dB, lookahead in s; Latenz = Lookahead); threshold/range/hysteresis in dB; attack/hold/release in Sekunden; ratio; scHp in Hz.
 * Rechenkern: audio/dsp-lib/dynamics.js (per `import`, wie envfollower.js: Chrome/Firefox/Node [S], Safari/iOS offen [H]).
 */
import { Dynamics, Limiter, Transient } from '../audio/dsp-lib/dynamics.js';

const K = 'k-rate';
class DynamicsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'mode',       defaultValue: 0,      minValue: 0,     maxValue: 3,    automationRate: K },
      { name: 'threshold',  defaultValue: -50,    minValue: -100,  maxValue: 0,    automationRate: K },
      { name: 'range',      defaultValue: -80,    minValue: -100,  maxValue: 0,    automationRate: K },
      { name: 'attack',     defaultValue: 0.005,  minValue: 0.0001, maxValue: 5,   automationRate: K },
      { name: 'hold',       defaultValue: 0.05,   minValue: 0,     maxValue: 5,    automationRate: K },
      { name: 'release',    defaultValue: 0.15,   minValue: 0.0001, maxValue: 10,  automationRate: K },
      { name: 'hysteresis', defaultValue: 3,      minValue: 0,     maxValue: 24,   automationRate: K },
      { name: 'ratio',      defaultValue: 2,      minValue: 1,     maxValue: 20,   automationRate: K },
      { name: 'scHp',       defaultValue: 20,     minValue: 1,     maxValue: 5000, automationRate: K },
      { name: 'inputGain',  defaultValue: 0,      minValue: -24,   maxValue: 48,   automationRate: K },
      { name: 'lookahead',  defaultValue: 0.005,  minValue: 0.0005, maxValue: 0.02, automationRate: K },
      { name: 'tAttack',    defaultValue: 0,      minValue: -24,   maxValue: 24,   automationRate: K },
      { name: 'tSustain',   defaultValue: 0,      minValue: -24,   maxValue: 24,   automationRate: K },
      { name: 'sensitivity', defaultValue: 0.5,   minValue: 0,     maxValue: 1,    automationRate: K },
      { name: 'mix',        defaultValue: 1,      minValue: 0,     maxValue: 1,    automationRate: K }
    ];
  }

  constructor() {
    super();
    // Beendigung (Fix A, Befund 3A): ein getrennter Knoten mit process() → true bliebe aktiv. 'dispose' lässt process() false liefern.
    this._alive = true;
    this.port.onmessage = e => { if (e && e.data === 'dispose') this._alive = false; };
    this._dyn = new Dynamics(sampleRate, 2);
    this._lim = new Limiter(sampleRate, 2);
    this._tr = new Transient(sampleRate, 2);
    this._tp = { attackDb: 0, sustainDb: 0, sensitivity: 0.5, release: 0.15, mix: 1 };
    this._lp = { ceilingDb: -1, inputGainDb: 0, release: 0.08, lookahead: 0.005 };
    this._zero = [new Float32Array(128), new Float32Array(128)];
    this._p = { mode: 0, thresholdDb: -50, rangeDb: -80, attack: 0.005, hold: 0.05, release: 0.15, hysteresisDb: 3, ratio: 2, scHp: 20 };
  }

  process(inputs, outputs, params) {
    if (!this._alive) return false;
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    if (params.mode[0] >= 2.5) {                       // Transient Shaper (keine Latenz: ohne Eingang Stille)
      if (!inp || !inp.length) { for (const ch of out) ch.fill(0); return true; }
      const tp = this._tp;
      tp.attackDb = params.tAttack[0]; tp.sustainDb = params.tSustain[0]; tp.sensitivity = params.sensitivity[0]; tp.release = params.release[0]; tp.mix = params.mix[0];
      this._tr.process(inp, out, out[0].length, tp);
      return true;
    }
    if (params.mode[0] >= 1.5) {                       // Limiter: auch ohne Eingang weiterlaufen, damit die Verzögerung ausklingt
      const lp = this._lp;
      lp.ceilingDb = params.threshold[0]; lp.inputGainDb = params.inputGain[0]; lp.release = params.release[0]; lp.lookahead = params.lookahead[0];
      const n = out[0].length;
      let src = inp && inp.length ? inp : this._zero;
      if (src === this._zero && this._zero[0].length < n) this._zero = [new Float32Array(n), new Float32Array(n)];
      this._lim.process(src, out, n, lp);
      return true;
    }
    if (!inp || !inp.length) { for (const ch of out) ch.fill(0); return true; }
    const p = this._p;
    p.mode = params.mode[0]; p.thresholdDb = params.threshold[0]; p.rangeDb = params.range[0];
    p.attack = params.attack[0]; p.hold = params.hold[0]; p.release = params.release[0];
    p.hysteresisDb = params.hysteresis[0]; p.ratio = params.ratio[0]; p.scHp = params.scHp[0];
    this._dyn.process(inp, out, out[0].length, p);
    return true;
  }
}

registerProcessor('dynamics-processor', DynamicsProcessor);
