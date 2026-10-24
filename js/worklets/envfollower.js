/**
 * envfollower.js — AudioWorklet Processor (Phase 5): Hüllkurvenfolger als Steuersignal.
 * Registriert als: 'envelope-follower-processor'
 *
 * Eingang: beliebige Kanalzahl (gekoppelt ausgewertet). Ausgang: 1 Kanal, die Hüllkurve als Audiosignal
 * (0 … ≈ Eingangspegel), anschließbar an einen AudioParam (z. B. Filterfrequenz über einen Gain als Tiefe).
 * Parameter (k-rate): attack/release in Sekunden, mode 0 = Peak, 1 = RMS.
 * Der Rechenkern liegt in audio/dsp-lib/envelope.js (per `import`; funktioniert in Chrome/Firefox [S],
 * Safari/iOS offen [H]).
 */
import { EnvelopeFollower } from '../audio/dsp-lib/envelope.js';

class EnvelopeFollowerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'attack',  defaultValue: 0.005, minValue: 0.0001, maxValue: 10, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1,   minValue: 0.0001, maxValue: 10, automationRate: 'k-rate' },
      { name: 'mode',    defaultValue: 0,     minValue: 0,      maxValue: 1,  automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    // Beendigung (Fix A, Befund 3A): ein getrennter Knoten mit process() → true bliebe aktiv. 'dispose' lässt process() false liefern.
    this._alive = true;
    this.port.onmessage = e => { if (e && e.data === 'dispose') this._alive = false; };
    this._env = new EnvelopeFollower(sampleRate);
  }

  process(inputs, outputs, params) {
    if (!this._alive) return false;
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const ch = inputs[0] && inputs[0].length ? inputs[0] : [];
    this._env.process(ch, out, params.attack[0], params.release[0], params.mode[0] >= 0.5);
    // Weitere Ausgangskanäle (falls vom Host angelegt) bekommen dasselbe Signal.
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor('envelope-follower-processor', EnvelopeFollowerProcessor);
