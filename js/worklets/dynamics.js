/**
 * dynamics.js — AudioWorklet Processor (Phase 11a): Gate und Expander.
 * Registriert als: 'dynamics-processor'
 *
 * Ein Eingang, ein Ausgang, gleiche Kanalzahl wie der Eingang (Mono bleibt Mono — die Pegelbilanz der Kette ändert sich nicht, M-3).
 * Parameter (k-rate): mode 0 = Gate, 1 = Expander; threshold/range/hysteresis in dB; attack/hold/release in Sekunden; ratio; scHp in Hz.
 * Rechenkern: audio/dsp-lib/dynamics.js (per `import`, wie envfollower.js: Chrome/Firefox/Node [S], Safari/iOS offen [H]).
 */
import { Dynamics } from '../audio/dsp-lib/dynamics.js';

const K = 'k-rate';
class DynamicsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'mode',       defaultValue: 0,      minValue: 0,     maxValue: 1,    automationRate: K },
      { name: 'threshold',  defaultValue: -50,    minValue: -100,  maxValue: 0,    automationRate: K },
      { name: 'range',      defaultValue: -80,    minValue: -100,  maxValue: 0,    automationRate: K },
      { name: 'attack',     defaultValue: 0.005,  minValue: 0.0001, maxValue: 5,   automationRate: K },
      { name: 'hold',       defaultValue: 0.05,   minValue: 0,     maxValue: 5,    automationRate: K },
      { name: 'release',    defaultValue: 0.15,   minValue: 0.0001, maxValue: 10,  automationRate: K },
      { name: 'hysteresis', defaultValue: 3,      minValue: 0,     maxValue: 24,   automationRate: K },
      { name: 'ratio',      defaultValue: 2,      minValue: 1,     maxValue: 20,   automationRate: K },
      { name: 'scHp',       defaultValue: 20,     minValue: 1,     maxValue: 5000, automationRate: K }
    ];
  }

  constructor() {
    super();
    // Beendigung (Fix A, Befund 3A): ein getrennter Knoten mit process() → true bliebe aktiv. 'dispose' lässt process() false liefern.
    this._alive = true;
    this.port.onmessage = e => { if (e && e.data === 'dispose') this._alive = false; };
    this._dyn = new Dynamics(sampleRate, 2);
    this._p = { mode: 0, thresholdDb: -50, rangeDb: -80, attack: 0.005, hold: 0.05, release: 0.15, hysteresisDb: 3, ratio: 2, scHp: 20 };
  }

  process(inputs, outputs, params) {
    if (!this._alive) return false;
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
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
