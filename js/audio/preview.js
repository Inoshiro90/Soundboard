/**
 * audio/preview.js — Effekt-Editor-Vorschau + Analyzer
 * Ausgelagert aus audio.js (Phase 3 der Refaktorierung).
 */

import { APP } from '../core/state.js';
import { toast } from '../notifications.js';
import { bk } from '../utils.js';
import { getOrDecodeBuffer } from '../audioCache.js';
import { renderSoundGraph } from '../renderPipeline.js';
import { actx } from './context.js';

// ─── ANALYZER ────────────────────────────────────────────────

export function createAnalyzerSplit(ctx) {
  const a = ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0.8; return a;
}

export function stopAnalyzer() {
  if (APP.analyzer.rafId) { cancelAnimationFrame(APP.analyzer.rafId); APP.analyzer.rafId = null; }
  APP.analyzer.active = false;
  updateAnalyzerIdleHint();
}

export function startAnalyzerLoop(analyserNode, canvas, mode) {
  stopAnalyzer(); APP.analyzer.node = analyserNode; APP.analyzer.canvas = canvas;
  APP.analyzer.mode = mode || 'bars'; APP.analyzer.active = true;
  updateAnalyzerIdleHint();
  const bufLen = analyserNode.frequencyBinCount;
  const dataF  = new Uint8Array(bufLen); const dataT = new Uint8Array(analyserNode.fftSize);
  // Abschnitt 25: Canvas-Backing-Store (cv.width/height) und die Theme-
  // Farben nur bei tatsächlicher Änderung neu lesen/setzen, nicht bei
  // jedem der ~60 Frames/Sekunde — cv.width/height-Zuweisung löscht und
  // realloziert intern die gesamte Canvas-Bitmap, und getComputedStyle()
  // erzwingt einen Style-Recalc; beides pro Frame ist unnötige Last,
  // gerade auf Mobile (Abschnitt 26).
  let lastW = 0, lastH = 0, lastDpr = 0;
  let accent = '#0075de', bg = '#1a1a1a';
  function _refreshThemeColors() {
    const cs = getComputedStyle(document.documentElement);
    accent = cs.getPropertyValue('--color-accent').trim() || accent;
    bg     = cs.getPropertyValue('--bg-warm').trim()     || bg;
  }
  _refreshThemeColors();
  function draw() {
    if (!APP.analyzer.active) return;
    APP.analyzer.rafId = requestAnimationFrame(draw);
    const cv = APP.analyzer.canvas; if (!cv || !cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1; const W = cv.offsetWidth; const H = cv.offsetHeight;
    if (!W || !H) return;
    if (W !== lastW || H !== lastH || dpr !== lastDpr) {
      cv.width = W * dpr; cv.height = H * dpr;
      lastW = W; lastH = H; lastDpr = dpr;
    }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    if (APP.analyzer.mode === 'bars') {
      analyserNode.getByteFrequencyData(dataF);
      const barW = W / bufLen * 2.5;
      for (let i = 0; i < bufLen; i++) { const v = dataF[i] / 255; c.fillStyle = `hsl(${200 + v * 60},80%,${40 + v * 30}%)`; c.fillRect(i * barW * 0.8, H - v * H, barW * 0.75, v * H); }
    } else if (APP.analyzer.mode === 'line') {
      analyserNode.getByteFrequencyData(dataF); c.beginPath(); c.strokeStyle = accent; c.lineWidth = 2;
      for (let i = 0; i < bufLen; i++) { const x = (i / bufLen) * W; const y = H - (dataF[i] / 255) * H; if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); } c.stroke();
    } else {
      analyserNode.getByteTimeDomainData(dataT); c.beginPath(); c.strokeStyle = accent; c.lineWidth = 2;
      for (let i = 0; i < dataT.length; i++) { const x = (i / dataT.length) * W; const y = ((dataT[i] / 128) - 1) * (H / 2) + H / 2; if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); } c.stroke();
    }
  }
  draw();
}

/* ═══════════════ EFFEKT-EDITOR-PREVIEW (isolierter Lifecycle) ═══════════
 * Läuft komplett NEBEN der normalen Soundboard-Wiedergabe: eigener State
 * (APP.audioPreview statt APP.activeAudio), kein _setPlaying()/kein
 * Tile-Highlight, kein Auto-Duck, keine Rotation-/Fortschrittsanzeige,
 * kein stopAll()/stopItem() auf echte Sounds. Nutzt aber dieselbe
 * renderSoundGraph()-Pipeline wie Live-Playback/Export (Abschnitt 28) —
 * dieselben Effekte, derselbe Analyzer-Aufbau, keine zweite Engine.
 *
 * previewSound() ist der öffentliche Einstiegspunkt (Bestandsname/-signatur
 * beibehalten, Abschnitt 30) und togglet intern zwischen
 * startEffectPreview()/stopEffectPreview().
 * ══════════════════════════════════════════════════════════════════════ */

function _stopPreviewSourceOnly() {
  const p = APP.audioPreview;
  if (p.src) {
    // Abschnitt 14: mehrfaches/zu spätes .stop() (Quelle bereits von selbst
    // beendet) darf nie zu einem sichtbaren Fehler führen.
    try { p.src.onended = null; p.src.stop(); } catch (e) { /* bereits beendet — ignorieren */ }
  }
}

/**
 * Zentrale, einzige Cleanup-Stelle für die Effekt-Editor-Preview
 * (Abschnitt 35). Wird aufgerufen bei: Stop-Klick, natürlichem Ende,
 * Start einer neuen Preview (ersetzt die alte), Modal-Schließen,
 * Speichern und Abbrechen.
 */
export function stopEffectPreview() {
  const p = APP.audioPreview;
  p.token++; // entwertet jede noch wartende startEffectPreview()-Anfrage (Decode/Graph-Aufbau)
  _stopPreviewSourceOnly();
  if (p.analyser) stopAnalyzer();
  p.playing = false; p.loading = false;
  p.src = null; p.masterGain = null; p.analyser = null;
  p.soundId = null; p.slotIdx = null;
  _updatePreviewButton();
}

async function startEffectPreview(s, slotIdx) {
  const p = APP.audioPreview;
  stopEffectPreview(); // Abschnitt 15: eine evtl. laufende/ladende Preview immer zuerst sauber beenden
  const myToken = p.token; // stopEffectPreview() hat token bereits erhöht — dieser Aufruf "besitzt" ihn jetzt

  const slot = s.slots?.[slotIdx];
  if (!slot?.data) { toast('Slot ' + (slotIdx + 1) + ' leer'); return; }

  p.loading = true; _updatePreviewButton();
  actx(); // stellt AudioContext innerhalb der User-Geste sicher (Abschnitt 21/22)
  const ctx = actx();

  // Abschnitt 19: bestehenden Cache verwenden, nicht unnötig neu dekodieren.
  let buf = APP.audioBuffers[bk(s.id, slotIdx)];
  if (!buf) {
    try {
      buf = await getOrDecodeBuffer(s.id, slotIdx, slot.data, ctx);
    } catch (e) {
      console.error('[audio] Preview-Decode-Fehler:', e);
      buf = null;
    }
  }
  if (myToken !== p.token) return; // zwischenzeitlich gestoppt/durch neue Preview ersetzt

  if (!buf) {
    toast('Audio konnte nicht geladen werden', 'err');
    p.loading = false; _updatePreviewButton();
    return;
  }

  let graph;
  try {
    // mode:'preview' — dieselbe Pipeline wie Live/Export (Abschnitt 28/29),
    // erzeugt seit dem P3-Fix auch hier einen Analyser, falls in den
    // aktuellen Effekten aktiviert (Abschnitt 3/8).
    graph = await renderSoundGraph(ctx, buf, slot, s, { mode: 'preview', destination: ctx.destination });
  } catch (e) {
    console.error('[audio] Preview-Graph-Fehler:', e);
    graph = null;
  }
  if (myToken !== p.token) {
    // Zwischenzeitlich gestoppt/durch neue Preview ersetzt, während der
    // Graph aufgebaut wurde — src wurde noch nie gestartet, daher
    // disconnect() statt stop() (stop() vor start() wirft InvalidStateError).
    try { graph?.src.disconnect(); } catch (e) {}
    return;
  }

  if (!graph) {
    toast('Vorschau-Fehler', 'err');
    p.loading = false; _updatePreviewButton();
    return;
  }

  const { src, masterGain, analyser, dur } = graph;
  p.loading = false; p.playing = true;
  p.src = src; p.masterGain = masterGain; p.analyser = analyser;
  p.soundId = s.id; p.slotIdx = slotIdx;

  src.onended = () => {
    // Abschnitt 13/15: onended kann auch von einer bereits ERSETZTEN
    // Quelle nachträglich feuern — nur reagieren, wenn es noch DIESE ist.
    if (APP.audioPreview.src !== src) return;
    stopEffectPreview();
  };

  graph.start(0);
  _updatePreviewButton();

  if (analyser) {
    const cv = document.getElementById('analyzerCanvas');
    if (cv) startAnalyzerLoop(analyser, cv, s.effects?.analyzer?.mode || 'bars');
  }
  void dur; // (aktuell ungenutzt — Preview braucht keine Fortschrittsanzeige)
}

/**
 * Öffentlicher Einstiegspunkt: togglet die Effekt-Editor-Preview für Sound
 * `s`, Slot `slotIdx`. Läuft bereits eine Preview (spielend oder ladend),
 * wird sie gestoppt (Abschnitt 5/14) — Argumente werden dann ignoriert.
 * Sonst wird eine neue gestartet (ersetzt automatisch eine evtl. andere
 * laufende Preview, Abschnitt 15).
 */
export async function previewSound(s, slotIdx) {
  if (APP.audioPreview.playing || APP.audioPreview.loading) { stopEffectPreview(); return; }
  await startEffectPreview(s, slotIdx ?? 0);
}

/**
 * Abschnitt 38: "Analyzer AUS ≠ Preview AUS" — reagiert auf die
 * Spektrum-Analyzer-Checkbox im FX-Dialog, OHNE eine laufende Preview zu
 * beenden. Beim Deaktivieren wird nur die Visualisierungsschleife
 * gestoppt (stopAnalyzer()); beim Reaktivieren wird — sofern gerade eine
 * Preview läuft — ein neuer AnalyserNode LIVE in den bereits laufenden
 * Graph gespleißt (masterGain → Analyser → Destination), da der Graph
 * ohne Analyzer aufgebaut wurde, falls dieser bei Preview-Start
 * deaktiviert war. Ohne laufende Preview ist dies ein No-op — die
 * nächste Preview erzeugt den Analyser dann regulär über renderSoundGraph().
 */
export function syncPreviewAnalyzer(enabled) {
  const p = APP.audioPreview;
  if (!p.playing || !p.masterGain) { updateAnalyzerIdleHint(); return; }
  if (!enabled) { if (p.analyser) stopAnalyzer(); return; }

  const ctx = actx();
  try { p.masterGain.disconnect(); } catch (e) {}
  const analyser = createAnalyzerSplit(ctx);
  p.masterGain.connect(analyser);
  analyser.connect(ctx.destination);
  p.analyser = analyser;
  const cv = document.getElementById('analyzerCanvas');
  const mode = document.getElementById('fxAnalyzerMode')?.value || 'bars';
  if (cv) startAnalyzerLoop(analyser, cv, mode);
}

function _updatePreviewButton() {
  const p = APP.audioPreview;
  // Abschnitt 5: zwei Buttons steuern dieselbe Preview — #btnPreviewSound
  // (Sticky-Bar des Sound-Editors) und #btnPreviewFx (Footer von
  // "Audio-Effekte"). Beide müssen denselben Zustand zeigen.
  ['btnPreviewSound', 'btnPreviewFx'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const icon = btn.querySelector('i');
    btn.disabled = p.loading;
    if (p.loading) {
      if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
      btn.setAttribute('aria-label', 'Vorschau wird geladen…');
    } else if (p.playing) {
      if (icon) icon.className = 'fa-solid fa-stop u-text-accent';
      btn.setAttribute('aria-label', 'Vorschau stoppen');
    } else {
      if (icon) icon.className = 'fa-solid fa-play u-text-accent';
      btn.setAttribute('aria-label', 'Vorschau');
    }
  });
  updateAnalyzerIdleHint();
}

/**
 * Abschnitt 24: dezenter Hinweis auf dem Analyzer-Canvas, solange der
 * Analyzer aktiviert, aber gerade nichts zu visualisieren ist (keine
 * laufende Preview) — sonst wirkt das Canvas nur leer/defekt. No-op außerhalb
 * des Audio-Effekt-Dialogs (Elemente existieren dann schlicht nicht im DOM).
 */
export function updateAnalyzerIdleHint() {
  const wrap = document.getElementById('analyzerCanvasWrap');
  if (!wrap) return;
  const enabled = !!document.getElementById('fxAnalyzerEnabled')?.checked;
  wrap.classList.toggle('is-idle', enabled && !APP.analyzer.active);
}
