/**
 * delayline.js — AudioWorklet Processor (Phase 12c/12d): Kurzzeit-Verzögerung bzw. Allpass-Kette mit sample-genauer Rückkopplung (Flanger, Phaser).
 * Registriert als: 'delayline-processor'
 *
 * Ein Eingang, ein Ausgang, Ausgangskanäle = Eingangskanäle (Mono bleibt Mono, M-3). Der L/R-Versatz (`phase`) wirkt nur auf zweikanalige
 * Eingänge; der Aufrufer schaltet dafür einen StereoPanner (pan 0) davor (effect-graph.js `_buildFlanger`).
 * Parameter (k-rate, im Kern je Sample geglättet): mode (0 Flanger, 1 Phaser — fest je Knoten), Flanger: baseDelay/depth in Sekunden, shape (0 Sinus,
 * 1 Dreieck), phase in Grad; Phaser: center in Hz, sweep 0…1 (± 2 Oktaven), stages 2…12; gemeinsam: rate in Hz, feedback, mix.
 * Ohne Eingang (Quelle beendet) läuft die Rückkopplung mit Stille weiter und klingt aus. Rechenkern: audio/dsp-lib/delayline.js (per `import`,
 * wie dynamics.js: Chrome/Firefox/Node [S], Safari/iOS offen [H]).
 *
 * Phase 21a: zweiter Prozessor 'combbank-processor' in derselben Datei (Worklet-ID `delayline`, Plan P21 „Modus combBank“). Eigener Prozessor statt
 * Modus 2, damit Flanger und Phaser unverändert bleiben (gleiche Parameterliste, gleiche Kosten). Rechenkern audio/dsp-lib/combbank.js.
 * Parameter (k-rate, im Kern je Sample geglättet; Startwerte über `parameterData`, damit der erste Block schon stimmt — Export = Live):
 * f0 (Hz), r0…r7 (Frequenzverhältnis je Kamm, 0 = aus), decay (RT60 in s; 0 = direkte Rückkopplung fb), fb (−0,99…0,99), damp (0…1),
 * spread (Cent L/R), mix (0…1), out (linear).
 */
import { DelayLine, Phaser } from '../audio/dsp-lib/delayline.js';
import { CombBank, COMB_MAX, COMB_MIN_FREQ, COMB_MAX_FB, COMB_DECAY_RANGE, COMB_SPREAD_MAX } from '../audio/dsp-lib/combbank.js';

const K = 'k-rate';
class DelayLineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'mode',      defaultValue: 0,     minValue: 0,     maxValue: 1,    automationRate: K },
      { name: 'baseDelay', defaultValue: 0.002, minValue: 0,     maxValue: 0.04, automationRate: K },
      { name: 'depth',     defaultValue: 0.0015, minValue: 0,    maxValue: 0.02, automationRate: K },
      { name: 'rate',      defaultValue: 0.2,   minValue: 0,     maxValue: 40,   automationRate: K },
      { name: 'feedback',  defaultValue: 0.5,   minValue: -0.99, maxValue: 0.99, automationRate: K },
      { name: 'mix',       defaultValue: 0.5,   minValue: 0,     maxValue: 1,    automationRate: K },
      { name: 'shape',     defaultValue: 0,     minValue: 0,     maxValue: 1,    automationRate: K },
      { name: 'phase',     defaultValue: 0,     minValue: 0,     maxValue: 360,  automationRate: K },
      { name: 'center',    defaultValue: 800,   minValue: 20,    maxValue: 20000, automationRate: K },
      { name: 'sweep',     defaultValue: 0.7,   minValue: 0,     maxValue: 1,    automationRate: K },
      { name: 'stages',    defaultValue: 4,     minValue: 2,     maxValue: 12,   automationRate: K }
    ];
  }

  constructor() {
    super();
    this._alive = true;                                          // Fix A: 'dispose' beendet den Prozessor
    this.port.onmessage = e => { if (e && e.data === 'dispose') this._alive = false; };
    this._dl = new DelayLine(sampleRate, 2, 0.05);
    this._ph = new Phaser(sampleRate, 2);
    this._p = { baseDelay: 0.002, depth: 0.0015, rate: 0.2, feedback: 0.5, mix: 0.5, shape: 0, phase: 0 };
    this._pp = { center: 800, depth: 0.7, rate: 0.5, feedback: 0, mix: 0.5, stages: 4 };
    this._zero = [new Float32Array(128), new Float32Array(128)];
  }

  process(inputs, outputs, params) {
    if (!this._alive) return false;
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    let inp = inputs[0];
    if (!inp || !inp.length) { if (this._zero[0].length < n) this._zero = [new Float32Array(n), new Float32Array(n)]; inp = this._zero; }
    if (params.mode[0] >= 0.5) {                                 // Phaser (12d)
      const q = this._pp;
      q.center = params.center[0]; q.depth = params.sweep[0]; q.rate = params.rate[0]; q.feedback = params.feedback[0]; q.mix = params.mix[0]; q.stages = params.stages[0];
      this._ph.process(inp, out, n, q);
      return true;
    }
    const p = this._p;
    p.baseDelay = params.baseDelay[0]; p.depth = params.depth[0]; p.rate = params.rate[0]; p.feedback = params.feedback[0];
    p.mix = params.mix[0]; p.shape = params.shape[0] >= 0.5 ? 1 : 0; p.phase = params.phase[0];
    this._dl.process(inp, out, n, p);
    return true;
  }
}

registerProcessor('delayline-processor', DelayLineProcessor);

class CombBankProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const r = [];
    for (let j = 0; j < COMB_MAX; j++) r.push({ name: 'r' + j, defaultValue: j === 0 ? 1 : 0, minValue: 0, maxValue: 64, automationRate: K });
    return [
      { name: 'f0',     defaultValue: 220, minValue: COMB_MIN_FREQ, maxValue: 20000, automationRate: K },
      ...r,
      { name: 'decay',  defaultValue: 0,   minValue: COMB_DECAY_RANGE[0], maxValue: COMB_DECAY_RANGE[1], automationRate: K },
      { name: 'fb',     defaultValue: 0,   minValue: -COMB_MAX_FB, maxValue: COMB_MAX_FB, automationRate: K },
      { name: 'damp',   defaultValue: 0,   minValue: 0, maxValue: 1, automationRate: K },
      { name: 'spread', defaultValue: 0,   minValue: 0, maxValue: COMB_SPREAD_MAX, automationRate: K },
      { name: 'mix',    defaultValue: 1,   minValue: 0, maxValue: 1, automationRate: K },
      { name: 'out',    defaultValue: 1,   minValue: 0, maxValue: 16, automationRate: K },
      // Phase 21b (Resonator): Nass-Verstärkung (Pegelkompensation, ≤ +24 dB) und weicher Limiter auf dem Nass-Signal; Standard = Rechenweg wie 21a
      { name: 'wg',     defaultValue: 1,   minValue: 0, maxValue: 16, automationRate: K },
      { name: 'lim',    defaultValue: 0,   minValue: 0, maxValue: 1, automationRate: K }
    ];
  }

  constructor() {
    super();
    this._alive = true;
    this.port.onmessage = e => { if (e && e.data === 'dispose') this._alive = false; };
    this._bank = new CombBank(sampleRate, 2);
    this._ratios = new Float64Array(COMB_MAX);
    this._p = { f0: 220, ratios: this._ratios, decay: 0, fb: 0, damp: 0, spread: 0, mix: 1, out: 1, wg: 1, lim: 0 };
    this._zero = [new Float32Array(128), new Float32Array(128)];
  }

  process(inputs, outputs, params) {
    if (!this._alive) return false;
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    let inp = inputs[0];
    if (!inp || !inp.length) { if (this._zero[0].length < n) this._zero = [new Float32Array(n), new Float32Array(n)]; inp = this._zero; }
    const p = this._p;
    p.f0 = params.f0[0]; p.decay = params.decay[0]; p.fb = params.fb[0]; p.damp = params.damp[0];
    p.spread = params.spread[0]; p.mix = params.mix[0]; p.out = params.out[0]; p.wg = params.wg[0]; p.lim = params.lim[0];
    for (let j = 0; j < COMB_MAX; j++) this._ratios[j] = params['r' + j][0];
    this._bank.process(inp, out, n, p);
    return true;
  }
}

registerProcessor('combbank-processor', CombBankProcessor);
