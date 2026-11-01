/**
 * audio/dsp-lib/fft.js — FFT für Worklets (Phase 17a, Grundlage der STFT-Engine, AE-09).
 *
 * Unterschied zu `js/dsp/fft.js` (Editor, Trim-Ansicht, Rauschminderung; bleibt unverändert): Tabellen (Bit-Umkehr, Drehfaktoren)
 * werden EINMAL je Größe im Konstruktor angelegt; `forward`/`inverse`/`realForward`/`realInverse` allokieren nicht und dürfen daher
 * in `process()` laufen. Rechnung in Float64 (Phasenverfolgung des Phasenvocoders braucht die Genauigkeit).
 *
 * Konventionen:
 *   forward  X[k] = Σ x[n]·e^(−2πikn/N)            (ohne Skalierung)
 *   inverse  x[n] = (1/N)·Σ X[k]·e^(+2πikn/N)      (skaliert, forward → inverse ergibt das Original)
 *   realForward(x, re, im): N reelle Samples → Bins 0 … N/2 (N/2 + 1 Werte; re/im brauchen mindestens N/2 + 1 Plätze)
 *   realInverse(re, im, out): Bins 0 … N/2 (hermitesch ergänzt) → N reelle Samples; Im von Bin 0 und N/2 wird ignoriert
 * Reelle Transformation über eine komplexe FFT halber Länge (gerade/ungerade Samples als Real-/Imaginärteil).
 */

/** true, wenn n eine Zweierpotenz ≥ 1 ist. */
export const isPow2 = n => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

/** Komplexe FFT fester Länge N (Zweierpotenz), in place auf zwei Float64Array/Float32Array (re, im). */
export class Fft {
  constructor(n) {
    if (!isPow2(n)) throw new Error(`Fft: Länge ${n} ist keine Zweierpotenz`);
    this.n = n;
    this._rev = new Uint32Array(n);
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this._rev[i] = r;
    }
    const h = Math.max(1, n >> 1);
    this._cos = new Float64Array(h);
    this._sin = new Float64Array(h);
    for (let i = 0; i < h; i++) { this._cos[i] = Math.cos(2 * Math.PI * i / n); this._sin[i] = Math.sin(2 * Math.PI * i / n); }
  }

  _permute(re, im) {
    const rev = this._rev, n = this.n;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
  }

  /** sign −1 = vorwärts, +1 = rückwärts (ohne Skalierung). */
  _run(re, im, sign) {
    const n = this.n, C = this._cos, S = this._sin;
    this._permute(re, im);
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = C[t], wi = sign * S[t];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  forward(re, im) { this._run(re, im, -1); }

  inverse(re, im) {
    this._run(re, im, 1);
    const s = 1 / this.n;
    for (let i = 0; i < this.n; i++) { re[i] *= s; im[i] *= s; }
  }
}

/** Reelle FFT der Länge N (Zweierpotenz ≥ 2) über eine komplexe FFT der Länge N/2. */
export class RealFft {
  constructor(n) {
    if (!isPow2(n) || n < 2) throw new Error(`RealFft: Länge ${n} ist keine Zweierpotenz ≥ 2`);
    this.n = n;
    this.bins = (n >> 1) + 1;
    const m = n >> 1;
    this._m = m;
    this._fft = new Fft(m);
    this._zr = new Float64Array(m);
    this._zi = new Float64Array(m);
    this._wr = new Float64Array(m + 1);   // e^(−2πik/N) = wr − i·wi … hier wr = cos, wi = sin (Vorzeichen in der Rechnung)
    this._wi = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) { this._wr[k] = Math.cos(2 * Math.PI * k / n); this._wi[k] = Math.sin(2 * Math.PI * k / n); }
  }

  /** x: N reelle Samples → re/im: Bins 0 … N/2. */
  realForward(x, re, im) {
    const m = this._m, zr = this._zr, zi = this._zi, WR = this._wr, WI = this._wi;
    for (let i = 0; i < m; i++) { zr[i] = x[2 * i]; zi[i] = x[2 * i + 1]; }
    this._fft.forward(zr, zi);
    for (let k = 0; k <= m; k++) {
      const a = k === m ? 0 : k, b = k === 0 ? 0 : m - k;   // Z[M] = Z[0]
      const ar = zr[a], ai = zi[a], br = zr[b], bi = -zi[b];   // Z[k], conj(Z[M−k])
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);          // E[k] = (Z[k] + conj Z[M−k]) / 2
      const dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);          // (Z[k] − conj Z[M−k]) / 2
      const or = di, oi = -dr;                                   // O[k] = (…)/i
      const wr = WR[k], wi = -WI[k];                             // W^k = e^(−2πik/N)
      re[k] = er + (or * wr - oi * wi);
      im[k] = ei + (or * wi + oi * wr);
    }
  }

  /** re/im: Bins 0 … N/2 → out: N reelle Samples (skaliert, realForward → realInverse ergibt das Original). */
  realInverse(re, im, out) {
    const m = this._m, zr = this._zr, zi = this._zi, WR = this._wr, WI = this._wi;
    for (let k = 0; k < m; k++) {
      const j = m - k;
      const ar = re[k], ai = k === 0 ? 0 : im[k];
      const br = re[j], bi = j === m ? 0 : -im[j];               // conj(X[M−k]); Im von Bin N/2 ignoriert
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      const wr = WR[k], wi = WI[k];                              // e^(+2πik/N)
      const or = dr * wr - di * wi, oi = dr * wi + di * wr;      // O[k]
      zr[k] = er - oi; zi[k] = ei + or;                          // Z = E + i·O
    }
    this._fft.inverse(zr, zi);
    for (let i = 0; i < m; i++) { out[2 * i] = zr[i]; out[2 * i + 1] = zi[i]; }
  }
}
