/**
 * ui/icon-picker.js — Lucide-Icon-Picker (v2) + Theme-Icon-Sync + Custom-Icon-Upload
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { APP } from '../core/state.js';
import { EMOJI_CATS, EMOJI_KEYWORDS } from '../data/emoji-data.js';
import { isCustomIcon, iconHtml } from '../utils.js';
import { toast } from '../notifications.js';

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

