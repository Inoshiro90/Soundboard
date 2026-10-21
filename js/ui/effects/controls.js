/**
 * ui/effects/controls.js — Generierte Effekt-Regler (Phase 8): Schieberegler + Zahlfeld, gekoppelt.
 * ------------------------------------------------------------------------------------------------
 * Zustand liegt NICHT im DOM, sondern im Aufrufer (`getValue`/`setValue`, siehe effect-editor.js). Das DOM ist nur Ansicht.
 *  • Schieberegler: Positionsachse 0…1000 (control-math.js), `aria-valuetext` mit Einheit, vollständige Tastatursteuerung
 *    (Pfeile = ein Schritt, Shift = fein, Bild↑/↓ = grob, Pos1/Ende = Min/Max). Doppelklick = Standardwert.
 *  • Zahlfeld: Eingabe wirkt sofort, sobald sie gültig ist und im Reglerbereich liegt; beim Verlassen wird geklemmt.
 *  • Eigene Tastatur-/Doppelklick-Aktionen senden ein künstliches `input`-Ereignis mit `fxUser = true` (der Vorschau-Hook
 *    in dialogs/fx-pipeline-modals.js lässt sonst nur echte Nutzereingaben durch, `isTrusted`). Das programmatische Befüllen
 *    (`sync()`) sendet NIE ein Ereignis.
 * Reine Browser-Datei (document); die Rechenlogik steht in control-math.js und ist in Node getestet.
 */
import { resolveParamUi, toPos, fromPos, snapValue, stepValue, clampUi, formatNumber, formatValueText, toDisplay, fromDisplay, POS_MAX } from './control-math.js';

export const el = (tag, cls, attrs) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : String(v));
  return e;
};

/** Künstliche Nutzeraktion (Tastatur, Doppelklick): bubbelt wie ein echtes Ereignis und trägt `fxUser`. */
export function emitUserEvent(target, type) {
  const ev = new Event(type, { bubbles: true });
  ev.fxUser = true;
  target.dispatchEvent(ev);
}

const KEYS = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 1, PageDown: -1 };

/**
 * Zahlparameter (Schieberegler + Zahlfeld).
 * @param {{idBase:string, moduleLabel:string, spec:object, getValue:()=>number, setValue:(v:number)=>void}} o
 * @returns {{root:HTMLElement, sync:()=>void}|null} null für nicht bediente (hidden) Parameter
 */
export function createNumberControl({ idBase, moduleLabel, spec, getValue, setValue }) {
  const ui = resolveParamUi(spec);
  if (ui.hidden) return null;
  const name = `${moduleLabel}: ${ui.label}`;

  const root = el('div', 'fx-param');
  const label = el('label', 'fx-param__label', { for: idBase }); label.textContent = ui.label;
  const row = el('div', 'fx-slider-row');
  const slider = el('input', 'slider fx-slider', { type: 'range', id: idBase, min: 0, max: POS_MAX, step: 1, 'aria-label': name });
  const wrap = el('span', 'fx-num-wrap');
  const num = el('input', 'fx-num', { type: 'number', id: idBase + '-num', min: toDisplay(ui, ui.min), max: toDisplay(ui, ui.max), step: 'any', inputmode: 'decimal', 'aria-label': `${name}, Zahlenwert` });
  wrap.appendChild(num);
  if (ui.unit) { const u = el('span', 'fx-unit', { 'aria-hidden': 'true' }); u.textContent = ui.unit; wrap.appendChild(u); }
  row.append(slider, wrap);
  const hint = el('span', 'fx-param__hint', { id: idBase + '-hint', hidden: true });     // sichtbarer Hinweis (auch auf Touch/Screenreader; ein title wäre das nicht)
  root.append(label, row, hint);

  const showValueText = v => slider.setAttribute('aria-valuetext', formatValueText(ui, v));

  /** Ansicht ← Zustand (kein Ereignis). */
  const sync = () => {
    const v = getValue();
    slider.value = String(toPos(ui, v));
    num.value = formatNumber(ui, v);
    showValueText(v);
    const out = v < ui.min || v > ui.max;                     // Datenwert außerhalb des Reglerbereichs: bleibt erhalten
    hint.hidden = !out;
    hint.textContent = out ? `Wert liegt außerhalb des Reglerbereichs (${toDisplay(ui, ui.min)}–${toDisplay(ui, ui.max)}${ui.unit ? ' ' + ui.unit : ''}) und bleibt erhalten, bis du ihn änderst.` : '';
    for (const c of [slider, num]) { if (out) c.setAttribute('aria-describedby', hint.id); else c.removeAttribute('aria-describedby'); }
  };
  const commit = (v, { redraw = true } = {}) => { setValue(v); if (redraw) sync(); else showValueText(v); };

  slider.addEventListener('input', e => {
    if (e.fxUser) return;                                       // eigene Aktionen haben den Zustand schon gesetzt
    const v = snapValue(ui, fromPos(ui, Number(slider.value)));
    setValue(v);
    num.value = formatNumber(ui, v); showValueText(v);
  });
  slider.addEventListener('keydown', e => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let v = null;
    if (e.key in KEYS) v = stepValue(ui, getValue(), KEYS[e.key], { fine: e.shiftKey, page: e.key.startsWith('Page') });
    else if (e.key === 'Home') v = ui.min;
    else if (e.key === 'End') v = ui.max;
    if (v === null) return;
    e.preventDefault();
    commit(v); emitUserEvent(slider, 'input');
  });
  slider.addEventListener('dblclick', () => { commit(clampUi(ui, spec.def)); emitUserEvent(slider, 'input'); });

  num.addEventListener('input', () => {
    const x = num.valueAsNumber;
    if (!Number.isFinite(x)) return;
    const v = fromDisplay(ui, x);
    if (v < ui.min || v > ui.max) return;
    setValue(v); slider.value = String(toPos(ui, v)); showValueText(v);
  });
  num.addEventListener('change', () => {
    const x = num.valueAsNumber;
    if (!Number.isFinite(x)) { sync(); return; }                // ungültig/leer: Anzeige zurück auf den Zustand
    commit(clampUi(ui, fromDisplay(ui, x)));
  });

  return { root, sync, slider, num };
}

/**
 * Auswahlparameter: `values` = erlaubte Werte (Aufzählung `spec.enum` oder die Impulsantwort-Namen), `spec.ui.options` =
 * { wert: 'Beschriftung' } (fehlt → der Wert selbst). Ist der Wert „nicht gesetzt“ (`spec.def === null`, z. B. Impulsantwort), kommt
 * ein erster Eintrag „Standard“ (`spec.ui.emptyLabel`) dazu; Wert `null` ↔ leere Option.
 * Das `change` ist ein echtes Nutzerereignis (Vorschau-Hook, Dirty-Flag) — es braucht kein künstliches.
 * @returns {{root:HTMLElement, sync:()=>void, select:HTMLSelectElement}}
 */
export function createSelectControl({ idBase, moduleLabel, spec, values, getValue, setValue }) {
  const root = el('div', 'fx-param');
  const label = el('label', 'fx-param__label', { for: idBase }); label.textContent = spec.label;
  const select = el('select', 'form-select form-select-sm fx-preset-select fx-select', { id: idBase, 'aria-label': `${moduleLabel}: ${spec.label}` });
  const nullable = spec.def === null;
  if (nullable) { const o = el('option', null, { value: '' }); o.textContent = spec.ui?.emptyLabel ?? 'Standard'; select.appendChild(o); }
  for (const v of values) { const o = el('option', null, { value: v }); o.textContent = spec.ui?.options?.[v] ?? v; select.appendChild(o); }
  root.append(label, select);
  const sync = () => { select.value = getValue() ?? ''; };
  select.addEventListener('change', () => setValue(nullable && select.value === '' ? null : select.value));
  return { root, sync, select };
}
