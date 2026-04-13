/**
 * notifications.js — Toast Notifications
 *
 * Renders and dismisses transient toast messages in the DOM.
 * Imports nothing; DOM-only side effects.
 */

/**
 * Shows a toast notification.
 *
 * @param {string} msg   Message text
 * @param {'ok'|'err'|''} [type='']  Visual variant
 */
export function toast(msg, type = '') {
  const container = document.getElementById('toasts');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'toast-item' +
    (type === 'err' ? ' toast-item--error' : '') +
    (type === 'ok'  ? ' toast-item--success' : '');
  el.textContent = msg;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('toast-item--out');
    setTimeout(() => el.remove(), 220);
  }, 2200);
}
