/**
 * dsp-lib/dynamics.js — Rechenkerne für Gate, Expander (Phase 11a) und Limiter (Phase 11b, AE-06: Worklet `dynamics`).
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
 * Limiter (Klasse `Limiter`, mode 2): Lookahead-Spitzenbegrenzer. Das Signal wird um `lookahead` verzögert; die nötige Verstärkung je
 *   Sample ist ceiling/|x| (nur über dem Ceiling < 1). Ein gleitendes Minimum über das Lookahead-Fenster und ein Mittelwert über
 *   dieselbe Fensterlänge senken die Verstärkung rechtzeitig und ohne Knick ab; das Maximum ist so garantiert eingehalten
 *   (Mittelwert aus Werten, die alle ≤ der Anforderung des gerade ausgegebenen Samples sind). Das Release ist eine exponentielle
 *   Rückkehr (vor der Mittelung angewandt, hebt die Garantie nicht auf). Stereo gekoppelt, Mono bleibt Mono.
 *   Garantiert wird der SAMPLE-Peak, nicht der True-Peak (Zwischenwerte nach D/A-Wandlung können darüber liegen).
 *   Latenz = Lookahead in Samples (`latencySamples`).
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

export const LIMITER_MAX_LOOKAHEAD_S = 0.02;

export class Limiter {
  constructor(sampleRate, maxChannels = 2) {
    this.sr = sampleRate;
    this.maxL = Math.ceil(sampleRate * LIMITER_MAX_LOOKAHEAD_S);
    this.chs = maxChannels;
    this.size = this.maxL + 1;                                     // Ringlänge ≥ L + 1
    this._delay = Array.from({ length: maxChannels }, () => new Float32Array(this.size));
    this._qv = new Float64Array(this.size);                        // Warteschlange für das gleitende Minimum: Werte
    this._qi = new Float64Array(this.size);                        //   und absolute Sample-Indizes
    this._m = new Float64Array(this.size);                         // Verlauf der geglätteten Mindestverstärkung (für den Mittelwert)
    this.L = 0;
    this.reset(1);
  }

  /** Fensterlänge in Samples für eine Lookahead-Zeit (Sekunden), geklemmt auf 1…maxL. */
  samplesFor(lookaheadS) { return clamp(Math.round(lookaheadS * this.sr), 1, this.maxL); }

  reset(L = this.L || 1) {
    this.L = clamp(Math.round(L), 1, this.maxL);
    for (const d of this._delay) d.fill(0);
    this._qv.fill(1); this._qi.fill(0); this._m.fill(1);
    this.n = 0; this.qh = 0; this.qt = 0;                          // absoluter Index, Warteschlange [qh, qt)
    this.mr = 1; this.sum = this.L + 1;                            // Release-Zustand, Summe der letzten L+1 Werte (alle 1)
  }

  get latencySamples() { return this.L; }

  /**
   * @param {{ceilingDb:number, inputGainDb:number, release:number, lookahead:number}} p  Zeiten in Sekunden; Ceiling/Eingangsverstärkung in dB
   */
  process(inp, out, n, p) {
    const want = this.samplesFor(p.lookahead);
    if (want !== this.L) this.reset(want);                         // Lookahead geändert: Zustand neu (die Hülle tauscht dafür das ganze Modul)
    const L = this.L, size = this.size, chs = Math.min(inp.length, out.length, this.chs);
    const ceil = dbToLin(clamp(p.ceilingDb, -100, 0));
    const inG = dbToLin(clamp(p.inputGainDb, -24, 48));
    const relC = 1 - Math.exp(-1 / (this.sr * Math.max(MIN_TIME_S, p.release)));
    const qv = this._qv, qi = this._qi, m = this._m, dl = this._delay;
    let mr = this.mr, sum = this.sum, N = this.n, qh = this.qh, qt = this.qt;

    for (let i = 0; i < n; i++) {
      // 1 · Eingang (mit Eingangsverstärkung) in die Verzögerung, Spitzenpegel über alle Kanäle
      const w = N % size;
      let pk = 0;
      for (let c = 0; c < chs; c++) {
        const x = inp[c][i];
        const v = Number.isFinite(x) ? x * inG : 0;
        dl[c][w] = v;
        const a = v < 0 ? -v : v;
        if (a > pk) pk = a;
      }
      // 2 · geforderte Verstärkung dieses Samples
      const r = pk > ceil ? ceil / pk : 1;
      // 3 · gleitendes Minimum über die letzten L+1 Anforderungen (Warteschlange mit wachsenden Werten)
      while (qt > qh && qv[(qt - 1) % size] >= r) qt--;
      qv[qt % size] = r; qi[qt % size] = N; qt++;
      while (qi[qh % size] < N - L) qh++;
      const mn = qv[qh % size];
      // 4 · Release: sofort nach unten, exponentiell nach oben
      const up = mr + (1 - mr) * relC;
      mr = mn < up ? mn : up;
      // 5 · Mittelwert über L+1 Werte (Ring m): Verstärkung für das um L Samples zurückliegende Eingangssample
      sum += mr - m[(N - L - 1 + size * 2) % size];                // den Wert von vor L+1 Samples herausnehmen
      m[w] = mr;
      const g = sum / (L + 1);
      const rd = (N - L + size * 2) % size;                        // Leseposition der Verzögerung (L Samples zurück)
      for (let c = 0; c < chs; c++) { const y = dl[c][rd] * g; out[c][i] = Math.abs(y) < DENORMAL_FLOOR ? 0 : y; }
      N++;
    }
    if (sum < 0) sum = 0;
    this.mr = mr < DENORMAL_FLOOR ? 0 : mr; this.sum = sum; this.n = N; this.qh = qh; this.qt = qt;
  }
}
