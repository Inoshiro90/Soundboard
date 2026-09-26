/**
 * ui/color-picker.js — Akzentfarben-Picker-Widget
 * Ausgelagert aus ui.js (Phase 4 der Refaktorierung).
 */

import { COLORS, COLOR_NAMES } from '../data/color-data.js';

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

