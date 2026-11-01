/**
 * stft.js — AudioWorklet Processor (Phase 17b): Tonhöhe v2 auf der STFT-Engine (AE-09).
 * Registriert als: 'stft-pitch-processor'
 *
 * Ein Eingang, ein Ausgang; Kanalzahl explizit (wie das Legacy-Worklet, effect-graph.js buildPitchNode), je Kanal eine eigene Engine.
 * Algorithmus `music` = Phasenvocoder (Rechenkern audio/dsp-lib/pitch-pv.js, per `import` wie crusher.js/delayline.js:
 * Chrome/Firefox/Node [S], Safari/iOS offen [H]); `voice` (17c) = WSOLA im Zeitbereich (audio/dsp-lib/pitch-wsola.js). Gewählt über
 * `processorOptions.algorithm` ('music' | 'voice', sonst 'music'); ein Wechsel ist ein Neubau des Knotens (der Name `stft` bleibt, Vertrag unverändert).
 * Parameter: pitchFactor 0,25–4 (k-rate; der Phasenvocoder übernimmt den Faktor je Rahmen), mix 0–1 (a-rate, je Sample),
 * formantFactor 0,5–2 (k-rate, 17d; nur `music`, `voice` ignoriert ihn).
 * Latenz (Wet und Dry, deckungsgleich): `music` 2048, `voice` 1344 Samples. Ohne Eingang (Quelle beendet) läuft Stille durch, damit der Rest ausklingt.
 * 'dispose' über den Port beendet den Prozessor.
 */
import { PvPitchShifter, PV_FACTOR_RANGE, PV_FORMANT_RANGE } from '../audio/dsp-lib/pitch-pv.js';
import { WsolaPitchShifter } from '../audio/dsp-lib/pitch-wsola.js';

const K = 'k-rate';
class StftPitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchFactor', defaultValue: 1, minValue: PV_FACTOR_RANGE[0], maxValue: PV_FACTOR_RANGE[1], automationRate: K },
      { name: 'mix',         defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },  // a-rate: Glättung ohne Stufen je Block
      { name: 'formantFactor', defaultValue: 1, minValue: PV_FORMANT_RANGE[0], maxValue: PV_FORMANT_RANGE[1], automationRate: K }
    ];
  }

  constructor(options) {
    super();
    this._alive = true;
    this.port.onmessage = e => { if (e && e.data === 'dispose') this._alive = false; };
    const ch = Math.max(1, Math.min(2, options?.outputChannelCount?.[0] || 2));
    const voice = options?.processorOptions?.algorithm === 'voice';
    this._engines = Array.from({ length: ch }, () => (voice ? new WsolaPitchShifter() : new PvPitchShifter()));
  }

  process(inputs, outputs, parameters) {
    if (!this._alive) return false;
    const input = inputs[0], output = outputs[0];
    if (!output || !output.length) return true;
    const f = parameters.pitchFactor[0], m = parameters.mix, fm = parameters.formantFactor[0];   // mix: Länge 1 (konstant) oder 128 (a-rate in Bewegung)
    const n = output[0].length;
    for (let ch = 0; ch < output.length && ch < this._engines.length; ch++) {
      const x = input && input.length ? input[Math.min(ch, input.length - 1)] : null;
      this._engines[ch].process(x, output[ch], n, f, m, fm);
    }
    return true;
  }
}

registerProcessor('stft-pitch-processor', StftPitchProcessor);
