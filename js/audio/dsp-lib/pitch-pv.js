/**
 * audio/dsp-lib/pitch-pv.js — Tonhöhenverschiebung per Phasenvocoder (Phase 17b, Algorithmus `music`).
 * Rein (keine Knoten, kein Context); läuft im Worklet `stft` und in Node-Tests. Eine Instanz je Kanal (L/R unabhängig).
 *
 * Verfahren (Spitzen-Verschiebung mit Phasenkopplung nach Laroche/Dolson 1999), je STFT-Rahmen (dsp-lib/stft.js, 2048/512):
 *   1. Zentrierte Phase: Spektrum × (−1)^k (entspricht einer Kreisverschiebung des Rahmens um N/2). Damit hängt die Phase eines Bins
 *      nicht mehr linear von der Lage im Hauptlappen ab, und ganze Bins lassen sich ohne Phasenrampe verschieben.
 *   2. Spitzen: lokale Maxima des Betrags (größer als beide Nachbarn, nicht kleiner als die übernächsten, über einer Schwelle von
 *      −100 dB unter der Rahmenspitze). Einflussbereich je Spitze: bis zum Betragsminimum zur Nachbarspitze.
 *   3. Tatsächliche Frequenz f der Spitze aus der Phasendifferenz zum Vorrahmen (Phasenverfolgung, stft.js `binFrequency`).
 *   4. Ziel: Bereich um (α − 1)·f Bins verschoben (Bruchteil per Catmull-Rom-Interpolation der komplexen Werte, α = pitchFactor;
 *      ganzzahlig verlor ein Sinus bis 1,5 dB, linear bis 0,8 dB, kubisch ≤ 0,24 dB [S Node]). Phase aller Bins des Bereichs um θ gedreht
 *      (Phasenkopplung: Abstände zur Spitze bleiben wie in der Analyse). θ läuft je Teilton weiter: θₙ = θₙ₋₁ + (α − 1)·ω·hop,
 *      ω = 2π·f/N. Teiltöne werden über die nächstgelegene Spitze des Vorrahmens (± 3 Bins) fortgesetzt, neue starten mit θ = 0.
 *      Folge: Bei α = 1 bleibt θ = 0 und der Ausgang ist die (verzögerte) Rekonstruktion des Eingangs.
 *   5. Überlappende Zielbereiche (α < 1) addieren sich komplex; Bereiche jenseits von Nyquist entfallen.
 *
 * Formant (Phase 17d, nur `music`): Verschiebung der Spektralhüllkurve des tonhöhenverschobenen Rahmens um den Faktor φ ohne Änderung der
 *   Tonhöhe. Hüllkurve = Cepstrum-Glättung (log|Y| → IFFT → Lifter ≤ 96 Samples → FFT → exp); Korrektur G(κ) = E(κ/(α·φ)) / E(κ/α), linear in
 *   log interpoliert, ±24 dB begrenzt, Phase unverändert; danach Energieabgleich je Rahmen (Pegel bleibt). Die Hüllkurve kommt aus dem Analyse-Betrag, nicht aus dem verschobenen Rahmen (der hat Lücken). φ = 1: der Zweig entfällt ganz
 *   (Ausgang bit-gleich zu 17c). Bezug: φ wirkt zusätzlich zur Mitführung der Hüllkurve durch die Tonhöhe (Formant 0 = Klang wie bisher).
 *
 * Mix: Dry-Anteil um genau die Latenz verzögert (deckungsgleich mit Wet), linear: y = mix·wet + (1 − mix)·dry.
 * Latenz: `latency` = FFT-Größe (2048 Samples, 46,4 ms bei 44,1 kHz).
 * Laufzeit: `process()` allokiert nicht; Eingangs-NaN → 0 und Denormale → 0 übernimmt die STFT.
 */
import { Stft, wrapPhase } from './stft.js';
import { RealFft } from './fft.js';
import { clamp } from './util.js';

export const PV_SIZE = 2048;
export const PV_HOP = 512;
export const PV_FACTOR_RANGE = [0.25, 4];
/** Schwelle für Spitzen relativ zur Rahmenspitze (−100 dB). */
const PEAK_REL = 1e-5;
/** Suchradius (Bins) für die Fortsetzung eines Teiltons aus dem Vorrahmen. */
const TRACK_BINS = 3;
const TWO_PI = 2 * Math.PI;
/** Formant (17d): Lifter-Grenze des Cepstrums in Samples (≈ 2 ms) und Obergrenze der Hüllkurven-Korrektur (±24 dB). */
export const PV_LIFTER = 96;
const FORMANT_MAX_LOG = Math.log(16);
export const PV_FORMANT_RANGE = [0.5, 2];

export class PvPitchShifter {
  constructor({ size = PV_SIZE, hop = PV_HOP } = {}) {
    this.size = size;
    this.hop = hop;
    this.factor = 1;
    this.mix = 1;
    this.formant = 1;
    const B = size / 2 + 1;
    this._rfft = new RealFft(size);
    this._lg = new Float64Array(B);      // log-Betrag, später geglättet
    this._lgIm = new Float64Array(B);    // Imaginärteil (Null bzw. Rest) des Cepstrums
    this._cep = new Float64Array(size);
    this.bins = B;
    this._mag = new Float64Array(B);
    this._ph = new Float64Array(B);
    this._prevPh = new Float64Array(B);
    this._cr = new Float64Array(B);     // zentrierte komplexe Werte des Rahmens
    this._ci = new Float64Array(B);
    this._outRe = new Float64Array(B);
    this._outIm = new Float64Array(B);
    this._peaks = new Int32Array(B);
    this._lo = new Int32Array(B);      // Bereichsgrenzen je Spitze [lo, hi]
    this._hi = new Int32Array(B);
    this._theta = new Float64Array(B);
    this._prevPeaks = new Int32Array(B);
    this._prevTheta = new Float64Array(B);
    this._nPrev = 0;
    this._first = true;
    this._stft = new Stft({ size, hop, onFrame: (re, im, b) => this._frame(re, im, b) });
    this._dry = new Float64Array(size);   // Ringpuffer für den verzögerten Dry-Anteil
    this._dryPos = 0;
    this._wetBlock = new Float32Array(128);
  }

  get latency() { return this.size; }

  reset() {
    this._stft.reset(); this._dry.fill(0); this._dryPos = 0;
    this._prevPh.fill(0); this._nPrev = 0; this._first = true;
  }

  /**
   * @param {Float32Array|null} input  null = Stille
   * @param {Float32Array} output
   * @param {number} n
   * @param {number} [factor]  Tonhöhenfaktor (wird je Rahmen übernommen)
   * @param {number|Float32Array} [mix]  0 … 1; als Feld je Sample (a-rate-Parameter des Worklets: ohne Stufen je Block, Klickmaß)
   * @param {number} [formant]  Formantfaktor φ (0,5 … 2), wird je Rahmen übernommen; 1 = aus
   */
  process(input, output, n, factor = this.factor, mix = this.mix, formant = this.formant) {
    this.factor = clamp(Number.isFinite(factor) ? factor : 1, PV_FACTOR_RANGE[0], PV_FACTOR_RANGE[1]);
    this.formant = clamp(Number.isFinite(formant) ? formant : 1, PV_FORMANT_RANGE[0], PV_FORMANT_RANGE[1]);
    const isArr = typeof mix === 'object' && mix !== null;
    const arr = isArr && mix.length > 1 ? mix : null;
    const m0 = isArr ? mix[0] : mix;
    const m = arr ? 0 : clamp(Number.isFinite(m0) ? m0 : 1, 0, 1);
    this.mix = arr ? clamp(arr[n - 1], 0, 1) : m;
    if (this._wetBlock.length < n) this._wetBlock = new Float32Array(n);   // nur bei ungewöhnlich großen Blöcken (nicht im Worklet: 128)
    const wet = this._wetBlock;
    this._stft.process(input, wet, n);
    const D = this._dry, L = D.length;
    let pos = this._dryPos;
    for (let i = 0; i < n; i++) {
      let x = input ? input[i] : 0;
      if (!(x === x) || x === Infinity || x === -Infinity) x = 0;
      const d = D[pos]; D[pos] = x; pos = pos + 1 === L ? 0 : pos + 1;   // liest das Sample von vor L Samples
      if (arr) { const g = arr[i] < 0 ? 0 : arr[i] > 1 ? 1 : arr[i]; output[i] = g * wet[i] + (1 - g) * d; }
      else output[i] = m === 1 ? wet[i] : m === 0 ? d : m * wet[i] + (1 - m) * d;
    }
    this._dryPos = pos;
  }

  _frame(re, im, B) {
    const N = this.size, H = this.hop, a = this.factor;
    const mag = this._mag, ph = this._ph, prev = this._prevPh, CR = this._cr, CI = this._ci;
    // 1. zentrierte Phase und Polarform
    let peakMax = 0;
    for (let k = 0; k < B; k++) {
      const s = (k & 1) ? -1 : 1;
      const r = re[k] * s, i = im[k] * s;
      const m = Math.hypot(r, i);
      mag[k] = m; ph[k] = Math.atan2(i, r); CR[k] = r; CI[k] = i;
      if (m > peakMax) peakMax = m;
    }
    const outRe = this._outRe, outIm = this._outIm;
    outRe.fill(0); outIm.fill(0);
    let nP = 0;
    if (peakMax > 0) {
      // 2. Spitzen
      const thr = peakMax * PEAK_REL, P = this._peaks;
      for (let k = 0; k < B; k++) {
        const m = mag[k];
        if (m <= thr) continue;
        if (k > 0 && m <= mag[k - 1]) continue;
        if (k < B - 1 && m < mag[k + 1]) continue;
        if (k > 1 && m < mag[k - 2]) continue;
        if (k < B - 2 && m < mag[k + 2]) continue;
        P[nP++] = k;
      }
      // Bereichsgrenzen: Minimum zwischen benachbarten Spitzen
      const LO = this._lo, HI = this._hi;
      for (let j = 0; j < nP; j++) {
        if (j === 0) LO[j] = 0;
        if (j === nP - 1) HI[j] = B - 1;
        else {
          let mi = P[j] + 1;
          for (let k = P[j] + 1; k < P[j + 1]; k++) if (mag[k] < mag[mi]) mi = k;
          HI[j] = mi - 1 < P[j] ? P[j] : mi - 1; LO[j + 1] = mi < P[j] + 1 ? P[j] + 1 : mi;
          if (HI[j] >= LO[j + 1]) HI[j] = LO[j + 1] - 1;
        }
      }
      // 3./4. Teiltöne fortsetzen, verschieben, Phase drehen
      const TH = this._theta, PP = this._prevPeaks, PT = this._prevTheta, nPrev = this._nPrev;
      let q = 0;
      for (let j = 0; j < nP; j++) {
        const p = P[j];
        let f = p;   // Bins
        if (!this._first) f = p + wrapPhase(ph[p] - prev[p] - TWO_PI * p * H / N) * N / (TWO_PI * H);
        while (q + 1 < nPrev && Math.abs(PP[q + 1] - p) <= Math.abs(PP[q] - p)) q++;
        const th0 = (nPrev && Math.abs(PP[q] - p) <= TRACK_BINS) ? PT[q] : 0;
        const th = wrapPhase(th0 + (a - 1) * TWO_PI * f / N * H);
        TH[j] = th;
        // Bereich um (α − 1)·f Bins verschieben (Bruchteil per Interpolation der zentrierten komplexen Werte: die Hauptkeule
        // landet so mit ihrer Form auf der Zielfrequenz α·f).
        const sh = (a - 1) * f, lo = LO[j], hi = HI[j];
        const c = Math.cos(th), s = Math.sin(th);
        const t0 = Math.max(0, Math.ceil(lo + sh - 2)), t1 = Math.min(B - 1, Math.floor(hi + sh + 2));
        for (let t = t0; t <= t1; t++) {
          const src = t - sh, k0 = Math.floor(src), fr = src - k0;
          // Catmull-Rom über k0 − 1 … k0 + 2 (Werte außerhalb des Bereichs = 0)
          const f2 = fr * fr, f3 = f2 * fr;
          const w0 = -0.5 * f3 + f2 - 0.5 * fr, w1 = 1.5 * f3 - 2.5 * f2 + 1, w2 = -1.5 * f3 + 2 * f2 + 0.5 * fr, w3 = 0.5 * f3 - 0.5 * f2;
          let r = 0, i = 0;
          if (k0 - 1 >= lo && k0 - 1 <= hi) { r += w0 * CR[k0 - 1]; i += w0 * CI[k0 - 1]; }
          if (k0 >= lo && k0 <= hi) { r += w1 * CR[k0]; i += w1 * CI[k0]; }
          if (k0 + 1 >= lo && k0 + 1 <= hi) { r += w2 * CR[k0 + 1]; i += w2 * CI[k0 + 1]; }
          if (k0 + 2 >= lo && k0 + 2 <= hi) { r += w3 * CR[k0 + 2]; i += w3 * CI[k0 + 2]; }
          if (r === 0 && i === 0) continue;
          outRe[t] += r * c - i * s; outIm[t] += r * s + i * c;
        }
      }
      // Spitzen dieses Rahmens merken (sortiert nach Bin)
      for (let j = 0; j < nP; j++) { PP[j] = P[j]; PT[j] = TH[j]; }
    }
    this._nPrev = nP;
    this._first = false;
    prev.set(ph);
    if (nP > 0 && Math.abs(this.formant - 1) > 1e-9) this._warpEnvelope(outRe, outIm, B, peakMax);
    // 1. zurück: × (−1)^k
    for (let k = 0; k < B; k++) { const s = (k & 1) ? -1 : 1; re[k] = outRe[k] * s; im[k] = outIm[k] * s; }
  }

  /**
   * Formant: Hüllkurve per Cepstrum aus dem ANALYSE-Betrag glätten (nach der Tonhöhenverschiebung hat der Rahmen Lücken zwischen den
   * verschobenen Bereichen; deren Nullen würden das log-Cepstrum zerstören) und die Korrektur auf (re, im) anwenden.
   * Hüllkurve des Ausgangs ohne Formant: E_Y(κ) = E_X(κ/α); mit Formant gewollt: E_X(κ/(α·φ)) → G(κ) = E_X(κ/(αφ)) / E_X(κ/α).
   */
  _warpEnvelope(re, im, B, peakMax) {
    const N = this.size, phi = this.formant, al = this.factor, mag = this._mag, lg = this._lg, lgIm = this._lgIm, cep = this._cep, fft = this._rfft;
    const floor = peakMax * PEAK_REL;
    for (let k = 0; k < B; k++) { lg[k] = Math.log(mag[k] + floor); lgIm[k] = 0; }
    fft.realInverse(lg, lgIm, cep);
    // Lifter: n ≤ Q behalten (die letzten 16 Quefrenzen sanft ausgeblendet), Rest 0
    const Q = PV_LIFTER;
    for (let i = 0; i < N; i++) {
      const d = i <= N / 2 ? i : N - i;
      cep[i] = d <= Q - 16 ? cep[i] : d < Q ? cep[i] * 0.5 * (1 + Math.cos(Math.PI * (d - (Q - 16)) / 16)) : 0;
    }
    fft.realForward(cep, lg, lgIm);   // lg = geglätteter log-Betrag E_X
    const lim = FORMANT_MAX_LOG, top = B - 1;
    const at = x => { if (x <= 0) return lg[0]; if (x >= top) return lg[top]; const i = Math.floor(x), f = x - i; return lg[i] + (lg[i + 1] - lg[i]) * f; };
    let p0 = 0, p1 = 0;
    for (let k = 0; k < B; k++) {
      p0 += re[k] * re[k] + im[k] * im[k];
      let g = at(k / (al * phi)) - at(k / al);
      g = g > lim ? lim : g < -lim ? -lim : g;
      const gl = Math.exp(g);
      re[k] *= gl; im[k] *= gl;
      p1 += re[k] * re[k] + im[k] * im[k];
    }
    if (p1 > 0 && p0 > 0) {
      const e = clamp(Math.sqrt(p0 / p1), 0.25, 4);
      for (let k = 0; k < B; k++) { re[k] *= e; im[k] *= e; }
    }
  }
}
