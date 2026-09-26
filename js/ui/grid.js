/**
 * ui/grid.js — Kachel-Grid-Rendering (Sound/Makro/Platzhalter) + "+"-Kachel
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { APP, CItems } from '../core/state.js';
// `uid` und `stopItem` (Zeile darunter) waren bereits im ursprünglichen
// ui.js importiert, aber nie aufgerufen (toter Import) — mechanisch mit
// übernommen.
import { uid, iconHtmlOr } from '../utils.js';
import { playSound, stopItem, runMacro, refreshRotBadge } from '../audio/playback.js';
import { mkPH } from '../storage/factories.js';
// Zirkulärer Import (drag-drop.js importiert umgekehrt makeSoundTile/
// makeMacroTile/renderGrid aus diesem Modul; tabs.js importiert umgekehrt
// renderGrid) — unkritisch, da alle betroffenen Bezeichner Funktions-
// deklarationen sind, die erst zur Laufzeit aufgerufen werden (analog zum
// bereits bestehenden audio/playback.js/ambient.js-Muster).
import { isTileEditMode, setupDrag } from './drag-drop.js';
import { renderPresetDropdown, updateCategories } from './tabs.js';
import { renderLucideIcons } from './icon-picker.js';
import {normaliseOrders} from './drag-drop.js';
import {PENCIL_ICON_SVG} from '../ui.js';

// ─── GRID ─────────────────────────────────────────────────────
// Reines CSS-Grid seit der Einführung des Spalten-Systems
// (siehe grid-system.css): Spaltenzahl kommt aus --grid-cols
// (breakpoint-gesteuert, 4/4/8/12/12/12), Kacheln sind per
// aspect-ratio quadratisch. Kein maxCols/maxRows, kein
// ResizeObserver, keine JS-Breitenmessung mehr nötig.

// Nach den echten Sounds/Makros werden immer ein paar leere
// "+"-Kacheln angehängt, damit zum Hinzufügen nie manuell eine
// neue Reihe/Spalte geschaffen werden muss — das Grid wächst
// einfach mit dem Inhalt (kein Zeilenlimit mehr).
const TRAILING_PLACEHOLDERS = 8;

export function renderGrid() {
  const grid = document.getElementById('grid');

  normaliseOrders();

  let list = [...CItems()].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (APP.activeCategory !== 'all') {
    list = list.filter(x =>
      x.type === 'placeholder' || x.type === 'macro' ||
      (x.type === 'sound' && x.category === APP.activeCategory)
    );
  }

  // Bestehende Platzhalter am Ende zählen, damit nicht bei jedem
  // renderGrid() weitere angehängt werden (nur auffüllen, nicht endlos wachsen).
  let trailingPH = 0;
  for (let i = list.length - 1; i >= 0 && list[i].type === 'placeholder'; i--) trailingPH++;
  for (let i = trailingPH; i < TRAILING_PLACEHOLDERS; i++) list.push(mkPH(list.length));

  grid.innerHTML = '';
  // Bisherige Kacheln werden gleich verworfen (innerHTML = '') — vorher
  // alle Beobachtungen des gemeinsamen Sound-Tile-Label-ResizeObservers
  // lösen, sonst würden verwaiste, nicht mehr im DOM befindliche
  // .tile-wrap-Elemente dauerhaft beobachtet bleiben (Memory Leak bei
  // häufigem Neu-Rendern des Grids).
  _tileLabelObserver.disconnect();
  list.forEach(item => {
    grid.appendChild(
      item.type === 'sound' ? makeSoundTile(item) :
      item.type === 'macro' ? makeMacroTile(item) :
      makePHTile(item)
    );
  });
  renderLucideIcons(grid);

  updateCategories();
  setupDrag();
  CItems().filter(x => x.type === 'sound').forEach(x => refreshRotBadge(x.id));
}

// ─── TILE BUILDERS ────────────────────────────────────────────

// ─── SOUND-TILE LABEL AUTO-FIT ──────────────────────────────────
// Verkleinert die Schriftgröße von .tile__label--autofit automatisch
// so weit, bis der vollständige (unveränderte) Soundname einzeilig in
// die tatsächlich verfügbare Kachelbreite passt — kein Zeilenumbruch,
// keine Ellipsis (siehe .tile__label in components.css: white-space:
// nowrap, kein -webkit-line-clamp mehr). Nur für Sound-Tiles aktiv;
// Macro-Tiles (makeMacroTile) behalten die normale CSS-clamp()-Größe
// unverändert, da ihre Labels nicht die Klasse .tile__label--autofit
// erhalten.
//
// Messung erfolgt über eine Offscreen-<canvas> (kein DOM-Reflow pro
// Messschritt), Reaktion auf Größenänderungen der Kachel über einen
// einzigen gemeinsamen ResizeObserver (kein setInterval/Polling).

const _tileLabelCanvas = document.createElement('canvas');
const _tileLabelCtx    = _tileLabelCanvas.getContext('2d');
const TILE_LABEL_SAFETY_PX = 3; // Sicherheitsmarge (Letter-Spacing/Rundung)

function _cssLengthToPx(value) {
  if (!value) return 0;
  const remMatch = /^([\d.]+)rem$/.exec(value);
  if (remMatch) {
    const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return parseFloat(remMatch[1]) * rootSize;
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

// Untere Grenze aus dem bestehenden Designsystem (--tile-label-min-size,
// css/base.css) — deckt sich mit dem bisherigen unteren clamp()-Wert von
// .tile__label, kein neuer willkürlicher Wert.
function tileLabelMinSize() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--tile-label-min-size').trim();
  return _cssLengthToPx(raw) || 9.6; // Fallback ≈ 0.6rem bei 16px Root-Schrift
}

function fitTileLabel(label) {
  if (!label || !label.isConnected) return;

  // Baseline (vom CSS clamp() vorgegebene Größe) zuerst wiederherstellen —
  // sonst würde eine zuvor reduzierte Größe als neuer Ausgangswert dienen
  // und nie mehr größer werden, wenn die Kachel anschließend wächst.
  label.style.fontSize = '';

  const availableWidth = label.clientWidth;
  if (availableWidth <= 0) return;

  const cs       = getComputedStyle(label);
  const baseSize = parseFloat(cs.fontSize);
  if (!baseSize) return;

  const text = (label.textContent || '').toUpperCase(); // text-transform: uppercase
  _tileLabelCtx.font = `${cs.fontWeight} ${baseSize}px ${cs.fontFamily}`;
  const textWidth = _tileLabelCtx.measureText(text).width;

  if (textWidth <= availableWidth) return; // passt bereits — nichts zu tun

  const minSize = tileLabelMinSize();

  // Schritt 1: neue Größe direkt aus dem Verhältnis verfügbare/tatsächliche
  // Breite ableiten, statt viele kleine Einzelschritte zu messen.
  let newSize = Math.max(minSize, baseSize * (availableWidth - TILE_LABEL_SAFETY_PX) / textWidth);

  // Schritt 2: kurze Feinjustierung, da Rendering/Letter-Spacing/Rundung
  // vom reinen Verhältnis abweichen können.
  for (let i = 0; i < 6 && newSize > minSize; i++) {
    _tileLabelCtx.font = `${cs.fontWeight} ${newSize}px ${cs.fontFamily}`;
    if (_tileLabelCtx.measureText(text).width <= availableWidth - TILE_LABEL_SAFETY_PX) break;
    newSize -= 0.5;
  }

  label.style.fontSize = `${Math.max(minSize, newSize)}px`;
}

// Ein einziger gemeinsamer ResizeObserver für alle Sound-Tiles statt
// einem Observer pro Kachel. .tile-wrap trägt bereits container-type:
// inline-size (components.css) — seine Breite ist also die maßgebliche,
// dynamische Größe (Grid-Spaltenwechsel, Breakpoints, Fenster-Resize).
// Mehrere gleichzeitig ausgelöste Callbacks werden in einem
// requestAnimationFrame gebündelt, um font-size nicht mehrfach
// hintereinander pro Tick zu setzen.
let _tileLabelFitScheduled = false;
const _tileLabelPending = new Set();
const _tileLabelObserver = new ResizeObserver(entries => {
  entries.forEach(entry => {
    const label = entry.target.querySelector('.tile__label--autofit');
    if (label) _tileLabelPending.add(label);
  });
  if (_tileLabelFitScheduled) return;
  _tileLabelFitScheduled = true;
  requestAnimationFrame(() => {
    _tileLabelFitScheduled = false;
    _tileLabelPending.forEach(fitTileLabel);
    _tileLabelPending.clear();
  });
});

function tileStyle(item) {
  return item.tileColor ? `background:${item.tileColor};` : '';
}

export function makeSoundTile(s) {
  const wrap = document.createElement('div');
  wrap.className  = 'tile-wrap' + (s.locked ? ' is-locked' : '');
  wrap.dataset.id = s.id;
  wrap.draggable  = true;

  const hasAudio    = (s.slots || []).some(sl => sl && sl.data);
  const hkHtml      = s.hotkey ? `<div class="tile__hotkey">${s.hotkey}</div>` : '';
  const accentStyle = s.color && s.color !== 'none' ? `border: 2px solid ${s.color};` : '';

  wrap.innerHTML = `
    <div class="tile${!hasAudio ? ' tile--no-audio' : ''}${s.loop ? ' tile--loop' : ''}"
         style="${tileStyle(s)}${accentStyle}"
         role="button" aria-label="${s.name || 'Sound'}">
      ${hkHtml}
      <div class="tile__icon" aria-hidden="true">${iconHtmlOr(s.icon, '🔊', 'tile__icon-img')}</div>
      <div class="tile__label tile__label--autofit">${s.name || 'SOUND'}</div>
      <div class="tile__slot-badge" aria-hidden="true"></div>
      <i class="fa-solid fa-rotate tile__loop-icon" aria-hidden="true"></i>
      <i class="fa-solid fa-lock tile__lock-icon" aria-hidden="true"></i>
      <div class="tile__progress" aria-hidden="true"></div>
    </div>
    <div class="tile-controls" aria-label="Kachel-Aktionen">
      <button class="tile-ctrl-btn js-edit-btn" title="Bearbeiten" aria-label="Sound bearbeiten">
        ${PENCIL_ICON_SVG}
      </button>
    </div>
    <div class="drag-dots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  `;

  const tile = wrap.querySelector('.tile');

  // Im Bearbeitungsmodus (Toggle über #btnTileEditMode) editiert ein Tap
  // auf die Kachel direkt, statt abzuspielen — Abspielen ist dort bewusst
  // deaktiviert, damit ein normaler Klick nicht versehentlich Sounds
  // auslöst, während man eigentlich Kacheln durchgeht/bearbeitet.
  // Außerhalb des Bearbeitungsmodus spielt ein Tap wie gewohnt ab.
  tile.addEventListener('click', e => {
    if (e.target.closest('.tile-controls')) return;
    if (isTileEditMode()) { import('../events.js').then(mod => mod.openSoundModal(s.id)); return; }
    playSound(s);
  });

  wrap.querySelector('.js-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    import('../events.js').then(m => m.openSoundModal(s.id));
  });

  _tileLabelObserver.observe(wrap);

  refreshRotBadge(s.id);
  return wrap;
}

export function makeMacroTile(m) {
  const wrap = document.createElement('div');
  wrap.className  = 'tile-wrap' + (m.locked ? ' is-locked' : '');
  wrap.dataset.id = m.id;
  wrap.draggable  = true;

  const hkHtml      = m.hotkey ? `<div class="tile__hotkey">${m.hotkey}</div>` : '';
  const accentStyle = m.color && m.color !== 'none' ? `border: 2px solid ${m.color};` : '';

  wrap.innerHTML = `
    <div class="tile tile--macro"
         style="${tileStyle(m)}${accentStyle}"
         role="button" aria-label="${m.name || 'Makro'}">
      ${hkHtml}
      <div class="tile__icon" aria-hidden="true">${iconHtmlOr(m.icon, '🪄', 'tile__icon-img')}</div>
      <div class="tile__label">${m.name || 'MAKRO'}</div>
      <div class="tile__macro-badge" aria-hidden="true">MAKRO${m.repeat > 1 ? ' ×' + m.repeat : ''}</div>
      <i class="fa-solid fa-lock tile__lock-icon" aria-hidden="true"></i>
      <div class="tile__progress" aria-hidden="true"></div>
    </div>
    <div class="tile-controls" aria-label="Kachel-Aktionen">
      <button class="tile-ctrl-btn js-edit-btn" title="Bearbeiten" aria-label="Makro bearbeiten">
        ${PENCIL_ICON_SVG}
      </button>
    </div>
    <div class="drag-dots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  `;

  // Gleiche Logik wie bei Sound-Kacheln: im Bearbeitungsmodus editiert ein
  // Tap direkt, statt das Makro auszuführen.
  wrap.querySelector('.tile').addEventListener('click', e => {
    if (e.target.closest('.tile-controls')) return;
    if (isTileEditMode()) { import('../events.js').then(mod => mod.openMacroModal(m.id)); return; }
    runMacro(m);
  });
  wrap.querySelector('.js-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    import('../events.js').then(ev => ev.openMacroModal(m.id));
  });
  return wrap;
}

export function makePHTile(ph) {
  const wrap = document.createElement('div');
  wrap.className  = 'tile-wrap' + (ph.locked ? ' is-locked' : '');
  wrap.dataset.id = ph.id;
  wrap.draggable  = true;

  wrap.innerHTML = `
    <div class="tile tile--placeholder" aria-label="Leerer Slot">
      <i class="fa-solid fa-lock tile__lock-icon" aria-hidden="true"></i>
      <div class="tile-controls">
        <button class="tile-ctrl-btn js-add-btn" title="Sound oder Makro hinzufügen" aria-label="Hinzufügen"
          aria-haspopup="menu" aria-expanded="false">
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <div class="drag-dots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  `;

  const phTile = wrap.querySelector('.tile');
  phTile.addEventListener('click', e => {
    if (e.target.closest('.tile-controls')) return;
  });
  phTile.addEventListener('dblclick', () => {
    import('../events.js').then(m => m.openSoundModal(null, ph.id));
  });
  const addBtn = wrap.querySelector('.js-add-btn');
  if (addBtn) addBtn.addEventListener('click', e => {
    e.stopPropagation();
    _openTileAddChoice(addBtn, ph.id);
  });
  return wrap;
}

// ─── "+"-KACHEL: SOUND ODER MAKRO WÄHLEN ───────────────────────
// Ein einziges, wiederverwendetes Popover für alle leeren Kacheln (statt
// eines pro Kachel) — positioniert sich per JS am zuletzt geklickten
// "+"-Button. Ersetzt den vormals eigenständigen "Makro"-Menüband-Button:
// Sound UND Makro werden jetzt direkt am Zielslot entschieden.
let _tileAddTargetId = null;
let _tileAddTargetBtn = null;

function _closeTileAddChoice() {
  const panel = document.getElementById('tileAddChoicePopover');
  if (panel) panel.hidden = true;
  _tileAddTargetBtn?.setAttribute('aria-expanded', 'false');
  _tileAddTargetId  = null;
  _tileAddTargetBtn = null;
}

function _openTileAddChoice(anchorBtn, phId) {
  const panel = document.getElementById('tileAddChoicePopover');
  if (!panel) return;
  const alreadyOpenForThis = !panel.hidden && _tileAddTargetId === phId;
  _closeTileAddChoice();
  if (alreadyOpenForThis) return; // clicking the same "+" again just closes it

  _tileAddTargetId  = phId;
  _tileAddTargetBtn = anchorBtn;
  anchorBtn.setAttribute('aria-expanded', 'true');

  const rect = anchorBtn.getBoundingClientRect();
  panel.style.position = 'fixed';
  panel.style.top  = `${Math.round(rect.bottom + 6)}px`;
  panel.style.left = `${Math.round(rect.left)}px`;
  panel.style.right = 'auto';
  panel.hidden = false;
  requestAnimationFrame(() => {
    if (panel.hidden) return;
    const pad  = 8;
    const pRect = panel.getBoundingClientRect();
    if (pRect.right > window.innerWidth - pad) {
      panel.style.left = `${Math.max(pad, window.innerWidth - pad - pRect.width)}px`;
    }
  });
}

/** Wires the shared "Sound / Makro" choice popover once. Call on app init. */
export function initTileAddChoice() {
  if (document._tileAddChoiceWired) return;
  document._tileAddChoiceWired = true;

  import('./disclosure.js').then(m => m.portalToBody(document.getElementById('tileAddChoicePopover')));

  document.getElementById('tileAddChoiceSound')?.addEventListener('click', () => {
    const phId = _tileAddTargetId;
    _closeTileAddChoice();
    import('../events.js').then(m => m.openSoundModal(null, phId));
  });
  document.getElementById('tileAddChoiceMacro')?.addEventListener('click', () => {
    const phId = _tileAddTargetId;
    _closeTileAddChoice();
    import('../events.js').then(m => m.openMacroModal(null, phId));
  });
  document.addEventListener('click', e => {
    const panel = document.getElementById('tileAddChoicePopover');
    if (!panel || panel.hidden) return;
    if (panel.contains(e.target) || e.target.closest('.js-add-btn')) return;
    _closeTileAddChoice();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') _closeTileAddChoice();
  });
}

/**
 * Prompt 4, Kap. 3: generische Variante von renderPresetDropdown() — baut
 * die Preset-Optionsliste (Kategorien + eigene Presets) in ein beliebiges
 * <select>-Element statt fest in #fxPreset. Es darf nur EINE Quelle für die
 * Preset-Liste geben: sowohl Sound-Effekte (#fxPreset) als auch der
 * Musik-Track-Dialog (Prompt 3) und die Profil-Presets (Prompt 4) rufen
 * diese Funktion auf.
 * @param {HTMLSelectElement} sel - Ziel-<select>, dessen erstes <option>
 *   ("— Kein Preset —"/"Kein Preset") im Markup bereits vorhanden sein muss.
 * @param {string} [currentId] - zu erhaltender Wert; Standard: sel.value.
 */
