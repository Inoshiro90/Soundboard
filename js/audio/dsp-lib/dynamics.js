/**
 * dsp-lib/dynamics.js — Rechenkern für Gate und Expander (Phase 11a, AE-06: Worklet `dynamics`).
 * ------------------------------------------------------------------------------------------------
 * Rein (kein DOM, kein AudioContext), damit der Kern in Node ohne Browser testbar ist (wie envelope.js).
 *
 * Erkennung: Sidechain-Hochpass (1. Ordnung, je Kanal) → Betrag → Maximum über alle Kanäle (stereo-gekoppelt: beide Kanäle
 * bekommen dieselbe Verstärkung, das Stereobild bleibt stehen) → Spitzenwert-Hüllkurve mit 5 ms Abfall.
 *
 * Gate (mode 0): Zustandsautomat mit Hysterese und Hold. Öffnet bei Pegel ≥ Schwelle, schließt erst, wenn der Pegel für die Hold-Zeit
 *   unter (Schwelle − Hysterese) lag. Zielverstärkung 1 (offen) oder `range` (geschlossen, z. B. −80 dB); die Verstärkung läuft mit
 *   Attack (öffnen) bzw. Release (schließen) als Einpol-Glättung dorthin.
 * Expander (mode 1): Abwärts-Expander. Unterhalb der Schwelle sinkt der Pegel um (Schwelle − Pegel)·(Ratio − 1) dB, höchstens
 *   um `range` dB; Glättung wie beim Gate (kein Hold).
 *
 * Keine Allokation in process(); NaN/Inf im Eingang werden als 0 gewertet, Zustände werden von Denormalen freigehalten.
 */
import { clamp, dbToLin, DENORMAL_FLOOR } from './util.js';

const DETECTOR_DECAY_S = 0.005;
const MIN_TIME_S = 0.0001;

export class Dynamics {
  constructor(sampleRate, maxChannels = 2) {
    this.sr = sampleRate;
    this.gain = 1;
    this.open = false;
    this.holdLeft = 0;
    this.det = 0;
    this._hpx = new Float64Array(maxChannels);   // letzter Eingang je Kanal (Sidechain-Hochpass)
    this._hpy = new Float64Array(maxChannels);   // letzter Ausgang je Kanal
    this._decay = Math.exp(-1 / (sampleRate * DETECTOR_DECAY_S));
  }

  reset() { this.gain = 1; this.open = false; this.holdLeft = 0; this.det = 0; this._hpx.fill(0); this._hpy.fill(0); }

  /**
   * @param {Float32Array[]} inp  Eingangskanäle (0…n)
   * @param {Float32Array[]} out  Ausgangskanäle (gleiche Anzahl wie inp)
   * @param {number} n            Anzahl Samples dieses Blocks
   * @param {{mode:number, thresholdDb:number, rangeDb:number, attack:number, hold:number, release:number, hysteresisDb:number, ratio:number, scHp:number}} p
   *        Zeiten in Sekunden, Pegel in dB
   */
  process(inp, out, n, p) {
    const sr = this.sr, chs = Math.min(inp.length, out.length, this._hpx.length);
    const expander = p.mode >= 0.5;
    const thrDb = clamp(p.thresholdDb, -100, 0);
    const thrOpen = dbToLin(thrDb);
    const thrClose = dbToLin(thrDb - clamp(p.hysteresisDb, 0, 24));
    const rangeDb = clamp(p.rangeDb, -100, 0);
    const rangeLin = rangeDb <= -100 ? 0 : dbToLin(rangeDb);
    const ratio = clamp(p.ratio, 1, 20);
    const aAtt = Math.exp(-1 / (sr * Math.max(MIN_TIME_S, p.attack)));
    const aRel = Math.exp(-1 / (sr * Math.max(MIN_TIME_S, p.release)));
    const holdSamples = Math.max(0, Math.round(p.hold * sr));
    const hpA = 1 / (1 + 2 * Math.PI * clamp(p.scHp, 1, 5000) / sr);
    const decay = this._decay, hpx = this._hpx, hpy = this._hpy;
    let g = this.gain, det = this.det, open = this.open, holdLeft = this.holdLeft;

    for (let i = 0; i < n; i++) {
      let lvl = 0;
      for (let c = 0; c < chs; c++) {
        const x = inp[c][i];
        const xv = Number.isFinite(x) ? x : 0;
        const y = hpA * (hpy[c] + xv - hpx[c]);
        hpx[c] = xv; hpy[c] = Math.abs(y) < DENORMAL_FLOOR ? 0 : y;
        const a = y < 0 ? -y : y;
        if (a > lvl) lvl = a;
      }
      det = lvl > det ? lvl : det * decay;
      if (det < DENORMAL_FLOOR) det = 0;

      let target;
      if (!expander) {
        if (!open) { if (det >= thrOpen) { open = true; holdLeft = holdSamples; } }
        else if (det >= thrClose) holdLeft = holdSamples;
        else if (holdLeft > 0) holdLeft--;
        else open = false;
        target = open ? 1 : rangeLin;
      } else {
        if (det >= thrOpen) target = 1;
        else {
          const lvlDb = det > 1e-9 ? 20 * Math.log10(det) : -180;
          target = Math.max(rangeLin, dbToLin(Math.max(rangeDb, (lvlDb - thrDb) * (ratio - 1))));
        }
      }
      const a = target > g ? aAtt : aRel;
      g = target + (g - target) * a;
      if (g < DENORMAL_FLOOR) g = 0;
      for (let c = 0; c < chs; c++) { const x = inp[c][i]; out[c][i] = Number.isFinite(x) ? x * g : 0; }
    }
    this.gain = g; this.det = det; this.open = open; this.holdLeft = holdLeft;
  }
}
