/**
 * utils.js — Pure Helper Functions
 *
 * No imports, no side effects. All functions are stateless utilities.
 */

/**
 * Generates a short unique ID.
 * @returns {string}
 */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Returns a human-readable hotkey string from a KeyboardEvent.
 * @param {KeyboardEvent} e
 * @returns {string} e.g. "Ctrl+Shift+A"
 */
export function hotkeyStr(e) {
  const parts = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = e.key;
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(k)) {
    parts.push(k.length === 1 ? k.toUpperCase() : k);
  }
  return parts.join('+');
}

/**
 * Tests whether a stored hotkey string matches a KeyboardEvent.
 * @param {string}        hk  stored hotkey (e.g. "Ctrl+A")
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function hotkeyMatch(hk, e) {
  if (!hk) return false;
  const parts = hk.split('+');
  const needCtrl  = parts.includes('Ctrl');
  const needAlt   = parts.includes('Alt');
  const needShift = parts.includes('Shift');
  const key = parts.filter(x => !['Ctrl', 'Alt', 'Shift'].includes(x))[0] || '';
  const ek  = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return needCtrl === e.ctrlKey
      && needAlt   === e.altKey
      && needShift === e.shiftKey
      && key === ek;
}

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Builds the audio-buffer key from an item ID and a slot index.
 * @param {string} id
 * @param {number} i
 * @returns {string}
 */
export const bk = (id, i) => `${id}_${i}`;

/**
 * Formats a duration (seconds) as a readable string.
 * @param {number} s  seconds
 * @returns {string}
 */
export function fmtDur(s) {
  if (s == null || isNaN(s)) return '';
  return s.toFixed(1) + 's';
}

/**
 * Icons throughout the app are either a short emoji string, or — for
 * custom-uploaded icons (PNG/JPEG/GIF/WEBP/BMP/SVG) — a `data:image/...`
 * URI. This is the single shared convention every renderer checks.
 * @param {string} icon
 * @returns {boolean}
 */
export function isCustomIcon(icon) {
  return typeof icon === 'string' && icon.startsWith('data:image');
}

/**
 * Renders an icon as HTML: an <img> for custom-uploaded images, or the
 * emoji character itself as plain text otherwise. Used by every tile/tab/row
 * template so custom icons work consistently everywhere (sound tiles, macro
 * tiles, profile tabs, ambient scene tabs, ambient track rows).
 * @param {string} icon
 * @param {string} [cls]   extra class(es) for the <img>, e.g. for sizing
 * @returns {string} HTML
 */
export function iconHtml(icon, cls = '') {
  if (isCustomIcon(icon)) {
    return `<img src="${icon}" class="icon-img${cls ? ' ' + cls : ''}" alt="" draggable="false">`;
  }
  return icon ?? '';
}

/**
 * Text-only counterpart to iconHtml() — for contexts that can't render HTML
 * (element.textContent, <option> labels inside <select>). Custom-uploaded
 * images fall back to a neutral picture glyph since an <img> can't be shown.
 * @param {string} icon
 * @param {string} [fallback]  shown when icon is empty/unset
 * @returns {string} plain text
 */
export function iconGlyph(icon, fallback = '') {
  if (isCustomIcon(icon)) return '🖼️';
  return icon || fallback;
}

/** Convenience: iconHtml() with a fallback emoji for when no icon is set at all. */
export function iconHtmlOr(icon, fallback, cls = '') {
  return icon ? iconHtml(icon, cls) : fallback;
}
