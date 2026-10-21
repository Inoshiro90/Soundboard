/**
 * ui/effects/module-card.js — Karte eines Effektmoduls (Phase 8): Schalter + Regler aus der Registry.
 * Schalter = `role="switch"`; ein ausgeschaltetes Modul macht seinen Reglerbereich `inert` (nicht fokussier-/bedienbar, für
 * Screenreader ausgeblendet) statt nur `opacity`/`pointer-events` (B-17). Jeder Parameter-Typ bekommt hier sein Control;
 * unterstützt: Zahlen (createNumberControl), Aufzählungen und Impulsantwort-Namen (createSelectControl), EQ-Bänder (createBandsControl). Andere Typen werfen — kein stilles Weglassen.
 */
import { el, createNumberControl, createSelectControl } from './controls.js';
import { createBandsControl } from './eq10-bands.js';
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
  const controls = [];
  for (const [param, spec] of Object.entries(def.params)) {
    if (spec.ui?.hidden) continue;
    if (spec.bands) {                                                  // 10-Band-EQ: eigenes Control mit Reset im Kopf
      const c = createBandsControl({ idBase: `${idBase}-${param}`, moduleLabel: def.label, spec, getBands: () => api.get(param), setBands: v => api.set(param, v) });
      controls.push(c); body.appendChild(c.root); head.appendChild(c.headExtra);
      continue;
    }
    const values = Array.isArray(spec.enum) ? spec.enum : spec.impulse ? IR_IMPULSE_NAMES : null;       // Aufzählung oder Impulsantwort-Name
    const make = values ? createSelectControl : typeof spec.def === 'number' ? createNumberControl : null;
    if (!make) throw new Error(`Effekt-UI: Parametertyp von ${def.key}.${param} wird noch nicht unterstützt`);
    const c = make({ idBase: `${idBase}-${param}`, moduleLabel: def.label, spec, values, getValue: () => api.get(param), setValue: v => api.set(param, v) });
    if (c) { controls.push(c); body.appendChild(c.root); }
  }

  const applyEnabled = on => { sw.checked = on; body.toggleAttribute('inert', !on); root.classList.toggle('is-off', !on); };
  sw.addEventListener('change', () => { api.setEnabled(sw.checked); applyEnabled(sw.checked); });

  root.append(head, note, body);
  const sync = () => { applyEnabled(api.getEnabled()); for (const c of controls) c.sync(); };
  const setNote = text => {
    note.textContent = text || ''; note.hidden = !text;
    if (text) sw.setAttribute('aria-describedby', note.id); else sw.removeAttribute('aria-describedby');
    root.classList.toggle('is-shadowed', !!text);
  };
  return { key: def.key, root, sync, setNote };
}
