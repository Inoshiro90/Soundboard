/**
 * ui/effects/split-branches.js — Zweige eines Splitters (Phase 22d): Tabs je Zweig, darin die Karten der erlaubten Module.
 * --------------------------------------------------------------------------------------------------------------------
 * Ein Tab je Zweig-Parameter (`spec.branch`, Registry) — auf kleinen Displays ist immer genau EIN Zweig sichtbar (Tabs statt Spalten).
 * Tabs mit `ui.showIf` (Frequenz-Splitter „Mitte“ nur bei 3 Bändern) werden aus- und eingeblendet; ist der gewählte Tab ausgeblendet, springt die
 * Auswahl auf den ersten sichtbaren. Tastatur: Pfeil links/rechts, Pos1/Ende (WAI-ARIA Tabs, automatische Aktivierung).
 * Modulkarten im Zweig = dieselbe Karte wie im Layer (createModuleCard, Registry-Regler inkl. `ui.grid`), Reihenfolge = Registry (wie im Layer gebaut).
 * Daten: der Zweig ist `{ chain, x? }`; die Karte schreibt in `chain[modul]` (fehlt das Modul, beginnt es mit den Registry-Standards). Ausgeschaltete
 * Module entfallen beim Speichern (sparsam, schema.js sparsifyBranch); `x` (nicht gebaute Module) bleibt unverändert erhalten.
 */
import { el } from './controls.js';
import { MODULES, isBranchModuleKey, defaultModule } from '../../audio/engine/registry.js';
import { shadowed } from '../../audio/engine/schema.js';

const BRANCH_DEFS = () => MODULES.filter(m => isBranchModuleKey(m.key));

/**
 * @param {{idBase:string, def:object, params:string[], getBranch:(name:string)=>object, shown:(name:string)=>boolean, createCard:Function}} o
 *   `createCard(def, api, opts)` = createModuleCard (übergeben, um einen Importzirkel mit module-card.js zu vermeiden).
 * @returns {{root:HTMLElement, sync:()=>void, refresh:()=>void, select:(name:string)=>void, selected:()=>string, cards:object}}
 */
export function createSplitBranchesControl({ idBase, def, params, getBranch, shown, createCard }) {
  const root = el('div', 'fx-split', { 'data-fx-split': def.key });
  const tabs = el('div', 'fx-split__tabs', { role: 'tablist', 'aria-label': `${def.label}: Zweige` });
  root.appendChild(tabs);
  const hint = el('p', 'fx-split__hint');
  hint.textContent = 'Jeder Zweig hat seine eigene Mini-Kette; die Zweige werden danach wieder summiert. Reihenfolge im Zweig wie im Layer. '
    + 'Hall im Modus „Reverse“ klingt im Zweig nur trocken.';
  const items = {}, cards = {};
  let current = params[0];

  const chainOf = name => {
    const b = getBranch(name);
    if (!b.chain || typeof b.chain !== 'object' || Array.isArray(b.chain)) b.chain = {};
    return b.chain;
  };
  const modOf = (name, key) => chainOf(name)[key] || null;
  const ensure = (name, key) => { const c = chainOf(name); if (!c[key]) c[key] = defaultModule(key); return c[key]; };

  for (const name of params) {
    const label = def.params[name]?.label || name;
    const tab = el('button', 'fx-split__tab', { type: 'button', role: 'tab', id: `${idBase}-tab-${name}`, 'aria-controls': `${idBase}-panel-${name}`, 'data-fx-branch': name });
    tab.textContent = label;
    const panel = el('div', 'fx-split__panel', { role: 'tabpanel', id: `${idBase}-panel-${name}`, 'aria-labelledby': tab.id, 'data-fx-branch-panel': name });
    const list = el('div', 'fx-split__cards');
    cards[name] = [];
    for (const md of BRANCH_DEFS()) {
      const card = createCard(md, {
        get: p => (modOf(name, md.key) || defaultModule(md.key))[p],
        set: (p, v) => { ensure(name, md.key)[p] = v; },
        getEnabled: () => modOf(name, md.key)?.enabled === true,
        setEnabled: on => { ensure(name, md.key).enabled = on; notes(name); }
      }, { idBase: `${idBase}-${name}-${md.key}`, branch: name });
      list.appendChild(card.root); cards[name].push(card);
    }
    panel.append(list);
    tab.addEventListener('click', () => select(name, true));
    tabs.appendChild(tab); root.appendChild(panel);
    items[name] = { tab, panel };
  }
  root.appendChild(hint);

  /** Überlagerte Module im Zweig (Exklusivgruppen wie im Layer: EQ, Hall). */
  const notes = name => {
    const dead = new Map(shadowed(chainOf(name)).map(s => [s.shadowed, s.active]));
    for (const c of cards[name]) {
      const act = dead.get(c.key);
      c.setNote(act ? `Überlagert: „${MODULES.find(m => m.key === act)?.label ?? act}“ ist in diesem Zweig ebenfalls aktiv und hat Vorrang.` : null);
    }
  };

  const visible = () => params.filter(n => shown(n));
  function select(name, focus = false) {
    if (!items[name] || !shown(name)) return;
    current = name;
    for (const [n, it] of Object.entries(items)) {
      const on = n === name;
      it.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      it.tab.tabIndex = on ? 0 : -1;
      it.panel.hidden = !on;
    }
    if (focus) items[name].tab.focus();
  }
  tabs.addEventListener('keydown', e => {
    const vis = visible(), i = vis.indexOf(current);
    let next = null;
    if (e.key === 'ArrowRight') next = vis[(i + 1) % vis.length];
    else if (e.key === 'ArrowLeft') next = vis[(i - 1 + vis.length) % vis.length];
    else if (e.key === 'Home') next = vis[0];
    else if (e.key === 'End') next = vis[vis.length - 1];
    if (next) { e.preventDefault(); select(next, true); }
  });

  /** Sichtbarkeit der Tabs nach `ui.showIf` des Splitters; ausgeblendeter gewählter Tab → erster sichtbarer. */
  const refresh = () => {
    for (const [n, it] of Object.entries(items)) it.tab.hidden = !shown(n);
    select(shown(current) ? current : (visible()[0] || params[0]));
  };
  const sync = () => {
    for (const n of params) { for (const c of cards[n]) c.sync(); notes(n); }
    refresh();
  };
  select(current);
  return { root, sync, refresh, select, selected: () => current, cards };
}
