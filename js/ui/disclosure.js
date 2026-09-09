/**
 * js/ui/disclosure.js — Central Progressive-Disclosure System
 * ------------------------------------------------------------------
 * A single, reusable pattern for "show this only when asked for"
 * UI: popover toolbars (Werkzeuge, Einstellungen, Raster …) that
 * live behind a trigger button.
 *
 * Markup contract:
 *   <div class="popover-wrap">
 *     <button class="menubar-btn popover-toggle"
 *             data-disclosure-toggle
 *             aria-expanded="false"
 *             aria-controls="appSettingsPopover">
 *       Einstellungen <i class="fa-solid fa-chevron-down popover-toggle__chevron"></i>
 *     </button>
 *     <div class="popover-panel" id="appSettingsPopover" hidden>
 *       …existing buttons/inputs, IDs untouched…
 *     </div>
 *   </div>
 *
 * This module only handles open/close + a11y. It never touches the
 * app/audio state and never removes or renames the IDs that
 * events.js already binds to — existing behaviour for the wrapped
 * controls (Export/Import/Reset, Speichern, Undo/Redo, playback
 * checkboxes …) keeps working unmodified.
 */

const SELECTOR_TOGGLE = '[data-disclosure-toggle]';

function _panelFor(toggle) {
  const id = toggle.getAttribute('aria-controls');
  return id ? document.getElementById(id) : null;
}

/**
 * Moves a popover panel to be a direct child of <body>.
 *
 * Why: sticky bars like .app-menubar/.toolbar set `position: sticky` +
 * a non-auto `z-index`, which makes them establish their own stacking
 * context. A panel nested inside one of them stays trapped in that
 * context no matter what z-index or `position: fixed` we give the panel
 * itself — a later sibling bar at the same z-index (e.g. #soundMenubar
 * right after #appSettingsPopover's ancestor) then paints on top of it
 * and visually covers it. Reparenting onto <body> (a one-time "portal")
 * sidesteps the whole ancestor-stacking-context problem for good, on
 * every screen size. IDs are unchanged, so aria-controls and any
 * getElementById() lookups keep working exactly as before.
 */
export function portalToBody(panel) {
  if (panel && panel.parentElement !== document.body) {
    document.body.appendChild(panel);
  }
}

/**
 * Positions the panel with `position: fixed` using the trigger's
 * actual on-screen rect, instead of relying on CSS `position: absolute`
 * inside the trigger's parent. Several of the toolbars we hang popovers
 * off (.app-menubar, .toolbar) get `overflow-x: auto` on small screens
 * (see layout.css) — an ancestor with any non-visible overflow-x also
 * clips overflow-y per spec, which would silently cut the panel off on
 * mobile. Fixed positioning sidesteps that entirely, on every viewport.
 */
function _positionPanel(toggle, panel) {
  const rect = toggle.getBoundingClientRect();
  panel.style.position = 'fixed';
  panel.style.top  = `${Math.round(rect.bottom + 8)}px`;
  panel.style.left = `${Math.round(rect.left)}px`;
  panel.style.right = 'auto';
  requestAnimationFrame(() => {
    if (panel.hidden) return;
    const pad = 8;
    const pRect = panel.getBoundingClientRect();
    if (pRect.right > window.innerWidth - pad) {
      const shift = pRect.right - (window.innerWidth - pad);
      panel.style.left = `${Math.max(pad, rect.left - shift)}px`;
    }
  });
}

function _setOpen(toggle, panel, open) {
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.classList.toggle('is-active', open);
  panel.hidden = !open;
  panel.dataset.open = open ? 'true' : 'false';
  if (open) _positionPanel(toggle, panel);
}

function _closeAll(exceptPanel) {
  document.querySelectorAll(SELECTOR_TOGGLE).forEach(toggle => {
    const panel = _panelFor(toggle);
    if (!panel || panel === exceptPanel) return;
    if (toggle.getAttribute('aria-expanded') === 'true') _setOpen(toggle, panel, false);
  });
}

/**
 * Wires every [data-disclosure-toggle] button found in `root` into the
 * shared open/close/keyboard/click-outside behaviour. Safe to call more
 * than once (already-wired toggles are skipped).
 */
export function initDisclosure(root = document) {
  root.querySelectorAll(SELECTOR_TOGGLE).forEach(toggle => {
    if (toggle._disclosureWired) return;
    toggle._disclosureWired = true;

    const panel = _panelFor(toggle);
    if (!panel) return;
    portalToBody(panel);

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = toggle.getAttribute('aria-expanded') !== 'true';
      _closeAll(willOpen ? panel : null);
      _setOpen(toggle, panel, willOpen);
      if (willOpen) {
        const focusable = panel.querySelector('button, input, select, textarea, [tabindex]');
        focusable?.focus({ preventScroll: true });
      }
    });

    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        _setOpen(toggle, panel, false);
        toggle.focus();
      }
    });

    // Let Escape close the panel from anywhere inside it, and return
    // focus to the trigger so keyboard users don't lose their place.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        _setOpen(toggle, panel, false);
        toggle.focus();
      }
    });
  });

  // Click-outside-to-close (delegated once on document; harmless to add
  // more than once since we only ever close what's actually open).
  if (!document._disclosureOutsideWired) {
    document._disclosureOutsideWired = true;
    document.addEventListener('click', (e) => {
      document.querySelectorAll(SELECTOR_TOGGLE).forEach(toggle => {
        if (toggle.getAttribute('aria-expanded') !== 'true') return;
        const panel = _panelFor(toggle);
        if (!panel) return;
        if (panel.contains(e.target) || toggle.contains(e.target)) return;
        _setOpen(toggle, panel, false);
      });
    });
  }
}

/**
 * Marks a popover trigger with a small accent dot so an advanced
 * setting that differs from its default stays visible even while its
 * panel is collapsed (mirrors .has-active-fx in the sound editor).
 */
export function setDisclosureActive(toggleId, isActive) {
  document.getElementById(toggleId)?.classList.toggle('has-active-setting', !!isActive);
}
