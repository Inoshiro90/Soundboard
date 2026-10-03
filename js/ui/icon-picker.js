/**
 * ui/icon-picker.js — Lucide-Icon-Picker (v2) + Theme-Icon-Sync + Custom-Icon-Upload
 */

import { iconSvg } from './icons.js';
import '../core/state.js';
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

// ─── EINSTIEGSKARTE „DARSTELLUNG & ORGANISATION“: PREVIEW ─────
/**
 * Zieht Icon + Akzentfarbe in der Einstiegskarte nach, damit die aktuelle Wahl
 * sichtbar bleibt, auch wenn der Dialog mit dem Picker geschlossen ist.
 * Eine einzige Implementierung für Sound/Ambient, Makro und Musik-Track.
 */
export function syncEntryCardPreview({ iconElId, inputId, fallbackIcon, colorElId, colorOptsId }) {
  const iconEl = document.getElementById(iconElId);
  if (iconEl) {
    const val = document.getElementById(inputId)?.value.trim();
    iconEl.textContent = isCustomIcon(val) ? '🖼️' : (val || fallbackIcon);
  }
  const colorEl = document.getElementById(colorElId);
  if (colorEl) {
    const color = document.querySelector(`#${colorOptsId} .color-swatch.is-selected`)?.dataset.color;
    colorEl.style.background = (color && color !== 'none') ? color : 'transparent';
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
// Kategorien, Stichwortsuche, Custom-Upload. Performance-Konzept (Messung: Engpass war nicht die
// Suche, sondern Layout/Paint von ~1640 Zellen + deren Aufbau bei jedem Modal-Öffnen):
//   1. Daten per dynamic import erst beim ersten Aufbau eines Pickers (nicht beim App-Start);
//      die Stichwort-Tabelle (~210 KB) erst bei Fokus/erster Suche. Beides In-Memory gecacht.
//   2. Fenster-Rendering: nur die sichtbaren Reihen + Puffer liegen im DOM (ein zusammenhängendes „Fenster“
//      von Entries). Zwei unsichtbare Spacer (grid-row: span N) vor/nach dem Fenster halten die Scrollhöhe
//      konstant → stabile Scrollleiste, kein Springen. Beim Scrollen wächst das Fenster nach oben/unten
//      (bestehende Zellen bleiben unangetastet: Fokus, Auswahl, Hover); springt der Benutzer per
//      Scrollleiste/Fling außerhalb des Fensters, wird das Fenster dort neu aufgesetzt (keine Lücken,
//      keine Zwischen-Reihen rendern). Dasselbe Prinzip zeigt das ausgewählte Emoji, ohne den Bestand davor zu rendern.
//   3. Ein Click-Handler auf dem Grid (Event Delegation) statt eines Listeners je Emoji.
//   4. Auswahl-/Roving-Zustand wird gezielt aktualisiert statt über alle Zellen zu iterieren.

const PREFETCH_ROWS   = 10;  // Puffer oberhalb/unterhalb des sichtbaren Bereichs (≈ 2 Viewports bei 5 Reihen)
const BATCH_ROWS      = 4;   // Nachladen in Reihen-Paketen (weniger, dafür etwas größere DOM-Updates)

// ── Daten: einmal laden, dann für alle Picker/Modals wiederverwenden ──
let _data = null, _dataPromise = null;     // Kategorien (~20 KB)
let _kwIndex = null, _kwPromise = null;    // Suchindex (Stichwörter ~210 KB)

// Browser merken sich einen fehlgeschlagenen import() pro URL dauerhaft (Modul-Map). Damit ein späterer Versuch
// (z.B. nach kurzem Netzausfall) wirklich neu lädt, bekommt jeder Retry eine eigene URL (?r=n).
let _dataTries = 0, _kwTries = 0;
const _retryQuery = n => (n ? `?r=${n}` : '');

/** Kategorien laden (single-flight; Fehlschlag wird nicht gecacht → nächster Picker versucht es erneut). */
function loadEmojiData() {
  if (_data) return Promise.resolve(_data);
  if (!_dataPromise) {
    _dataPromise = import('../data/emoji-data.js' + _retryQuery(_dataTries))
      .then(mod => (_data = _prepareData(mod.EMOJI_CATS)))
      .catch(err => { _dataPromise = null; _dataTries++; throw err; });
  }
  return _dataPromise;
}

/** Stichwort-Tabelle laden und EINMAL zum Suchindex aufbereiten (single-flight). */
function loadSearchIndex() {
  if (_kwIndex) return Promise.resolve(_kwIndex);
  if (!_kwPromise) {
    _kwPromise = import('../data/emoji-keywords.js' + _retryQuery(_kwTries)).then(mod => {
      const kw = mod.EMOJI_KEYWORDS;
      const keys = Object.keys(kw);
      // Pro Emoji ein String '\nbegriff1\nbegriff2…': „Begriff beginnt mit q“ = includes('\n'+q),
      // „Wort im Begriff beginnt mit q“ = includes(' '+q) → keine split()/Array-Allokationen je Suche.
      const hay = keys.map(k => '\n' + kw[k].join('\n'));
      return (_kwIndex = { keys, hay });
    }).catch(err => { _kwPromise = null; _kwTries++; throw err; });
  }
  return _kwPromise;
}

/** Listen-Modell: entries = Emoji-Strings und {h:label}-Überschriften; segs = Zeilen-Geometrie; optIdx = Option→Entry. */
function _flatList(emojis) {
  return { entries: emojis, segs: [{ h: false, start: 0, end: emojis.length }], optIdx: null, optOf: null, nOpts: emojis.length };
}

function _prepareData(cats) {
  const keys = Object.keys(cats);
  const allSet = new Set();
  const entries = [], segs = [], optIdx = [], optOf = [];
  keys.forEach((key, idx) => {
    cats[key].emojis.forEach(e => allSet.add(e));
    // Erste Kategorie ohne Überschrift: sie würde eine ganze Raster-Zeile belegen,
    // und die Auswahl soll initial 5 volle Emoji-Reihen zeigen. Alle weiteren
    // Kategorien behalten ihre Überschrift zur Orientierung beim Scrollen.
    if (idx > 0) { segs.push({ h: true, start: entries.length, end: entries.length + 1 }); optOf[entries.length] = -1; entries.push({ h: cats[key].label }); }
    const start = entries.length;
    cats[key].emojis.forEach(e => { optOf[entries.length] = optIdx.length; optIdx.push(entries.length); entries.push(e); });
    segs.push({ h: false, start, end: entries.length });
  });
  return {
    cats, keys, allSet,
    all: { entries, segs, optIdx, optOf, nOpts: optIdx.length },
    catLists: new Map(),                                   // key → Listenmodell (lazy)
    labelWords: keys.map(k => cats[k].label.toLowerCase().split(/\s+/))
  };
}

function _listFor(data, cat) {
  if (cat === 'all') return data.all;
  let l = data.catLists.get(cat);
  if (!l && data.cats[cat]) { l = _flatList(data.cats[cat].emojis); data.catLists.set(cat, l); }
  return l || null;
}

/** Suche auf dem VOLLEN Datensatz (unabhängig vom DOM). Semantik wie zuvor: Wortanfang-Treffer in
 *  Stichwörtern, dann Kategorie-Label-Wörter, dann exakter Emoji-Treffer. null = leere Anfrage. */
function _search(data, index, query) {
  const q = query.toLowerCase().trim();
  if (!q) return null;
  const results = new Set();
  const needle = '\n' + q, wordNeedle = ' ' + q, multiWord = /\s/.test(q);
  const { keys, hay } = index;
  for (let i = 0; i < keys.length; i++) {
    const h = hay[i];
    if (h.includes(needle) || (!multiWord && h.includes(wordNeedle))) results.add(keys[i]);
  }
  data.keys.forEach((k, i) => {
    if (data.labelWords[i].some(w => w.startsWith(q))) data.cats[k].emojis.forEach(e => results.add(e));
  });
  if (data.allSet.has(query)) results.add(query);
  return [...results];
}

/** Zeilen, die die ersten k Entries belegen (Überschrift = 1 Zeile; Emoji-Läufe umbrechen nach `cols`). */
function _rowsFor(list, k, cols) {
  let rows = 0;
  for (const sg of list.segs) {
    if (k <= sg.start) break;
    rows += sg.h ? 1 : Math.ceil((Math.min(k, sg.end) - sg.start) / cols);
  }
  return rows;
}
/** Kleinstes k, für das mindestens R Zeilen belegt sind (max. alle Entries). */
function _entriesForRows(list, R, cols) {
  if (R <= 0) return 0;
  let rows = 0;
  for (const sg of list.segs) {
    if (sg.h) { rows += 1; if (rows >= R) return sg.start + 1; continue; }
    const n = sg.end - sg.start, r = Math.ceil(n / cols);
    if (rows + r >= R) return sg.start + Math.min(n, (R - rows) * cols);
    rows += r;
  }
  return list.entries.length;
}

/** Reihe (0-basiert), in der Entry idx liegt. */
function _rowOfEntry(list, idx, cols) {
  let rows = 0;
  for (const sg of list.segs) {
    if (idx < sg.start) break;
    if (sg.h) { if (idx < sg.end) return rows; rows += 1; continue; }
    if (idx < sg.end) return rows + Math.floor((idx - sg.start) / cols);
    rows += Math.ceil((sg.end - sg.start) / cols);
  }
  return rows;
}

let _cellProto = null;
function _newCell() {
  if (!_cellProto) {
    _cellProto = document.createElement('div');
    _cellProto.className = 'icon-opt';
    _cellProto.setAttribute('role', 'option');
    _cellProto.setAttribute('aria-selected', 'false');
    _cellProto.tabIndex = -1; // Roving Tabindex: nur eine Zelle bekommt 0
  }
  return _cellProto.cloneNode(false);
}

export function buildIconGrid(containerId, current) {
  const ig = document.getElementById(containerId);
  if (!ig) return;
  // Vorherige Instanz an diesem Container abbauen (Observer, ausstehende Async-Fortsetzungen)
  if (typeof ig._iconPickerDispose === 'function') ig._iconPickerDispose();
  const parent = ig.parentNode;
  parent.querySelectorAll('.icon-picker-wrap').forEach(x => x.remove());
  ig.style.display = 'none';

  let disposed = false;
  let ro = null;
  ig._iconPickerDispose = () => { disposed = true; if (ro) ro.disconnect(); ro = null; ig._iconPickerDispose = null; };

  const wrap = document.createElement('div');
  wrap.className = 'icon-picker-wrap';

  // ── Custom image upload ──
  const uploadRow = document.createElement('div');
  uploadRow.className = 'icon-picker__upload';
  uploadRow.innerHTML = `
    <div class="icon-picker__upload-preview">${isCustomIcon(current) ? iconHtml(current) : (current || '🙂')}</div>
    <div class="icon-picker__upload-text"><strong>Eigenes Bild</strong><br>PNG, JPG, GIF, WEBP, BMP, SVG</div>
    <button type="button" class="btn btn--sm" data-act="upload-icon" aria-label="Eigenes Bild hochladen">
      ${iconSvg('image-up')}
    </button>
    <button type="button" class="icon-picker__upload-clear" data-act="clear-icon" title="Bild entfernen"
      aria-label="Bild entfernen" ${isCustomIcon(current) ? '' : 'hidden'}>
      ${iconSvg('x')}
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

  // "All" pill (braucht keine Daten) — die Kategorie-Pillen folgen, sobald die Daten geladen sind
  const allPill = _mkCatPill('all', 'Alle', 'layout-grid', true);
  catBar.appendChild(allPill);
  wrap.appendChild(catBar);

  // ── Emoji grid ──
  const grid = document.createElement('div');
  grid.className = 'icon-grid icon-picker__grid';
  grid.setAttribute('role', 'listbox');
  grid.setAttribute('aria-label', 'Emojis');
  grid.setAttribute('aria-busy', 'true');
  wrap.appendChild(grid);

  // Insert into the live DOM BEFORE calling lucide.createIcons().
  // Modern Lucide checks node.isConnected and silently skips detached nodes —
  // calling createIcons() on detached nodes leaves icons unrendered, especially
  // on mobile Safari.
  parent.insertBefore(wrap, ig);

  // NOW safe: all [data-lucide] nodes are document-connected.
  if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...catBar.querySelectorAll('[data-lucide]')] });

  // Input ID map
  const inputMap = { iconGrid: 'eIcon', mIconGrid: 'mIcon', profIconGrid: 'profIconInput', ambProfIconGrid: 'ambProfIconInput', ambTrackIconGrid: 'ambTrackIconInput', musicIconGrid: 'musicIconInput', musicProfIconGrid: 'musicProfIconInput' };

  // ── Zustand dieser Picker-Instanz ──────────────────────────
  let data = null;                    // Kategorien (nach Laden)
  let list = null;                    // aktuell angezeigtes Listenmodell
  let winStart = 0, winEnd = 0;       // gerendertes Fenster: Entries [winStart, winEnd) liegen im DOM
  const optByNum = new Map();         // Optionsnummer → Zelle (nur gerenderte)
  const elByEmoji = new Map();        // Emoji → Zelle (nur gerenderte)
  let selectedEl = null, rovingEl = null;
  let geom = null;                    // { cols, stride } — nur bekannt, solange das Grid sichtbar ist
  let revealPending = true;           // beim ersten sichtbaren Layout zum ausgewählten Emoji scrollen
  let searchSeq = 0;                  // verwirft veraltete (asynchrone) Suchläufe

  // Unsichtbare Platzhalter für die nicht gerenderten Zeilen vor/nach dem Fenster (halten die Scrollhöhe konstant)
  const mkSpacer = () => {
    const sp = document.createElement('div');
    sp.className = 'icon-picker__spacer';
    sp.setAttribute('aria-hidden', 'true');
    sp.hidden = true;
    return sp;
  };
  const spaceTop = mkSpacer(), spaceBot = mkSpacer();

  function selectIco(ico) {
    if (selectedEl) {
      selectedEl.classList.remove('is-selected');
      selectedEl.setAttribute('aria-selected', 'false');
      selectedEl = null;
    }
    const match = elByEmoji.get(ico);
    if (match) {
      match.classList.add('is-selected');
      match.setAttribute('aria-selected', 'true');
      selectedEl = match;
      match.scrollIntoView({ block: 'nearest' });
    }
    _syncRovingTabindex();
    const inputId = inputMap[containerId];
    if (inputId) { const inp = document.getElementById(inputId); if (inp) inp.value = ico; }
  }

  // ── Rendering (Fenster) ─────────────────────────────────────
  /** Erzeugt die DOM-Knoten für Entries [from, to). */
  function _makeNodes(from, to) {
    const frag = document.createDocumentFragment();
    let foundSelected = false;
    for (let i = from; i < to; i++) {
      const en = list.entries[i];
      if (typeof en === 'string') {
        const d = _newCell();
        d.textContent = en;
        d.setAttribute('data-emoji', en);
        d.setAttribute('aria-label', en);
        const num = list.optOf ? list.optOf[i] : i;
        d._oi = num;
        if (en === current && !selectedEl) {
          d.classList.add('is-selected');
          d.setAttribute('aria-selected', 'true');
          selectedEl = d; foundSelected = true;
        }
        optByNum.set(num, d);
        if (!elByEmoji.has(en)) elByEmoji.set(en, d);
        frag.appendChild(d);
      } else {
        const heading = document.createElement('div');
        heading.className   = 'icon-picker__section-title';
        heading.textContent = en.h;
        frag.appendChild(heading);
      }
    }
    if (foundSelected) _syncRovingTabindex();
    return frag;
  }

  /** Fenster nach unten erweitern bis Entry k (exklusiv). */
  function _appendTo(k) {
    k = Math.min(k, list.entries.length);
    if (k <= winEnd) return;
    grid.insertBefore(_makeNodes(winEnd, k), spaceBot);
    winEnd = k;
    _updateSpacers();
  }
  /** Fenster nach oben erweitern ab Entry k (muss am Beginn einer Reihe liegen). */
  function _prependTo(k) {
    k = Math.max(0, k);
    if (k >= winStart) return;
    grid.insertBefore(_makeNodes(k, winStart), spaceTop.nextSibling);
    winStart = k;
    _updateSpacers();
  }
  /** Verwirft das Fenster und rendert neu ab Reihe `row` (Sprung außerhalb des Fensters / Ausrichtung nach Resize). */
  function _resetAt(row) {
    const { cols, stride } = geom;
    const viewRows = Math.ceil(grid.clientHeight / stride);     // VOR dem Leeren lesen (kein Layout dazwischen!)
    optByNum.clear(); elByEmoji.clear(); selectedEl = null; rovingEl = null;
    grid.replaceChildren(spaceTop, spaceBot);
    const firstRow = Math.max(0, row);
    winStart = winEnd = _entriesForRows(list, firstRow, cols);
    // Leeres Fenster: Spacer geben zusammen exakt die alte Gesamthöhe zurück, bevor ein Layout stattfindet —
    // sonst würde der Browser scrollTop auf die kurzzeitig kleinere Scrollhöhe zurückklemmen.
    _updateSpacers();
    _appendTo(_entriesForRows(list, firstRow + viewRows + 2 * PREFETCH_ROWS + BATCH_ROWS, cols));
    _syncRovingTabindex();
  }

  function _updateSpacers() {
    if (!geom) { spaceTop.hidden = spaceBot.hidden = true; return; }
    const total = _rowsFor(list, list.entries.length, geom.cols);
    const topRows = _rowsFor(list, winStart, geom.cols);
    const botRows = total - _rowsFor(list, winEnd, geom.cols);
    spaceTop.hidden = topRows <= 0;
    if (topRows > 0) spaceTop.style.gridRow = `span ${topRows}`;
    spaceBot.hidden = botRows <= 0;
    if (botRows > 0) spaceBot.style.gridRow = `span ${botRows}`;
  }

  /** Liest die aktuelle Raster-Geometrie (nur sinnvoll, wenn das Grid sichtbar ist). */
  function _measure() {
    if (!grid.clientWidth) { geom = null; return false; }
    const cs = getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
    const rowH = parseFloat(cs.gridAutoRows);
    const gap  = parseFloat(cs.rowGap) || 0;
    if (!(cols > 0) || !(rowH > 0)) { geom = null; return false; }
    geom = { cols, stride: rowH + gap };
    return true;
  }

  /** Sorgt dafür, dass sichtbarer Bereich + Puffer gerendert sind — nach Scrollen (Rad, Touch, Leiste, Tastatur). */
  function _fill() {
    if (!geom || !list || !list.entries.length) return;
    const { cols, stride } = geom;
    const top = grid.scrollTop, bottom = top + grid.clientHeight;
    const total     = _rowsFor(list, list.entries.length, cols);
    const needFirst = Math.max(0, Math.floor(top / stride) - PREFETCH_ROWS);
    const needLast  = Math.min(total, Math.ceil(bottom / stride) + PREFETCH_ROWS);
    const winFirstRow = _rowsFor(list, winStart, cols);
    const winLastRow  = _rowsFor(list, winEnd, cols);
    // Leeres Fenster oder Sprung komplett außerhalb: neu aufsetzen statt eine Lücke aufzufüllen
    if (winEnd <= winStart || needLast <= winFirstRow || needFirst >= winLastRow) { _resetAt(needFirst); return; }
    if (winLastRow < needLast)  _appendTo(_entriesForRows(list, needLast + BATCH_ROWS, cols));
    if (winFirstRow > needFirst) _prependTo(_entriesForRows(list, Math.max(0, needFirst - BATCH_ROWS), cols));
  }

  /** Stellt sicher, dass Option t gerendert ist (Tastaturnavigation) — Ziel liegt immer direkt am Fenster. */
  function _ensureOpt(t) {
    if (optByNum.has(t)) return;
    const e = list.optIdx ? list.optIdx[t] : t;
    const cols = geom ? geom.cols : 1;
    if (e >= winEnd) _appendTo(e + 1 + cols);
    else if (e < winStart) _prependTo(_entriesForRows(list, Math.max(0, _rowOfEntry(list, e, cols) - 1), cols));
  }

  /** Ersetzt die angezeigte Liste (Kategorie / Suchergebnis). Rendert nur Fenster um die Scrollposition. */
  function setList(newList, { reveal = false } = {}) {
    list = newList;
    optByNum.clear(); elByEmoji.clear(); selectedEl = null; rovingEl = null;
    winStart = winEnd = 0;
    grid.setAttribute('aria-busy', 'false');
    if (!newList.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'icon-picker__empty';
      empty.textContent = 'Keine Ergebnisse';
      grid.classList.remove('is-pending');
      grid.replaceChildren(empty);
      grid.scrollTop = 0;
      return;
    }
    grid.replaceChildren(spaceTop, spaceBot);
    grid.scrollTop = 0;
    // Ist das Grid (noch) unsichtbar — z.B. eingeklappter Icon-Abschnitt —, wird NICHTS gerendert;
    // der ResizeObserver rendert beim ersten sichtbaren Layout (_layoutPass).
    if (!_measure()) {
      // Wartezustand: .is-pending reserviert die endgültige Höhe (CSS), damit das erste Rendern im
      // ResizeObserver-Callback die Größe des Grids nicht mehr ändert (sonst „ResizeObserver loop"-Fehler + Aufpoppen).
      spaceTop.hidden = spaceBot.hidden = true;
      grid.classList.add('is-pending');
      return;
    }
    grid.classList.remove('is-pending');
    _updateSpacers();                       // gesamte Scrollhöhe steht → Scrollposition kann gesetzt werden
    if (reveal) { revealPending = false; _revealSelected(); }
    _fill();
    _syncRovingTabindex();
  }

  /** Scrollt (nur innerhalb des Grids) so, dass das ausgewählte Emoji mittig liegt — ohne den Bestand davor zu rendern. */
  function _revealSelected() {
    if (!current || typeof current !== 'string') return;
    const idx = list.entries.indexOf(current);
    if (idx === -1) return;
    const row = _rowOfEntry(list, idx, geom.cols);
    const cell = geom.stride - (parseFloat(getComputedStyle(grid).rowGap) || 0);
    grid.scrollTop = Math.max(0, row * geom.stride - (grid.clientHeight - cell) / 2);
  }

  function _showStatus(text, extraClass) {
    const msg = document.createElement('div');
    msg.className = 'icon-picker__empty ' + (extraClass || '');
    msg.textContent = text;
    grid.classList.remove('is-pending');
    grid.replaceChildren(msg);
    list = null; winStart = winEnd = 0; optByNum.clear(); elByEmoji.clear(); selectedEl = null; rovingEl = null;
  }

  /** Layout-Pass bei Größen-/Sichtbarkeitsänderung (ResizeObserver): Geometrie, Fenster, Spacer, ausgewähltes Emoji. */
  function _layoutPass() {
    if (disposed || !list || !list.entries.length) return;
    const old = geom;
    if (!_measure()) return;
    if (winEnd <= winStart) {               // erstes sichtbares Layout (oder noch nichts gerendert)
      grid.classList.remove('is-pending');
      _updateSpacers();
      if (revealPending) _revealSelected();
      revealPending = false;
      _fill();
      _syncRovingTabindex();
      return;
    }
    if (old && old.cols !== geom.cols && winStart > 0) {
      // Spaltenzahl hat sich geändert (Resize/Rotation): Fenster ist nicht mehr reihen-ausgerichtet →
      // an der bisher obersten sichtbaren Reihe neu aufsetzen und dort bleiben.
      const topEntry = _entriesForRows(list, Math.floor(grid.scrollTop / old.stride), old.cols);
      const row = _rowOfEntry(list, topEntry, geom.cols);
      _updateSpacers();
      grid.scrollTop = row * geom.stride;
      _resetAt(Math.max(0, row - PREFETCH_ROWS));
      return;
    }
    _updateSpacers();
    _fill();
  }

  // ── Tastaturbedienung (Roving Tabindex) ─────────────────────
  // Ein Tab-Stopp für das ganze Grid statt >1000; Pfeiltasten bewegen den Fokus,
  // Enter/Leertaste wählen aus. Spaltenzahl wird aus dem tatsächlichen Layout
  // gelesen (responsiv), nicht angenommen.
  function _syncRovingTabindex() {
    const start = selectedEl || grid.querySelector('.icon-opt');
    if (rovingEl && rovingEl !== start) rovingEl.tabIndex = -1;
    if (start) start.tabIndex = 0;
    rovingEl = start || null;
  }
  grid.addEventListener('keydown', e => {
    const cur = e.target.closest?.('.icon-opt');
    if (!cur || !list) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault(); cur.click(); return;
    }
    const cols = geom ? geom.cols : 1;
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const target = Math.max(0, Math.min(list.nOpts - 1, cur._oi + delta));
    _ensureOpt(target);               // Ziel kann direkt hinter dem gerenderten Fenster liegen
    const next = optByNum.get(target);
    if (!next || next === cur) return;
    cur.tabIndex = -1; next.tabIndex = 0; rovingEl = next;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
  });

  // Event Delegation: ein Handler für alle Zellen (auch später nachgerenderte)
  grid.addEventListener('click', e => {
    const opt = e.target.closest?.('.icon-opt');
    if (!opt || !grid.contains(opt)) return;
    const ico = opt.getAttribute('data-emoji');
    current = ico;
    selectIco(ico);
  });

  // Nachrendern beim Scrollen (Mausrad, Touch, Scrollleiste, Tastatur) — passiv, kein Throttling nötig:
  // _fill() ist ein Vergleich und rendert nur, wenn der Puffer unterschritten wird.
  grid.addEventListener('scroll', _fill, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(_layoutPass);
    ro.observe(grid);
  } else {
    requestAnimationFrame(_layoutPass);
  }

  // ── Kategorien / Suche ─────────────────────────────────────
  function _showCategory(cat) {
    const l = _listFor(data, cat);
    if (l) setList(l);
  }

  catBar.addEventListener('click', e => {
    const pill = e.target.closest('.icon-picker__cat-pill');
    if (!pill || !data) return;
    activeCat = pill.dataset.cat;
    catBar.querySelectorAll('.icon-picker__cat-pill').forEach(p => {
      p.classList.toggle('is-active', p.dataset.cat === activeCat);
      p.setAttribute('aria-selected', p.dataset.cat === activeCat ? 'true' : 'false');
    });
    srch.value = '';
    searchSeq++;            // ausstehende Suche verwerfen
    revealPending = false;
    _showCategory(activeCat);
  });

  async function _onSearchInput() {
    const raw = srch.value;
    const seq = ++searchSeq;
    revealPending = false;
    if (!raw.trim()) {
      catBar.querySelector(`[data-cat="${activeCat}"]`)?.classList.add('is-active');
      if (data) _showCategory(activeCat);
      return;
    }
    // Clear category selection visually
    catBar.querySelectorAll('.icon-picker__cat-pill').forEach(p => {
      p.classList.remove('is-active');
      p.setAttribute('aria-selected', 'false');
    });
    if (!data) return;      // Daten noch nicht da → init() spielt die Eingabe danach ab
    let index = _kwIndex;
    if (!index) {
      // Erste Suche: Stichwörter nachladen. Status nur zeigen, wenn es spürbar dauert (kein Flackern).
      const slow = setTimeout(() => { if (!disposed && seq === searchSeq) _showStatus('Suche wird vorbereitet…', 'icon-picker__loading'); }, 150);
      try { index = await loadSearchIndex(); }
      catch (err) {
        clearTimeout(slow);
        console.error('[ui] emoji search index failed:', err);
        if (!disposed && seq === searchSeq) _showStatus('Suche nicht verfügbar');
        return;
      }
      clearTimeout(slow);
      if (disposed || seq !== searchSeq) return;   // zwischenzeitlich neu getippt / Kategorie gewählt / Picker neu gebaut
    }
    const results = _search(data, index, raw);
    setList(_flatList(results));
  }
  srch.addEventListener('input', _onSearchInput);
  // Stichwörter schon beim Fokussieren vorladen → erste Suche meist ohne Wartezeit
  srch.addEventListener('focus', () => { if (!_kwIndex) loadSearchIndex().catch(() => {}); }, { once: true });

  // ── Daten bereitstellen (synchron, wenn schon gecacht — sonst per dynamic import) ──
  function init(d) {
    data = d;
    const newIcons = [];
    d.keys.forEach(key => {
      const pill = _mkCatPill(key, d.cats[key].label, d.cats[key].icon, false);
      newIcons.push(...pill.querySelectorAll('[data-lucide]'));
      catBar.appendChild(pill);
    });
    if (typeof lucide !== 'undefined') lucide.createIcons({ nodes: newIcons });
    if (srch.value.trim()) _onSearchInput(); else setList(d.all, { reveal: revealPending });
  }

  if (_data) {
    init(_data);
  } else {
    _showStatus('Emojis werden geladen…', 'icon-picker__loading');
    grid.setAttribute('aria-busy', 'true');
    loadEmojiData().then(d => { if (!disposed) init(d); }).catch(err => {
      // Das Bearbeiten-Modal bleibt voll benutzbar (Upload, Direkteingabe, Speichern) — nur die Emoji-Liste fehlt.
      console.error('[ui] emoji data failed to load:', err);
      if (!disposed) _showStatus('Emojis konnten nicht geladen werden');
    });
  }
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

