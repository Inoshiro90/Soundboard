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
