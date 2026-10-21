/**
 * ui/effects/macro-bar.js — Makro-Regler im Layer-Modal (Phase 9)
 * ----------------------------------------------------------------
 * Zeigt je Makro des Presets einen Regler 0…100 %. Rechenlogik: audio/engine/macros.js (rein). Diese Datei kennt weder die
 * Engine noch das Layer-Formular: der Aufrufer liefert die aktuellen VOLLSTÄNDIGEN Layer-Parameter (`getParams`) und nimmt die
 * neuen entgegen (`onApply`); er schreibt sie ins Formular und stößt die Vorschau an.
 *
 * Verhalten (Entscheidungen B und D):
 *   • Startposition = aus dem ersten anwendbaren Ziel zurückgerechnet; das Öffnen/Anwenden eines Presets schreibt nichts.
 *   • Erst die Bedienung schreibt die Zielwerte. Ziele ausgeschalteter Module werden übersprungen, nie eingeschaltet.
 *   • Ändert der Nutzer danach einen Zielparameter von Hand (oder schaltet ein Zielmodul aus/ein), gilt das Makro als „gelöst“:
 *     Hinweis am Regler, Position folgt wieder dem ersten Ziel. Erneutes Bedienen koppelt es wieder.
 *   • Barrierefrei: echte Beschriftung, `aria-valuetext`, Tastatur über das native <input type="range">, Zielgröße ≥ 44 px (CSS).
 */

import { macroPosition, resolveMacro, writtenStillValid, applicableTargets } from '../../audio/engine/macros.js';

const POS_MAX = 1000;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pct = t => `${Math.round(t * 100)} %`;

export function createMacroBar({ host, getParams, onApply }) {
  /** @type {{macro:object, input:HTMLInputElement, out:HTMLElement, note:HTMLElement, written:object|null, dissolved:boolean}[]} */
  let rows = [];
  let uid = 0;

  function _setPos(r, t) {
    r.input.value = String(Math.round(t * POS_MAX));
    r.out.textContent = pct(t);
    r.input.setAttribute('aria-valuetext', `${r.macro.label} ${pct(t)}`);
  }

  function _onInput(r) {
    const t = Math.min(1, Math.max(0, Number(r.input.value) / POS_MAX));
    const base = getParams();
    const res = resolveMacro(r.macro, t, base);
    r.written = res.written; r.dissolved = false;
    r.out.textContent = pct(t);
    r.input.setAttribute('aria-valuetext', `${r.macro.label} ${pct(t)}`);
    r.note.textContent = '';
    onApply(res.params);
  }

  /** Baut die Leiste neu. Ohne Makros bleibt der Host verborgen. `params`: vollständige Layer-Parameter. */
  function render(macros, params) {
    rows = [];
    host.replaceChildren();
    const list = Array.isArray(macros) ? macros : [];
    host.hidden = !list.length;
    if (!list.length) return;
    host.appendChild(el('h6', 'fx-macros__head', 'Makro-Regler'));
    host.appendChild(el('p', 'fx-macros__hint u-text-muted u-text-badge',
      'Ein Regler stellt mehrere Werte dieses Layers gemeinsam ein. Ausgeschaltete Module bleiben aus. Das Preset selbst ändert sich nicht.'));
    const group = el('div', 'fx-macros__list'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Makro-Regler');
    for (const macro of list) {
      const id = `fxMacro_${++uid}`;
      const row = el('div', 'fx-macro');
      const label = el('label', 'fx-macro__label', macro.label); label.htmlFor = id;
      const input = el('input', 'fx-macro__range'); input.type = 'range'; input.id = id; input.min = '0'; input.max = String(POS_MAX); input.step = '1';
      const out = el('output', 'fx-macro__value'); out.htmlFor = id;
      const note = el('span', 'fx-macro__note u-text-muted u-text-badge'); note.setAttribute('role', 'status');
      const r = { macro, input, out, note, written: null, dissolved: false };
      input.addEventListener('input', () => _onInput(r));
      row.append(label, input, out, note);
      group.appendChild(row);
      rows.push(r);
    }
    host.appendChild(group);
    sync(params);
  }

  /** Stellt Positionen/Hinweise nach einer Änderung der Parameter nach. Ein gerade bedienter Regler wird nicht verschoben. */
  function sync(params) {
    for (const r of rows) {
      const targets = applicableTargets(r.macro, params);
      if (!targets.length) {
        r.input.disabled = true; r.written = null; r.dissolved = false;
        r.out.textContent = '–'; r.input.setAttribute('aria-valuetext', `${r.macro.label}: nicht verfügbar`);
        r.note.textContent = 'Alle Zielmodule sind ausgeschaltet.';
        continue;
      }
      r.input.disabled = false;
      if (r.written && writtenStillValid(r.macro, r.written, params)) { r.dissolved = false; continue; }   // gekoppelt: Position bleibt
      if (r.written) { r.dissolved = true; r.written = null; }                                              // von Hand verändert → gelöst
      _setPos(r, macroPosition(r.macro, params) ?? 0);
      r.note.textContent = r.dissolved ? 'Gelöst: ein Zielwert wurde von Hand geändert.' : '';
    }
  }

  function clear() { rows = []; host.replaceChildren(); host.hidden = true; }

  return { render, sync, clear, get rowCount() { return rows.length; } };
}
