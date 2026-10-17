/**
 * audio/dsp-lib/envelope.js — Hüllkurvenfolger (Peak/RMS) mit getrennter Attack-/Release-Zeit.
 * Reiner Rechenkern (keine Web-Audio-Typen); der Prozessor js/worklets/envfollower.js ist nur die Verdrahtung.
 * Peak: Betrag (mehrere Kanäle: Maximum) → Attack/Release. RMS: Quadrate (Mittel über die Kanäle) → 10-ms-Fenster → Wurzel →
 * Attack/Release (so bleibt der RMS-Wert unverzerrt; asymmetrisches Glätten der Quadrate würde ihn nach oben ziehen).
 */
import { finiteOr0, flush } from './util.js';

/** Glättungskoeffizient für eine Zeitkonstante in Sekunden (Zeit bis ≈ 63 % des Sprungs). ≤ 0 ⇒ 0 (sofort). */
export function timeToCoef(seconds, sampleRate) {
  if (!(seconds > 0) || !(sampleRate > 0)) return 0;
  return Math.exp(-1 / (seconds * sampleRate));
}

/** RMS-Fenster (symmetrische Einpol-Glättung der Quadrate); Attack/Release wirken erst danach auf den RMS-Wert. */
export const RMS_WINDOW_S = 0.01;

export class EnvelopeFollower {
  /** @param {number} sampleRate */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.state = 0;            // Ausgangs-Hüllkurve
    this.meanSquare = 0;       // nur RMS: geglättetes Quadrat (symmetrisch)
  }

  reset() { this.state = 0; this.meanSquare = 0; }

  /**
   * Verarbeitet einen Block. `channels`: Array von Float32Array (Länge ≥ 0; leer = kein Eingang → Hüllkurve klingt aus).
   * Mehrere Kanäle werden gekoppelt (Peak: Maximum der Beträge, RMS: Mittel der Quadrate).
   * @param {Float32Array[]} channels
   * @param {Float32Array} out  Ausgang (mono), Länge = Blocklänge
   * @param {number} attack     Sekunden
   * @param {number} release    Sekunden
   * @param {boolean} rms       true = RMS, false = Peak
   */
  process(channels, out, attack, release, rms = false) {
    const n = out.length, nch = channels ? channels.length : 0;
    const a = timeToCoef(attack, this.sampleRate), r = timeToCoef(release, this.sampleRate);
    const w = timeToCoef(RMS_WINDOW_S, this.sampleRate);
    let s = this.state, ms = this.meanSquare;
    for (let i = 0; i < n; i++) {
      let x = 0;
      if (rms) {
        for (let c = 0; c < nch; c++) { const v = finiteOr0(channels[c][i]); x += v * v; }
        if (nch > 1) x /= nch;
        ms = flush(w * ms + (1 - w) * x);
        x = Math.sqrt(ms);
      } else {
        for (let c = 0; c < nch; c++) { const v = Math.abs(finiteOr0(channels[c][i])); if (v > x) x = v; }
      }
      const k = x > s ? a : r;
      s = flush(k * s + (1 - k) * x);
      out[i] = s;
    }
    this.state = s; this.meanSquare = ms;
  }
}
