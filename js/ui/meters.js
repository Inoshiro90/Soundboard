/**
 * ui/meters.js — Peak/RMS-Pegelmesser (Overlay)
 */

import { getPeak, getRms } from '../analysis.js';
import { APP } from '../core/state.js';
import { busesOf } from '../audio/engine/buses.js';
import { createMeterState, dbToFraction, meterText } from '../audio/engine/meters.js';

// ─── PEAK/RMS-METER ─────────────────────────────────────────
// Läuft ausschließlich während einer aktiven Vorschau-Wiedergabe (siehe
// events/register-slot-events.js #btnTrimPreview), gespeist von einem in den Preview-Signalpfad
// eingeschleiften AnalyserNode. Eigenständige rAF-Schleife.

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


// ─── MASTER-METER (Phase 6) ──────────────────────────────────
// Stereo-Peak des Master-Busses (vor dem Begrenzer), ≈ 30 fps. DOM: #masterMeter mit #meterBarL/#meterBarR (Füllbalken),
// #meterClip (Textanzeige „Clip“, nicht nur Farbe). Rechenlogik: audio/engine/meters.js. Ohne Bus (kein Live-Context) passiert nichts.

let _masterRaf = null;

/** Startet das Master-Meter für den Live-Context `ctx` (idempotent). */
export function startMasterMeter(ctx) {
  const bus = busesOf(ctx)?.master;
  if (!bus || _masterRaf != null) return;
  const state = createMeterState();
  const bufL = new Float32Array(bus.analyserL.fftSize), bufR = new Float32Array(bus.analyserR.fftSize);
  const root = document.getElementById('masterMeter');
  const barL = document.getElementById('meterBarL'), barR = document.getElementById('meterBarR');
  const clipEl = document.getElementById('meterClip');
  let last = 0, lastText = '';
  const tick = ts => {
    _masterRaf = requestAnimationFrame(tick);
    if (ts - last < 33) return;   // ≈ 30 fps
    last = ts;
    const { peakL, peakR } = bus.readPeaks(bufL, bufR);
    const m = state.update(peakL, peakR, ts);
    APP.masterBus.peakL = peakL; APP.masterBus.peakR = peakR; APP.masterBus.clip = m.clip;
    if (barL) barL.style.height = (dbToFraction(m.dbL) * 100).toFixed(1) + '%';
    if (barR) barR.style.height = (dbToFraction(m.dbR) * 100).toFixed(1) + '%';
    if (clipEl) clipEl.hidden = !m.clip;
    if (root) {
      root.classList.toggle('is-clip', m.clip);
      const txt = meterText(m);   // Textalternative nur bei Änderung des gerundeten Texts schreiben (Screenreader-Ruhe)
      if (txt !== lastText) { lastText = txt; root.title = txt; }
    }
  };
  _masterRaf = requestAnimationFrame(tick);
}

/** Stoppt das Master-Meter. */
export function stopMasterMeter() { if (_masterRaf != null) { cancelAnimationFrame(_masterRaf); _masterRaf = null; } }


// ─── VORSCHAU-METER (Phase 7) ─────────────────────────────────
// Stereo-Peak des Preview-Busses (eigener Abgriff, beeinflusst den Master-Bus nie — Invariante 5), ≈ 30 fps, nur solange die
// Vorschau läuft. DOM: #previewMeter mit #previewMeterBarL/R, Text #previewMeterText („L −6,0 dB · R −6,0 dB“, bei Clip mit „Clip“,
// nicht nur Farbe). Der Text wird nur bei Änderung des gerundeten Werts geschrieben (Screenreader-Ruhe).

let _previewRaf = null;
const _PREVIEW_METER_SUFFIXES = ['', 'Layer'];   // gleiche Anzeige im Effekt-Dialog und im Layer-Modal (IDs previewMeter[Layer], …BarL/R, …Text)
const _pm = (sfx) => ({
  root: document.getElementById('previewMeter' + sfx), barL: document.getElementById('previewMeterBarL' + sfx),
  barR: document.getElementById('previewMeterBarR' + sfx), txt: document.getElementById('previewMeterText' + sfx)
});

/** Startet die Vorschau-Pegelanzeige für den Live-Context `ctx` (idempotent). */
export function startPreviewMeter(ctx) {
  const bus = busesOf(ctx)?.preview;
  if (!bus || _previewRaf != null) return;
  const state = createMeterState();
  const bufL = new Float32Array(bus.analyserL.fftSize), bufR = new Float32Array(bus.analyserR.fftSize);
  const sets = _PREVIEW_METER_SUFFIXES.map(_pm);
  for (const m of sets) if (m.root) m.root.hidden = false;
  let last = 0, lastText = '';
  const tick = ts => {
    _previewRaf = requestAnimationFrame(tick);
    if (ts - last < 33) return;
    last = ts;
    const { peakL, peakR } = bus.readPeaks(bufL, bufR);
    const st = state.update(peakL, peakR, ts);
    const txt = meterText(st), changed = txt !== lastText; lastText = txt;
    for (const m of sets) {
      if (m.barL) m.barL.style.height = (dbToFraction(st.dbL) * 100).toFixed(1) + '%';
      if (m.barR) m.barR.style.height = (dbToFraction(st.dbR) * 100).toFixed(1) + '%';
      if (m.root) m.root.classList.toggle('is-clip', st.clip);
      if (changed) { if (m.txt) m.txt.textContent = txt; if (m.root) m.root.setAttribute('aria-label', 'Vorschau-Pegel ' + txt); }   // Text nur bei Änderung (Screenreader-Ruhe)
    }
  };
  _previewRaf = requestAnimationFrame(tick);
}

/** Stoppt die Vorschau-Pegelanzeige und blendet sie aus. */
export function stopPreviewMeter() {
  if (_previewRaf != null) { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_previewRaf); _previewRaf = null; }
  for (const m of _PREVIEW_METER_SUFFIXES.map(_pm)) {
    if (m.root) { m.root.hidden = true; m.root.classList.remove('is-clip'); }
    if (m.barL) m.barL.style.height = '0%';
    if (m.barR) m.barR.style.height = '0%';
    if (m.txt) m.txt.textContent = '';
  }
}
