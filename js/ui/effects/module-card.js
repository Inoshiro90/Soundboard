/**
 * ui/effects/module-card.js — Karte eines Effektmoduls (Phase 8): Schalter + Regler aus der Registry.
 * Schalter = `role="switch"`; ein ausgeschaltetes Modul macht seinen Reglerbereich `inert` (nicht fokussier-/bedienbar, für
 * Screenreader ausgeblendet) statt nur `opacity`/`pointer-events` (B-17). Jeder Parameter-Typ bekommt hier sein Control;
 * unterstützt: Zahlen (createNumberControl), Aufzählungen und Impulsantwort-Namen (createSelectControl), EQ-Bänder (createBandsControl), Delay-Taps (createDelayTapsControl, 14b). Andere Typen werfen — kein stilles Weglassen.
 * Bedingte Regler (Phase 13e): `ui.showIf = { feld: [Werte…] }` — der Regler ist nur sichtbar, wenn alle genannten Felder desselben Moduls einen der
 * Werte haben (sonst `hidden`, der Wert bleibt in den Daten). Geprüft beim Laden (sync) und nach jeder Änderung in dieser Karte.
 */
import { el, createNumberControl, createSelectControl } from './controls.js';
import { createBandsControl } from './eq10-bands.js';
import { createParamEqControl } from './param-eq.js';
import { createDelayTapsControl } from './delay-taps.js';
import { IR_IMPULSE_NAMES } from '../../audio/engine/registry.js';

/**
 * @param {object} def  Registry-Eintrag (MODULES[i])
 * @param {{get:(param:string)=>any, set:(param:string,v:any)=>void, getEnabled:()=>boolean, setEnabled:(on:boolean)=>void}} api
 * @returns {{key:string, root:HTMLElement, sync:()=>void, setNote:(text:string|null)=>void}}
 *   `setNote` zeigt/entfernt einen Hinweis unter dem Kartenkopf (z. B. „überlagert“); der Schalter verweist per `aria-describedby` darauf.
 */
export function createModuleCard(def, api) {
  const idBase = `fxg-${def.key}`;
  const root = el('section', 'fx-group fx-card', { 'data-fx-module': def.key, 'aria-labelledby': idBase + '-title' });

  const head = el('div', 'fx-group__head');
  const lab = el('label', 'fx-check-label', { id: idBase + '-title' });
  const sw = el('input', null, { type: 'checkbox', role: 'switch', id: idBase + '-enabled', 'data-fx-enabled': true });
  const txt = el('span'); txt.textContent = def.label;
  lab.append(sw, txt); head.appendChild(lab);

  const note = el('p', 'fx-card__note', { id: idBase + '-note', hidden: true });
  const body = el('div', 'fx-controls fx-card__body', { 'data-fx-body': true });
  const controls = [], conditional = [];
  const shown = cond => Object.entries(cond).every(([f, vals]) => vals.includes(api.get(f)));
  const refresh = () => { for (const { root: r, cond } of conditional) r.hidden = !shown(cond); };
  const setAndRefresh = (param, v) => { api.set(param, v); if (conditional.length) refresh(); };
  for (const [param, spec] of Object.entries(def.params)) {
    if (spec.ui?.hidden) continue;
    if (spec.bandList) {                                               // Parametrischer EQ (P10d): Bandtabelle
      const c = createParamEqControl({ idBase: `${idBase}-${param}`, moduleLabel: def.label, getBands: () => api.get(param), setBands: v => api.set(param, v) });
      controls.push(c); body.appendChild(c.root); head.appendChild(c.headExtra);
      continue;
    }
    if (spec.tapList) {                                                // Multi-Tap-Delay (14b): Tap-Tabelle, sichtbar nach ui.showIf
      const c = createDelayTapsControl({ idBase: `${idBase}-${param}`, moduleLabel: def.label, getTaps: () => api.get(param), setTaps: v => api.set(param, v) });
      controls.push(c); body.appendChild(c.root);
      if (spec.ui?.showIf) { c.root.dataset.fxShowIf = Object.keys(spec.ui.showIf).join(','); conditional.push({ root: c.root, cond: spec.ui.showIf }); }
      continue;
    }
    if (spec.bands) {                                                  // 10-Band-EQ: eigenes Control mit Reset im Kopf
      const c = createBandsControl({ idBase: `${idBase}-${param}`, moduleLabel: def.label, spec, getBands: () => api.get(param), setBands: v => api.set(param, v) });
      controls.push(c); body.appendChild(c.root); head.appendChild(c.headExtra);
      if (c.after) body.appendChild(c.after);                           // einklappbare Frequenzliste (P10e)
      continue;
    }
    const values = Array.isArray(spec.enum) ? spec.enum : spec.impulse ? IR_IMPULSE_NAMES : null;       // Aufzählung oder Impulsantwort-Name
    const make = values ? createSelectControl : typeof spec.def === 'number' ? createNumberControl : null;
    if (!make) throw new Error(`Effekt-UI: Parametertyp von ${def.key}.${param} wird noch nicht unterstützt`);
    const c = make({ idBase: `${idBase}-${param}`, moduleLabel: def.label, spec, values, getValue: () => api.get(param), setValue: v => setAndRefresh(param, v) });
    if (c) {
      controls.push(c); body.appendChild(c.root);
      if (spec.ui?.showIf) { c.root.dataset.fxShowIf = Object.keys(spec.ui.showIf).join(','); conditional.push({ root: c.root, cond: spec.ui.showIf }); }
    }
  }

  const applyEnabled = on => { sw.checked = on; body.toggleAttribute('inert', !on); root.classList.toggle('is-off', !on); };
  sw.addEventListener('change', () => { api.setEnabled(sw.checked); applyEnabled(sw.checked); });

  root.append(head, note, body);
  const sync = () => { applyEnabled(api.getEnabled()); for (const c of controls) c.sync(); refresh(); };
  const setNote = text => {
    note.textContent = text || ''; note.hidden = !text;
    if (text) sw.setAttribute('aria-describedby', note.id); else sw.removeAttribute('aria-describedby');
    root.classList.toggle('is-shadowed', !!text);
  };
  return { key: def.key, root, sync, setNote };
}
