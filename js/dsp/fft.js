/**
 * fft.js — Kompakte, reine JS-FFT/IFFT (radix-2 Cooley-Tukey, iterativ, in-place).
 *
 * Bewusst ohne externe Abhängigkeiten (WASM/Bibliothek) gehalten, siehe
 * AUDACITY_SOUNDBOARD_IMPLEMENTATION_PLAN.md, Abschnitt "Echte spektrale
 * Noise Reduction" → Technologie-Entscheidung. Für Soundboard-typische,
 * kurze Clips ist eine reine JS-FFT ausreichend performant.
 *
 * `n` (Länge von re/im) MUSS eine Zweierpotenz sein — Aufrufer in
 * noiseReduction.js stellen das über `nextPow2()` sicher.
 */

/** Prüft, ob n eine Zweierpotenz ist. */
export function isPow2(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Nächste Zweierpotenz ≥ n. */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place FFT. re/im sind Float64Array gleicher Länge n (Zweierpotenz).
 * Nach dem Aufruf enthalten re/im das komplexe Spektrum.
 */
export function fft(re, im) {
  const n = re.length;
  if (!isPow2(n)) throw new Error(`fft(): Länge ${n} ist keine Zweierpotenz`);

  // Bit-Reversal-Permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  // Iterative Butterfly-Stufen
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = -2 * Math.PI / len;
    const wRe  = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const aIdx = i + k, bIdx = i + k + half;
        const vRe = re[bIdx] * curRe - im[bIdx] * curIm;
        const vIm = re[bIdx] * curIm + im[bIdx] * curRe;
        const uRe = re[aIdx], uIm = im[aIdx];
        re[aIdx] = uRe + vRe; im[aIdx] = uIm + vIm;
        re[bIdx] = uRe - vRe; im[bIdx] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        const nIm = curRe * wIm + curIm * wRe;
        curRe = nRe; curIm = nIm;
      }
    }
  }
}

/**
 * In-place inverse FFT. re/im werden mit dem Zeitbereichssignal
 * überschrieben (re = Signal, im ≈ 0 bei rein reellem Ursprungssignal).
 */
export function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] = re[i] / n;
    im[i] = -im[i] / n;
  }
}

/** Hann-Fenster der Länge `size` (periodisch normiert für Overlap-Add). */
export function hannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return w;
}
