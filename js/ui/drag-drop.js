/**
 * ui/drag-drop.js — Kachel-Drag&Drop (Maus + Touch), Long-Press, Tile-Edit-Modus
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { CItems } from '../core/state.js';
// Zirkulärer Import (grid.js importiert umgekehrt isTileEditMode/setupDrag
// aus diesem Modul) — unkritisch, s. Kommentar in ui/grid.js.
import { makeSoundTile, makeMacroTile, renderGrid } from './grid.js';

// ─── DRAG & DROP ──────────────────────────────────────────────

let _dragSrc = null;

export function setupDrag() {
  document.querySelectorAll('.tile-wrap').forEach(w => {
    w.addEventListener('dragstart', e => {
      // Während eines Touch-Drags (Bearbeitungsmodus) keine parallele
      // native HTML5-DnD-Operation zulassen (manche Browser lösen bei
      // Long-Press auch natives Drag aus).
      if (_touchDragSrcId) { e.preventDefault(); return; }
      _dragSrc = w.dataset.id; w.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // WICHTIG: manche Browser (insbesondere Firefox, teils auch Chrome
      // je nach Konfiguration) behandeln eine Drag-Operation ohne
      // dataTransfer.setData() als "ungültig" und liefern das drop-Event
      // dann nicht zuverlässig aus — ohne diese Zeile könnte das Ziehen
      // rein optisch starten, aber beim Loslassen wirkungslos bleiben.
      e.dataTransfer.setData('text/plain', w.dataset.id);
    });
    w.addEventListener('dragend', () => {
      w.classList.remove('is-dragging');
      document.querySelectorAll('.tile-wrap').forEach(x => x.classList.remove('is-drag-over'));
    });
    w.addEventListener('dragover',  e => { e.preventDefault(); w.classList.add('is-drag-over'); });
    w.addEventListener('dragleave', ()=> w.classList.remove('is-drag-over'));
    w.addEventListener('drop', e => {
      e.preventDefault();
      if (!_dragSrc || _dragSrc === w.dataset.id) return;
      _moveTileOrder(_dragSrc, w.dataset.id);
    });
    setupTileEditGestures(w);
  });
}

/**
 * Verschiebt Kachel `srcId` auf die Position von `dstId` — ECHTER
 * Positionstausch (Swap) der beiden `.order`-Werte. Nur die gezogene und
 * die Ziel-Kachel wechseln ihren Platz; alle übrigen Kacheln (und
 * bestehende Lücken/Platzhalter) bleiben exakt an ihrer Stelle.
 *
 * TATSÄCHLICHER FEHLER (vorherige Implementierung): die Funktion hat
 * NICHT getauscht, sondern per splice()-Remove+Insert ein "Einfügen mit
 * Nachrücken" gemacht (`items.splice(ai,1)` gefolgt von
 * `items.splice(bi,0,moved)`). Dabei rücken ALLE Kacheln, die zwischen
 * Quell- und Zielposition liegen, um genau eine Stelle nach — inklusive
 * bestehender Platzhalter/Lücken, die dabei mitgeschoben wurden statt an
 * ihrem Platz zu bleiben. Das erklärt exakt die gemeldeten Symptome:
 *   - Fehler A: zieht man eine Kachel weiter nach rechts auf eine andere,
 *     werden alle dazwischenliegenden Kacheln um eins nach LINKS
 *     verschoben (und umgekehrt bei einer Bewegung nach links werden
 *     dazwischenliegende Kacheln nach RECHTS verschoben) — obwohl der
 *     Nutzer nur EINE Kachel bewegen wollte.
 *   - Fehler B: eine bestehende Lücke, die zwischen Quelle und Ziel liegt,
 *     wird beim Verschieben unbeabsichtigt mitgenommen/verschoben, statt
 *     an ihrer bisherigen visuellen Stelle stehen zu bleiben bzw. exakt
 *     die freigewordene Zielposition zu übernehmen.
 * Reproduzierbar rein aus der Datenstruktur: bei [A,B,C,D] (order 0..3)
 * ergab ein Drag von D (Index 3) auf B (Index 1) vorher [A,D,B,C] — C
 * (Index 2) wurde nach rechts verschoben, obwohl nur D bewegt werden
 * sollte. Die Anforderung "andere Kacheln dürfen nicht unkontrolliert
 * verschoben werden" verlangt stattdessen einen reinen Swap: [A,D,C,B].
 *
 * Bonus-Fix: `dstId` kann auf eine der rein visuellen, nachträglich in
 * renderGrid() angehängten "+"-Füll-Platzhalter zeigen (siehe
 * TRAILING_PLACEHOLDERS) — die existieren NUR im DOM/in der lokalen
 * Render-Liste, nicht in CItems(). Ein Drop darauf fand bisher keinen
 * Treffer (bi < 0) und tat dadurch kommentarlos gar nichts. Das wird hier
 * als "an eine frische Stelle ans Ende verschieben" behandelt, statt den
 * Drop wirkungslos verpuffen zu lassen.
 */
function _moveTileOrder(srcId, dstId) {
  const items = CItems();
  const src = items.find(x => x.id === srcId);
  if (!src) return;

  const dst = items.find(x => x.id === dstId);
  if (src === dst) return;

  if (!dst) {
    // dstId gehört zu einem transienten, nicht persistierten Füll-
    // Platzhalter (s.o.) — an eine neue, echte Stelle ans Ende verschieben.
    const maxOrder = items.reduce((m, x) => Math.max(m, x.order || 0), -1);
    src.order = maxOrder + 1;
    renderGrid();
    return;
  }

  const srcOrder = src.order;
  src.order = dst.order;
  dst.order = srcOrder;
  renderGrid();
}

export function normaliseOrders() {
  CItems().sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((x, i) => { x.order = i; });
}

// ─── TILE-BEARBEITUNGSMODUS ──────────────────────────────────────
// Zwei bewusst ENTKOPPELTE Mechanismen (vorher beide an Long-Press
// gekoppelt, das war der alte "iOS-Homescreen"-Ansatz):
//
// 1) Bearbeitungsmodus (dieser Abschnitt, isTileEditMode()/
//    setTileEditMode()): wird per Toolbar-Button #btnTileEditMode
//    (events.js) EIN-/AUSGESCHALTET, nicht mehr per Long-Press. Während
//    dieser Modus aktiv ist, öffnet ein Tap auf eine Sound-/Makro-Kachel
//    direkt den Editor (statt abzuspielen/auszuführen) — bewusst OHNE
//    Abhängigkeit von einem sichtbaren Stift-Icon, da dessen Sichtbarkeit
//    sich als unzuverlässig erwiesen hat (siehe makeSoundTile/
//    makeMacroTile Klick-Handler). Der Stift-Button (.js-edit-btn) bleibt
//    als zusätzlicher, unabhängiger Weg bestehen (z.B. Desktop-Hover
//    außerhalb des Bearbeitungsmodus).
//
// 2) Kachel verschieben (setupTileEditGestures()/_beginTouchDrag()
//    unten): auf Touch löst ein Long-Press DIREKT das Ziehen aus,
//    unabhängig vom Bearbeitungsmodus — kein Zwischenschritt mehr
//    nötig. Auf Desktop (Maus) unverändert: natives HTML5-Drag&Drop.

let _tileEditMode = false;

export function isTileEditMode() { return _tileEditMode; }

export function setTileEditMode(on) {
  _tileEditMode = !!on;
  document.getElementById('grid')?.classList.toggle('is-edit-mode', _tileEditMode);
  const bar = document.getElementById('editModeBar');
  if (bar) bar.hidden = !_tileEditMode;
  const btn = document.getElementById('btnTileEditMode');
  if (btn) {
    btn.classList.toggle('is-active', _tileEditMode);
    btn.setAttribute('aria-pressed', String(_tileEditMode));
  }
  if (!_tileEditMode) _endTouchDrag();
}

const LONG_PRESS_MS   = 450;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

let _lp = null; // { timer, wrap, moveHandler, upHandler }

function _clearLongPress() {
  if (!_lp) return;
  clearTimeout(_lp.timer);
  _lp.wrap.removeEventListener('pointermove',  _lp.moveHandler);
  _lp.wrap.removeEventListener('pointerup',    _lp.upHandler);
  _lp.wrap.removeEventListener('pointercancel',_lp.upHandler);
  _lp = null;
}

function _armLongPress(e, wrap, onFire) {
  _clearLongPress();
  const startX = e.clientX, startY = e.clientY;
  const moveHandler = ev => {
    if (Math.abs(ev.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE_PX ||
        Math.abs(ev.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE_PX) _clearLongPress();
  };
  const upHandler = () => _clearLongPress();
  const timer = setTimeout(() => { _clearLongPress(); onFire(); }, LONG_PRESS_MS);
  _lp = { timer, wrap, moveHandler, upHandler };
  wrap.addEventListener('pointermove',   moveHandler);
  wrap.addEventListener('pointerup',     upHandler, { once: true });
  wrap.addEventListener('pointercancel', upHandler, { once: true });
}

// Nur EIN aktiver Touch-Drag gleichzeitig — modulweiter Zustand statt
// pro Kachel, da das Ziel beim Ziehen über andere Kacheln ermittelt wird.
let _touchDragSrcId = null;

function _beginTouchDrag(wrap) {
  _touchDragSrcId = wrap.dataset.id;
  wrap.classList.add('is-dragging');
  document.addEventListener('pointermove',   _onTouchDragMove);
  document.addEventListener('pointerup',     _onTouchDragEnd,   { once: true });
  document.addEventListener('pointercancel', _onTouchDragCancel,{ once: true });
}

function _onTouchDragMove(e) {
  if (!_touchDragSrcId) return;
  document.querySelectorAll('.tile-wrap.is-drag-over').forEach(x => x.classList.remove('is-drag-over'));
  const el     = document.elementFromPoint(e.clientX, e.clientY);
  const target = el && el.closest ? el.closest('.tile-wrap') : null;
  if (target && target.dataset.id !== _touchDragSrcId) target.classList.add('is-drag-over');
}

function _onTouchDragEnd(e) {
  const el     = document.elementFromPoint(e.clientX, e.clientY);
  const target = el && el.closest ? el.closest('.tile-wrap') : null;
  const srcId  = _touchDragSrcId;
  _endTouchDrag();
  if (target && srcId && target.dataset.id !== srcId) _moveTileOrder(srcId, target.dataset.id);
}

function _onTouchDragCancel() { _endTouchDrag(); }

function _endTouchDrag() {
  document.removeEventListener('pointermove',   _onTouchDragMove);
  document.removeEventListener('pointerup',     _onTouchDragEnd);
  document.removeEventListener('pointercancel', _onTouchDragCancel);
  document.querySelectorAll('.tile-wrap.is-drag-over, .tile-wrap.is-dragging')
    .forEach(x => x.classList.remove('is-drag-over', 'is-dragging'));
  _touchDragSrcId = null;
}

/** Long-Press-Erkennung pro Kachel — nur für Touch-Pointer (Desktop/Maus
 *  bleibt vom bestehenden Hover+Klick+HTML5-DnD-Verhalten unberührt).
 *  Löst DIREKT das Verschieben aus (kein Bearbeitungsmodus mehr dazwischen,
 *  s. Kommentarblock oben). */
export function setupTileEditGestures(wrap) {
  wrap.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    _armLongPress(e, wrap, () => {
      if (navigator.vibrate) navigator.vibrate(12);
      _beginTouchDrag(wrap);
    });
  });
}


