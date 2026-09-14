/**
 * dsp/noiseReduction.js — Spektralsubtraktions-Rauschunterdrückung.
 *
 * Algorithmus siehe AUDACITY_SOUNDBOARD_IMPLEMENTATION_PLAN.md,
 * Abschnitt "Echte spektrale Noise Reduction" → "Algorithmus-Spezifikation".
 * Läuft bewusst auf dem Haupt-Thread statt in einem Web Worker (siehe
 * Abweichungs-Hinweis im Antworttext) — für typische Soundboard-Clip-
 * längen (Sekunden bis niedrige Zehnersekunden) bleibt die Blockierung
 * kurz; bei sehr langen Clips ist ein Web Worker die im Plan empfohlene
 * spätere Ausbaustufe.
 */

import { fft, ifft, hannWindow, isPow2 } from './fft.js';

/**
 * @param {AudioBuffer} buffer
 * @param {{magnitudes:number[], sampleRate:number, fftSize:number}} noiseProfile
 * @param {{amount?:number, sensitivity?:number, smoothing?:number, fftSize?:number, hopSize?:number}} params
 * @returns {AudioBuffer} neuer Buffer, gleiche Kanalzahl/Sample-Rate/Länge
 */
export function reduceNoiseSpectral(buffer, noiseProfile, params = {}) {
  if (!noiseProfile || !noiseProfile.magnitudes || !noiseProfile.magnitudes.length) {
    throw new Error('Kein gültiges Rauschprofil vorhanden.');
  }
  // Guard: Sample-Rate-Mismatch NICHT automatisch resamplen (würde die
  // Bin-Zuordnung verfälschen) — stattdessen kontrolliert abbrechen.
  if (noiseProfile.sampleRate !== buffer.sampleRate) {
    throw new Error('Rauschprofil wurde mit einer anderen Sample-Rate erstellt. Bitte Rauschprofil neu lernen.');
  }

  const fftSize = params.fftSize || noiseProfile.fftSize || 2048;
  if (!isPow2(fftSize)) throw new Error(`fftSize (${fftSize}) muss eine Zweierpotenz sein.`);
  const hopSize     = params.hopSize ?? Math.floor(fftSize / 4); // 75% Overlap
  const amount      = clamp(params.amount ?? 0.6, 0, 1);
  const sensitivity = clamp(params.sensitivity ?? 6, 1, 10);
  const smoothingN  = Math.round(clamp(params.smoothing ?? 2, 0, 10));
  const minGainFloor = 0.05; // ≈ -26 dB, verhindert Total-Mute-Artefakte

  // sensitivity (1–10 UI-Skala) → overSubtraction (1.0–3.0), s. Plan-Spezifikation
  const overSubtraction = 1 + (sensitivity - 1) * (2 / 9);

  const half = fftSize / 2;
  const noiseFloor = noiseProfile.magnitudes; // Länge fftSize/2 + 1 (linear, nicht dB)
  const window = hannWindow(fftSize);

  const numCh  = buffer.numberOfChannels;
  const length = buffer.length;
  const sr     = buffer.sampleRate;
  const outBuffer = new AudioBuffer({ numberOfChannels: numCh, length, sampleRate: sr });

  for (let ch = 0; ch < numCh; ch++) {
    const input = buffer.getChannelData(ch);
    // +fftSize Puffer am Ende, damit der letzte (über das Buffer-Ende
    // hinausragende, nullgepaddete) Frame vollständig ins Overlap-Add passt.
    const accum    = new Float64Array(length + fftSize);
    const winAccum = new Float64Array(length + fftSize);

    /** @type {Float64Array|null} Temporal geglättete Gain-Maske über Frames hinweg */
    let gainSmoothed = null;

    for (let pos = 0; pos < length; pos += hopSize) {
      const frameRe = new Float64Array(fftSize);
      const frameIm = new Float64Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        const idx = pos + i;
        frameRe[i] = (idx < length ? input[idx] : 0) * window[i];
      }

      fft(frameRe, frameIm);

      // Magnitude/Phase für die untere Hälfte (0..Nyquist) extrahieren
      const mags   = new Float64Array(half + 1);
      const phases = new Float64Array(half + 1);
      for (let b = 0; b <= half; b++) {
        mags[b]   = Math.hypot(frameRe[b], frameIm[b]);
        phases[b] = Math.atan2(frameIm[b], frameRe[b]);
      }

      // Gain-Maske: 1 - estimatedNoise/magnitude, geclampt auf [minGainFloor, 1]
      const rawGain = new Float64Array(half + 1);
      for (let b = 0; b <= half; b++) {
        const nf = noiseFloor[b] ?? noiseFloor[noiseFloor.length - 1] ?? 0;
        const estimatedNoise = nf * overSubtraction;
        const g = 1 - estimatedNoise / Math.max(mags[b], 1e-8);
        rawGain[b] = clamp(g, minGainFloor, 1);
      }

      // Frequency Smoothing: gleitender Mittelwert über ±smoothingN Bins
      const freqSmoothed = smoothingN > 0 ? movingAverage(rawGain, smoothingN) : rawGain;

      // Temporal Smoothing (Attack/Release über aufeinanderfolgende Frames)
      if (!gainSmoothed) {
        gainSmoothed = freqSmoothed.slice();
      } else {
        const attackCoef = 0.5, releaseCoef = 0.15; // steigt schneller als es fällt -> weniger "Pumpen"
        for (let b = 0; b <= half; b++) {
          const coef = freqSmoothed[b] < gainSmoothed[b] ? releaseCoef : attackCoef;
          gainSmoothed[b] += (freqSmoothed[b] - gainSmoothed[b]) * coef;
        }
      }

      // Gain auf Magnitude anwenden, Phase unverändert lassen, Spektrum
      // wieder komplex + spiegel-symmetrisch (reelles Zeitsignal) aufbauen.
      for (let b = 0; b <= half; b++) {
        const mag = mags[b] * gainSmoothed[b];
        frameRe[b] = mag * Math.cos(phases[b]);
        frameIm[b] = mag * Math.sin(phases[b]);
        if (b > 0 && b < half) {
          frameRe[fftSize - b] =  frameRe[b];
          frameIm[fftSize - b] = -frameIm[b];
        }
      }

      ifft(frameRe, frameIm); // frameRe ist jetzt das (reelle) Zeitsignal des Frames

      // Overlap-Add inkl. Fenster-Energie-Aufsummierung zur Normalisierung
      for (let i = 0; i < fftSize; i++) {
        accum[pos + i]    += frameRe[i] * window[i];
        winAccum[pos + i] += window[i] * window[i];
      }
    }

    const outData = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const norm = winAccum[i] > 1e-8 ? winAccum[i] : 1;
      const processed = accum[i] / norm;
      // Dry/Wet-Mix über `amount` (0 = unverändertes Original, 1 = voll bearbeitet)
      outData[i] = amount * processed + (1 - amount) * input[i];
    }
    outBuffer.copyToChannel(outData, ch);
  }

  return outBuffer;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Gleitender Mittelwert über ±n Nachbar-Bins (Rand wird geklemmt, kein Wrap-Around). */
function movingAverage(arr, n) {
  if (n <= 0) return arr;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, count = 0;
    for (let k = -n; k <= n; k++) {
      const j = i + k;
      if (j >= 0 && j < arr.length) { sum += arr[j]; count++; }
    }
    out[i] = sum / count;
  }
  return out;
}
