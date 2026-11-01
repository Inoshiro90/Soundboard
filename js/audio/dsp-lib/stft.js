/**
 * audio/dsp-lib/stft.js — STFT-Engine (Phase 17a, AE-09): Fenster, Overlap-Add, Phasenverfolgung.
 * Gemeinsame Grundlage für Pitch & Formant (P17, Worklet `stft`) und Spectral (P24). Rein: keine Knoten, kein Context.
 *
 * Ablauf je Kanal (eine Instanz je Kanal → L/R unabhängig):
 *   Eingang → Analysefenster (periodisches Hann) → reelle FFT → onFrame(re, im, bins, frame) → inverse FFT → Synthesefenster
 *   (dasselbe Hann) → Overlap-Add → Ausgang.
 *   Ohne onFrame (oder wenn onFrame nichts ändert) ist der Ausgang der um `latency` Samples verzögerte Eingang (Rekonstruktion
 *   bis auf Rundung, Test < 1e−9).
 *
 * Latenz: genau `size` Samples, unabhängig von der Blockgröße des Aufrufers (ein Sample frühestens dann, wenn der letzte Rahmen, der
 * es enthält, vollständig ist). FFT 2048 → 46,4 ms bei 44,1 kHz, 42,7 ms bei 48 kHz.
 * Normierung: Σ w²[n + k·hop] ist bei periodischem Hann und Überlappung R = size/hop ≥ 4 konstant (= 3R/8, bei R = 4 also 1,5);
 * die Engine teilt durch diesen Wert. Überlappung < 4 (hop > size/4) ist für Hann² nicht konstant → Fehler.
 *
 * Laufzeit: `process()` allokiert nicht. Eingänge werden gegen NaN/Inf geschützt (→ 0), Ausgänge auf Denormale geprüft (→ 0).
 * Die FFT-Last fällt alle `hop` Samples an (bei 512 alle 4 Render-Blöcke).
 */
import { isPow2, RealFft } from './fft.js';
import { DENORMAL_FLOOR } from './util.js';

const TWO_PI = 2 * Math.PI;

/** Periodisches Hann-Fenster der Länge n (w[0] = 0, kein Endpunkt bei n − 1). */
export function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / n);
  return w;
}

/** Phase auf (−π, π]. */
export function wrapPhase(p) {
  p = p - TWO_PI * Math.round(p / TWO_PI);
  return p <= -Math.PI ? p + TWO_PI : p;
}

/**
 * Phasenverfolgung: tatsächliche Frequenz (Hz) eines Bins aus der Phasendifferenz zweier aufeinanderfolgender Rahmen.
 *   f = (k + wrap(Δφ − 2π·k·hop/size) · size / (2π·hop)) · sr / size
 */
export function binFrequency(k, phase, prevPhase, size, hop, sr) {
  const expected = TWO_PI * k * hop / size;
  const dev = wrapPhase(phase - prevPhase - expected);
  return (k + dev * size / (TWO_PI * hop)) * sr / size;
}

/** re/im → Betrag/Phase für Bins 0 … n − 1 (allokiert nicht). */
export function toPolar(re, im, mag, ph, n) {
  for (let k = 0; k < n; k++) { mag[k] = Math.hypot(re[k], im[k]); ph[k] = Math.atan2(im[k], re[k]); }
}

/** Betrag/Phase → re/im für Bins 0 … n − 1 (allokiert nicht). */
export function fromPolar(mag, ph, re, im, n) {
  for (let k = 0; k < n; k++) { re[k] = mag[k] * Math.cos(ph[k]); im[k] = mag[k] * Math.sin(ph[k]); }
}

export class Stft {
  /**
   * @param {object} o
   * @param {number} [o.size=2048]  Rahmenlänge (Zweierpotenz ≥ 16)
   * @param {number} [o.hop=size/4] Rahmenabstand; size muss ein Vielfaches sein, Überlappung size/hop ≥ 4
   * @param {function} [o.onFrame]  (re, im, bins, frame) → void; darf re/im in place ändern
   */
  constructor({ size = 2048, hop, onFrame = null } = {}) {
    if (!isPow2(size) || size < 16) throw new Error(`Stft: size ${size} ist keine Zweierpotenz ≥ 16`);
    hop = hop ?? size / 4;
    if (!Number.isInteger(hop) || hop < 1 || size % hop !== 0) throw new Error(`Stft: hop ${hop} teilt size ${size} nicht`);
    if (size / hop < 4) throw new Error(`Stft: Überlappung ${size / hop} < 4 (Hann² nicht konstant)`);
    this.size = size;
    this.hop = hop;
    this.bins = size / 2 + 1;
    this.onFrame = onFrame;
    this.frame = 0;
    this._fft = new RealFft(size);
    this._win = hannPeriodic(size);
    // Normierung Σ w² über die Überlappungen (konstant für alle n, Test).
    let s = 0; for (let k = 0; k < size; k += hop) s += this._win[k] * this._win[k];
    this._norm = 1 / s;
    this.re = new Float64Array(this.bins);
    this.im = new Float64Array(this.bins);
    this._frameBuf = new Float64Array(size);
    this._in = new Float64Array(size);    // letzte `size` Eingangssamples (neueste am Ende)
    this._acc = new Float64Array(size);   // Overlap-Add-Akkumulator, acc[0] = ältestes noch nicht ausgegebenes Sample
    this._out = new Float64Array(hop);    // fertige Ausgangssamples des letzten Rahmens
    this._pos = 0;                        // Position im laufenden Hop
  }

  /** Latenz in Samples (Eingang → Ausgang). */
  get latency() { return this.size; }

  /** Summe Σ w²[n + k·hop] (für Tests; Index n ∈ [0, hop)). */
  windowSum(n) { let s = 0; for (let k = n; k < this.size; k += this.hop) s += this._win[k] * this._win[k]; return s; }

  reset() {
    this._in.fill(0); this._acc.fill(0); this._out.fill(0); this.re.fill(0); this.im.fill(0);
    this._pos = 0; this.frame = 0;
  }

  /**
   * Verarbeitet n Samples. input darf null sein (Stille); output darf input sein (in place).
   * @param {Float32Array|Float64Array|null} input
   * @param {Float32Array|Float64Array} output
   * @param {number} [n=output.length]
   */
  process(input, output, n = output.length) {
    const size = this.size, hop = this.hop, base = size - hop, IN = this._in, OUT = this._out;
    let pos = this._pos;
    for (let i = 0; i < n; i++) {
      const x = input ? input[i] : 0;
      IN[base + pos] = (x === x && x !== Infinity && x !== -Infinity) ? x : 0;
      const y = OUT[pos];
      output[i] = (y > -DENORMAL_FLOOR && y < DENORMAL_FLOOR) ? 0 : y;
      if (++pos === hop) { this._runFrame(); pos = 0; }
    }
    this._pos = pos;
  }

  _runFrame() {
    const size = this.size, hop = this.hop, W = this._win, F = this._frameBuf, IN = this._in, ACC = this._acc, OUT = this._out;
    for (let i = 0; i < size; i++) F[i] = IN[i] * W[i];
    this._fft.realForward(F, this.re, this.im);
    if (this.onFrame) this.onFrame(this.re, this.im, this.bins, this.frame);
    this._fft.realInverse(this.re, this.im, F);
    const g = this._norm;
    for (let i = 0; i < size; i++) ACC[i] += F[i] * W[i] * g;
    for (let i = 0; i < hop; i++) OUT[i] = ACC[i];
    ACC.copyWithin(0, hop); ACC.fill(0, size - hop);
    IN.copyWithin(0, hop);
    this.frame++;
  }
}
