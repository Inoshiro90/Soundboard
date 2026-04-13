/**
 * events.js — Event Listeners, Modal Controllers, Grid Operations
 *
 * All addEventListener calls live here.
 * Uses ui.js for rendering, audio.js for playback, storage.js for data.
 */

import { APP, CP, CItems, CSettings } from './state.js';
import { uid, hotkeyStr, hotkeyMatch, bk } from './utils.js';
import { toast }          from './notifications.js';
import { actx, stopAll, stopItem, runMacro, decodeAudio, playBufferPreview } from './audio.js';
import {
  renderGrid, renderProfileTabs, applyProfileSettings, updateStatus,
  buildIconGrid, buildColorOpts, renderSlotList, renderMacroSteps,
  openTrimModal, drawTrimWaveform, updateTrimDurLabel, normaliseOrders,
  updateMoveBarSelects, exitArrangeMode, enterArrangeMode, syncThemeIcon
} from './ui.js';
import {
  save, load, exportData, importData, resetAll,
  initDefaults, mkProfile, mkSound, mkMacro, mkPH, decodeAllAudio
} from './storage.js';

// ─── SOUND MODAL ─────────────────────────────────────────────

export function openSoundModal(id, placeholderId = null) {
  APP.editId          = id;
  APP._phReplacingId  = placeholderId;
  const s = id ? CItems().find(x => x.id === id) : null;

  document.getElementById('sMTitle').textContent = id ? 'SOUND BEARBEITEN' : 'NEUER SOUND';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  const chk = (elId, val) => { const el = document.getElementById(elId); if (el) el.checked = val; };

  set('eName',    s ? s.name     : '');
  set('eVol',     s ? s.vol      : 1);
  set('ePitch',   s ? s.pitch    : 1);
  set('eVolNum',  Math.round((s ? s.vol : 1) * 100));
  set('eLoop',    '');
  set('eHotkey',  s ? s.hotkey   : '');
  set('eCat',     s ? s.category : '');
  set('eIcon',    s ? s.icon     : '');
  // Tile background color swatch initialized via buildColorOpts below
  // set('eTileClr', ...) removed — color picker replaced by swatch
  set('eTileW',   s && s.tileW ? s.tileW : '');
  set('eTileH',   s && s.tileH ? s.tileH : '');

  chk('eLoop', s ? !!s.loop   : false);
  chk('eFade', s ? !!s.fade   : false);
  chk('eRnd',  s ? !!s.random : false);

  const pitchLbl = document.getElementById('pitchLbl');
  if (pitchLbl) pitchLbl.textContent = ((s ? s.pitch : 1) || 1).toFixed(2) + '×';

  const delBtn = document.getElementById('btnDelSound');
  if (delBtn) delBtn.style.display = id ? '' : 'none';

  APP.editSlots = s ? (s.slots || []).map(sl => ({ ...sl })) : [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null }];
  renderSlotList();
  buildIconGrid('iconGrid',  s ? s.icon  : '');
  buildColorOpts('clrOpts',  s ? s.color : 'none');
  buildColorOpts('eTileClrOpts', s && s.tileColor ? s.tileColor : 'none');

  // FIX #5: Re-run Lucide after Bootstrap's fade transition completes.
  // iOS WebKit can defer SVG rendering inside opacity-transitioning elements.
  document.getElementById('soundModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#soundModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });

  new bootstrap.Modal(document.getElementById('soundModal')).show();
}

// ─── MACRO MODAL ─────────────────────────────────────────────

export function openMacroModal(id) {
  APP.editMacroId = id;
  const m = id ? CItems().find(x => x.id === id && x.type === 'macro') : null;

  document.getElementById('mMTitle').textContent = id ? 'MAKRO BEARBEITEN' : 'NEUES MAKRO';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };

  set('mName',      m ? m.name         : '');
  set('mRepeat',    m ? m.repeat        : 1);
  set('mRepDelay',  m ? m.repeatDelay   : 500);
  set('mHotkey',    m ? m.hotkey        : '');
  set('mIcon',      m ? m.icon          : '🪄');
  set('mTileW',     m && m.tileW ? m.tileW : '');
  set('mTileH',     m && m.tileH ? m.tileH : '');
  set('mPlayMode',  m ? m.playMode || 'parallel' : 'parallel');
  set('mTileClr',   m && m.tileColor ? m.tileColor : '#ffffff');

  const delBtn = document.getElementById('btnDelMacro');
  if (delBtn) delBtn.style.display = id ? '' : 'none';

  APP.macroSteps = m ? (m.steps || []).map(s => ({ ...s })) : [];
  buildColorOpts('mClrOpts', m ? m.color : 'none');
  buildColorOpts('mTileClrOpts', m && m.tileColor ? m.tileColor : 'none');
  buildIconGrid('mIconGrid',  m ? m.icon  : '🪄');
  renderMacroSteps();
  document.getElementById('macroModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#macroModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('macroModal')).show();
}

// ─── PROFILE MODAL ────────────────────────────────────────────

function openProfileModal(id) {
  APP.editProfileId = id;
  const p = id ? APP.profiles.find(x => x.id === id) : null;

  document.getElementById('profModalTitle').textContent = id ? 'PROFIL BEARBEITEN' : 'NEUES PROFIL';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  set('profNameInput', p ? p.name : '');
  set('profIconInput', p ? p.icon : '');

  const delBtn = document.getElementById('btnDelProfile');
  if (delBtn) delBtn.style.display = (id && APP.profiles.length > 1) ? '' : 'none';

  buildIconGrid('profIconGrid', p ? p.icon : '🎵');
  document.getElementById('profModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#profModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('profModal')).show();
}

// ─── PROFILE SWITCH ───────────────────────────────────────────

function switchProfile(id) {
  stopAll();
  APP.activeProfileId = id;
  APP.activeCategory  = 'all';
  exitArrangeMode();
  const moveBar = document.getElementById('moveBar');
  if (moveBar) moveBar.classList.add('is-hidden');
  APP.moveMode = false;
  document.getElementById('btnMoveMode')?.classList.remove('btn--active');
  renderProfileTabs();
  applyProfileSettings();
  renderGrid();
}

// ─── ARRANGE HELPERS ─────────────────────────────────────────

function snapshotArrange() {
  APP.arrangeHistory.push(CItems().map(x => ({ id: x.id, order: x.order })));
  if (APP.arrangeHistory.length > 20) APP.arrangeHistory.shift();
}

function arrangeRowLeft() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders();
  const items = CItems();
  for (let r = 0; r < rows; r++) {
    const base     = r * cols;
    const rowItems = items.filter(x => x.order >= base && x.order < base + cols).sort((a, b) => a.order - b.order);
    const reals    = rowItems.filter(x => !x.locked && x.type !== 'placeholder');
    let col = 0;
    rowItems.forEach(x => { if (!x.locked && x.type !== 'placeholder') { x.order = base + col; col++; } });
    const usedCols = reals.map(x => x.order - base);
    const freeCols = Array.from({ length: cols }, (_, i) => i).filter(c => !usedCols.includes(c) && !rowItems.some(x => x.locked && x.order - base === c));
    rowItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeCols[i] !== undefined) ph.order = base + freeCols[i]; });
  }
  normaliseOrders(); renderGrid(); toast('Links ausgerichtet', 'ok');
}

function arrangeRowRight() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let r = 0; r < rows; r++) {
    const base     = r * cols;
    const rowItems = items.filter(x => x.order >= base && x.order < base + cols).sort((a, b) => a.order - b.order);
    const reals    = rowItems.filter(x => !x.locked && x.type !== 'placeholder');
    let col = cols - 1;
    for (let i = reals.length - 1; i >= 0; i--) { reals[i].order = base + col; col--; }
    const usedCols = reals.map(x => x.order - base);
    const freeCols = Array.from({ length: cols }, (_, i) => i).filter(c => !usedCols.includes(c) && !rowItems.some(x => x.locked && x.order - base === c));
    rowItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeCols[i] !== undefined) ph.order = base + freeCols[i]; });
  }
  normaliseOrders(); renderGrid(); toast('Rechts ausgerichtet', 'ok');
}

function arrangeRowCenter() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let r = 0; r < rows; r++) {
    const base     = r * cols;
    const rowItems = items.filter(x => x.order >= base && x.order < base + cols).sort((a, b) => a.order - b.order);
    const reals    = rowItems.filter(x => !x.locked && x.type !== 'placeholder');
    const start    = Math.floor((cols - reals.length) / 2);
    reals.forEach((x, i) => { x.order = base + start + i; });
    const usedCols = reals.map(x => x.order - base);
    const freeCols = Array.from({ length: cols }, (_, i) => i).filter(c => !usedCols.includes(c) && !rowItems.some(x => x.locked && x.order - base === c));
    rowItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeCols[i] !== undefined) ph.order = base + freeCols[i]; });
  }
  normaliseOrders(); renderGrid(); toast('Mittig ausgerichtet', 'ok');
}

function arrangeRowJustify() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let r = 0; r < rows; r++) {
    const base     = r * cols;
    const rowItems = items.filter(x => x.order >= base && x.order < base + cols).sort((a, b) => a.order - b.order);
    const reals    = rowItems.filter(x => !x.locked && x.type !== 'placeholder');
    if (reals.length <= 1) { reals.forEach((x, i) => { x.order = base + i; }); continue; }
    const step     = (cols - 1) / (reals.length - 1);
    reals.forEach((x, i) => { x.order = base + Math.round(i * step); });
    const usedCols = reals.map(x => x.order - base);
    const freeCols = Array.from({ length: cols }, (_, i) => i).filter(c => !usedCols.includes(c) && !rowItems.some(x => x.locked && x.order - base === c));
    rowItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeCols[i] !== undefined) ph.order = base + freeCols[i]; });
  }
  normaliseOrders(); renderGrid(); toast('Verteilt', 'ok');
}

function arrangeColTop() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let c = 0; c < cols; c++) {
    const colItems = items.filter(x => x.order % cols === c && x.order < cols * rows).sort((a, b) => a.order - b.order);
    const reals    = colItems.filter(x => !x.locked && x.type !== 'placeholder');
    let row = 0;
    reals.forEach(x => { x.order = row * cols + c; row++; });
    const usedRows = reals.map(x => Math.floor(x.order / cols));
    const freeRows = Array.from({ length: rows }, (_, i) => i).filter(r => !usedRows.includes(r) && !colItems.some(x => x.locked && Math.floor(x.order / cols) === r));
    colItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeRows[i] !== undefined) ph.order = freeRows[i] * cols + c; });
  }
  normaliseOrders(); renderGrid(); toast('Spalten nach oben', 'ok');
}

function arrangeColBottom() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let c = 0; c < cols; c++) {
    const colItems = items.filter(x => x.order % cols === c && x.order < cols * rows).sort((a, b) => a.order - b.order);
    const reals    = colItems.filter(x => !x.locked && x.type !== 'placeholder');
    let row = rows - 1;
    for (let i = reals.length - 1; i >= 0; i--) { reals[i].order = row * cols + c; row--; }
    const usedRows = reals.map(x => Math.floor(x.order / cols));
    const freeRows = Array.from({ length: rows }, (_, i) => i).filter(r => !usedRows.includes(r) && !colItems.some(x => x.locked && Math.floor(x.order / cols) === r));
    colItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeRows[i] !== undefined) ph.order = freeRows[i] * cols + c; });
  }
  normaliseOrders(); renderGrid(); toast('Spalten nach unten', 'ok');
}

function arrangeCompact() {
  snapshotArrange(); normaliseOrders();
  const items    = CItems();
  const locked   = items.filter(x => x.locked);
  const lockedOrders = new Set(locked.map(x => x.order));
  const reals    = items.filter(x => !x.locked && x.type !== 'placeholder').sort((a, b) => a.order - b.order);
  const phs      = items.filter(x => !x.locked && x.type === 'placeholder');
  let slot = 0;
  reals.forEach(x => { while (lockedOrders.has(slot)) slot++; x.order = slot; slot++; });
  const usedOrders = new Set([...locked.map(x => x.order), ...reals.map(x => x.order)]);
  let phSlot = 0;
  phs.forEach(x => { while (usedOrders.has(phSlot)) phSlot++; x.order = phSlot; usedOrders.add(phSlot); phSlot++; });
  normaliseOrders(); renderGrid(); toast('Alle Lücken geschlossen', 'ok');
}

function undoArrange() {
  if (!APP.arrangeHistory.length) { toast('Nichts zum Rückgängig'); return; }
  const snap = APP.arrangeHistory.pop();
  snap.forEach(s => { const item = CItems().find(x => x.id === s.id); if (item) item.order = s.order; });
  renderGrid(); toast('Rückgängig ✓', 'ok');
}

// ─── GRID MANAGEMENT ─────────────────────────────────────────

function addCol() {
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  cs.maxCols = Math.min(32, cols + 1);
  normaliseOrders();
  const items = CItems();
  for (let r = 0; r < rows; r++) {
    items.forEach(x => { if (x.order >= r * (cols + 1) + cols) x.order++; });
    items.push(mkPH(r * (cols + 1) + cols));
  }
  normaliseOrders();
  const el = document.getElementById('maxCols'); if (el) el.value = cs.maxCols;
  renderGrid();
}
function removeCol() {
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  if (cols <= 1) return;
  cs.maxCols = cols - 1;
  normaliseOrders();
  const items = CItems();
  for (let r = 0; r < rows; r++) {
    const lastOrder = r * cols + (cols - 1);
    const idx = items.findIndex(x => x.order === lastOrder && x.type === 'placeholder');
    if (idx >= 0) items.splice(idx, 1);
  }
  normaliseOrders();
  const el = document.getElementById('maxCols'); if (el) el.value = cs.maxCols;
  renderGrid();
}
function addRow() {
  const cs = CSettings(); const cols = cs.maxCols;
  cs.maxRows = Math.min(32, cs.maxRows + 1);
  const items = CItems(); const base = cols * (cs.maxRows - 1);
  for (let c = 0; c < cols; c++) items.push(mkPH(base + c));
  normaliseOrders();
  const el = document.getElementById('maxRows'); if (el) el.value = cs.maxRows;
  renderGrid();
}
function removeRow() {
  const cs = CSettings(); if (cs.maxRows <= 1) return;
  const cols = cs.maxCols; const lastRowBase = cols * (cs.maxRows - 1);
  const items = CItems();
  const toRemove = items.filter(x => x.order >= lastRowBase && x.type === 'placeholder').map(x => x.id);
  CP().items = items.filter(x => !toRemove.includes(x.id));
  cs.maxRows--;
  normaliseOrders();
  const el = document.getElementById('maxRows'); if (el) el.value = cs.maxRows;
  renderGrid();
}

// ─── SWAP ROWS / COLS ─────────────────────────────────────────

function swapRows() {
  const ra = parseInt(document.getElementById('mvRowA').value);
  const rb = parseInt(document.getElementById('mvRowB').value);
  if (!ra || !rb || ra === rb) { toast('Zwei verschiedene Reihen wählen'); return; }
  const cols = CSettings().maxCols;
  snapshotArrange(); normaliseOrders();
  const baseA = (ra - 1) * cols; const baseB = (rb - 1) * cols;
  CItems().forEach(x => {
    if      (x.order >= baseA && x.order < baseA + cols) x.order = baseB + (x.order - baseA);
    else if (x.order >= baseB && x.order < baseB + cols) x.order = baseA + (x.order - baseB);
  });
  normaliseOrders(); renderGrid(); toast(`Reihe ${ra} ↔ ${rb} getauscht`, 'ok');
}

function swapCols() {
  const ca = parseInt(document.getElementById('mvColA').value);
  const cb = parseInt(document.getElementById('mvColB').value);
  if (!ca || !cb || ca === cb) { toast('Zwei verschiedene Spalten wählen'); return; }
  const cols = CSettings().maxCols;
  snapshotArrange(); normaliseOrders();
  CItems().forEach(x => {
    const col = (x.order % cols) + 1;
    if      (col === ca) x.order = x.order - (ca - 1) + (cb - 1);
    else if (col === cb) x.order = x.order - (cb - 1) + (ca - 1);
  });
  normaliseOrders(); renderGrid(); toast(`Spalte ${ca} ↔ ${cb} getauscht`, 'ok');
}

// ─── HOTKEY RECORDING ─────────────────────────────────────────

function handleHotkeyRecord(e) {
  if (!APP.hkTarget) return false;
  const f = document.getElementById(APP.hkTarget); if (!f) return false;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape' || e.key === 'Backspace') {
    f.value = ''; f.classList.remove('is-recording'); APP.hkTarget = null; return true;
  }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return true;
  f.value = hotkeyStr(e); f.classList.remove('is-recording'); APP.hkTarget = null;
  return true;
}

// ─── REGISTER ALL LISTENERS ───────────────────────────────────

export function registerEvents() {
  // Theme toggle
  document.getElementById('btnTheme')?.addEventListener('click', () => {
    const html    = document.documentElement;
    const current = html.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    html.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
    syncThemeIcon();
  });

  // Profile bar (event delegation)
  document.getElementById('profBar')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.profile-tab__edit');
    const tab     = e.target.closest('.profile-tab');
    if (editBtn) { const pid = tab?.dataset.pid; if (pid) openProfileModal(pid); return; }
    if (tab)     { switchProfile(tab.dataset.pid); }
  });
  document.getElementById('btnAddProfile')?.addEventListener('click', () => openProfileModal(null));

  // Profile modal
  document.getElementById('btnSaveProfile')?.addEventListener('click', () => {
    const name = document.getElementById('profNameInput').value.trim() || 'Profil';
    const icon = document.getElementById('profIconInput').value.trim() || '🎵';
    if (APP.editProfileId) {
      const p = APP.profiles.find(x => x.id === APP.editProfileId);
      if (p) { p.name = name; p.icon = icon; }
    } else {
      const np = mkProfile(name, icon);
      np.settings = { ...CSettings() };
      const total = np.settings.maxCols * np.settings.maxRows;
      for (let i = 0; i < total; i++) np.items.push(mkPH(i));
      APP.profiles.push(np);
      APP.activeProfileId = np.id;
    }
    bootstrap.Modal.getInstance(document.getElementById('profModal')).hide();
    renderProfileTabs(); renderGrid(); toast('Profil gespeichert', 'ok');
  });
  document.getElementById('btnDelProfile')?.addEventListener('click', () => {
    if (APP.profiles.length <= 1) { toast('Letztes Profil kann nicht gelöscht werden', 'err'); return; }
    if (!confirm('Profil wirklich löschen?')) return;
    APP.profiles        = APP.profiles.filter(x => x.id !== APP.editProfileId);
    APP.activeProfileId = APP.profiles[0].id;
    bootstrap.Modal.getInstance(document.getElementById('profModal')).hide();
    renderProfileTabs(); renderGrid(); toast('Profil gelöscht');
  });

  // Toolbar — grid controls
  document.getElementById('btnColPlus')?.addEventListener('click',  addCol);
  document.getElementById('btnColMinus')?.addEventListener('click', removeCol);
  document.getElementById('btnRowPlus')?.addEventListener('click',  addRow);
  document.getElementById('btnRowMinus')?.addEventListener('click', removeRow);
  document.getElementById('maxCols')?.addEventListener('change', function() {
    const cs = CSettings(); cs.maxCols = Math.max(1, Math.min(32, parseInt(this.value) || 10)); this.value = cs.maxCols; renderGrid();
  });
  document.getElementById('maxRows')?.addEventListener('change', function() {
    const cs = CSettings(); cs.maxRows = Math.max(1, Math.min(32, parseInt(this.value) || 10)); this.value = cs.maxRows; renderGrid();
  });

  // Header controls
  // Master volume — slider and number input stay in sync
  document.getElementById('masterVol')?.addEventListener('input', function() {
    const val = parseFloat(this.value);
    APP.globalSettings.masterVol = val;
    const numEl = document.getElementById('masterVolNum');
    if (numEl) numEl.value = Math.round(val * 100);
  });
  document.getElementById('masterVolNum')?.addEventListener('input', function() {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const val  = pct / 100;
    APP.globalSettings.masterVol = val;
    const slEl = document.getElementById('masterVol');
    if (slEl) slEl.value = val;
  });
  document.getElementById('btnStop')?.addEventListener('click', stopAll);
  document.getElementById('btnSave')?.addEventListener('click', save);

  document.getElementById('btnNewMacro')?.addEventListener('click', () => openMacroModal(null));

  // Options bar
  document.getElementById('btnOptsToggle')?.addEventListener('click', function() {
    const bar  = document.getElementById('optsBar');
    const open = bar.classList.toggle('is-open');
    this.classList.toggle('is-active', open);
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
    bar.setAttribute('aria-hidden', open ? 'false' : 'true');
  });
  document.getElementById('setOverlap')?.addEventListener('change',    e => { APP.globalSettings.overlap    = e.target.checked; });
  document.getElementById('setStopReplay')?.addEventListener('change', e => { APP.globalSettings.stopReplay = e.target.checked; });
  document.getElementById('setMultiClick')?.addEventListener('change', e => { APP.globalSettings.multiClick = e.target.checked; });

  // Data
  document.getElementById('btnExport')?.addEventListener('click', exportData);
  document.getElementById('btnImportTrigger')?.addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f) return;
    importData(f, {
      onSuccess: () => {
        applyProfileSettings(); renderProfileTabs(); renderGrid(); toast('Import ✓', 'ok');
      }
    });
  });
  document.getElementById('btnReset')?.addEventListener('click', () => {
    resetAll({
      onDone: () => { applyProfileSettings(); renderProfileTabs(); renderGrid(); }
    });
  });

  // Arrange mode
  document.getElementById('btnArrange')?.addEventListener('click', () => {
    if (APP.arrangeMode) exitArrangeMode(); else enterArrangeMode();
  });
  document.getElementById('btnCloseArrange')?.addEventListener('click', exitArrangeMode);
  document.getElementById('btnLockToggle')?.addEventListener('click', function() {
    APP.lockMode = !APP.lockMode;
    this.classList.toggle('btn--active', APP.lockMode);
    toast(APP.lockMode ? 'Sperr-Modus aktiv: Kacheln klicken zum Sperren/Entsperren' : 'Sperr-Modus deaktiviert');
  });
  document.getElementById('arrRowLeft')?.addEventListener('click',    arrangeRowLeft);
  document.getElementById('arrRowCenter')?.addEventListener('click',  arrangeRowCenter);
  document.getElementById('arrRowRight')?.addEventListener('click',   arrangeRowRight);
  document.getElementById('arrRowJustify')?.addEventListener('click', arrangeRowJustify);
  document.getElementById('arrColTop')?.addEventListener('click',     arrangeColTop);
  document.getElementById('arrColBottom')?.addEventListener('click',  arrangeColBottom);
  document.getElementById('arrCompact')?.addEventListener('click',    arrangeCompact);
  document.getElementById('btnUndoArrange')?.addEventListener('click', undoArrange);

  // Move mode
  document.getElementById('btnMoveMode')?.addEventListener('click', function() {
    APP.moveMode = !APP.moveMode;
    document.getElementById('moveBar')?.classList.toggle('is-hidden', !APP.moveMode);
    this.classList.toggle('is-active', APP.moveMode);
    if (APP.moveMode) updateMoveBarSelects();
  });
  document.getElementById('btnCloseMoveMode')?.addEventListener('click', () => {
    APP.moveMode = false;
    document.getElementById('moveBar')?.classList.add('is-hidden');
    document.getElementById('btnMoveMode')?.classList.remove('is-active');
  });
  document.getElementById('btnSwapRows')?.addEventListener('click', swapRows);
  document.getElementById('btnSwapCols')?.addEventListener('click', swapCols);

  // Sound modal — slot management
  document.getElementById('btnAddSlot')?.addEventListener('click', () => {
    APP.editSlots.push({ data: null, name: 'Leer', trimStart: 0, trimEnd: null });
    renderSlotList();
  });
  document.getElementById('slotFile')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f || APP.loadingSlotIdx === null) return;
    const r = new FileReader();
    r.onload = e => {
      const b64 = e.target.result.split(',')[1];
      APP.editSlots[APP.loadingSlotIdx] = { data: b64, name: f.name, trimStart: 0, trimEnd: null };
      try {
        const bin = atob(b64); const arr = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
        actx().decodeAudioData(arr.buffer.slice(0),
          buf => { APP.audioBuffers[`_ed_${APP.loadingSlotIdx}`] = buf; renderSlotList(); },
          ()  => renderSlotList()
        );
      } catch (e) { renderSlotList(); }
    };
    r.readAsDataURL(f);
  });
  document.getElementById('btnBulk')?.addEventListener('click', () => document.getElementById('bulkFile').click());
  document.getElementById('bulkFile')?.addEventListener('change', function() {
    const files = [...this.files]; if (!files.length) return;
    let pending = files.length;
    files.forEach(f => {
      const r = new FileReader();
      r.onload = e => {
        const b64     = e.target.result.split(',')[1];
        const emptyIdx = APP.editSlots.findIndex(sl => !sl.data);
        const slotIdx  = emptyIdx >= 0 ? emptyIdx : APP.editSlots.length;
        if (emptyIdx >= 0) APP.editSlots[emptyIdx] = { data: b64, name: f.name, trimStart: 0, trimEnd: null };
        else               APP.editSlots.push({ data: b64, name: f.name, trimStart: 0, trimEnd: null });
        try {
          const bin = atob(b64); const arr = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
          actx().decodeAudioData(arr.buffer.slice(0), buf => { APP.audioBuffers[`_ed_${slotIdx}`] = buf; }, () => {});
        } catch (e) {}
        if (--pending === 0) renderSlotList();
      };
      r.readAsDataURL(f);
    });
    toast(`${files.length} Dateien geladen`, 'ok');
  });
  document.getElementById('ePitch')?.addEventListener('input', function() {
    const lbl = document.getElementById('pitchLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(2) + '×';
  });

  // Sound modal: volume slider ↔ number input sync
  document.getElementById('eVol')?.addEventListener('input', function() {
    const numEl = document.getElementById('eVolNum');
    if (numEl) numEl.value = Math.round(parseFloat(this.value) * 100);
  });
  document.getElementById('eVolNum')?.addEventListener('input', function() {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const slEl = document.getElementById('eVol');
    if (slEl) slEl.value = pct / 100;
  });

  // Sound modal — save / delete
  document.getElementById('btnSaveSound')?.addEventListener('click', () => {
    const g = id => document.getElementById(id);
    const name     = g('eName').value.trim()      || 'SOUND';
    const vol      = parseFloat(g('eVol').value);
    const pitch    = parseFloat(g('ePitch').value);
    const loop     = g('eLoop').checked;
    const fade     = g('eFade').checked;
    const random   = g('eRnd').checked;
    const hotkey   = g('eHotkey').value.trim();
    const category = g('eCat').value.trim();
    const icon     = g('eIcon').value.trim()      || '🔊';
    const sel      = document.querySelector('#clrOpts .color-swatch.is-selected');
    const color    = sel ? sel.dataset.color : 'none';
    // Tile background: read from color swatch (same component as accent color)
    const tcSel    = document.querySelector('#eTileClrOpts .color-swatch.is-selected');
    const tileColor = (tcSel && tcSel.dataset.color !== 'none') ? tcSel.dataset.color : '';
    const tileW    = parseInt(g('eTileW').value)  || null;
    const tileH    = parseInt(g('eTileH').value)  || null;
    const items    = CItems();

    if (APP.editId) {
      const s = items.find(x => x.id === APP.editId);
      Object.assign(s, { name, vol, pitch, loop, fade, random, hotkey, category, icon, color, tileColor, tileW, tileH, slots: APP.editSlots, curSlot: 0 });
      APP.editSlots.forEach((sl, i) => { if (sl && sl.data) decodeAudio(bk(s.id, i), sl.data); });
    } else {
      const id    = uid();
      const phId  = APP._phReplacingId;
      const phIdx = phId ? items.findIndex(x => x.id === phId) : -1;
      const newS  = { type: 'sound', id, order: phIdx >= 0 ? items[phIdx].order : 99999, name, vol, pitch, loop, fade, random, hotkey, category, icon, color, tileColor, tileW, tileH, slots: APP.editSlots, curSlot: 0, locked: false };
      if (phIdx >= 0) items.splice(phIdx, 1, newS);
      else {
        const firstPH = items.findIndex(x => x.type === 'placeholder');
        if (firstPH >= 0) { newS.order = items[firstPH].order; items.splice(firstPH, 1, newS); }
        else              { newS.order = items.length; items.push(newS); }
      }
      APP.editSlots.forEach((sl, i) => { if (sl && sl.data) decodeAudio(bk(id, i), sl.data); });
    }
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gespeichert ✓', 'ok');
  });
  document.getElementById('btnDelSound')?.addEventListener('click', () => {
    if (!APP.editId) return;
    stopItem(APP.editId);
    const items = CItems(); const idx = items.findIndex(x => x.id === APP.editId);
    if (idx >= 0) { const order = items[idx].order; items.splice(idx, 1, { type: 'placeholder', id: uid(), order, locked: false }); }
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gelöscht');
  });
  document.getElementById('btnPreviewSound')?.addEventListener('click', async () => {
    const slots = APP.editSlots.filter(sl => sl && sl.data);
    if (!slots.length) { toast('Keine Slots geladen'); return; }
    const vol   = parseFloat(document.getElementById('eVol').value)   || 1;
    const pitch = parseFloat(document.getElementById('ePitch').value) || 1;
    for (let i = 0; i < APP.editSlots.length; i++) {
      const sl = APP.editSlots[i]; if (!sl || !sl.data) continue;
      const buf = APP.audioBuffers[`_ed_${i}`]; if (!buf) continue;
      toast(`Vorschau Slot ${i + 1}…`);
      await new Promise(res => {
        const ctx = actx(); const gain = ctx.createGain();
        gain.gain.value = vol;
        gain.connect(ctx.destination);
        const src = ctx.createBufferSource(); src.buffer = buf;
        src.playbackRate.value = pitch;   // ← pitch applied
        const ts = sl.trimStart || 0; let te = sl.trimEnd ?? buf.duration; if (te <= ts) te = buf.duration;
        src.connect(gain); src.start(0, ts, te - ts);
        src.onended = res; setTimeout(res, Math.min((te - ts) * 1000 + 200, 10000));
      });
    }
    toast('Vorschau fertig ✓', 'ok');
  });

  // Trim modal
  document.getElementById('trimCanvas')?.addEventListener('mousedown', function(e) {
    if (!APP.trim.buf) return;
    const r   = this.getBoundingClientRect();
    const x   = (e.clientX - r.left) / r.width;
    const dur = APP.trim.buf.duration;
    const t   = x * dur;
    const ts  = parseFloat(document.getElementById('trimStart').value) || 0;
    const te  = parseFloat(document.getElementById('trimEnd').value)   || dur;
    const distS = Math.abs(x - (ts / dur));
    const distE = Math.abs(x - (te / dur));
    if      (distS < 0.04)   APP.trim.dragging = 'start';
    else if (distE < 0.04)   APP.trim.dragging = 'end';
    else if (e.button === 2) APP.trim.dragging = 'end';
    else                     APP.trim.dragging = 'start';
    setTrimPoint(t);
  });
  document.getElementById('trimCanvas')?.addEventListener('mousemove', function(e) {
    if (!APP.trim.dragging || !APP.trim.buf) return;
    const r = this.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    setTrimPoint(Math.max(0, Math.min(APP.trim.buf.duration, x * APP.trim.buf.duration)));
  });
  document.getElementById('trimCanvas')?.addEventListener('mouseup',    () => { APP.trim.dragging = null; });
  document.getElementById('trimCanvas')?.addEventListener('mouseleave', () => { APP.trim.dragging = null; });
  document.getElementById('trimCanvas')?.addEventListener('contextmenu', e => e.preventDefault());
  document.getElementById('trimStart')?.addEventListener('input', () => { updateTrimDurLabel(); drawTrimWaveform(); });
  document.getElementById('trimEnd')?.addEventListener('input',   () => { updateTrimDurLabel(); drawTrimWaveform(); });
  document.getElementById('btnTrimReset')?.addEventListener('click', () => {
    if (!APP.trim.buf) return;
    document.getElementById('trimStart').value   = '0';
    document.getElementById('trimEnd').value     = APP.trim.buf.duration.toFixed(3);
    document.getElementById('trimFadeIn').value  = '0';
    document.getElementById('trimFadeOut').value = '0';
    updateTrimDurLabel(); drawTrimWaveform();
  });
  document.getElementById('btnTrimPreview')?.addEventListener('click', () => {
    if (!APP.trim.buf) return;
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
    const ts  = parseFloat(document.getElementById('trimStart').value) || 0;
    const te  = parseFloat(document.getElementById('trimEnd').value)   || APP.trim.buf.duration;
    const ctx = actx(); const gain = ctx.createGain(); gain.gain.value = 0.8; gain.connect(ctx.destination);
    const src = ctx.createBufferSource(); src.buffer = APP.trim.buf; src.connect(gain);
    src.start(0, ts, te - ts); APP.trim.previewSrc = src;
    src.onended = () => { APP.trim.previewSrc = null; };
    toast('Vorschau läuft…');
  });
  document.getElementById('btnTrimStop')?.addEventListener('click', () => {
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
  });
  document.getElementById('btnTrimSave')?.addEventListener('click', () => {
    if (APP.trim.slotIdx === null || !APP.trim.buf) return;
    const ts = parseFloat(document.getElementById('trimStart').value) || 0;
    const te = parseFloat(document.getElementById('trimEnd').value)   || APP.trim.buf.duration;
    const fi = Math.max(0, parseFloat(document.getElementById('trimFadeIn').value)  || 0);
    const fo = Math.max(0, parseFloat(document.getElementById('trimFadeOut').value) || 0);
    APP.editSlots[APP.trim.slotIdx].trimStart = Math.max(0, ts);
    APP.editSlots[APP.trim.slotIdx].trimEnd   = Math.min(APP.trim.buf.duration, te);
    APP.editSlots[APP.trim.slotIdx].fadeIn    = fi;
    APP.editSlots[APP.trim.slotIdx].fadeOut   = fo;
    bootstrap.Modal.getInstance(document.getElementById('trimModal')).hide();
    renderSlotList(); toast('Trim übernommen ✓', 'ok');
  });

  // Macro modal
  document.getElementById('btnAddStep')?.addEventListener('click',      () => { APP.macroSteps.push({ action: 'play',    targetId: '', delay: 300 });               renderMacroSteps(); });
  document.getElementById('btnAddStepStop')?.addEventListener('click',  () => { APP.macroSteps.push({ action: 'stop',    targetId: '', delay: 0 });                 renderMacroSteps(); });
  document.getElementById('btnAddStepFade')?.addEventListener('click',  () => { APP.macroSteps.push({ action: 'fadeout', targetId: '', fadeDuration: 1000, delay: 0 }); renderMacroSteps(); });
  document.getElementById('btnAddStepVol')?.addEventListener('click',   () => { APP.macroSteps.push({ action: 'volume',  volumeVal: 1, delay: 0 });                renderMacroSteps(); });
  document.getElementById('btnTestMacro')?.addEventListener('click', () => {
    runMacro({
      id: '_test',
      steps:       [...APP.macroSteps],
      repeat:      parseInt(document.getElementById('mRepeat').value) || 1,
      repeatDelay: parseInt(document.getElementById('mRepDelay').value) || 500,
      playMode:    document.getElementById('mPlayMode').value
    });
  });
  document.getElementById('btnSaveMacro')?.addEventListener('click', () => {
    const g  = id => document.getElementById(id);
    const name        = g('mName').value.trim()  || 'MAKRO';
    const repeat      = parseInt(g('mRepeat').value)    || 1;
    const repeatDelay = parseInt(g('mRepDelay').value)  || 500;
    const hotkey      = g('mHotkey').value.trim();
    const icon        = g('mIcon').value.trim()  || '🪄';
    const tileW       = parseInt(g('mTileW').value)     || null;
    const tileH       = parseInt(g('mTileH').value)     || null;
    const playMode    = g('mPlayMode').value;
    const mTcSel  = document.querySelector('#mTileClrOpts .color-swatch.is-selected');
    const tileColor   = (mTcSel && mTcSel.dataset.color !== 'none') ? mTcSel.dataset.color : '';
    const sel         = document.querySelector('#mClrOpts .color-swatch.is-selected');
    const color       = sel ? sel.dataset.color : 'none';
    const items       = CItems();
    if (APP.editMacroId) {
      const m = items.find(x => x.id === APP.editMacroId);
      Object.assign(m, { name, repeat, repeatDelay, hotkey, icon, color, tileColor, tileW, tileH, playMode, steps: [...APP.macroSteps] });
    } else {
      const nm = mkMacro({ name, repeat, repeatDelay, hotkey, icon, color, tileColor, tileW, tileH, playMode, steps: [...APP.macroSteps] });
      const firstPH = items.findIndex(x => x.type === 'placeholder');
      if (firstPH >= 0) { nm.order = items[firstPH].order; items.splice(firstPH, 1, nm); }
      else              { nm.order = items.length; items.push(nm); }
    }
    bootstrap.Modal.getInstance(document.getElementById('macroModal')).hide();
    renderGrid(); toast('Makro gespeichert ✓', 'ok');
  });
  document.getElementById('btnDelMacro')?.addEventListener('click', () => {
    if (!APP.editMacroId) return;
    const items = CItems(); const idx = items.findIndex(x => x.id === APP.editMacroId);
    if (idx >= 0) { const order = items[idx].order; items.splice(idx, 1, { type: 'placeholder', id: uid(), order, locked: false }); }
    bootstrap.Modal.getInstance(document.getElementById('macroModal')).hide();
    renderGrid(); toast('Makro gelöscht');
  });

  // Hotkey fields
  ['eHotkey', 'mHotkey'].forEach(id => {
    const f = document.getElementById(id);
    if (!f) return;
    f.addEventListener('click', () => { APP.hkTarget = id; f.classList.add('is-recording'); f.value = 'Taste drücken…'; });
  });

  // Global keyboard
  document.addEventListener('keydown', e => {
    if (APP.hkTarget) { handleHotkeyRecord(e); return; }
    const tag = e.target.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const match = CItems().find(x => x.hotkey && hotkeyMatch(x.hotkey, e));
    if (match) { e.preventDefault(); import('./audio.js').then(m => m.playItem(match.id)); }
  });

  // Wake AudioContext on first interaction
  document.body.addEventListener('click', () => actx(), { once: true });
}

// ─── TRIM HELPER ─────────────────────────────────────────────

function setTrimPoint(t) {
  const dur = APP.trim.buf.duration;
  if (APP.trim.dragging === 'start') {
    const te = parseFloat(document.getElementById('trimEnd').value) || dur;
    document.getElementById('trimStart').value = Math.min(t, te - 0.01).toFixed(3);
  } else {
    const ts = parseFloat(document.getElementById('trimStart').value) || 0;
    document.getElementById('trimEnd').value = Math.max(t, ts + 0.01).toFixed(3);
  }
  updateTrimDurLabel(); drawTrimWaveform();
}
