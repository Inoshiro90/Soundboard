/**
 * ui/slot-editor.js — Slot-Liste, Slot-Bearbeiten-Dialog, Trim-Modal-Guard
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { APP } from '../core/state.js';
import { bk } from '../utils.js';
import { playBufferPreview } from '../audio/playback.js';
import { toast } from '../notifications.js';
import { detectClipping } from '../analysis.js';
import { createModalDraftGuard } from '../modalGuards.js';
import { renderLucideIcons } from './icon-picker.js';
import { drawTrimWaveform, drawTrimSpectrogram, updateTrimDurLabel } from './trim-canvas.js';

// ─── SLOT LIST ────────────────────────────────────────────────

/**
 * Bugfix (Abschnitt 4+9, Testfall H): APP.audioBuffers['_ed_N'] ist
 * positionsbezogen (N = Index in APP.editSlots), wurde aber bei einem
 * Drag-and-Drop-Reorder oder beim Entfernen eines Slots bisher NICHT
 * mitverschoben — nur das APP.editSlots-Array selbst wurde umsortiert.
 * Folge: nach einem Reorder zeigte z.B. _ed_0 weiterhin auf den Buffer,
 * der VOR dem Reorder an Position 0 lag — Slot-Vorschau (previewSlot),
 * Trim-Dialog (openTrimModal) und vor allem der beim Speichern in den
 * Haupt-Cache kopierte Buffer (bk(soundId, i)) bezogen sich dadurch auf
 * die FALSCHE Audiodatei für diese Position.
 *
 * Fix: unmittelbar vor jeder Array-Mutation, die die Zuordnung
 * Index→Slot-Objekt verändert (Reorder, Entfernen), wird der aktuelle
 * _ed_N-Stand anhand der ALTEN Reihenfolge (prevSlots) auf die
 * Objekt-IDENTITÄT der Slots gemapped. Nach der Mutation wird _ed_N aus
 * diesem Mapping anhand der NEUEN Reihenfolge neu aufgebaut. Da die
 * Zuordnung über Objekt-Referenzen (nicht Indizes) läuft, ist das
 * Ergebnis unabhängig davon, wie die Slots konkret umsortiert wurden.
 */
function _resyncEdBuffers(prevSlots) {
  const bufByObj = new Map();
  prevSlots.forEach((sl, i) => {
    const buf = APP.audioBuffers[`_ed_${i}`];
    if (buf) bufByObj.set(sl, buf);
  });
  Object.keys(APP.audioBuffers).forEach(k => {
    if (k.startsWith('_ed_')) delete APP.audioBuffers[k];
  });
  APP.editSlots.forEach((sl, i) => {
    const buf = bufByObj.get(sl);
    if (buf) APP.audioBuffers[`_ed_${i}`] = buf;
  });
}

export function renderSlotList() {
  const list = document.getElementById('slotList');
  if (!list) return;
  list.innerHTML = '';

  let slotDragSrc = null;

  APP.editSlots.forEach((sl, i) => {
    const row = document.createElement('div');
    row.className = 'slot-row';
    row.draggable = true;
    row.dataset.si = i;

    const hasUsableData = sl && sl.data && !sl._loading;
    const previewHtml = hasUsableData
      ? `<button class="slot-btn slot-btn--preview js-prev-btn" title="Vorschau abspielen" aria-label="Slot vorschau">
           <i class="fa-solid fa-play" aria-hidden="true"></i>
         </button>` : '';

    // Sounddauer/Start/Ende/Zuschneiden leben jetzt gebündelt im
    // slotEditModal (Edit-Button) — die Zeile zeigt nur noch Name +
    // die vier Kernaktionen, dafür alle groß genug für motorisch
    // eingeschränkte Nutzer:innen (≥44px Touch-Ziel).
    // Aktionsbuttons in einen eigenen Wrapper (.slot-actions) gebündelt:
    // die Anzahl variiert je Slot-Zustand (Preview/Edit fehlen z.B. ohne
    // Audiodaten) — .slot-row darf daher nicht von einer festen
    // Spaltenzahl für die Buttons ausgehen (siehe CSS). Der Wrapper macht
    // aus "Name + N variable Buttons" strukturell "Name + 1 Aktionsblock",
    // unabhängig von N.
    row.innerHTML = `
      <div class="slot-drag-handle" title="Ziehen" aria-hidden="true"><span></span><span></span><span></span></div>
      <span class="slot-num">${i + 1}.</span>
      <span class="slot-name${sl && sl.data ? '' : ' slot-name--empty'}">${sl?._loading ? (sl.name || 'Datei ' + (i + 1)) + ' (lädt…)' : (sl && sl.data ? (sl.name || 'Datei ' + (i + 1)) : '– leer –')}</span>
      <div class="slot-actions">
        ${previewHtml}
        <button class="slot-btn slot-btn--load js-load-btn" title="Datei laden" aria-label="Audio laden">
          <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
        </button>
        <button class="slot-btn slot-btn--load js-gen-btn" title="Testton/Sweep generieren" aria-label="Ton generieren">
          <i class="fa-solid fa-wave-square" aria-hidden="true"></i>
        </button>
        ${hasUsableData ? `<button class="slot-btn slot-btn--edit js-slot-edit-btn" title="Bearbeiten (Dauer, Start, Ende, Zuschneiden)" aria-label="Slot bearbeiten"><i data-lucide="pencil" aria-hidden="true"></i></button>` : ''}
        <button class="slot-btn slot-btn--remove js-rm-btn" title="Entfernen" aria-label="Slot entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
    `;

    row.querySelector('.js-load-btn').addEventListener('click', () => {
      APP.loadingSlotIdx = i;
      const sf = document.getElementById('slotFile');
      if (sf) { sf.value = ''; sf.click(); }
    });
    row.querySelector('.js-gen-btn').addEventListener('click', () => {
      APP.loadingSlotIdx = i;
      const modalEl = document.getElementById('toneGeneratorModal');
      if (modalEl) new bootstrap.Modal(modalEl).show();
    });
    const rmBtn = row.querySelector('.js-rm-btn');
    if (rmBtn) rmBtn.addEventListener('click', () => {
      // Abschnitt 10+11: Entfernen muss IMMER bestätigt werden — auch für
      // den letzten verbleibenden Slot, dessen Entfernen jetzt ausdrücklich
      // erlaubt ist (ein Sound ganz ohne Audioslot ist ein gültiger
      // Editor-Zustand). Bei Abbruch: keinerlei Mutation, Slot/Buffer/UI
      // bleiben exakt wie zuvor.
      const isLastSlot = APP.editSlots.length === 1;
      const msg = isLastSlot
        ? 'Diesen Audioslot wirklich entfernen? Danach hat der Sound keine Audiospur mehr.'
        : 'Diesen Audioslot wirklich entfernen?';
      if (!confirm(msg)) return;
      const prevSlots = APP.editSlots.slice();
      APP.editSlots.splice(i, 1);
      _resyncEdBuffers(prevSlots);
      renderSlotList();
    });
    const editBtn = row.querySelector('.js-slot-edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => openSlotEditModal(i));
    const prevBtn = row.querySelector('.js-prev-btn');
    if (prevBtn) prevBtn.addEventListener('click', () => previewSlot(i));

    row.addEventListener('dragstart', e => {
      slotDragSrc = i; row.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      list.querySelectorAll('.slot-row').forEach(r => r.classList.remove('is-drag-over'));
    });
    row.addEventListener('dragover',  e => { e.preventDefault(); row.classList.add('is-drag-over'); });
    row.addEventListener('dragleave', ()  => row.classList.remove('is-drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      if (slotDragSrc === null || slotDragSrc === i) return;
      const prevSlots = APP.editSlots.slice();
      const moved = APP.editSlots.splice(slotDragSrc, 1)[0];
      APP.editSlots.splice(i, 0, moved);
      _resyncEdBuffers(prevSlots);
      renderSlotList();
    });

    list.appendChild(row);
  });

  renderLucideIcons(list);
}

// ─── SLOT-EDIT-DIALOG (Sounddauer / Start / Ende / Zuschneiden) ─
// Ein einziger, wiederverwendeter Dialog für alle Slots (statt einem
// Modal pro Slot) — gleiches Muster wie die "+"-Kachel Sound/Makro-Wahl.
let _slotEditIdx = null;

/** Slot-Index, der aktuell im (geteilten) Slot-Edit-Modal offen ist, oder null. */
export function getSlotEditIndex() { return _slotEditIdx; }

export function openSlotEditModal(i) {
  const sl = APP.editSlots[i];
  if (!sl || !sl.data) return;
  _slotEditIdx = i;

  const hasBuf = APP.audioBuffers[`_ed_${i}`];
  const dur    = hasBuf ? APP.audioBuffers[`_ed_${i}`].duration : null;

  const durEl = document.getElementById('slotEditDuration');
  if (durEl) durEl.textContent = dur ? dur.toFixed(1) + 's' : '–';
  const nameEl = document.getElementById('slotEditName');
  if (nameEl) nameEl.textContent = sl.name || `Datei ${i + 1}`;
  const tsEl = document.getElementById('slotEditStart');
  if (tsEl) tsEl.value = sl.trimStart || 0;
  const teEl = document.getElementById('slotEditEnd');
  if (teEl) teEl.value = sl.trimEnd ?? '';

  new bootstrap.Modal(document.getElementById('slotEditModal')).show();
}

/** Wires the shared slot-edit dialog once. Call on app init. */
export function initSlotEditModal() {
  if (document._slotEditWired) return;
  document._slotEditWired = true;

  document.getElementById('slotEditStart')?.addEventListener('change', e => {
    if (_slotEditIdx === null) return;
    const sl = APP.editSlots[_slotEditIdx];
    if (sl) sl.trimStart = parseFloat(e.target.value) || 0;
  });
  document.getElementById('slotEditEnd')?.addEventListener('change', e => {
    if (_slotEditIdx === null) return;
    const sl = APP.editSlots[_slotEditIdx];
    if (sl) sl.trimEnd = e.target.value === '' ? null : parseFloat(e.target.value);
  });
  document.getElementById('slotEditTrimBtn')?.addEventListener('click', () => {
    if (_slotEditIdx === null) return;
    const idx = _slotEditIdx;
    bootstrap.Modal.getInstance(document.getElementById('slotEditModal'))?.hide();
    openTrimModal(idx);
  });
}

// previewSlot: applies the sound's existing pitch (Pitch hat keine eigene
// UI mehr, siehe Audio-Effekte → Pitch Shift)
function previewSlot(i) {
  const sl = APP.editSlots[i];
  if (!sl || !sl.data) { toast('Slot leer'); return; }
  const buf = APP.audioBuffers[`_ed_${i}`];
  if (!buf) { toast('Audio lädt…'); return; }
  const vol   = parseFloat(document.getElementById('eVol')?.value) || 1;
  const pitch = APP.editId ? (CItems().find(x => x.id === APP.editId)?.pitch || 1) : 1;
  playBufferPreview(buf, sl, vol, pitch);
  toast(`Slot ${i + 1} ▶`, 'ok');
}

// ─── TRIM MODAL ───────────────────────────────────────────────
// Abschnitt 7: #trimModal führt Start/Ende/Fades zunächst nur lokal im
// Dialog (erst btnTrimSave übernimmt sie in APP.editSlots) — bekommt daher
// einen eigenen, kleinen Dirty-Schutz über dieselbe zentrale Guard-Utility
// wie #soundModal (keine zweite, abweichende Implementierung).
let _trimGuard    = null;
let _trimBaseline = null;

function _snapshotTrimDraft() {
  const val = id => document.getElementById(id)?.value ?? '';
  return JSON.stringify({
    start:      val('trimStart'),
    end:        val('trimEnd'),
    fadeIn:     val('trimFadeIn'),
    fadeOut:    val('trimFadeOut'),
    fadeInCurve:  val('trimFadeInCurve'),
    fadeOutCurve: val('trimFadeOutCurve'),
  });
}

function _ensureTrimGuard() {
  if (_trimGuard) return;
  _trimGuard = createModalDraftGuard({
    modalId: 'trimModal',
    isDirty: () => _trimBaseline !== null && _snapshotTrimDraft() !== _trimBaseline,
    message: 'Es gibt ungespeicherte Änderungen am Zuschnitt. Wenn du den Dialog jetzt schließt, gehen diese Änderungen verloren. Dialog wirklich schließen?',
    // Nichts rückgängig zu machen: Start/Ende/Fades wurden noch nicht nach
    // APP.editSlots übernommen (das passiert erst in btnTrimSave), das
    // einfache Schließen verwirft sie also automatisch mit.
    onDiscard: () => {},
  });
}

/**
 * Von events.js' btnTrimSave-Handler VOR dem programmgesteuerten `.hide()`
 * aufzurufen — verhindert, dass das erfolgreiche Übernehmen der Trimwerte
 * selbst nochmal die Verwerfen-Rückfrage auslöst (Abschnitt 13, hier für
 * den Trim-Dialog).
 */
export function markTrimSaved() {
  _trimGuard?.disarm();
  _trimBaseline = null;
}

export function openTrimModal(slotIdx) {
  const sl  = APP.editSlots[slotIdx];
  if (!sl || !sl.data) { toast('Kein Audio'); return; }
  const buf = APP.audioBuffers[`_ed_${slotIdx}`];
  if (!buf)            { toast('Audio lädt…'); return; }

  // P3 Spektrogramm: bei jedem Öffnen zurücksetzen (eingeklappt) — die
  // vorherige Anzeige bezog sich sonst kurzzeitig noch auf den ALTEN
  // Slot-Buffer, bis der Toggle erneut angeklickt wird. Der Cache selbst
  // (_trimSpectrogramCache) erkennt den Buffer-Wechsel ohnehin automatisch
  // und berechnet bei Bedarf neu (s. drawTrimSpectrogram()).
  const specToggle = document.getElementById('trimSpectrogramToggle');
  const specCanvas = document.getElementById('trimSpectrogramCanvas');
  if (specToggle) specToggle.checked = false;
  if (specCanvas) specCanvas.style.display = 'none';

  APP.trim.slotIdx      = slotIdx;
  APP.trim.buf          = buf;
  APP.trim.previewSrc   = null;
  APP.trim.dragging     = null;
  APP.trim.zoom         = 1;
  APP.trim.scrollOffset = 0;
  APP.trim.playheadPos  = null;

  // P2 Find Clipping: einmalig beim Öffnen berechnen (nicht bei jedem
  // Redraw — detectClipping() iteriert einmal über alle Samples, das bei
  // Zoom/Scroll wiederholt auszuführen wäre unnötige Arbeit).
  const clip = detectClipping(buf, { threshold: 0.999 });
  APP.trim.clippingRegions = clip.clippingRegions;
  const warnEl  = document.getElementById('trimClipWarning');
  const warnTxt = document.getElementById('trimClipWarningText');
  if (warnEl) warnEl.style.display = clip.clippingRegions.length ? '' : 'none';
  if (warnTxt) warnTxt.textContent = `Clipping erkannt (${clip.clippingRegions.length} Stelle${clip.clippingRegions.length === 1 ? '' : 'n'})`;

  const dur = buf.duration;
  const si  = document.getElementById('trimSlotInfo');
  if (si) si.textContent = `Slot ${slotIdx + 1}: ${sl.name || 'Audio'} — ${dur.toFixed(2)}s`;

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('trimStart',   (sl.trimStart || 0).toFixed(3));
  setVal('trimEnd',     (sl.trimEnd != null ? sl.trimEnd : dur).toFixed(3));
  setVal('trimFadeIn',  (sl.fadeIn  || 0).toFixed(2));
  setVal('trimFadeOut', (sl.fadeOut || 0).toFixed(2));
  setVal('trimFadeInCurve',  sl.fadeInCurve  || 'linear');
  setVal('trimFadeOutCurve', sl.fadeOutCurve || 'linear');
  setVal('trimZoom',    1);

  const teEl = document.getElementById('trimEnd');
  const tsEl = document.getElementById('trimStart');
  if (teEl) teEl.max = dur;
  if (tsEl) tsEl.max = dur;
  const zoomLbl = document.getElementById('trimZoomLbl');
  if (zoomLbl) zoomLbl.textContent = '1×';

  _ensureTrimGuard();
  _trimBaseline = _snapshotTrimDraft();
  _trimGuard.arm();

  updateTrimDurLabel();
  const modal = new bootstrap.Modal(document.getElementById('trimModal'));
  modal.show();
  document.getElementById('trimModal').addEventListener('shown.bs.modal', () => {
    drawTrimWaveform();
    _initTrimCanvasDrag();
    _initTrimZoom();
  }, { once: true });
}

/** Initialise zoom slider — called once per modal open */
