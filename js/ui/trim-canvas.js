/**
 * ui/trim-canvas.js — Trim-Wellenform (Zoom/Drag) + statisches Spektrogramm
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { APP } from '../core/state.js';
import { detectClipping } from '../analysis.js';
import { clampFadeDurations } from '../renderPipeline.js';
import { fft, hannWindow } from '../dsp/fft.js';

function _initTrimZoom() {
  const zoomSlider = document.getElementById('trimZoom');
  if (!zoomSlider) return;
  zoomSlider.oninput = function() {
    APP.trim.zoom = parseFloat(this.value) || 1;
    const lbl = document.getElementById('trimZoomLbl');
    if (lbl) lbl.textContent = APP.trim.zoom.toFixed(1) + '×';
    // Centre scroll on current trim midpoint
    if (APP.trim.buf) {
      const dur = APP.trim.buf.duration;
      const ts  = parseFloat(document.getElementById('trimStart').value) || 0;
      const te  = parseFloat(document.getElementById('trimEnd').value)   || dur;
      const mid = (ts + te) / 2 / dur;
      APP.trim.scrollOffset = Math.max(0, Math.min(1 - 1 / APP.trim.zoom, mid - 1 / (2 * APP.trim.zoom)));
    }
    drawTrimWaveform();
  };
}

/** Extracts clientX/clientY from either a MouseEvent or a TouchEvent, so the
 *  same hit-testing logic can drive both mouse and touch interaction. */
function _eventPoint(e) {
  if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}

/** Initialise canvas mouse/touch drag — called once per modal open */
function _initTrimCanvasDrag() {
  const canvas = document.getElementById('trimCanvas');
  if (!canvas) return;

  let panStart = null; // { x, scrollOffset } for middle-button/space pan

  /** Shared hit-test + drag-start logic for both mouse and touch.
   *  @param isTouch  Fingers are far less precise than a mouse cursor, so
   *  touch gets a much larger "grab radius" around each handle (Kap. 59:
   *  Mindestgröße für Touch-Targets) — mouse keeps its tighter, pixel-
   *  accurate snap. BUGFIX (Nutzer-Feedback): when neither handle was
   *  within the (very tight) snap distance, this used to unconditionally
   *  fall back to 'start', so any imprecise touch that missed the end
   *  handle silently grabbed the start handle instead. Now falls back to
   *  whichever handle is actually closer. */
  function _pointerDown(e, isTouch) {
    if (!APP.trim.buf) return;
    const pt = _eventPoint(e);
    const { normX } = _canvasNormXAt(pt.x, canvas);
    const t = _normToTime(normX);
    const dur = APP.trim.buf.duration;
    const ts  = parseFloat(document.getElementById('trimStart').value) || 0;
    const te  = parseFloat(document.getElementById('trimEnd').value)   || dur;
    const pxTs = _timeToNorm(ts);
    const pxTe = _timeToNorm(te);
    const distS = Math.abs(normX - pxTs);
    const distE = Math.abs(normX - pxTe);
    const snap  = (isTouch ? Math.max(24, canvas.offsetWidth * 0.04) / canvas.offsetWidth : 0.015) / APP.trim.zoom;

    if (!isTouch && e.button === 1) { panStart = { x: pt.x, scrollOffset: APP.trim.scrollOffset }; e.preventDefault(); return; }
    if (distS < snap)                    APP.trim.dragging = 'start';
    else if (distE < snap)               APP.trim.dragging = 'end';
    else if (!isTouch && e.button === 2) APP.trim.dragging = 'end';
    else                                  APP.trim.dragging = (distS <= distE) ? 'start' : 'end';
    _applyTrimPoint(t);
  }

  function _pointerMove(e, isTouch) {
    if (!APP.trim.buf) return;
    const pt = _eventPoint(e);
    if (panStart) {
      const dx = (pt.x - panStart.x) / canvas.offsetWidth;
      APP.trim.scrollOffset = Math.max(0, Math.min(1 - 1 / APP.trim.zoom, panStart.scrollOffset - dx / APP.trim.zoom));
      drawTrimWaveform(); return;
    }
    if (!APP.trim.dragging) return;
    if (isTouch) e.preventDefault(); // verhindert Seiten-Scroll während des Ziehens
    const { normX } = _canvasNormXAt(pt.x, canvas);
    _applyTrimPoint(_normToTime(normX));
  }

  canvas.onmousedown = e => _pointerDown(e, false);
  canvas.onmousemove = e => _pointerMove(e, false);
  canvas.onmouseup    = () => { APP.trim.dragging = null; panStart = null; };
  canvas.onmouseleave = () => { if (!panStart) APP.trim.dragging = null; };
  canvas.oncontextmenu = e => e.preventDefault();

  // Touch: eigene Handler statt sich auf emulierte mousedown/mousemove-
  // Events zu verlassen — die feuern auf den meisten mobilen Browsern
  // während eines echten Touch-Drags gar nicht zuverlässig durchgehend.
  canvas.addEventListener('touchstart', e => { _pointerDown(e, true); }, { passive: true });
  canvas.addEventListener('touchmove',  e => { _pointerMove(e, true); }, { passive: false });
  canvas.addEventListener('touchend',    () => { APP.trim.dragging = null; }, { passive: true });
  canvas.addEventListener('touchcancel', () => { APP.trim.dragging = null; }, { passive: true });

  // Scroll to zoom with mouse wheel
  canvas.onwheel = function(e) {
    if (!APP.trim.buf) return;
    e.preventDefault();
    const zoomSlider = document.getElementById('trimZoom');
    const oldZoom = APP.trim.zoom;
    const delta = e.deltaY < 0 ? 0.5 : -0.5;
    APP.trim.zoom = Math.max(1, Math.min(20, oldZoom + delta));
    if (zoomSlider) { zoomSlider.value = APP.trim.zoom; const lbl = document.getElementById('trimZoomLbl'); if (lbl) lbl.textContent = APP.trim.zoom.toFixed(1) + '×'; }
    // Zoom towards mouse position
    const { normX } = _canvasNormX(e, this);
    const timeAtCursor = _normToTime(normX);
    APP.trim.scrollOffset = Math.max(0, Math.min(1 - 1 / APP.trim.zoom, timeAtCursor / APP.trim.buf.duration - normX / APP.trim.zoom));
    drawTrimWaveform();
  };
}

/** Converts mouse event to 0..1 canvas-relative X, accounting for zoom/scroll (mouse-only entry point, kept for onwheel) */
function _canvasNormX(e, canvas) {
  return _canvasNormXAt(e.clientX, canvas);
}

/** Converts a raw clientX to 0..1 canvas-relative X, accounting for zoom/scroll */
function _canvasNormXAt(clientX, canvas) {
  const r    = canvas.getBoundingClientRect();
  const rawX = (clientX - r.left) / r.width; // 0..1 in viewport
  const normX = APP.trim.scrollOffset + rawX / APP.trim.zoom;
  return { rawX, normX: Math.max(0, Math.min(1, normX)) };
}

/** Converts a normalised position (0..1) to audio time */
function _normToTime(norm) {
  const dur = APP.trim.buf?.duration || 1;
  return Math.max(0, Math.min(dur, norm * dur));
}

/** Converts an audio time to normalised position (0..1) in full audio */
function _timeToNorm(t) {
  const dur = APP.trim.buf?.duration || 1;
  return t / dur;
}

/** Converts a normalised full-audio position (0..1) to canvas X accounting for zoom */
function _normToCanvasX(norm, W) {
  return ((norm - APP.trim.scrollOffset) * APP.trim.zoom) * W;
}

function _applyTrimPoint(t) {
  const dur = APP.trim.buf.duration;
  if (APP.trim.dragging === 'start') {
    const te = parseFloat(document.getElementById('trimEnd').value) || dur;
    document.getElementById('trimStart').value = Math.min(t, te - 0.01).toFixed(3);
  } else {
    const ts = parseFloat(document.getElementById('trimStart').value) || 0;
    document.getElementById('trimEnd').value = Math.max(t, ts + 0.01).toFixed(3);
  }
  updateTrimDurLabel();
  drawTrimWaveform();
}

export function drawTrimWaveform() {
  const canvas = document.getElementById('trimCanvas');
  if (!canvas || !APP.trim.buf) return;

  const dpr  = window.devicePixelRatio || 1;
  const W    = canvas.offsetWidth;
  const H    = canvas.offsetHeight;
  if (W === 0 || H === 0) return;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const zoom   = APP.trim.zoom   || 1;
  const scroll = APP.trim.scrollOffset || 0;
  const data   = APP.trim.buf.getChannelData(0);
  const totalSamples = data.length;
  const cs     = getComputedStyle(document.documentElement);
  const bgClr     = cs.getPropertyValue('--bg-warm').trim()      || '#f6f5f4';
  const accentClr = cs.getPropertyValue('--color-accent').trim() || '#0075de';
  const mutedClr  = cs.getPropertyValue('--text-muted').trim()   || '#999';

  ctx.fillStyle = bgClr;
  ctx.fillRect(0, 0, W, H);

  // Visible time window
  const dur        = APP.trim.buf.duration;
  const winStart   = scroll * dur;           // audio seconds at left edge
  const winEnd     = winStart + dur / zoom;  // audio seconds at right edge

  // Grid lines (10 per visible window)
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth   = 1;
  const gridCount = 10;
  for (let g = 0; g <= gridCount; g++) {
    const x = (g / gridCount) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  // Waveform
  const amp  = H / 2;
  const startSmp = Math.floor((winStart / dur) * totalSamples);
  const endSmp   = Math.ceil ((winEnd   / dur) * totalSamples);
  const step = Math.max(1, Math.ceil((endSmp - startSmp) / W));

  ctx.strokeStyle = accentClr + 'aa';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  for (let px = 0; px < W; px++) {
    const si = startSmp + Math.floor((px / W) * (endSmp - startSmp));
    let mn = 0, mx = 0;
    for (let j = 0; j < step && si + j < totalSamples; j++) {
      const v = data[si + j] || 0;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const y1 = amp - mx * amp * 0.95;
    const y2 = amp - mn * amp * 0.95;
    if (px === 0) ctx.moveTo(px, y1);
    else { ctx.lineTo(px, y1); ctx.lineTo(px, y2); }
  }
  ctx.stroke();

  // Trim region overlay
  const ts = parseFloat(document.getElementById('trimStart').value) || 0;
  const te = parseFloat(document.getElementById('trimEnd').value)   || dur;
  const x1 = _normToCanvasX(ts / dur, W);
  const x2 = _normToCanvasX(te / dur, W);

  // Greyed-out regions
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  if (x1 > 0)     ctx.fillRect(0,  0, x1,     H);
  if (x2 < W)     ctx.fillRect(x2, 0, W - x2, H);

  // Active region tint
  ctx.fillStyle = accentClr + '18';
  ctx.fillRect(x1, 0, Math.max(0, x2 - x1), H);

  // P2 Find Clipping: rote Marker an den beim Öffnen erkannten Clipping-
  // Regionen (siehe openTrimModal() → detectClipping()). Mindestbreite
  // 1.5px, damit auch kurze Regionen bei starkem Zoom-out noch sichtbar
  // bleiben (sonst < 1 Pixel und optisch unsichtbar).
  if (APP.trim.clippingRegions?.length) {
    ctx.fillStyle = 'rgba(220,40,40,0.55)';
    for (const r of APP.trim.clippingRegions) {
      const rx1 = _normToCanvasX(r.start / totalSamples, W);
      const rx2 = _normToCanvasX((r.end + 1) / totalSamples, W);
      if (rx2 < 0 || rx1 > W) continue; // außerhalb des sichtbaren Fensters
      ctx.fillRect(rx1, 0, Math.max(1.5, rx2 - rx1), H);
    }
  }

  // Start/End markers
  const drawMarker = (x, label, side) => {
    if (x < -10 || x > W + 10) return;
    ctx.strokeStyle = accentClr;
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    // Handle triangle
    ctx.fillStyle = accentClr;
    ctx.beginPath();
    if (side === 'start') { ctx.moveTo(x, 0); ctx.lineTo(x + 10, 0); ctx.lineTo(x, 10); }
    else                  { ctx.moveTo(x, 0); ctx.lineTo(x - 10, 0); ctx.lineTo(x, 10); }
    ctx.closePath(); ctx.fill();
    // Label
    ctx.fillStyle = accentClr;
    ctx.font = `10px ${cs.getPropertyValue('--font-mono') || 'monospace'}`;
    const lbl = (side === 'start' ? ts : te).toFixed(2) + 's';
    ctx.fillText(lbl, side === 'start' ? x + 4 : Math.max(4, x - 36), 22);
  };
  drawMarker(x1, ts, 'start');
  drawMarker(x2, te, 'end');

  // Playhead
  if (APP.trim.playheadPos != null) {
    const phX = _normToCanvasX(APP.trim.playheadPos / dur, W);
    ctx.strokeStyle = '#e04040';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Time ruler (bottom strip)
  ctx.fillStyle    = 'rgba(0,0,0,0.04)';
  ctx.fillRect(0, H - 14, W, 14);
  ctx.fillStyle    = mutedClr;
  ctx.font         = `9px ${cs.getPropertyValue('--font-mono') || 'monospace'}`;
  const tickCount  = Math.min(10, Math.floor(zoom * 5));
  for (let t2 = 0; t2 <= tickCount; t2++) {
    const normPos = t2 / tickCount;
    const timeVal = winStart + normPos * (winEnd - winStart);
    const px      = normPos * W;
    ctx.fillText(timeVal.toFixed(2) + 's', Math.min(px + 2, W - 32), H - 3);
  }

  // Overview bar (top 6px — mini full-view with window indicator)
  const ovH = 6;
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, 0, W, ovH);
  ctx.fillStyle = accentClr + '44';
  const ovX1 = scroll * W;
  const ovX2 = Math.min(W, (scroll + 1 / zoom) * W);
  ctx.fillRect(ovX1, 0, ovX2 - ovX1, ovH);
  ctx.strokeStyle = accentClr;
  ctx.lineWidth   = 1;
  ctx.strokeRect(ovX1, 0, ovX2 - ovX1, ovH);
}



// ─── STATISCHES SPEKTROGRAMM (P3) ────────────────────────────────
// Reine Zusatz-Visualisierung des GESAMTEN Clips (keine Bearbeitung,
// keine Zoom-Synchronisation mit der Wellenform — bewusst als feste
// Übersicht gehalten, siehe Plan-Wortlaut "Übersicht des GESAMTEN
// Clips"). Einmal pro geöffnetem Trim-Modal berechnet (bei openTrimModal),
// NICHT bei jedem Redraw — FFT-Berechnung ist teurer als die reine
// Min/Max-Wellenform-Darstellung.
// Bewusste Abweichung vom Plan: kein Web Worker für Clips > 30s — analog
// zur Rauschunterdrückung (dsp/noiseReduction.js) sind Soundboard-Clips
// typischerweise kurz (Sekunden), ein Worker wäre hier unverhältnismäßiger
// Mehraufwand für einen Randfall, der in der Praxis kaum vorkommt.

let _trimSpectrogramCache = null; // { frames, fftSize, hopSize, sr } — zum zuletzt in APP.trim.buf geöffneten Buffer

function _computeSpectrogramFrames(buf, { fftSize = 1024, hopSize = 256 } = {}) {
  const data = buf.getChannelData(0); // Mono-Ansicht reicht für eine Übersichtsvisualisierung
  const window = hannWindow(fftSize);
  const half = fftSize / 2;
  const frames = [];
  for (let pos = 0; pos + fftSize <= data.length; pos += hopSize) {
    const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) re[i] = data[pos + i] * window[i];
    fft(re, im);
    const magsDb = new Float32Array(half);
    for (let b = 0; b < half; b++) {
      const mag = Math.hypot(re[b], im[b]) / (fftSize / 2); // grobe Normierung auf ~0..1-Bereich
      magsDb[b] = mag > 0 ? 20 * Math.log10(mag) : -100;
    }
    frames.push(magsDb);
  }
  return { frames, fftSize, hopSize, sr: buf.sampleRate };
}

/** dB (-80..0, darunter geclampt) -> Farbe (dunkelblau→orange→gelb/weiß). */
function _dbToSpectrogramColor(db) {
  const t = Math.max(0, Math.min(1, (db + 80) / 80));
  let r, g, b;
  if (t < 0.6) {
    const u = t / 0.6;
    r = u * 200; g = u * 60; b = 40 - u * 20;
  } else {
    const u = (t - 0.6) / 0.4;
    r = 200 + u * 55; g = 60 + u * 195; b = 20 + u * 180;
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

/** Berechnet (falls nötig) und zeichnet das Spektrogramm für APP.trim.buf in #trimSpectrogramCanvas. */
export function drawTrimSpectrogram() {
  const canvas = document.getElementById('trimSpectrogramCanvas');
  const buf = APP.trim.buf;
  if (!canvas || !buf) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1); // Mobile: Obergrenze 2x gegen Speicherverbrauch
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');

  if (!_trimSpectrogramCache || _trimSpectrogramCache._srcBuf !== buf) {
    _trimSpectrogramCache = _computeSpectrogramFrames(buf);
    _trimSpectrogramCache._srcBuf = buf;
  }
  const { frames, fftSize, sr } = _trimSpectrogramCache;
  if (!frames.length) { ctx.clearRect(0, 0, W, H); return; }

  // Direkt in Device-Pixel-Auflösung (W×H) rechnen — vermeidet ein
  // nachträgliches Hoch-/Herunterskalieren zwischen CSS- und Geräte-
  // Pixeln, putImageData ignoriert ohnehin jede Canvas-Transform-Matrix.
  const imgData = ctx.createImageData(W, H);
  const nyquist = sr / 2;
  const minFreq = 20;
  const numBins = fftSize / 2;
  for (let x = 0; x < W; x++) {
    const frameIdx = Math.min(frames.length - 1, Math.floor((x / W) * frames.length));
    const frame = frames[frameIdx];
    for (let y = 0; y < H; y++) {
      const frac = 1 - y / H; // 0 (unten, minFreq) .. 1 (oben, Nyquist) — logarithmische Frequenzachse
      const freq = minFreq * Math.pow(nyquist / minFreq, frac);
      const bin  = Math.max(0, Math.min(numBins - 1, Math.round(freq * fftSize / sr)));
      const [r, g, b] = _dbToSpectrogramColor(frame[bin]);
      const idx = (y * W + x) * 4;
      imgData.data[idx] = r; imgData.data[idx + 1] = g; imgData.data[idx + 2] = b; imgData.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

export function updateTrimDurLabel() {
  const dur = APP.trim.buf?.duration || 0;
  const ts  = parseFloat(document.getElementById('trimStart')?.value) || 0;
  const te  = parseFloat(document.getElementById('trimEnd')?.value)   || dur;
  const selDur = Math.max(0, te - ts);
  const el  = document.getElementById('trimDurLabel');
  if (el) el.textContent = `Dauer: ${selDur.toFixed(2)}s`;

  // P3 (Audit-Problem 13): zeigt live an, ob/wie stark die eingegebenen
  // Fade-Dauern relativ zur AKTUELLEN (Trim-)Clip-Länge geclampt würden —
  // ohne diese Rückmeldung könnte der Nutzer einen Wert eintragen, der
  // beim tatsächlichen Abspielen (renderPipeline.js clampFadeDurations())
  // stillschweigend gekürzt wird.
  const fiRaw = parseFloat(document.getElementById('trimFadeIn')?.value)  || 0;
  const foRaw = parseFloat(document.getElementById('trimFadeOut')?.value) || 0;
  const { fadeIn: fiClamped, fadeOut: foClamped } = clampFadeDurations(fiRaw, foRaw, selDur);
  const fiHint = document.getElementById('trimFadeInClampHint');
  const foHint = document.getElementById('trimFadeOutClampHint');
  if (fiHint) {
    const clamped = fiClamped < fiRaw - 0.001;
    fiHint.textContent = clamped ? `→ wirkt als ${fiClamped.toFixed(2)}s` : '';
    fiHint.style.display = clamped ? '' : 'none';
  }
  if (foHint) {
    const clamped = foClamped < foRaw - 0.001;
    foHint.textContent = clamped ? `→ wirkt als ${foClamped.toFixed(2)}s` : '';
    foHint.style.display = clamped ? '' : 'none';
  }
}

