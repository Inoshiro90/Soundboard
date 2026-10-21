/**
 * ui/effects/effect-editor.js — Editor der registry-generierten Effektmodule im Layer-Formular (Phase 8).
 * ---------------------------------------------------------------------------------------------------
 * Strangler: Module mit `ui.generated: true` in der Registry werden hier gebaut und gelesen; alle anderen Module bleiben
 * im handgeschriebenen Formular (dialogs/sound-modal.js). Mit jedem Umstellungsschritt wächst die Menge der generierten Module.
 *
 * Der ZUSTAND liegt im Editor (`state[modul] = { enabled, …Parameter }`), nicht im DOM. Dadurch
 *  • ist Lesen/Schreiben ohne DOM möglich (Node-Tests, Aufrufe vor dem Mounten),
 *  • bleiben nicht bediente (hidden) Parameter und Datenwerte außerhalb des Reglerbereichs beim Bearbeiten erhalten,
 *  • ändert nur eine echte Nutzeraktion den Zustand (`setValues` sendet nie ein Ereignis).
 * Hosts im HTML: `<div data-fx-host data-fx-modules="lowpass,highpass,notch"></div>` — mehr handgeschriebenes Effekt-HTML gibt es nicht.
 */
import { MODULES, NUM_RANGES, IR_IMPULSE_NAMES, defaultModule } from '../../audio/engine/registry.js';
import { createModuleCard } from './module-card.js';
import { normalizeModule as schemaNormalize, shadowed } from '../../audio/engine/schema.js';
import { MODULE_BY_KEY } from '../../audio/engine/registry.js';

/** Registry-Module, die das Formular erzeugt (Reihenfolge = Registry). */
export const generatedModules = () => MODULES.filter(m => m.ui?.generated);

/** Eingehende Modulwerte → gültiger Editor-Zustand: fehlend/ungültig → Default, Zahlen auf den Registry-Bereich geklemmt. */
function normalizeModule(def, src) {
  if (def.params.bands) return schemaNormalize(def.key, src);                       // EQ-Bänder: eine Wahrheit (schema.js)
  const out = defaultModule(def.key);
  if (!src || typeof src !== 'object') return out;
  out.enabled = !!src.enabled;
  for (const [p, spec] of Object.entries(def.params)) {
    const v = src[p];
    if (spec.impulse) { out[p] = IR_IMPULSE_NAMES.includes(v) ? v : null; }               // wie schema.js: bekannter Name, sonst „nicht gesetzt“
    else if (typeof spec.def === 'number') {
      if (!Number.isFinite(v)) continue;
      const r = NUM_RANGES[`${def.key}.${p}`];
      out[p] = r ? Math.min(r[1], Math.max(r[0], v)) : v;
    } else if (Array.isArray(spec.enum)) { if (spec.enum.includes(v)) out[p] = v; }   // Aufzählung: nur erlaubte Werte, sonst Default
    else if (typeof v === typeof spec.def) out[p] = v;
  }
  return out;
}

/** Welche Sektionen (Panel-IDs) mindestens ein aktives Modul enthalten. `sectionMap` = { sektionsId: [modulSchlüssel] }, `fx` = flacher Layerstand. */
export function activeSectionsOf(sectionMap, fx) {
  const out = {};
  for (const [sec, keys] of Object.entries(sectionMap)) out[sec] = keys.some(k => !!fx?.[k]?.enabled);
  return out;
}

/** Hinweise für überlagerte Module (Exklusivgruppen der Registry, z. B. IR-Reverb vor Reverb): { modulSchlüssel: Text }. */
export function shadowNotes(values) {
  const label = k => MODULE_BY_KEY[k]?.label ?? k;
  const out = {};
  for (const s of shadowed(values)) {
    out[s.shadowed] = `Überlagert: „${label(s.active)}“ ist ebenfalls aktiv und hat Vorrang, dieses Modul hat keine Wirkung. `
      + 'Für beide Wirkungen den zweiten Effekt in eine eigene Ebene legen.';
  }
  return out;
}

/**
 * Ansage für Screenreader, wenn sich durch eine Nutzeraktion ändert, welche Module überlagert sind.
 * @param {string[]} prevKeys vorher überlagerte Module   @param {object} values Zustand nach der Aktion
 * @returns {string} Text („“ = nichts anzusagen)
 */
export function shadowAnnouncement(prevKeys, values) {
  const label = k => MODULE_BY_KEY[k]?.label ?? k;
  const now = shadowed(values), nowKeys = now.map(s => s.shadowed), msgs = [];
  for (const s of now) if (!prevKeys.includes(s.shadowed)) msgs.push(`${label(s.shadowed)} ist überlagert von ${label(s.active)} und hat keine Wirkung.`);
  for (const k of prevKeys) if (!nowKeys.includes(k)) msgs.push(`${label(k)} ist nicht mehr überlagert.`);
  return msgs.join(' ');
}

/** „3 aktive Module“ / „1 aktives Modul“ / „Keine aktiven Module in dieser Ebene.“ */
export const activeCountText = n => (n === 0 ? 'Keine aktiven Module in dieser Ebene.' : n === 1 ? '1 aktives Modul' : `${n} aktive Module`);

export function createEffectEditor() {
  const defs = generatedModules();
  const state = {};
  const cards = [];
  const sectionMap = {};                 // Sektions-ID → Modulschlüssel (aus der Lage der Hosts im HTML abgeleitet)
  const sectionWrap = {};                // Sektions-ID → .disclosure-section
  let onlyActive = false, hintEl = null, liveEl = null, prevShadowed = [];
  for (const d of defs) state[d.key] = defaultModule(d.key);

  /** `announce`: nur bei einer Nutzeraktion (Schalter), nie beim Laden eines Layers — sonst Lärm für Screenreader. */
  const refreshHints = (announce = false) => {
    const notes = shadowNotes(state);
    for (const c of cards) c.setNote(notes[c.key] || null);
    if (announce && liveEl) { const msg = shadowAnnouncement(prevShadowed, state); if (msg) liveEl.textContent = msg; }
    prevShadowed = Object.keys(notes);
  };
  /** „Nur aktive“: ausgeschaltete Karten und Sektionen ohne aktives Modul ausblenden. Wird beim Umschalten und beim Laden eines
   *  Layers angewendet — NICHT live: eine eben ausgeschaltete Karte soll nicht unter dem Zeiger verschwinden. */
  const applyFilter = () => {
    for (const c of cards) c.root.hidden = onlyActive && !state[c.key].enabled;
    for (const [sec, keys] of Object.entries(sectionMap)) if (sectionWrap[sec]) sectionWrap[sec].hidden = onlyActive && !keys.some(k => state[k].enabled);
    if (hintEl) hintEl.textContent = onlyActive ? activeCountText(defs.filter(d => state[d.key].enabled).length) : '';
  };

  const api = {
    /** Zustand ← Modulwerte (flaches Layer-Objekt, z. B. fillLayerParams()). Aktualisiert gemountete Karten; kein Ereignis. */
    setValues(fx) {
      for (const d of defs) state[d.key] = normalizeModule(d, fx?.[d.key]);
      for (const c of cards) c.sync();
      refreshHints(); applyFilter();
    },
    /** Abschnitts-Aktivität für Punkt-Anzeigen/Überblick (`fx` = flacher Layerstand). Vor dem Mounten leer. */
    activeSections(fx) { return activeSectionsOf(sectionMap, fx); },
    /** Kopie des Zustands aller generierten Module: { lowpass: {enabled, frequency, Q}, … }. */
    getValues() {
      return JSON.parse(JSON.stringify(state));
    },
    /** Baut die Karten in alle `[data-fx-host]` unterhalb von `root` (idempotent je Host). Nur im Browser. */
    mount(root) {
      for (const host of root.querySelectorAll('[data-fx-host]')) {
        if (host.dataset.fxMounted) continue;
        const keys = (host.dataset.fxModules || '').split(',').map(s => s.trim()).filter(Boolean);
        const panel = host.closest('.disclosure-section__panel');
        if (panel?.id) { (sectionMap[panel.id] ||= []).push(...keys); sectionWrap[panel.id] = panel.closest('.disclosure-section'); }
        for (const key of keys) {
          const def = defs.find(d => d.key === key);
          if (!def) throw new Error(`Effekt-UI: Modul „${key}“ ist nicht als generiert markiert (Registry ui.generated)`);
          const card = createModuleCard(def, {
            get: p => state[key][p], set: (p, v) => { state[key][p] = v; },
            getEnabled: () => state[key].enabled, setEnabled: on => { state[key].enabled = on; refreshHints(true); }
          });
          host.appendChild(card.root); cards.push(card); card.sync();
        }
        host.dataset.fxMounted = '1';
      }
      refreshHints(); applyFilter();
    },
    /** Baut den „Nur aktive Module zeigen“-Schalter in `el`. `el` muss AUSSERHALB des Layer-Formulars liegen: der Schalter ist
     *  Ansicht, keine Effektänderung (kein Dirty-Flag, kein Vorschau-Update). */
    mountToolbar(el) {
      if (!el || el.dataset.fxMounted) return;
      const label = document.createElement('label'); label.className = 'fx-check-label';
      const sw = document.createElement('input'); sw.type = 'checkbox'; sw.setAttribute('role', 'switch'); sw.id = 'fxg-only-active';
      const txt = document.createElement('span'); txt.textContent = 'Nur aktive Module zeigen';
      label.append(sw, txt);
      hintEl = document.createElement('span'); hintEl.className = 'fx-toolbar__hint'; hintEl.setAttribute('aria-live', 'polite');
      sw.addEventListener('change', () => { onlyActive = sw.checked; applyFilter(); });
      liveEl = document.createElement('div'); liveEl.className = 'fx-sr-only'; liveEl.setAttribute('role', 'status'); liveEl.setAttribute('aria-live', 'polite'); liveEl.id = 'fxg-live';
      el.append(label, hintEl, liveEl); el.dataset.fxMounted = '1';
    },
    keys: defs.map(d => d.key)
  };
  return api;
}
