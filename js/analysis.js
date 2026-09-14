/**
 * analysis.js — Wiederverwendbare Audioanalyse (Peak, RMS).
 *
 * Bewusst schlank gehalten: nur das, was die Loudness-Normalisierung
 * (P1) tatsächlich braucht. Weitere Analysefunktionen (Clipping-Erkennung,
 * DC-Offset …) sind laut Plan als spätere P2-Erweiterung vorgesehen und
 * werden hier nicht vorweggenommen, um den Umfang nicht unnötig
 * aufzublähen (siehe Plan, Abschnitt "Vermeidung unnötiger neuer Dateien").
 */

/** Spitzenpegel (linear, 0–1) über alle Kanäle. */
export function getPeakLinear(buffer) {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Spitzenpegel in dBFS (-Infinity bei digitaler Stille). */
export function getPeakDb(buffer) {
  const peak = getPeakLinear(buffer);
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** RMS (linear) über alle Kanäle/Samples gemeinsam gemittelt. */
export function getRmsLinear(buffer) {
  let sumSq = 0, count = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { sumSq += d[i] * d[i]; count++; }
  }
  return count ? Math.sqrt(sumSq / count) : 0;
}

/** RMS in dBFS (-Infinity bei digitaler Stille). */
export function getRmsDb(buffer) {
  const rms = getRmsLinear(buffer);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * RMS in dBFS nach grober K-Weighting-Annäherung (Hochpass ~38Hz +
 * Hochregal-Filter +4dB ab ~1.5kHz). Das ist AUSDRÜCKLICH KEINE
 * vollständige ITU-R BS.1770/EBU-R128-Lautheitsmessung (kein Gating,
 * keine Kanalgewichtung) — nur eine bessere Annäherung an wahrgenommene
 * Lautheit als reines unfiltertes RMS. Deshalb heißt die Funktion in
 * editor.js bewusst "RMS-Lautstärke-Normalisierung", nicht "LUFS".
 *
 * @param {AudioBuffer} buffer
 * @param {BaseAudioContext} ctx - zum Rendern des Filters benötigt (Live- oder OfflineAudioContext)
 */
export async function getWeightedRmsDb(buffer, ctx) {
  const off = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const src = off.createBufferSource(); src.buffer = buffer;
  const hp = off.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
  const shelf = off.createBiquadFilter();
  shelf.type = 'highshelf'; shelf.frequency.value = 1500; shelf.gain.value = 4;
  src.connect(hp); hp.connect(shelf); shelf.connect(off.destination);
  src.start();
  const filtered = await off.startRendering();
  return getRmsDb(filtered);
}
