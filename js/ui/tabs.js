/**
 * ui/tabs.js — Profil-Tab-Leiste, Kategorie-Filter, Preset-Dropdown
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { APP, CItems } from '../core/state.js';
import { iconHtmlOr } from '../utils.js';
import { getAllPresets, PRESET_CATEGORIES } from '../presets.js';
// Zirkulärer Import (grid.js importiert umgekehrt renderPresetDropdown/
// updateCategories aus diesem Modul) — unkritisch, s. Kommentar in grid.js.
import { renderGrid } from './grid.js';

export const PENCIL_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>';

/**
 * Prompt 1, Kap. 5: gemeinsame Hilfsfunktion für die dezente Akzent-
 * markierung eingefärbter Tabs — von allen drei Tab-Leisten verwendet
 * (#profBar in ui/tabs.js, #ambProfBar in ambient.js, #musicProfBar in music.js),
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

