/**
 * noise-generator-processor.js — AudioWorklet Processor (P2)
 * Erzeugt White-, Pink- oder Brown-Noise in Echtzeit, pro Aufruf neu
 * generiert (kein vorab erzeugter, geloopter AudioBuffer) — siehe
 * Plan-Begründung "Realtime vs. AudioBuffer-Generierung": Rauschen ist per
 * Definition nicht-periodisch, ein Loop würde bei jedem Übergang eine
 * (wenn auch subtile) hörbare Wiederholung erzeugen und unnötig RAM binden.
 *
 * Registered as: 'noise-generator-processor'
 *
 * Pink Noise: Paul-Kellett-"Economy"-Filterkaskade (7 gekoppelte
 * IIR-Zustände b0..b6) auf ein White-Noise-Eingangssignal — Standard-
 * Näherung für 1/f-Rauschen (~-3dB/Oktave), weit verbreitet und gut
 * dokumentiert (u.a. musicdsp.org).
 *
 * Brown/Brownian Noise: Leaky-Integrator (Random Walk mit Leck-Faktor
 * < 1, verhindert Drift ins Unendliche) — ~-6dB/Oktave, deutlich
 * bassbetonter als Pink Noise.
 */

class NoiseGeneratorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    // 0=white, 1=pink, 2=brown — als Zahl, da AudioParam keine Strings kennt.
    // Lautstärke wird BEWUSST NICHT hier, sondern über einen externen
    // GainNode gesteuert (siehe generators.js/ambient.js) — konsistent mit
    // allen anderen Ambient-Track-Typen (_ambientTargetGain()), damit
    // Master-Volume UND Auto Duck (P2) einheitlich über denselben
    // Mechanismus greifen, ohne den Worklet-Code kennen zu müssen.
    return [{ name: 'type', defaultValue: 1, minValue: 0, maxValue: 2 }];
  }

  constructor() {
    super();
    // Pink-Noise-Filterzustände (Paul-Kellett-Kaskade), PRO Kanal getrennt
    // (analog zum Stereo-Pitch-Worklet: kein gemeinsamer Zustand zwischen
    // L/R, sonst wären beide Kanäle vollständig korreliert/identisch).
    this._pinkState  = [];
    this._brownState = [];
  }

  _ensureChannelState(numChannels) {
    while (this._pinkState.length < numChannels) this._pinkState.push(new Float32Array(7));
    while (this._brownState.length < numChannels) this._brownState.push(0);
  }

  _pinkStep(ch, white) {
    const b = this._pinkState[ch];
    b[0] = 0.99886 * b[0] + white * 0.0555179;
    b[1] = 0.99332 * b[1] + white * 0.0750759;
    b[2] = 0.96900 * b[2] + white * 0.1538520;
    b[3] = 0.86650 * b[3] + white * 0.3104856;
    b[4] = 0.55000 * b[4] + white * 0.5329522;
    b[5] = -0.7616 * b[5] - white * 0.0168980;
    const pink = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + white * 0.5362;
    b[6] = white * 0.115926;
    // Empirisch bei 10 Minuten Dauerlauf max. ~0.94 (kein Clipping), Clamp
    // trotzdem als Sicherheitsnetz für noch längere Ambient-Sessions.
    return Math.max(-1, Math.min(1, pink * 0.11));
  }

  _brownStep(ch, white) {
    // Leaky Integrator: state = (state + white*scale) * leak. leak<1 zieht
    // den Random Walk sanft Richtung 0 zurück, statt unbegrenzt zu driften.
    let s = this._brownState[ch];
    s = (s + white * 0.02) * 0.999;
    this._brownState[ch] = s;
    // Normierung + hartes Clamping: der Leaky Integrator ist ein AR(1)-
    // Prozess mit STATISTISCH, nicht absolut begrenzter Amplitude — bei
    // langer Ambient-Wiedergabe (Minuten bis Stunden) treten irgendwann
    // seltene Ausreißer auf, die ohne Clamp Samples > 1.0 erzeugen würden
    // (empirisch getestet: bei ungeclampter Skalierung 0.8 nach ~10 Min.
    // Wiedergabe ein einzelner Peak von 1.06 gemessen). Das Clamping greift
    // dadurch nur extrem selten (einzelne Samples), nicht als hörbarer
    // Dauer-Limiter.
    return Math.max(-1, Math.min(1, s * 0.7));
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    this._ensureChannelState(output.length);

    const type = Math.round(parameters.type[0]);

    for (let ch = 0; ch < output.length; ch++) {
      const data = output[ch];
      for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        if (type === 0) data[i] = white;
        else if (type === 1) data[i] = this._pinkStep(ch, white);
        else data[i] = this._brownStep(ch, white);
      }
    }
    return true;
  }
}

registerProcessor('noise-generator-processor', NoiseGeneratorProcessor);
