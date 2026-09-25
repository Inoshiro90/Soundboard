/**
 * ui.js — DOM Rendering & UI Updates
 *
 * Changes v2:
 * - Responsive grid (auto-fill + minmax, ResizeObserver)
 * - No stop-overlay on tiles; click always plays / advances slot
 * - buildIconGrid rewritten: new EMOJI_CATS structure, keyword search, scrollable cat bar
 * - previewSlot now applies pitch from modal input
 * - Theme icon updated on toggle
 */

import { APP, CItems } from './core/state.js';
import { EMOJI_CATS, EMOJI_KEYWORDS } from './data/emoji-data.js';
import { COLORS, COLOR_NAMES } from './data/color-data.js';
import { uid, bk, isCustomIcon, iconHtml, iconGlyph, iconHtmlOr }  from './utils.js';
import { playSound, stopItem, runMacro, refreshRotBadge, playBufferPreview } from './audio.js';
import { mkPH }                            from './storage.js';
import { toast }                           from './notifications.js';
import { getPeak, getRms, detectClipping } from './analysis.js';
import { clampFadeDurations } from './renderPipeline.js';
import { fft, hannWindow } from './dsp/fft.js';
import { getAllPresets, PRESET_CATEGORIES } from './presets.js';
import { createModalDraftGuard } from './modalGuards.js';

// Lucide "pencil" icon (Nutzer-Vorgabe) — als Konstante, damit Profile-
// und Ambient-Tabs (ui.js/ambient.js) exakt dasselbe Icon verwenden.
export const PENCIL_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';

/**
 * Prompt 1, Kap. 5: gemeinsame Hilfsfunktion für die dezente Akzent-
 * markierung eingefärbter Tabs — von allen drei Tab-Leisten verwendet
 * (#profBar in ui.js, #ambProfBar in ambient.js, #musicProfBar in music.js),
 * damit keine drei separaten Umsetzungen entstehen. Setzt KEINE
 * Vollfarbe als Hintergrund, sondern einen farbigen oberen Rand über eine
 * CSS-Custom-Property, die von .profile-tab per box-shadow ausgelesen wird
 * (siehe css/components.css) — dadurch bleiben Active-/Hover-Zustand
 * (Hintergrund, unterer Rand) davon vollkommen unberührt.
 * @param {HTMLElement} tab
 * @param {string} color - Hex-Farbe oder 'none'
 */
export function _applyTabAccent(tab, color) {
  if (color && color !== 'none') {
    tab.style.setProperty('--tab-accent', color);
    tab.classList.add('profile-tab--accent');
  } else {
    tab.style.removeProperty('--tab-accent');
    tab.classList.remove('profile-tab--accent');
  }
}

// ─── PROFILE TABS ─────────────────────────────────────────────

export function renderProfileTabs() {
  const bar    = document.getElementById('profBar');
  const addBtn = document.getElementById('btnAddProfile');
  bar.querySelectorAll('.profile-tab').forEach(t => t.remove());

  APP.profiles.forEach(p => {
    const tab = document.createElement('button');
    tab.className = 'profile-tab' + (p.id === APP.activeProfileId ? ' is-active' : '');
    tab.dataset.pid = p.id;
    // Prompt 1, Kap. 5: dezente, dauerhafte Akzentmarkierung statt
    // Vollfarben-Hintergrund — siehe _applyTabAccent() weiter unten.
    _applyTabAccent(tab, p.color);
    tab.innerHTML =
      `<span class="profile-tab__name">${iconHtmlOr(p.icon, '🎵', 'profile-tab__icon-img')} ${p.name}</span>` +
      `<span class="profile-tab__edit" title="Profil bearbeiten" aria-label="Profil bearbeiten">` +
      `${PENCIL_ICON_SVG}</span>`;
    bar.insertBefore(tab, addBtn);
  });
}

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
    if (isTileEditMode()) { import('./events.js').then(mod => mod.openSoundModal(s.id)); return; }
    playSound(s);
  });

  wrap.querySelector('.js-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    import('./events.js').then(m => m.openSoundModal(s.id));
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
    if (isTileEditMode()) { import('./events.js').then(mod => mod.openMacroModal(m.id)); return; }
    runMacro(m);
  });
  wrap.querySelector('.js-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    import('./events.js').then(ev => ev.openMacroModal(m.id));
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
    import('./events.js').then(m => m.openSoundModal(null, ph.id));
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

  import('./ui/disclosure.js').then(m => m.portalToBody(document.getElementById('tileAddChoicePopover')));

  document.getElementById('tileAddChoiceSound')?.addEventListener('click', () => {
    const phId = _tileAddTargetId;
    _closeTileAddChoice();
    import('./events.js').then(m => m.openSoundModal(null, phId));
  });
  document.getElementById('tileAddChoiceMacro')?.addEventListener('click', () => {
    const phId = _tileAddTargetId;
    _closeTileAddChoice();
    import('./events.js').then(m => m.openMacroModal(null, phId));
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
export function renderPresetOptions(sel, currentId) {
  if (!sel) return;
  const prevValue = currentId !== undefined ? currentId : sel.value;

  // WICHTIG: sel.options ist eine FLACHE Liste aller <option>-Elemente,
  // auch derer innerhalb von <optgroup>s. sel.remove(1) entfernt daher nur
  // das <option> selbst — die dadurch leer werdende <optgroup> bleibt als
  // leere Hülle im DOM zurück. Bei jedem Re-Render (nach Preset erstellen/
  // duplizieren/bearbeiten/löschen/importieren) sammelten sich so pro
  // Kategorie immer mehr leere <optgroup>-Einträge an. Stattdessen direkt
  // alle Kind-Elemente außer der ersten Option ("— Kein Preset —") aus dem
  // <select> entfernen — das räumt auch verwaiste <optgroup>s zuverlässig weg.
  while (sel.lastElementChild && sel.lastElementChild !== sel.firstElementChild) {
    sel.removeChild(sel.lastElementChild);
  }

  const all = getAllPresets();
  const builtins = all.filter(p => p.builtin);
  const users    = all.filter(p => !p.builtin);

  const categoryOrder = Object.keys(PRESET_CATEGORIES).sort(
    (a, b) => (PRESET_CATEGORIES[a].order || 0) - (PRESET_CATEGORIES[b].order || 0)
  );

  categoryOrder.forEach(catKey => {
    const inCat = builtins.filter(p => p.category === catKey);
    if (!inCat.length) return;
    const group = document.createElement('optgroup');
    group.label = `${PRESET_CATEGORIES[catKey].icon} ${PRESET_CATEGORIES[catKey].label}`;
    inCat.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      if (p.description) opt.title = p.description;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  });

  if (users.length) {
    const group = document.createElement('optgroup');
    group.label = '⭐ Eigene Presets';
    users.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      if (p.description) opt.title = p.description;
      group.appendChild(opt);
    });
    sel.appendChild(group);
  }

  // Auswahl beibehalten, falls das Preset noch existiert (z.B. nach dem
  // Bearbeiten eines eigenen Presets); sonst zurück auf "Kein Preset".
  sel.value = [...sel.options].some(o => o.value === prevValue) ? prevValue : '';
}

// ─── AUDIO-EFFEKT-PRESET-DROPDOWN (Sound-Editor) ──────────────
// Ersetzt die früher statisch in index.html hinterlegten <optgroup>-Blöcke
// ("Phase 1"/"Phase 2", technisch nach Entwicklungsphase gruppiert). Baut
// die Optionsliste jetzt dynamisch nach akustischer Kategorie (Kap. 9) auf
// und hängt eine eigene Gruppe für benutzerdefinierte Presets an — dadurch
// erscheinen neu erstellte/importierte User-Presets sofort im Dropdown,
// ohne dass HTML angefasst werden muss (Kap. 17: generisch, keine
// Sonderfälle je Preset-ID). Dünner Wrapper um renderPresetOptions() für
// die einzige feste Aufrufstelle #fxPreset (Prompt 4, Kap. 3).
export function renderPresetDropdown() {
  renderPresetOptions(document.getElementById('fxPreset'));
}

// ─── CATEGORIES ───────────────────────────────────────────────

export function updateCategories() {
  let cats = ['all', ...new Set(
    CItems().filter(x => x.type === 'sound').map(x => x.category).filter(Boolean)
  )];

  if (cats.length === 1) {
    cats = [];
  }

  const tabs = document.getElementById('catTabs');
  if (!tabs) return;
  tabs.innerHTML = '';

  cats.forEach(c => {
    const b = document.createElement('button');
    b.className   = 'category-tab' + (APP.activeCategory === c ? ' is-active' : '');
    b.dataset.cat = c;
    b.textContent = c === 'all' ? 'Alle' : c;
    b.setAttribute('aria-pressed', APP.activeCategory === c ? 'true' : 'false');
    b.addEventListener('click', () => { APP.activeCategory = c; renderGrid(); });
    tabs.appendChild(b);
  });
}

// ─── PROFILE SETTINGS SYNC ───────────────────────────────────

export function applyProfileSettings() {
  const mv = document.getElementById('masterVol');
  if (mv) mv.value = APP.globalSettings.masterVol;
  const mvNum = document.getElementById('masterVolNum');
  if (mvNum) mvNum.value = Math.round(APP.globalSettings.masterVol * 100);
  const so = document.getElementById('setOverlap');    if (so) so.checked = APP.globalSettings.overlap;
  const sr = document.getElementById('setStopReplay'); if (sr) sr.checked = APP.globalSettings.stopReplay;
  const sm = document.getElementById('setMultiClick'); if (sm) sm.checked = APP.globalSettings.multiClick;
  // P2 Auto Duck
  const ad = document.getElementById('setAutoDuck'); if (ad) ad.checked = !!APP.globalSettings.autoDuck?.enabled;
  const adAmt = document.getElementById('setAutoDuckAmount');
  if (adAmt) adAmt.value = APP.globalSettings.autoDuck?.amount ?? 0.7;
  const adAmtLbl = document.getElementById('setAutoDuckAmountLbl');
  if (adAmtLbl) adAmtLbl.textContent = Math.round((APP.globalSettings.autoDuck?.amount ?? 0.7) * 100) + '%';
  // Keep the "Wiedergabe" popover trigger's active-dot in sync whenever
  // settings are (re)applied — e.g. after import/reset, not just on toggle.
  const gs = APP.globalSettings;
  const playbackIsDefault = gs.overlap !== false && gs.stopReplay !== true && gs.multiClick !== false && !gs.autoDuck?.enabled;
  document.getElementById('btnPlaybackSettingsToggle')?.classList.toggle('has-active-setting', !playbackIsDefault);
}

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


// ─── LUCIDE ICON UTILITY ──────────────────────────────────────
/**
 * Renders all pending [data-lucide] elements in the document
 * or within a specific container. Call after any DOM insertion
 * of data-lucide elements.
 * @param {Element|null} [container] - Optional container to scope rendering
 */
export function renderLucideIcons(container = null) {
  if (typeof lucide === 'undefined') return;
  if (container) {
    const nodes = [...container.querySelectorAll('[data-lucide]')];
    if (nodes.length) lucide.createIcons({ nodes });
  } else {
    lucide.createIcons();
  }
}

// ─── THEME ICON SYNC ─────────────────────────────────────────

export function syncThemeIcon() {
  // Dark Mode active  → sun icon    (clicking switches to Light)
  // Light Mode active → moon icon   (clicking switches to Dark)
  const btn = document.getElementById('btnTheme');
  if (!btn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  btn.setAttribute('aria-label', isDark ? 'Light Mode aktivieren' : 'Dark Mode aktivieren');
  btn.setAttribute('title',      isDark ? 'Light Mode aktivieren' : 'Dark Mode aktivieren');
  const icon = btn.querySelector('[data-lucide]');
  if (icon) {
    icon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
    // Re-render this single Lucide icon
    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [icon] });
  }
}

// ─── CUSTOM ICON IMAGES ──────────────────────────────────────
// Users can upload their own icon (PNG/JPEG/GIF/WEBP/BMP/SVG) instead of
// picking an emoji — e.g. a spell icon or an NPC portrait. Stored as a
// `data:image/...` URI directly in the icon field (see utils.js isCustomIcon).

const ICON_IMAGE_SIZE = 128; // every raster icon is scaled to exactly fill this square

/**
 * Reads an image file and returns a compact `data:image/...` URI.
 * SVGs are kept as vector data (no rasterizing); raster formats are always
 * scaled to fill the full ICON_IMAGE_SIZE square — upscaling small source
 * images as well as downscaling large ones — so every icon appears the same
 * size regardless of its original resolution (a tiny 16×16 upload won't look
 * smaller than a 512×512 one or an emoji). Upscaling uses nearest-neighbour
 * sampling (crisp/blocky) instead of smoothing (blurry/mushy).
 * @param {File} file
 * @returns {Promise<string>}
 */
async function _processIconFile(file) {
  const isSvg = /svg/i.test(file.type) || /\.svg$/i.test(file.name);
  if (isSvg) {
    const text = await file.text();
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload  = () => resolve(el);
      el.onerror = () => reject(new Error('Bild konnte nicht gelesen werden'));
      el.src = objectUrl;
    });

    const size  = ICON_IMAGE_SIZE;
    // No Math.min(1, …) cap: small images are deliberately upscaled to fill
    // the square, not left tiny in the middle of empty transparent padding.
    const scale = size / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth  * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    // Upscaling: keep it crisp/pixelated rather than smoothed into a blur.
    // Downscaling: smoothing stays on to avoid noisy aliasing.
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);

    let dataUri = canvas.toDataURL('image/webp', 0.85);
    if (!dataUri.startsWith('data:image/webp')) dataUri = canvas.toDataURL('image/png');
    return dataUri;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// ─── ICON PICKER (v2) ─────────────────────────────────────────
// Uses new EMOJI_CATS structure with categories, icons, keyword search

export function buildIconGrid(containerId, current) {
  const ig = document.getElementById(containerId);
  if (!ig) return;
  const parent = ig.parentNode;
  parent.querySelectorAll('.icon-picker-wrap').forEach(x => x.remove());
  ig.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'icon-picker-wrap';

  // ── Custom image upload ──
  const uploadRow = document.createElement('div');
  uploadRow.className = 'icon-picker__upload';
  uploadRow.innerHTML = `
    <div class="icon-picker__upload-preview">${isCustomIcon(current) ? iconHtml(current) : (current || '🙂')}</div>
    <div class="icon-picker__upload-text"><strong>Eigenes Bild</strong><br>PNG, JPG, GIF, WEBP, BMP, SVG</div>
    <button type="button" class="btn btn--sm" data-act="upload-icon" aria-label="Eigenes Bild hochladen">
      <i class="fa-solid fa-upload" aria-hidden="true"></i>
    </button>
    <button type="button" class="icon-picker__upload-clear" data-act="clear-icon" title="Bild entfernen"
      aria-label="Bild entfernen" ${isCustomIcon(current) ? '' : 'hidden'}>
      <i class="fa-solid fa-xmark" aria-hidden="true"></i>
    </button>
    <input type="file" class="u-hidden" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml,.svg" aria-hidden="true">
  `;
  wrap.appendChild(uploadRow);

  const uploadPreview = uploadRow.querySelector('.icon-picker__upload-preview');
  const uploadClearBtn = uploadRow.querySelector('[data-act="clear-icon"]');
  const uploadFileInput = uploadRow.querySelector('input[type="file"]');

  uploadRow.querySelector('[data-act="upload-icon"]').addEventListener('click', () => uploadFileInput.click());

  uploadFileInput.addEventListener('change', async () => {
    const file = uploadFileInput.files?.[0];
    uploadFileInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') && !/\.svg$/i.test(file.name)) {
      toast('Bitte eine Bilddatei wählen', 'err'); return;
    }
    try {
      const dataUri = await _processIconFile(file);
      current = dataUri;
      selectIco(dataUri);
      uploadPreview.innerHTML = iconHtml(dataUri);
      uploadClearBtn.hidden = false;
    } catch (e) {
      console.error('[ui] icon upload failed:', e);
      toast('Bild konnte nicht geladen werden', 'err');
    }
  });

  uploadClearBtn.addEventListener('click', () => {
    current = '';
    selectIco('');
    uploadPreview.textContent = '🙂';
    uploadClearBtn.hidden = true;
  });

  // ── Search bar ──
  const searchWrap = document.createElement('div');
  searchWrap.className = 'icon-picker__search';
  const srch = document.createElement('input');
  srch.className   = 'form-control icon-picker__search-input';
  srch.type        = 'search';
  srch.placeholder = 'Suchen… (z.B. fire, feuer, clap)';
  srch.setAttribute('aria-label', 'Emoji suchen');
  searchWrap.appendChild(srch);
  wrap.appendChild(searchWrap);

  // ── Category scroll bar ──
  const catBar = document.createElement('div');
  catBar.className   = 'icon-picker__cats';
  catBar.setAttribute('role', 'tablist');
  catBar.setAttribute('aria-label', 'Emoji-Kategorien');

  let activeCat = 'all';

  // "All" pill
  const allPill = _mkCatPill('all', 'Alle', 'layout-grid', true);
  catBar.appendChild(allPill);

  // Category pills
  Object.entries(EMOJI_CATS).forEach(([key, cat]) => {
    catBar.appendChild(_mkCatPill(key, cat.label, cat.icon, false));
  });
  wrap.appendChild(catBar);

  // ── Emoji grid ──
  const grid = document.createElement('div');
  grid.className = 'icon-grid icon-picker__grid';
  grid.setAttribute('role', 'listbox');
  grid.setAttribute('aria-label', 'Emojis');
  wrap.appendChild(grid);

  // FIX #1: Insert into the live DOM BEFORE calling lucide.createIcons().
  // Modern Lucide checks node.isConnected and silently skips detached nodes.
  // Calling createIcons() on detached nodes was the primary root cause of
  // icons never rendering — especially on mobile Safari.
  parent.insertBefore(wrap, ig);

  // NOW safe: all [data-lucide] nodes are document-connected.
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...catBar.querySelectorAll('[data-lucide]')] });

  // Input ID map
  const inputMap = { iconGrid: 'eIcon', mIconGrid: 'mIcon', profIconGrid: 'profIconInput', ambProfIconGrid: 'ambProfIconInput', ambTrackIconGrid: 'ambTrackIconInput', musicIconGrid: 'musicIconInput', musicProfIconGrid: 'musicProfIconInput' };

  function selectIco(ico) {
    grid.querySelectorAll('.icon-opt').forEach(x => x.classList.remove('is-selected'));
    const match = [...grid.querySelectorAll('.icon-opt')].find(x => x.dataset.emoji === ico);
    if (match) { match.classList.add('is-selected'); match.scrollIntoView({ block: 'nearest' }); }
    const inputId = inputMap[containerId];
    if (inputId) { const inp = document.getElementById(inputId); if (inp) inp.value = ico; }
  }

  function searchEmojis(query) {
    const q = query.toLowerCase().trim();
    if (!q) return null; // null = show category

    // Word-start matching: keyword must start with q OR be exactly q
    // This prevents "elf" from matching "shelf", "self", "myself" etc.
    function kwMatch(kw) {
      if (kw === q) return true;              // exact
      if (kw.startsWith(q)) return true;      // word starts with query
      // word boundary: space-separated word inside keyword starts with q
      return kw.split(/\s+/).some(word => word.startsWith(q));
    }

    const results = new Set();
    // 1. Keyword map — strict word-start matching
    Object.entries(EMOJI_KEYWORDS).forEach(([emoji, keywords]) => {
      if (keywords.some(kw => kwMatch(kw))) results.add(emoji);
    });
    // 2. Category label fallback (whole-word only)
    Object.entries(EMOJI_CATS).forEach(([, cat]) => {
      if (cat.label.toLowerCase().split(/\s+/).some(w => w.startsWith(q))) {
        cat.emojis.forEach(e => results.add(e));
      }
    });
    // 3. Direct emoji character match
    Object.values(EMOJI_CATS).flatMap(c => c.emojis).forEach(e => {
      if (e === query) results.add(e);
    });
    return [...results];
  }

  function renderEmojis(cat = 'all', searchResults = null) {
    grid.innerHTML = '';

    if (searchResults !== null) {
      // Search results: flat list, no section headers
      if (searchResults.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'icon-picker__empty';
        empty.textContent = 'Keine Ergebnisse';
        grid.appendChild(empty);
        return;
      }
      _appendEmojiItems(grid, searchResults, current, (ico) => { current = ico; selectIco(ico); });
      return;
    }

    if (cat === 'all') {
      // Show all categories with section titles — use DocumentFragment for perf
      const frag = document.createDocumentFragment();
      Object.entries(EMOJI_CATS).forEach(([, catData]) => {
        const heading = document.createElement('div');
        heading.className   = 'icon-picker__section-title';
        heading.textContent = catData.label;
        frag.appendChild(heading);
        _appendEmojiItems(frag, catData.emojis, current, (ico) => { current = ico; selectIco(ico); });
      });
      grid.appendChild(frag);
    } else {
      // Single category
      const catData = EMOJI_CATS[cat];
      if (!catData) return;
      const frag = document.createDocumentFragment();
      const heading = document.createElement('div');
      heading.className   = 'icon-picker__section-title';
      heading.textContent = catData.label;
      frag.appendChild(heading);
      _appendEmojiItems(frag, catData.emojis, current, (ico) => { current = ico; selectIco(ico); });
      grid.appendChild(frag);
    }
  }

  function _appendEmojiItems(container, emojis, selectedEmoji, onSelect) {
    // Use DocumentFragment for batch DOM insertion
    const frag = container.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? container : document.createDocumentFragment();
    emojis.forEach(ico => {
      const d = document.createElement('div');
      d.className     = 'icon-opt' + (ico === selectedEmoji ? ' is-selected' : '');
      d.textContent   = ico;
      d.dataset.emoji = ico;
      d.setAttribute('role', 'option');
      d.setAttribute('aria-label', ico);
      d.setAttribute('aria-selected', ico === selectedEmoji ? 'true' : 'false');
      d.addEventListener('click', () => onSelect(ico));
      frag.appendChild(d);
    });
    // Only append if container is a real DOM node (not already a fragment)
    if (container.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      container.appendChild(frag);
    }
  }

  // Category pill click
  catBar.addEventListener('click', e => {
    const pill = e.target.closest('.icon-picker__cat-pill');
    if (!pill) return;
    activeCat = pill.dataset.cat;
    catBar.querySelectorAll('.icon-picker__cat-pill').forEach(p => {
      p.classList.toggle('is-active', p.dataset.cat === activeCat);
      p.setAttribute('aria-selected', p.dataset.cat === activeCat ? 'true' : 'false');
    });
    srch.value = '';
    renderEmojis(activeCat, null);
  });

  // Search input
  srch.addEventListener('input', () => {
    const q = srch.value.trim();
    if (q) {
      // Clear category selection visually
      catBar.querySelectorAll('.icon-picker__cat-pill').forEach(p => {
        p.classList.remove('is-active');
        p.setAttribute('aria-selected', 'false');
      });
      renderEmojis('all', searchEmojis(srch.value));
    } else {
      catBar.querySelector(`[data-cat="${activeCat}"]`)?.classList.add('is-active');
      renderEmojis(activeCat, null);
    }
  });

  renderEmojis('all', null);
}

// Known-valid Lucide icon names used in this app.
// Any icon name NOT in this set falls back to 'circle' to prevent silent failures.
const KNOWN_LUCIDE_ICONS = new Set([
  'smile', 'cat', 'apple', 'car', 'trophy', 'lightbulb', 'hash', 'flag',
  'layout-grid', 'sun', 'moon', 'columns-3', 'rows-3', 'circle',
]);

/**
 * Returns `name` if it is a known-valid Lucide icon, otherwise 'circle'.
 * Prevents silent rendering failures when an invalid icon name is passed.
 * @param {string} name
 * @returns {string}
 */
function _resolveLucideIcon(name) {
  if (KNOWN_LUCIDE_ICONS.has(name)) return name;
  console.warn(`[Lucide] Unknown icon "${name}" — falling back to "circle"`);
  return 'circle';
}

function _mkCatPill(key, label, icon, isActive) {
  const btn = document.createElement('button');
  btn.className  = 'icon-picker__cat-pill' + (isActive ? ' is-active' : '');
  btn.dataset.cat = key;
  btn.title       = label;
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  btn.setAttribute('aria-label',    label);

  // Lucide icon — rendered by lucide.createIcons() after insertion.
  // _resolveLucideIcon guards against invalid names (falls back to 'circle').
  const ico = document.createElement('i');
  ico.setAttribute('data-lucide', _resolveLucideIcon(icon));
  ico.setAttribute('aria-hidden', 'true');
  btn.appendChild(ico);

  // Label (hidden on very small screens via CSS)
  const lbl = document.createElement('span');
  lbl.className   = 'icon-picker__cat-label';
  lbl.textContent = label;
  btn.appendChild(lbl);

  return btn;
}

// ─── COLOR PICKER ─────────────────────────────────────────────

/**
 * Prompt 1, Kap. 2/3: zentraler Farbpicker — quadratische, abgerundete
 * Swatches mit ZWEI Ebenen (äußerer neutraler Rand bleibt IMMER sichtbar,
 * auch im ausgewählten Zustand; die Akzentfarbe lebt als innere Fläche +
 * innerer Rand auf einer zweiten, verschachtelten Ebene — siehe
 * .color-swatch/.color-swatch__fill in css/components.css). Der
 * Selection-State wird bewusst NICHT mehr über eine Randfarben-Überschreibung
 * realisiert, sondern über eine eigene Kennzeichnung (.is-selected setzt
 * einen zusätzlichen box-shadow-Ring), damit er sich von Hover/Focus klar
 * unterscheidet und den neutralen Rand nicht verdrängt.
 *
 * Rückwärtskompatibilität (Kap. 3): `current` kann ein alter, nicht mehr in
 * COLORS enthaltener Hex-Wert sein (z.B. aus einem älteren Speicherstand).
 * Dieser wird dann als zusätzliches, bereits ausgewähltes Swatch ans Ende
 * angehängt — keine destruktive Migration, der Wert bleibt beim Speichern
 * exakt erhalten, solange der Nutzer ihn nicht aktiv ändert.
 */
export function buildColorOpts(containerId, current) {
  const co = document.getElementById(containerId);
  if (!co) return;
  co.innerHTML = '';

  const isLegacyCustom = current && current !== 'none' && !COLORS.includes(current);
  const palette = isLegacyCustom ? [...COLORS, current] : COLORS;

  palette.forEach(c => {
    const isNone = c === 'none';
    const isCustom = isLegacyCustom && c === current && !COLORS.includes(c);
    const d = document.createElement('div');
    d.className = 'color-swatch' +
      (isNone ? ' color-swatch--none' : '') +
      (c === current ? ' is-selected' : '');
    d.dataset.color = c;

    const name = isNone ? 'Kein Akzent' : (COLOR_NAMES[c] || (isCustom ? 'Aktuelle Farbe' : c));
    d.title = isNone ? name : `${name} (${c})`;

    if (!isNone) {
      // Innere Fläche + innerer Rand in derselben Akzentfarbe (Kap. 2) —
      // eigenes Element, damit der äußere neutrale Rand (.color-swatch
      // selbst) davon unberührt bleibt.
      const fill = document.createElement('div');
      fill.className = 'color-swatch__fill';
      fill.style.background  = c;
      fill.style.borderColor = c;
      d.appendChild(fill);
    }

    // Spez. Kap. 24: Color Swatches müssen per Tastatur bedienbar und
    // fokussierbar sein (WCAG 2.1.1 / 2.4.7), nicht nur per Klick.
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    d.setAttribute('aria-pressed', String(c === current));
    d.setAttribute('aria-label', isNone ? name : `Farbe ${name}`);
    const select = () => {
      co.querySelectorAll('.color-swatch').forEach(x => {
        x.classList.remove('is-selected');
        x.setAttribute('aria-pressed', 'false');
      });
      d.classList.add('is-selected');
      d.setAttribute('aria-pressed', 'true');
    };
    d.addEventListener('click', select);
    d.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        select();
      }
    });
    co.appendChild(d);
  });
}

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

// ─── MACRO STEPS RENDER ───────────────────────────────────────

export function renderMacroSteps() {
  const list = document.getElementById('mStepList');
  if (!list) return;
  list.innerHTML = '';

  const allTargets = CItems().filter(x =>
    (x.type === 'sound' || x.type === 'macro') && x.id !== APP.editMacroId
  );

  APP.macroSteps.forEach((step, i) => {
    const div    = document.createElement('div');
    div.className = 'macro-step';
    const action  = step.action || 'play';

    if (action === 'stop_all') {
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <span class="u-text-badge u-text-danger" style="flex:1">
          <i class="fa-solid fa-stop" aria-hidden="true"></i> Alle stoppen
        </span>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
    } else if (action === 'stop') {
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <span class="u-text-badge u-text-danger u-nowrap">
          <i class="fa-solid fa-stop" aria-hidden="true"></i> Stop
        </span>
        <select class="form-select mstep-select js-sel" aria-label="Ziel-Sound">
          <option value="">-- wählen --</option>
          ${allTargets.filter(x => x.type === 'sound').map(x =>
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${iconGlyph(x.icon)} ${x.name}</option>`
          ).join('')}
        </select>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      div.querySelector('.js-sel').addEventListener('change', e => { APP.macroSteps[i].targetId = e.target.value; });
    } else if (action === 'fadeout') {
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <span class="u-text-badge u-text-accent u-nowrap">
          <i class="fa-solid fa-volume-xmark" aria-hidden="true"></i> Fade
        </span>
        <select class="form-select mstep-select js-sel" aria-label="Ziel-Sound">
          <option value="">-- wählen --</option>
          ${allTargets.filter(x => x.type === 'sound').map(x =>
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${iconGlyph(x.icon)} ${x.name}</option>`
          ).join('')}
        </select>
        <input type="number" class="form-control mstep-delay js-fade-dur" value="${step.fadeDuration || 1000}" min="100" max="10000" aria-label="Fade-Dauer ms">
        <span class="mstep-ms-label">ms</span>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      div.querySelector('.js-sel').addEventListener('change',      e => { APP.macroSteps[i].targetId     = e.target.value; });
      div.querySelector('.js-fade-dur').addEventListener('change', e => { APP.macroSteps[i].fadeDuration = parseInt(e.target.value) || 1000; });
      div.querySelector('.js-delay').addEventListener('change',    e => { APP.macroSteps[i].delay        = parseInt(e.target.value) || 0; });
    } else if (action === 'volume') {
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <span class="u-text-badge u-text-accent u-nowrap">
          <i class="fa-solid fa-sliders" aria-hidden="true"></i> Vol
        </span>
        <input type="range" class="slider js-vol-sl" style="flex:1;min-width:70px" min="0" max="1" step=".05" value="${step.volumeVal != null ? step.volumeVal : 1}" aria-label="Lautstärke">
        <span class="js-vol-val u-text-mono u-text-badge u-text-accent" style="min-width:36px">${Math.round((step.volumeVal != null ? step.volumeVal : 1) * 100)}%</span>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      const sl = div.querySelector('.js-vol-sl');
      const vv = div.querySelector('.js-vol-val');
      sl.addEventListener('input', e => { APP.macroSteps[i].volumeVal = parseFloat(e.target.value); vv.textContent = Math.round(parseFloat(e.target.value) * 100) + '%'; });
      div.querySelector('.js-delay').addEventListener('change', e => { APP.macroSteps[i].delay = parseInt(e.target.value) || 0; });
    } else {
      const selType = step.targetId ? (CItems().find(x => x.id === step.targetId)?.type || 'sound') : 'sound';
      div.innerHTML = `
        <span class="mstep-num">${i + 1}.</span>
        <select class="form-select mstep-type js-type" aria-label="Typ">
          <option value="sound"${selType === 'sound' ? ' selected' : ''}>Sound</option>
          <option value="macro"${selType === 'macro' ? ' selected' : ''}>Makro</option>
        </select>
        <select class="form-select mstep-select js-sel" aria-label="Ziel">
          <option value="">-- wählen --</option>
          ${allTargets.filter(x => x.type === selType).map(x =>
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${iconGlyph(x.icon)} ${x.name}</option>`
          ).join('')}
        </select>
        <input type="number" class="form-control mstep-delay js-delay" value="${step.delay || 0}" min="0" max="60000" aria-label="Verzögerung ms">
        <span class="mstep-ms-label">ms</span>
        <button class="mstep-remove" aria-label="Schritt entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      `;
      const typeEl = div.querySelector('.js-type');
      const selEl  = div.querySelector('.js-sel');
      typeEl.addEventListener('change', () => {
        const t = typeEl.value;
        selEl.innerHTML = '<option value="">-- wählen --</option>' +
          allTargets.filter(x => x.type === t).map(x => `<option value="${x.id}">${iconGlyph(x.icon)} ${x.name}</option>`).join('');
        APP.macroSteps[i].targetId = '';
      });
      selEl.addEventListener('change', e  => { APP.macroSteps[i].targetId = e.target.value; });
      div.querySelector('.js-delay').addEventListener('change', e => { APP.macroSteps[i].delay = parseInt(e.target.value) || 0; });
    }

    if (action === 'stop_all' || action === 'stop') {
      const dEl = div.querySelector('.js-delay');
      if (dEl) dEl.addEventListener('change', e => { APP.macroSteps[i].delay = parseInt(e.target.value) || 0; });
    }

    div.querySelector('.mstep-remove').addEventListener('click', () => { APP.macroSteps.splice(i, 1); renderMacroSteps(); });
    list.appendChild(div);
  });
}
