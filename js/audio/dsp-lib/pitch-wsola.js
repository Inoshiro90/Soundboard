/**
 * audio/dsp-lib/pitch-wsola.js — Tonhöhenverschiebung per WSOLA (Phase 17c, Algorithmus `voice`).
 * Rein (keine Knoten, kein Context); läuft im Worklet `stft` und in Node-Tests. Eine Instanz je Kanal (L/R unabhängig).
 *
 * Verfahren (Zeitbereich, geringere Latenz und CPU als der Phasenvocoder `music`):
 *   1. Zeitdehnung um den Faktor α (= pitchFactor) mit WSOLA: Hann-Körner der Länge N = 1024, feste Synthese-Hop H = 256 (75 % Überlappung,
 *      Fensterstärke konstant 1), Eingangsposition je Korn p = t − Latenz + (g·H − r)/α. Die Position hängt am Ausgangszeitpunkt t und am
 *      Leseort r der Neuabtastung, nicht an einer mitgeführten Summe: Der Versatz zur Echtzeit bleibt bei jedem α und beim Fahren von α fest.
 *   2. Ausrichtung: Das Korn wird um δ ∈ [−256, +256] so verschoben, dass sein Anfang die natürliche Fortsetzung des vorigen Korns
 *      (Eingang ab s_prev + H) bestmöglich trifft (normierte Kreuzkorrelation über 512 Samples). Grob auf 4× verkleinertem Raster, dann fein
 *      (±3). Die Fortsetzung selbst ist ein Kandidat: Bei α = 1 bleibt der Ausgang ohne Eingriff der (verzögerte) Eingang. Gleichstand → δ = 0.
 *   3. Neuabtastung um α aus dem gedehnten Strom (Catmull-Rom, wie in pitch-pv.js). Für α > 1 vorher ein Tiefpass 4. Ordnung bei 0,45·fs/α
 *      (relativ zur Abtastrate, die Datei kennt keine), eingeblendet von α = 1 (aus) bis α = 1,5 (voll): Bei α ≤ 1 gibt es keinen Filter und
 *      damit keine Gruppenlaufzeit, α = 1 ist die (verzögerte) Identität.
 *   4. Mix: Dry-Anteil um genau die Latenz verzögert (deckungsgleich mit der nominellen Wet-Lage), linear: y = mix·wet + (1 − mix)·dry.
 *
 * Latenz: `latency` = N + Suchbereich + 64 = 1344 Samples (30,5 ms bei 44,1 kHz, 28,0 ms bei 48 kHz), fest unabhängig von α und der Abtastrate.
 *   Die 64 Samples Reserve decken die Interpolation (3/α ≤ 12 Samples Eingangszeit bei α = 0,25) und den Blockrand ab; es wird nie über den
 *   aktuellen Eingangszeitpunkt hinaus gelesen (Ergebnis unabhängig von der Blockgröße, solange α konstant ist).
 *   Ausrichtungs-Jitter: Der tatsächliche Kornanfang liegt bis zu ±256 Samples neben dem nominellen (WSOLA-typisch).
 * Laufzeit: `process()` allokiert nicht; NaN/Inf am Eingang → 0, Denormale in Zuständen → 0.
 */
import { clamp, flush } from './util.js';

export const WSOLA_SIZE = 1024;
export const WSOLA_HOP = 256;
export const WSOLA_SEARCH = 256;
export const WSOLA_LATENCY = WSOLA_SIZE + WSOLA_SEARCH + 64;
export const WSOLA_FACTOR_RANGE = [0.25, 4];

const N = WSOLA_SIZE, H = WSOLA_HOP, D = WSOLA_SEARCH;
const CORR = 512;          // Länge des Vergleichsstücks
const DEC = 4;             // grobes Raster
const CD = CORR / DEC;
const RING = 4096, MASK = RING - 1;   // Eingang, Überlagerung, gedehnter Strom (muss N + Vorlauf des Lesers fassen: 4·128 + 1024 + Reserve)
const LP_REL = 0.45;
const TWO_PI = 2 * Math.PI;

export class WsolaPitchShifter {
  constructor() {
    this.factor = 1;
    this.mix = 1;
    this._in = new Float64Array(RING);
    this._ola = new Float64Array(RING);
    this._tsm = new Float64Array(RING);    // gedehnter Strom, roh
    this._tsmF = new Float64Array(RING);   // gedehnter Strom, tiefpassgefiltert (für α > 1)
    this._dry = new Float64Array(WSOLA_LATENCY);
    this._win = new Float64Array(N);
    for (let i = 0; i < N; i++) this._win[i] = 0.5 * (0.5 - 0.5 * Math.cos(TWO_PI * i / N));   // Hann/2: Summe bei 75 % Überlappung = 1
    this._refD = new Float64Array(CD);
    this._xd = new Float64Array(((2 * D) / DEC + 2) + CD + 2);
    this._ref = new Float64Array(CORR);
    // Tiefpass 4. Ordnung: zwei Biquads (Transponierte Direktform II)
    this._c = [new Float64Array(3), new Float64Array(3)];
    this._z = new Float64Array(4);
    this._lpA = NaN;
    this.reset();
  }

  get latency() { return WSOLA_LATENCY; }

  reset() {
    this._in.fill(0); this._ola.fill(0); this._tsm.fill(0); this._tsmF.fill(0); this._wCur = 0; this._dry.fill(0); this._z.fill(0);
    this._dryPos = 0;
    this._t = 0;          // Anzahl verarbeiteter Eingangssamples (= Ausgangszeit)
    this._r = 0;          // Leseort im gedehnten Strom
    this._g = -3;         // nächstes zu legendes Korn (3 Vorläuferkörner mit Eingang < 0: volle Überlappung ab Stromanfang)
    this._sPrev = 0; this._haveRef = false;
  }

  /** Tiefpass-Koeffizienten (zwei TPT-Zustandsvariablenfilter, Butterworth 4. Ordnung). Zustände sind physikalisch: Koeffizientenwechsel je Block klicken nicht (Biquads in Direktform taten es). */
  _setLowpass(a) {
    if (a === this._lpA) return;
    this._lpA = a;
    const g = Math.tan(Math.PI * LP_REL * Math.min(1, 1 / a)), qs = [0.5411961, 1.3065630];
    for (let k = 0; k < 2; k++) {
      const kk = 1 / qs[k], a1 = 1 / (1 + g * (g + kk)), c = this._c[k];
      c[0] = a1; c[1] = g * a1; c[2] = g * g * a1;
    }
  }

  /**
   * @param {Float32Array|null} input  null = Stille
   * @param {Float32Array} output
   * @param {number} n
   * @param {number} [factor]  Tonhöhenfaktor (0,25 … 4), je Aufruf übernommen
   * @param {number|Float32Array} [mix]  0 … 1; als Feld je Sample (a-rate-Parameter des Worklets)
   */
  process(input, output, n, factor = this.factor, mix = this.mix) {
    const a = clamp(Number.isFinite(factor) ? factor : 1, WSOLA_FACTOR_RANGE[0], WSOLA_FACTOR_RANGE[1]);
    this.factor = a;
    this._setLowpass(a);
    const isArr = typeof mix === 'object' && mix !== null;
    const arr = isArr && mix.length > 1 ? mix : null;
    const m0 = isArr ? mix[0] : mix;
    const m = arr ? 0 : clamp(Number.isFinite(m0) ? m0 : 1, 0, 1);
    this.mix = arr ? clamp(arr[n - 1], 0, 1) : m;
    const IN = this._in, TSM = this._tsm, TSF = this._tsmF, DRY = this._dry, DL = DRY.length;
    // Anteil des Tiefpasses: 0 bei α ≤ 1 (keine Gruppenlaufzeit, Ausgang = Eingang), voll ab α = 1,5; je Sample linear über den Block (Stufen wären hörbar)
    const wT = clamp((a - 1) / 0.5, 0, 1), dw = (wT - this._wCur) / n;
    let pos = this._dryPos, t = this._t, r = this._r, wc = this._wCur;
    for (let i = 0; i < n; i++) {
      let x = input ? input[i] : 0;
      if (!(x === x) || x === Infinity || x === -Infinity) x = 0;
      IN[t & MASK] = x;
      const d = DRY[pos]; DRY[pos] = x; pos = pos + 1 === DL ? 0 : pos + 1;
      // Körner legen, bis der gedehnte Strom bis r + 2 endgültig ist
      while (this._g * H <= r + 2) { this._lay(this._g, t, r, a); this._g++; }
      // Neuabtastung (Catmull-Rom)
      const k0 = Math.floor(r), f = r - k0, f2 = f * f, f3 = f2 * f;
      const w0 = -0.5 * f3 + f2 - 0.5 * f, w1 = 1.5 * f3 - 2.5 * f2 + 1, w2 = -1.5 * f3 + 2 * f2 + 0.5 * f, w3 = 0.5 * f3 - 0.5 * f2;
      const j0 = (k0 - 1) & MASK, j1 = k0 & MASK, j2 = (k0 + 1) & MASK, j3 = (k0 + 2) & MASK;
      let wet = w0 * TSM[j0] + w1 * TSM[j1] + w2 * TSM[j2] + w3 * TSM[j3];
      wc += dw;
      if (wc > 0) wet += wc * (w0 * TSF[j0] + w1 * TSF[j1] + w2 * TSF[j2] + w3 * TSF[j3] - wet);
      if (wet > -1e-30 && wet < 1e-30) wet = 0;
      r += a; t++;
      if (arr) { const g = arr[i] < 0 ? 0 : arr[i] > 1 ? 1 : arr[i]; output[i] = g * wet + (1 - g) * d; }
      else output[i] = m === 1 ? wet : m === 0 ? d : m * wet + (1 - m) * d;
    }
    this._dryPos = pos; this._t = t; this._r = r; this._wCur = wT;
  }

  /** Legt Korn g (Anfang im gedehnten Strom bei g·H) und gibt den Block [g·H, g·H + H) gefiltert frei. */
  _lay(g, t, r, a) {
    const IN = this._in, OLA = this._ola, TSM = this._tsm, TSF = this._tsmF, win = this._win;
    const pc = Math.round(t - WSOLA_LATENCY + (g * H - r) / a);
    const maxS = t + 1 - N;            // nie über den aktuellen Eingangszeitpunkt hinaus lesen
    let lo = -D, hi = D;
    if (pc + hi > maxS) hi = maxS - pc;
    if (hi < lo) { lo = hi; }
    let s = pc;
    if (this._haveRef && hi > lo) {
      const rs = this._sPrev + H;
      const ref = this._ref;
      let er = 0;
      for (let k = 0; k < CORR; k++) { const v = IN[(rs + k) & MASK]; ref[k] = v; er += v * v; }
      if (er > 1e-20) {
        // grob: Mittel über je DEC Samples
        const refD = this._refD, xd = this._xd;
        for (let k = 0; k < CD; k++) { const b = rs + DEC * k; refD[k] = (IN[b & MASK] + IN[(b + 1) & MASK] + IN[(b + 2) & MASK] + IN[(b + 3) & MASK]) * 0.25; }
        const nl = Math.floor((hi - lo) / DEC) + 1, nx = nl - 1 + CD;
        const c0 = pc + lo;
        for (let k = 0; k < nx; k++) { const b = c0 + DEC * k; xd[k] = (IN[b & MASK] + IN[(b + 1) & MASK] + IN[(b + 2) & MASK] + IN[(b + 3) & MASK]) * 0.25; }
        let e = 0;
        for (let k = 0; k < CD; k++) e += xd[k] * xd[k];
        const jc = clamp(Math.round(-lo / DEC), 0, nl - 1);
        let bestJ = jc, best = -Infinity;
        for (let j = 0; j < nl; j++) {
          let c = 0;
          for (let k = 0; k < CD; k++) c += refD[k] * xd[j + k];
          const sc = c / Math.sqrt(e + 1e-12);
          if (j === jc) { if (sc > best) { best = sc; bestJ = j; } }
          else if (sc > best * (best > 0 ? 1.000001 : 0.999999) + 1e-30) { best = sc; bestJ = j; }
          if (j + 1 < nl) { const o = xd[j], nw = xd[j + CD]; e += nw * nw - o * o; if (e < 0) e = 0; }
        }
        // fein: ±(DEC − 1) um das grobe Maximum, volle Auflösung
        const dc = lo + DEC * bestJ;
        let bestD = dc, bestS = -Infinity;
        const f0 = Math.max(lo, dc - DEC + 1), f1 = Math.min(hi, dc + DEC - 1);
        for (let d = f0; d <= f1; d++) {
          let c = 0, ee = 0;
          const b = pc + d;
          for (let k = 0; k < CORR; k++) { const v = IN[(b + k) & MASK]; c += ref[k] * v; ee += v * v; }
          const sc = c / Math.sqrt(ee + 1e-12);
          if (sc > bestS) { bestS = sc; bestD = d; }
        }
        s = pc + bestD;
      } else s = pc + clamp(0, lo, hi);
    } else s = pc + clamp(0, lo, hi);
    this._sPrev = s; this._haveRef = true;
    // Überlagern: neuer Bereich [g·H + N − H, g·H + N) zuerst leeren
    const base = g * H;
    for (let k = N - H; k < N; k++) OLA[(base + k) & MASK] = 0;
    for (let k = 0; k < N; k++) OLA[(base + k) & MASK] += win[k] * IN[(s + k) & MASK];
    // Block freigeben: Tiefpass
    const c1 = this._c[0], c2 = this._c[1], z = this._z;
    for (let k = 0; k < H; k++) {
      const m = (base + k) & MASK;
      const x = OLA[m];
      let v3 = x - z[1], v1 = c1[0] * z[0] + c1[1] * v3, v2 = z[1] + c1[1] * z[0] + c1[2] * v3;
      z[0] = flush(2 * v1 - z[0]); z[1] = flush(2 * v2 - z[1]);
      const y = v2;
      v3 = y - z[3]; v1 = c2[0] * z[2] + c2[1] * v3; v2 = z[3] + c2[1] * z[2] + c2[2] * v3;
      z[2] = flush(2 * v1 - z[2]); z[3] = flush(2 * v2 - z[3]);
      const y2 = v2;
      TSM[m] = x; TSF[m] = y2;
    }
  }
}
