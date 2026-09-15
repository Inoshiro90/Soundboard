/**
 * analysis.js — Wiederverwendbare Audioanalyse (Peak, RMS).
 *
 * Bewusst schlank gehalten: nur das, was die Loudness-Normalisierung
 * (P1) tatsächlich braucht. Weitere Analysefunktionen (Clipping-Erkennung,
 * DC-Offset …) sind laut Plan als spätere P2-Erweiterung vorgesehen und
 * werden hier nicht vorweggenommen, um den Umfang nicht unnötig
 * aufzublähen (siehe Plan, Abschnitt "Vermeidung unnötiger neuer Dateien").
 */

/**
 * analysis.js — Wiederverwendbare Audioanalyse (Peak, RMS, DC-Offset,
 * Clipping-Erkennung, Silence-Regionen).
 *
 * Zentrale Quelle der Wahrheit für Normalize, Loudness, Meter, Find
 * Clipping, Truncate Silence (siehe Plan Abschnitt 6, "Zentrales
 * Analyse-Modul js/analysis.js").
 */

/**
 * Spitzenpegel (linear, 0–1).
 * @param {AudioBuffer} buffer
 * @param {number|null} [channel] - null: Maximum über ALLE Kanäle gemeinsam. N: nur Kanal N.
 */
export function getPeak(buffer, channel = null) {
  let peak = 0;
  const chans = channel !== null ? [channel] : _allChannels(buffer);
  for (const ch of chans) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** @deprecated Alias für getPeak(buffer) — Rückwärtskompatibilität. */
export function getPeakLinear(buffer) { return getPeak(buffer); }

/** Spitzenpegel in dBFS (-Infinity bei digitaler Stille). */
export function getPeakDb(buffer, channel = null) {
  const peak = getPeak(buffer, channel);
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * RMS (linear, quadratischer Mittelwert).
 * @param {AudioBuffer} buffer
 * @param {number|null} [channel] - null: über ALLE Kanäle/Samples gemeinsam gemittelt. N: nur Kanal N.
 */
export function getRms(buffer, channel = null) {
  let sumSq = 0, count = 0;
  const chans = channel !== null ? [channel] : _allChannels(buffer);
  for (const ch of chans) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { sumSq += d[i] * d[i]; count++; }
  }
  return count ? Math.sqrt(sumSq / count) : 0;
}

/** @deprecated Alias für getRms(buffer) — Rückwärtskompatibilität. */
export function getRmsLinear(buffer) { return getRms(buffer); }

/** RMS in dBFS (-Infinity bei digitaler Stille). */
export function getRmsDb(buffer, channel = null) {
  const rms = getRms(buffer, channel);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * DC-Offset: arithmetisches Mittel der (unrektifizierten) Samplewerte.
 * Ein von 0 abweichender Wert deutet auf eine Gleichspannungs-Verschiebung
 * hin (häufig durch billige Aufnahmehardware), die u.a. Normalize
 * verfälscht (Peak wird durch den Offset einseitig überschätzt).
 */
export function getDcOffset(buffer, channel = null) {
  let sum = 0, count = 0;
  const chans = channel !== null ? [channel] : _allChannels(buffer);
  for (const ch of chans) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) { sum += d[i]; count++; }
  }
  return count ? sum / count : 0;
}

/**
 * Erkennt zusammenhängende Clipping-Regionen (Samples mit |Wert| ≥
 * threshold) pro Kanal. `end` ist der Index des LETZTEN geclippten
 * Samples der Region (inklusiv), nicht der erste Sample danach.
 * @returns {{clippingSamples:number, clippingRegions:{start:number,end:number,channel:number}[], firstClippingSample:number|null, clippingDurationSec:number}}
 */
export function detectClipping(buffer, { threshold = 0.999 } = {}) {
  const regions = [];
  let clippingSamples = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    let runStart = -1;
    for (let i = 0; i < d.length; i++) {
      if (Math.abs(d[i]) >= threshold) {
        if (runStart === -1) runStart = i;
      } else if (runStart !== -1) {
        regions.push({ start: runStart, end: i - 1, channel: ch });
        clippingSamples += (i - runStart);
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      regions.push({ start: runStart, end: d.length - 1, channel: ch });
      clippingSamples += (d.length - runStart);
    }
  }
  regions.sort((a, b) => a.start - b.start);
  return {
    clippingSamples,
    clippingRegions: regions,
    firstClippingSample: regions.length ? regions.reduce((m, r) => Math.min(m, r.start), Infinity) : null,
    clippingDurationSec: clippingSamples / buffer.sampleRate,
  };
}

/**
 * Erkennt zusammenhängende Stille-Regionen (Maximum über ALLE Kanäle
 * gemeinsam unter thresholdDb), mindestens minDurationSec lang.
 * KORRIGIERT gegenüber dem ursprünglichen editRemoveSilence()-Bug, der
 * nur Kanal 0 prüfte (siehe Audit) — hier wird pro Sample-Index das
 * Maximum über alle Kanäle gebildet, sodass Stille nur erkannt wird,
 * wenn wirklich ALLE Kanäle an dieser Stelle leise sind.
 * @returns {{startSample:number, endSample:number, durationSec:number}[]}
 */
export function findSilenceRegions(buffer, { thresholdDb = -50, minDurationSec = 0.5 } = {}) {
  const linThreshold = Math.pow(10, thresholdDb / 20);
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const numCh = buffer.numberOfChannels;
  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));
  const minSamples = Math.round(minDurationSec * sr);

  const regions = [];
  let runStart = -1;
  for (let i = 0; i < len; i++) {
    let maxAbs = 0;
    for (let ch = 0; ch < numCh; ch++) {
      const a = Math.abs(channels[ch][i]);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs < linThreshold) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const runLen = i - runStart;
      if (runLen >= minSamples) regions.push({ startSample: runStart, endSample: i - 1, durationSec: runLen / sr });
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    const runLen = len - runStart;
    if (runLen >= minSamples) regions.push({ startSample: runStart, endSample: len - 1, durationSec: runLen / sr });
  }
  return regions;
}

/** Gesamtanalyse eines Buffers — bündelt alle Einzelmetriken. */
export function analyzeBuffer(buffer) {
  return {
    peakDb: getPeakDb(buffer),
    rmsDb: getRmsDb(buffer),
    dcOffset: getDcOffset(buffer),
    clipping: detectClipping(buffer),
    durationSec: buffer.duration,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  };
}

function _allChannels(buffer) {
  const arr = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) arr.push(ch);
  return arr;
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
