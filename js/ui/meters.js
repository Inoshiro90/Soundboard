/**
 * ui/meters.js — Peak/RMS-Pegelmesser (Analyzer-Overlay)
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { getPeak, getRms } from '../analysis.js';

// ─── PEAK/RMS-METER (P2) ─────────────────────────────────────────
// Läuft ausschließlich während einer aktiven Vorschau-Wiedergabe (siehe
// events.js #btnTrimPreview), gespeist von einem in den Preview-Signalpfad
// eingeschleiften AnalyserNode. Eigenständige rAF-Schleife, unabhängig vom
// bestehenden APP.analyzer-Singleton (der ist für den FX-Spektrum-Effekt
// während LIVE-Playback reserviert, s. startAnalyzerLoop()).

let _meterRaf = null;
let _meterPeakHoldDb = -Infinity;
let _meterPeakHoldSetAt = 0;
let _meterLastFrameAt = 0;

/**
 * @param {AnalyserNode} analyserNode
 * @param {{updateRateHz?:number, peakHoldMs?:number}} [opts]
 */
export function startPeakRmsMeter(analyserNode, opts = {}) {
  stopPeakRmsMeter();
  if (!analyserNode) return;
  const updateRateHz = Math.max(10, Math.min(60, opts.updateRateHz ?? 30));
  const peakHoldMs    = Math.max(0, Math.min(5000, opts.peakHoldMs ?? 1500));
  const intervalMs    = 1000 / updateRateHz;

  const data = new Float32Array(analyserNode.fftSize);
  let lastUpdate = 0;
  _meterPeakHoldDb = -Infinity;
  _meterPeakHoldSetAt = performance.now();
  _meterLastFrameAt   = _meterPeakHoldSetAt;

  function loop(now) {
    _meterRaf = requestAnimationFrame(loop);
    if (now - lastUpdate < intervalMs) return;
    lastUpdate = now;

    analyserNode.getFloatTimeDomainData(data);
    // getPeak()/getRms() aus analysis.js erwarten ein AudioBuffer-artiges
    // Objekt (getChannelData) — hier reicht ein minimaler Adapter um das
    // rohe Float32Array, statt die Funktionen für diesen einen Aufrufer
    // zu duplizieren.
    const bufLike = { numberOfChannels: 1, getChannelData: () => data };
    const peak = getPeak(bufLike);
    const rms  = getRms(bufLike);
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const rmsDb  = rms  > 0 ? 20 * Math.log10(rms)  : -Infinity;

    // Peak-Hold-Ballistik: neuer Peak übernimmt sofort; nach Ablauf von
    // peakHoldMs klingt der gehaltene Wert langsam ab (~20dB/s, angelehnt
    // an klassische Studio-Meter-Ballistik), statt abrupt zu springen.
    const dtSec = Math.max(0, (now - _meterLastFrameAt) / 1000);
    _meterLastFrameAt = now;
    if (peakDb >= _meterPeakHoldDb) {
      _meterPeakHoldDb = peakDb;
      _meterPeakHoldSetAt = now;
    } else if (now - _meterPeakHoldSetAt > peakHoldMs) {
      _meterPeakHoldDb = Math.max(peakDb, _meterPeakHoldDb - 20 * dtSec);
    }

    _renderPeakRmsMeter(peakDb, rmsDb, _meterPeakHoldDb);
  }
  _meterRaf = requestAnimationFrame(loop);
}

export function stopPeakRmsMeter() {
  if (_meterRaf) cancelAnimationFrame(_meterRaf);
  _meterRaf = null;
  _renderPeakRmsMeter(-Infinity, -Infinity, -Infinity);
}

function _renderPeakRmsMeter(peakDb, rmsDb, peakHoldDb) {
  const peakBar = document.getElementById('trimMeterPeakBar');
  const rmsBar  = document.getElementById('trimMeterRmsBar');
  const holdEl  = document.getElementById('trimMeterPeakHold');
  const lbl     = document.getElementById('trimMeterLbl');
  // -60..0 dBFS linear auf 0..100% abgebildet — deckt den für Soundboard-
  // Clips relevanten Bereich ab, ohne dass leise Passagen die ganze Zeit
  // bei 0% "unsichtbar" wären.
  const dbToPct = db => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  if (peakBar) peakBar.style.width = dbToPct(peakDb) + '%';
  if (rmsBar)  rmsBar.style.width  = dbToPct(rmsDb)  + '%';
  if (holdEl) {
    if (peakHoldDb > -60) { holdEl.style.opacity = '1'; holdEl.style.left = `calc(${dbToPct(peakHoldDb)}% - 1px)`; }
    else                  { holdEl.style.opacity = '0'; }
  }
  if (lbl) {
    const fmt = db => db > -60 ? db.toFixed(1) : '–∞';
    lbl.textContent = `Peak ${fmt(peakDb)} dB · RMS ${fmt(rmsDb)} dB`;
  }
}

