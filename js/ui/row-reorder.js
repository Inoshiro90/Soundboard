/**
 * ui/row-reorder.js — Touch-Umsortierung für Listenzeilen (Ambient)
 * ------------------------------------------------------------------
 * Ergänzt das native HTML5-Drag&Drop der Listen (Maus/Stift) um Touch: Long-Press AM GRIFF startet
 * das Ziehen, Loslassen über einer anderen Zeile ruft onSwap(srcId, dstId). Dasselbe Muster wie die
 * Kachel-Gesten in ui/drag-drop.js (gleiche Haltezeit, Toleranz, Vibration, pointer-Events,
 * `.is-dragging`/`.is-drag-over`) — die dortige Long-Press-Erkennung wird wiederverwendet.
 * Nur pointerType === 'touch': Maus bleibt beim nativen Drag&Drop, es entsteht nie ein Doppel-Drag.
 * Slider, Buttons und Eingabefelder der Zeile sind nie Auslöser (nur das Griff-Element hört zu).
 *
 * Zustand ist modulweit (immer nur ein aktiver Touch-Drag); jeder Abbruchweg (pointerup/-cancel,
 * Re-Render der Liste, Verlassen der Seite) räumt die Klassen und Listener auf.
 */
import { _armLongPress, _clearLongPress } from './drag-drop.js';

let _active = null; // { list, rowSelector, srcId, onSwap }

const _rowAt = (list, rowSelector, x, y) => {
  const el = document.elementFromPoint(x, y);
  const row = el && el.closest ? el.closest(rowSelector) : null;
  return row && list.contains(row) ? row : null;
};

function _clearMarks(list, rowSelector) {
  list.querySelectorAll(`${rowSelector}.is-drag-over, ${rowSelector}.is-dragging`)
    .forEach(x => x.classList.remove('is-drag-over', 'is-dragging'));
}

function _onMove(e) {
  if (!_active) return;
  const { list, rowSelector, srcId } = _active;
  list.querySelectorAll(`${rowSelector}.is-drag-over`).forEach(x => x.classList.remove('is-drag-over'));
  const row = _rowAt(list, rowSelector, e.clientX, e.clientY);
  if (row && row.dataset.id !== srcId) row.classList.add('is-drag-over');
}

function _onUp(e) {
  if (!_active) return;
  const { list, rowSelector, srcId, onSwap } = _active;
  const row = _rowAt(list, rowSelector, e.clientX, e.clientY);
  const dstId = row?.dataset.id;
  endTouchReorder();
  if (dstId && dstId !== srcId) onSwap(srcId, dstId);
}

/** Beendet einen laufenden Touch-Drag und entfernt alle Zustände/Listener (idempotent). */
export function endTouchReorder() {
  document.removeEventListener('pointermove',   _onMove);
  document.removeEventListener('pointerup',     _onUp);
  document.removeEventListener('pointercancel', endTouchReorder);
  if (_active) _clearMarks(_active.list, _active.rowSelector);
  _active = null;
}

export function isTouchReorderActive() { return !!_active; }

/**
 * @param {object} o
 * @param {HTMLElement} o.list          Container (Delegation — überlebt Re-Renders der Zeilen)
 * @param {string}      o.rowSelector   z. B. '.ambient-row' (Zeile trägt data-id)
 * @param {string}      o.handleSelector z. B. '.ambient-row__handle'
 * @param {(srcId:string,dstId:string)=>void} o.onSwap
 */
export function setupTouchRowReorder({ list, rowSelector, handleSelector, onSwap }) {
  if (!list) return;
  list.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    const handle = e.target.closest(handleSelector); if (!handle) return;
    const row = handle.closest(rowSelector); if (!row) return;
    _armLongPress(e, handle, () => {
      if (navigator.vibrate) navigator.vibrate(12);
      endTouchReorder();
      _active = { list, rowSelector, srcId: row.dataset.id, onSwap };
      row.classList.add('is-dragging');
      document.addEventListener('pointermove',   _onMove);
      document.addEventListener('pointerup',     _onUp,           { once: true });
      document.addEventListener('pointercancel', endTouchReorder, { once: true });
    });
  });
  // Während des Haltens kein Kontextmenü/Textauswahl am Griff (Mobile-Browser öffnen sonst bei Long-Press ihr Menü).
  list.addEventListener('contextmenu', e => { if (e.target.closest(handleSelector)) e.preventDefault(); });
}

export { _clearLongPress as cancelPendingLongPress };
