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

import { APP, CP, CItems, CSettings, EMOJI_CATS, EMOJI_KEYWORDS, COLORS } from './state.js';
import { uid, bk }                        from './utils.js';
import { playSound, stopItem, runMacro, refreshRotBadge, playBufferPreview } from './audio.js';
import { mkPH }                            from './storage.js';
import { toast }                           from './notifications.js';

// ─── RESPONSIVE GRID CONFIG ───────────────────────────────────
const MIN_TILE_W = 120; // px — never smaller than this
let _gridResizeObserver = null;

// ─── PROFILE TABS ─────────────────────────────────────────────

export function renderProfileTabs() {
  const bar    = document.getElementById('profBar');
  const addBtn = document.getElementById('btnAddProfile');
  bar.querySelectorAll('.profile-tab').forEach(t => t.remove());

  APP.profiles.forEach(p => {
    const tab = document.createElement('button');
    tab.className = 'profile-tab' + (p.id === APP.activeProfileId ? ' is-active' : '');
    tab.dataset.pid = p.id;
    tab.innerHTML =
      `<span>${p.icon || '🎵'} ${p.name}</span>` +
      `<span class="profile-tab__edit" title="Profil bearbeiten" aria-label="Profil bearbeiten">` +
      `<i class="fa-solid fa-pen" aria-hidden="true"></i></span>`;
    bar.insertBefore(tab, addBtn);
  });

  const profLbl = document.getElementById('profLbl');
  if (profLbl) profLbl.textContent = CP() ? `${CP().icon || ''} ${CP().name}` : '';
}

// ─── GRID ─────────────────────────────────────────────────────

export function renderGrid() {
  const grid = document.getElementById('grid');
  const cs   = CSettings();
  const cols = Math.max(1, Math.min(32, cs.maxCols));
  const rows = Math.max(1, Math.min(32, cs.maxRows));

  // Responsive: compute tile min-width based on desired cols and available space.
  // If container is too narrow, auto-fill wraps gracefully — no horizontal scroll.
  _applyResponsiveGrid(grid, cols);
  document.documentElement.style.setProperty('--th', cs.tileH + 'px');

  // Attach resize observer once
  if (!_gridResizeObserver) {
    _gridResizeObserver = new ResizeObserver(() => {
      const g = document.getElementById('grid');
      if (g) _applyResponsiveGrid(g, Math.max(1, Math.min(32, CSettings().maxCols)));
    });
    const board = document.querySelector('.board');
    if (board) _gridResizeObserver.observe(board);
  }

  normaliseOrders();

  let list = [...CItems()].sort((a, b) => (a.order || 0) - (b.order || 0));
  if (APP.activeCategory !== 'all') {
    list = list.filter(x =>
      x.type === 'placeholder' || x.type === 'macro' ||
      (x.type === 'sound' && x.category === APP.activeCategory)
    );
  }

  const total = cols * rows;
  while (list.length < total) list.push(mkPH(list.length));
  const display = list.slice(0, total);

  grid.innerHTML = '';
  display.forEach(item => {
    grid.appendChild(
      item.type === 'sound' ? makeSoundTile(item) :
      item.type === 'macro' ? makeMacroTile(item) :
      makePHTile(item)
    );
  });

  updateCategories();
  updateStatus();
  setupDrag();
  CItems().filter(x => x.type === 'sound').forEach(x => refreshRotBadge(x.id));
  updateMoveBarSelects();
}

function _applyResponsiveGrid(grid, cols) {
  const containerW = grid.parentElement?.clientWidth || window.innerWidth;
  // Ideal tile width based on desired columns
  const idealW = Math.floor((containerW - (cols - 1) * 8) / cols);
  // Never smaller than MIN_TILE_W — browser auto-fills fewer columns if needed
  const tileMinW = Math.max(MIN_TILE_W, idealW);
  grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${tileMinW}px, 1fr))`;
}

// ─── TILE BUILDERS ────────────────────────────────────────────

function tileStyle(item) {
  const cs = CSettings();
  const h  = item.tileH || cs.tileH;
  const bg = item.tileColor ? `background:${item.tileColor};` : '';
  return `height:${h}px;${bg}`;
}

export function makeSoundTile(s) {
  const wrap = document.createElement('div');
  wrap.className  = 'tile-wrap' + (s.locked ? ' is-locked' : '');
  wrap.dataset.id = s.id;
  wrap.draggable  = !APP.arrangeMode;

  const hasAudio    = (s.slots || []).some(sl => sl && sl.data);
  const hkHtml      = s.hotkey ? `<div class="tile__hotkey">${s.hotkey}</div>` : '';
  const accentStyle = s.color && s.color !== 'none' ? `border-top: 2px solid ${s.color};` : '';

  wrap.innerHTML = `
    <div class="tile${!hasAudio ? ' tile--no-audio' : ''}${s.loop ? ' tile--loop' : ''}"
         style="${tileStyle(s)}${accentStyle}"
         role="button" aria-label="${s.name || 'Sound'}">
      ${hkHtml}
      <div class="tile__icon" aria-hidden="true">${s.icon || '🔊'}</div>
      <div class="tile__label">${s.name || 'SOUND'}</div>
      <div class="tile__slot-badge" aria-hidden="true"></div>
      <i class="fa-solid fa-rotate tile__loop-icon" aria-hidden="true"></i>
      <i class="fa-solid fa-lock tile__lock-icon" aria-hidden="true"></i>
      <div class="tile__progress" aria-hidden="true"></div>
    </div>
    <div class="tile-controls" aria-label="Kachel-Aktionen">
      <button class="tile-ctrl-btn js-edit-btn" title="Bearbeiten" aria-label="Sound bearbeiten">
        <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
      </button>
    </div>
    <div class="drag-dots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  `;

  const tile = wrap.querySelector('.tile');

  // NEW click logic: always play / advance slot. No per-tile stop.
  tile.addEventListener('click', e => {
    if (APP.arrangeMode) { handleArrangeClick(wrap, s); return; }
    if (e.target.closest('.tile-controls')) return;
    playSound(s);
  });

  wrap.querySelector('.js-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (!APP.arrangeMode) import('./events.js').then(m => m.openSoundModal(s.id));
  });

  refreshRotBadge(s.id);
  return wrap;
}

export function makeMacroTile(m) {
  const wrap = document.createElement('div');
  wrap.className  = 'tile-wrap' + (m.locked ? ' is-locked' : '');
  wrap.dataset.id = m.id;
  wrap.draggable  = !APP.arrangeMode;

  const hkHtml      = m.hotkey ? `<div class="tile__hotkey">${m.hotkey}</div>` : '';
  const accentStyle = m.color && m.color !== 'none' ? `border-top: 2px solid ${m.color};` : '';

  wrap.innerHTML = `
    <div class="tile tile--macro"
         style="${tileStyle(m)}${accentStyle}"
         role="button" aria-label="${m.name || 'Makro'}">
      ${hkHtml}
      <div class="tile__icon" aria-hidden="true">${m.icon || '🪄'}</div>
      <div class="tile__label">${m.name || 'MAKRO'}</div>
      <div class="tile__macro-badge" aria-hidden="true">MAKRO${m.repeat > 1 ? ' ×' + m.repeat : ''}</div>
      <i class="fa-solid fa-lock tile__lock-icon" aria-hidden="true"></i>
      <div class="tile__progress" aria-hidden="true"></div>
    </div>
    <div class="tile-controls" aria-label="Kachel-Aktionen">
      <button class="tile-ctrl-btn js-edit-btn" title="Bearbeiten" aria-label="Makro bearbeiten">
        <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
      </button>
    </div>
    <div class="drag-dots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  `;

  wrap.querySelector('.tile').addEventListener('click', e => {
    if (APP.arrangeMode) { handleArrangeClick(wrap, m); return; }
    if (e.target.closest('.tile-controls')) return;
    runMacro(m);
  });
  wrap.querySelector('.js-edit-btn').addEventListener('click', e => {
    e.stopPropagation();
    if (!APP.arrangeMode) import('./events.js').then(ev => ev.openMacroModal(m.id));
  });
  return wrap;
}

export function makePHTile(ph) {
  const wrap = document.createElement('div');
  wrap.className  = 'tile-wrap' + (ph.locked ? ' is-locked' : '');
  wrap.dataset.id = ph.id;
  wrap.draggable  = !APP.arrangeMode;
  const h = CSettings().tileH;

  wrap.innerHTML = `
    <div class="tile tile--placeholder" style="height:${h}px" aria-label="Leerer Slot">
      <i class="fa-solid fa-lock tile__lock-icon" aria-hidden="true"></i>
      <div class="tile-controls">
        <button class="tile-ctrl-btn js-add-btn" title="Sound hinzufügen" aria-label="Sound hinzufügen"
          style="display:${APP.arrangeMode ? 'none' : 'flex'}">
          <i class="fa-solid fa-plus" aria-hidden="true"></i>
        </button>
      </div>
    </div>
    <div class="drag-dots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  `;

  const phTile = wrap.querySelector('.tile');
  phTile.addEventListener('click', e => {
    if (APP.arrangeMode) { handleArrangeClick(wrap, ph); return; }
    if (e.target.closest('.tile-controls')) return;
  });
  phTile.addEventListener('dblclick', () => {
    if (!APP.arrangeMode) import('./events.js').then(m => m.openSoundModal(null, ph.id));
  });
  const addBtn = wrap.querySelector('.js-add-btn');
  if (addBtn) addBtn.addEventListener('click', e => {
    e.stopPropagation();
    import('./events.js').then(m => m.openSoundModal(null, ph.id));
  });
  return wrap;
}

// ─── STATUS BAR ───────────────────────────────────────────────

export function updateStatus() {
  const n      = Object.keys(APP.activeAudio).length;
  const sounds = CItems().filter(x => x.type === 'sound').length;
  const macros = CItems().filter(x => x.type === 'macro').length;
  const stxt = document.getElementById('stxt');
  const scnt = document.getElementById('scnt');
  const sdot = document.getElementById('sdot');
  if (stxt) stxt.textContent = n > 0 ? `${n} AKTIV` : 'BEREIT';
  if (scnt) scnt.textContent = `${sounds} S · ${macros} M`;
  if (sdot) sdot.classList.toggle('is-active', n > 0);
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
  const cs = CSettings();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('maxCols', cs.maxCols);
  set('maxRows', cs.maxRows);
  set('tileW',   cs.tileW);
  set('tileH',   cs.tileH);
  document.documentElement.style.setProperty('--th', cs.tileH + 'px');
  const mv = document.getElementById('masterVol');
  if (mv) mv.value = APP.globalSettings.masterVol;
  const mvNum = document.getElementById('masterVolNum');
  if (mvNum) mvNum.value = Math.round(APP.globalSettings.masterVol * 100);
  const so = document.getElementById('setOverlap');    if (so) so.checked = APP.globalSettings.overlap;
  const sr = document.getElementById('setStopReplay'); if (sr) sr.checked = APP.globalSettings.stopReplay;
  const sm = document.getElementById('setMultiClick'); if (sm) sm.checked = APP.globalSettings.multiClick;
}

// ─── MOVE BAR SELECTS ─────────────────────────────────────────

export function updateMoveBarSelects() {
  const cs = CSettings();
  ['mvRowA', 'mvRowB'].forEach(id => {
    const sel = document.getElementById(id); if (!sel) return;
    const cur = sel.value; sel.innerHTML = '';
    for (let r = 1; r <= cs.maxRows; r++) {
      const o = document.createElement('option'); o.value = r; o.textContent = 'Reihe ' + r; sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  });
  ['mvColA', 'mvColB'].forEach(id => {
    const sel = document.getElementById(id); if (!sel) return;
    const cur = sel.value; sel.innerHTML = '';
    for (let c = 1; c <= cs.maxCols; c++) {
      const o = document.createElement('option'); o.value = c; o.textContent = 'Spalte ' + c; sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  });
}

// ─── ARRANGE MODE ─────────────────────────────────────────────

export function handleArrangeClick(wrap, item) {
  if (APP.lockMode) { item.locked = !item.locked; wrap.classList.toggle('is-locked', item.locked); return; }
  wrap.classList.toggle('is-arrange-selected');
}

export function enterArrangeMode() {
  APP.arrangeMode = true;
  document.getElementById('arrangeBar')?.classList.remove('is-hidden');
  document.getElementById('btnArrange')?.classList.add('is-active');
  renderGrid();
}

export function exitArrangeMode() {
  APP.arrangeMode = false; APP.lockMode = false;
  document.getElementById('arrangeBar')?.classList.add('is-hidden');
  document.getElementById('btnArrange')?.classList.remove('is-active');
  document.getElementById('btnLockToggle')?.classList.remove('btn--active');
  document.querySelectorAll('.tile-wrap.is-arrange-selected').forEach(w => w.classList.remove('is-arrange-selected'));
  renderGrid();
}

// ─── DRAG & DROP ──────────────────────────────────────────────

let _dragSrc = null;

export function setupDrag() {
  document.querySelectorAll('.tile-wrap').forEach(w => {
    w.addEventListener('dragstart', e => {
      if (APP.arrangeMode) return;
      _dragSrc = w.dataset.id; w.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move';
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
      const items = CItems();
      const ai = items.findIndex(x => x.id === _dragSrc);
      const bi = items.findIndex(x => x.id === w.dataset.id);
      if (ai < 0 || bi < 0) return;
      [items[ai].order, items[bi].order] = [items[bi].order, items[ai].order];
      renderGrid();
    });
  });
}

export function normaliseOrders() {
  CItems().sort((a, b) => (a.order || 0) - (b.order || 0)).forEach((x, i) => { x.order = i; });
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
  const inputMap = { iconGrid: 'eIcon', mIconGrid: 'mIcon', profIconGrid: 'profIconInput' };

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

export function buildColorOpts(containerId, current) {
  const co = document.getElementById(containerId);
  if (!co) return;
  co.innerHTML = '';
  COLORS.forEach(c => {
    const d = document.createElement('div');
    d.className    = 'color-swatch' + (c === 'none' ? ' color-swatch--none' : '') + (c === current ? ' is-selected' : '');
    if (c !== 'none') d.style.background = c;
    d.dataset.color = c;
    d.title = c === 'none' ? 'Kein Akzent' : c;
    d.setAttribute('aria-label', c === 'none' ? 'Kein Akzent' : `Farbe ${c}`);
    d.addEventListener('click', () => {
      co.querySelectorAll('.color-swatch').forEach(x => x.classList.remove('is-selected'));
      d.classList.add('is-selected');
    });
    co.appendChild(d);
  });
}

// ─── SLOT LIST ────────────────────────────────────────────────

export function renderSlotList() {
  const list   = document.getElementById('slotList');
  const wvDisp = document.getElementById('wvDisp');
  if (!list) return;
  list.innerHTML = '';

  const loaded = APP.editSlots.filter(sl => sl && sl.data).length;
  if (wvDisp) {
    wvDisp.innerHTML = loaded > 0
      ? '<div class="waveform-bars">' +
        Array.from({ length: 22 }, (_, i) =>
          `<div class="waveform-bar" style="height:${5 + Math.random() * 28}px;animation-delay:${i * 0.07}s"></div>`
        ).join('') + '</div>'
      : '<span>Keine Dateien geladen</span>';
  }

  let slotDragSrc = null;

  APP.editSlots.forEach((sl, i) => {
    const row = document.createElement('div');
    row.className = 'slot-row';
    row.draggable = true;
    row.dataset.si = i;

    const hasBuf = sl && sl.data && APP.audioBuffers[`_ed_${i}`];
    const dur    = hasBuf ? APP.audioBuffers[`_ed_${i}`].duration : null;
    const previewHtml = sl && sl.data
      ? `<button class="slot-btn slot-btn--preview js-prev-btn" title="Vorschau" aria-label="Slot vorschau">&#9654;</button>` : '';

    row.innerHTML = `
      <div class="slot-drag-handle" title="Ziehen" aria-hidden="true"><span></span><span></span><span></span></div>
      <span class="slot-num">${i + 1}.</span>
      <span class="slot-name${sl && sl.data ? '' : ' slot-name--empty'}">${sl && sl.data ? (sl.name || 'Datei ' + (i + 1)) : '– leer –'}</span>
      ${dur ? `<span class="slot-dur">${dur.toFixed(1)}s</span>` : ''}
      ${sl && sl.data ? `
        <span class="u-text-muted u-text-badge" aria-hidden="true">▶</span>
        <input type="number" class="form-control slot-trim js-trim-s" placeholder="0" step=".1" min="0" value="${sl.trimStart || 0}" aria-label="Start Sekunden">
        <span class="u-text-muted u-text-badge" aria-hidden="true">→</span>
        <input type="number" class="form-control slot-trim js-trim-e" placeholder="Ende" step=".1" min="0" value="${sl.trimEnd ?? ''}" aria-label="Ende Sekunden">
      ` : ''}
      ${previewHtml}
      <button class="slot-btn slot-btn--load js-load-btn" title="Laden" aria-label="Audio laden">
        <i class="fa-solid fa-folder-open" aria-hidden="true"></i>
      </button>
      ${sl && sl.data ? `<button class="slot-btn slot-btn--trim js-trim-btn" title="Zuschneiden" aria-label="Audio zuschneiden"><i class="fa-solid fa-scissors" aria-hidden="true"></i></button>` : ''}
      ${APP.editSlots.length > 1 ? `<button class="slot-btn slot-btn--remove js-rm-btn" title="Entfernen" aria-label="Slot entfernen"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>` : ''}
    `;

    const ts = row.querySelector('.js-trim-s');
    const te = row.querySelector('.js-trim-e');
    if (ts) ts.addEventListener('change', e => { APP.editSlots[i].trimStart = parseFloat(e.target.value) || 0; });
    if (te) te.addEventListener('change', e => { APP.editSlots[i].trimEnd   = e.target.value === '' ? null : parseFloat(e.target.value); });

    row.querySelector('.js-load-btn').addEventListener('click', () => {
      APP.loadingSlotIdx = i;
      const sf = document.getElementById('slotFile');
      if (sf) { sf.value = ''; sf.click(); }
    });
    const rmBtn = row.querySelector('.js-rm-btn');
    if (rmBtn) rmBtn.addEventListener('click', () => { APP.editSlots.splice(i, 1); renderSlotList(); });
    const trimBtn = row.querySelector('.js-trim-btn');
    if (trimBtn) trimBtn.addEventListener('click', () => openTrimModal(i));
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
      const moved = APP.editSlots.splice(slotDragSrc, 1)[0];
      APP.editSlots.splice(i, 0, moved);
      renderSlotList();
    });

    list.appendChild(row);
  });
}

// previewSlot: applies pitch from modal input field
function previewSlot(i) {
  const sl = APP.editSlots[i];
  if (!sl || !sl.data) { toast('Slot leer'); return; }
  const buf = APP.audioBuffers[`_ed_${i}`];
  if (!buf) { toast('Audio lädt…'); return; }
  const vol   = parseFloat(document.getElementById('eVol')?.value)   || 1;
  const pitch = parseFloat(document.getElementById('ePitch')?.value) || 1;
  playBufferPreview(buf, sl, vol, pitch);
  toast(`Slot ${i + 1} ▶`, 'ok');
}

// ─── TRIM MODAL ───────────────────────────────────────────────

export function openTrimModal(slotIdx) {
  const sl  = APP.editSlots[slotIdx];
  if (!sl || !sl.data) { toast('Kein Audio'); return; }
  const buf = APP.audioBuffers[`_ed_${slotIdx}`];
  if (!buf)            { toast('Audio lädt…'); return; }

  APP.trim.slotIdx      = slotIdx;
  APP.trim.buf          = buf;
  APP.trim.previewSrc   = null;
  APP.trim.dragging     = null;
  APP.trim.zoom         = 1;
  APP.trim.scrollOffset = 0;
  APP.trim.playheadPos  = null;

  const dur = buf.duration;
  const si  = document.getElementById('trimSlotInfo');
  if (si) si.textContent = `Slot ${slotIdx + 1}: ${sl.name || 'Audio'} — ${dur.toFixed(2)}s`;

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('trimStart',   (sl.trimStart || 0).toFixed(3));
  setVal('trimEnd',     (sl.trimEnd != null ? sl.trimEnd : dur).toFixed(3));
  setVal('trimFadeIn',  (sl.fadeIn  || 0).toFixed(2));
  setVal('trimFadeOut', (sl.fadeOut || 0).toFixed(2));
  setVal('trimZoom',    1);

  const teEl = document.getElementById('trimEnd');
  const tsEl = document.getElementById('trimStart');
  if (teEl) teEl.max = dur;
  if (tsEl) tsEl.max = dur;
  const zoomLbl = document.getElementById('trimZoomLbl');
  if (zoomLbl) zoomLbl.textContent = '1×';

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

/** Initialise canvas mouse/touch drag — called once per modal open */
function _initTrimCanvasDrag() {
  const canvas = document.getElementById('trimCanvas');
  if (!canvas) return;

  let panStart = null; // { x, scrollOffset } for middle-button/space pan

  canvas.onmousedown = function(e) {
    if (!APP.trim.buf) return;
    const { normX } = _canvasNormX(e, this);
    const t = _normToTime(normX);
    const dur = APP.trim.buf.duration;
    const ts  = parseFloat(document.getElementById('trimStart').value) || 0;
    const te  = parseFloat(document.getElementById('trimEnd').value)   || dur;
    const pxTs = _timeToNorm(ts);
    const pxTe = _timeToNorm(te);
    const distS = Math.abs(normX - pxTs);
    const distE = Math.abs(normX - pxTe);
    const snap  = 0.015 / APP.trim.zoom;

    if (e.button === 1) { panStart = { x: e.clientX, scrollOffset: APP.trim.scrollOffset }; e.preventDefault(); return; }
    if (distS < snap)      APP.trim.dragging = 'start';
    else if (distE < snap) APP.trim.dragging = 'end';
    else if (e.button === 2) APP.trim.dragging = 'end';
    else APP.trim.dragging = 'start';
    _applyTrimPoint(t);
  };

  canvas.onmousemove = function(e) {
    if (!APP.trim.buf) return;
    if (panStart) {
      const dx = (e.clientX - panStart.x) / this.offsetWidth;
      APP.trim.scrollOffset = Math.max(0, Math.min(1 - 1 / APP.trim.zoom, panStart.scrollOffset - dx / APP.trim.zoom));
      drawTrimWaveform(); return;
    }
    if (!APP.trim.dragging) return;
    const { normX } = _canvasNormX(e, this);
    _applyTrimPoint(_normToTime(normX));
  };

  canvas.onmouseup    = () => { APP.trim.dragging = null; panStart = null; };
  canvas.onmouseleave = () => { if (!panStart) APP.trim.dragging = null; };
  canvas.oncontextmenu = e => e.preventDefault();

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

/** Converts mouse event to 0..1 canvas-relative X, accounting for zoom/scroll */
function _canvasNormX(e, canvas) {
  const r    = canvas.getBoundingClientRect();
  const rawX = (e.clientX - r.left) / r.width; // 0..1 in viewport
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


export function updateTrimDurLabel() {
  const dur = APP.trim.buf?.duration || 0;
  const ts  = parseFloat(document.getElementById('trimStart')?.value) || 0;
  const te  = parseFloat(document.getElementById('trimEnd')?.value)   || dur;
  const el  = document.getElementById('trimDurLabel');
  if (el) el.textContent = `Dauer: ${Math.max(0, te - ts).toFixed(2)}s`;
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
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${x.icon || ''} ${x.name}</option>`
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
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${x.icon || ''} ${x.name}</option>`
          ).join('')}
        </select>
        <input type="number" class="form-control mstep-delay js-fade-dur" style="width:68px" value="${step.fadeDuration || 1000}" min="100" max="10000" aria-label="Fade-Dauer ms">
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
            `<option value="${x.id}"${step.targetId === x.id ? ' selected' : ''}>${x.icon || ''} ${x.name}</option>`
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
          allTargets.filter(x => x.type === t).map(x => `<option value="${x.id}">${x.icon || ''} ${x.name}</option>`).join('');
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
