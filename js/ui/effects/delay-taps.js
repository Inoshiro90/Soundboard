/**
 * ui/effects/delay-taps.js — Tap-Tabelle des Multi-Tap-Delays (Phase 14b).
 * ---------------------------------------------------------------------------------------------------------------------
 * Je Tap eine Tabellenzeile: Schalter „aktiv“, Zeit (ms), Pegel (%), Panorama (−100 = links … +100 = rechts), Rückkopplung (%), Entfernen.
 * Darunter „+ Tap“ (höchstens DELAY_TAPS_MAX_BUILD). Bewusst eine ZAHLENTABELLE wie die Bandtabelle des Parametrischen EQ (param-eq.js):
 * Zahlfeld + Pfeiltasten, Touch-tauglich, Screenreader-freundlich.
 *
 * Zustand liegt im Aufrufer (`getTaps`/`setTaps`, siehe module-card.js/effect-editor.js); das DOM ist nur Ansicht. Datenform je Tap:
 * `{ on, time (s), level (0–1), panorama (−1 … +1), feedback (0–0,95) }` (+ unbekannte Felder, die erhalten bleiben). Die Tabelle zeigt
 * Millisekunden und Prozent; jede Änderung läuft über `patchTap`, also über dieselbe Normalisierung wie beim Laden (schema.js `normalizeDelayTap`).
 *
 * Die reinen Modellfunktionen (oben) brauchen kein DOM und sind in Node getestet; `createDelayTapsControl` ist Browser-Code.
 */
import { DELAY_TAPS_MAX_BUILD, DELAY_TAP_RANGES } from '../../audio/engine/registry.js';
import { normalizeDelayTap } from '../../audio/engine/schema.js';
import { el, emitUserEvent } from './controls.js';

/** Anzeige-Einheiten der Spalten: Faktor Daten → Anzeige, Schritt der Anzeige. */
export const TAP_COLUMNS = [
  { key: 'time', head: 'Zeit (ms)', spoken: 'Zeit in Millisekunden', factor: 1000, step: 1 },
  { key: 'level', head: 'Pegel (%)', spoken: 'Pegel in Prozent', factor: 100, step: 1 },
  { key: 'panorama', head: 'Pan (−L/+R)', spoken: 'Panorama, minus 100 links bis plus 100 rechts', factor: 100, step: 1 },
  { key: 'feedback', head: 'Rückkopplung (%)', spoken: 'Rückkopplung in Prozent', factor: 100, step: 1 }
];
const toView = (v, f) => Math.round(v * f * 1000) / 1000;

/** Neuer Tap: 150 ms nach dem spätesten (ganze ms, höchstens 2 s), Pegel 60 %, Mitte, ohne Rückkopplung. */
export const newTap = taps => {
  const last = taps.length ? Math.max(...taps.map(t => (Number.isFinite(t?.time) ? t.time : 0))) : 0;
  return normalizeDelayTap({ on: true, time: Math.min(DELAY_TAP_RANGES.time[1], Math.round((last + 0.15) * 1000) / 1000), level: 0.6, panorama: 0, feedback: 0 });
};
export const canAddTap = taps => taps.length < DELAY_TAPS_MAX_BUILD;
export const addTap = taps => (canAddTap(taps) ? [...taps, newTap(taps)] : taps);
export const removeTap = (taps, i) => taps.filter((_, k) => k !== i);
/** Felder eines Taps ändern (Datenwerte, nicht Anzeigewerte); normalisiert (klemmt) und behält unbekannte Felder. */
export const patchTap = (taps, i, patch) => (i >= 0 && i < taps.length ? taps.map((t, k) => (k === i ? normalizeDelayTap({ ...t, ...patch }) : t)) : taps);
/** Anzahl der Taps jenseits der gebauten (bleiben in den Daten, klingen nicht). */
export const hiddenTapCount = taps => Math.max(0, taps.length - DELAY_TAPS_MAX_BUILD);
export const panSpoken = p => (Math.abs(p) < 0.005 ? 'Mitte' : p < 0 ? `links ${Math.round(-p * 100)}` : `rechts ${Math.round(p * 100)}`);
export const tapName = (t, i) => `Tap ${i + 1}: ${Math.round(t.time * 1000)} ms, ${panSpoken(t.panorama)}`;

/**
 * @param {{idBase:string, moduleLabel:string, getTaps:()=>Array, setTaps:(t:Array)=>void}} o
 * @returns {{root:HTMLElement, sync:()=>void}}
 */
export function createDelayTapsControl({ idBase, moduleLabel, getTaps, setTaps }) {
  const root = el('div', 'fx-taps');
  const wrap = el('div', 'fx-taps__wrap');
  const table = el('table', 'fx-taps__table');
  const cap = el('caption', 'fx-sr-only'); cap.textContent = `${moduleLabel}: Taps`;
  const thead = el('thead'), hr = el('tr');
  for (const [txt, cls] of [['Aktiv', 'fx-taps__c-on'], ...TAP_COLUMNS.map(c => [c.head, '']), ['Entfernen', 'fx-taps__c-del']]) {
    const th = el('th', cls || null, { scope: 'col' }); th.textContent = txt; hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = el('tbody');
  table.append(cap, thead, tbody); wrap.appendChild(table);
  const foot = el('div', 'fx-taps__foot');
  const addBtn = el('button', 'btn btn--sm btn--ghost fx-taps__add', { type: 'button', 'aria-label': `${moduleLabel}: Tap hinzufügen` }); addBtn.textContent = '+ Tap';
  foot.appendChild(addBtn);
  const info = el('p', 'fx-card__note', { hidden: true });          // Hinweis auf nicht gebaute Taps
  const live = el('p', 'fx-sr-only', { role: 'status', 'aria-live': 'polite' });
  root.append(wrap, foot, info, live);

  let rows = [];
  const commit = next => { setTaps(next); };
  const patch = (i, p) => { const next = patchTap(getTaps(), i, p); commit(next); return next[i]; };

  const paintRow = (r, t, i) => {
    r.on.checked = t.on !== false;
    for (const c of TAP_COLUMNS) r[c.key].value = String(toView(t[c.key], c.factor));
    r.tr.classList.toggle('is-off', t.on === false);
    const n = tapName(t, i);
    r.on.setAttribute('aria-label', `${n} aktiv`);
    for (const c of TAP_COLUMNS) r[c.key].setAttribute('aria-label', `Tap ${i + 1} ${c.spoken}`);
    r.del.setAttribute('aria-label', `${n} entfernen`);
  };

  const buildRows = () => {
    tbody.textContent = ''; rows = [];
    getTaps().forEach((t, i) => {
      const tr = el('tr', 'fx-taps__row');
      const on = el('input', null, { type: 'checkbox', id: `${idBase}-on-${i}` });
      const r = { tr, on };
      const cells = [['fx-taps__c-on', on]];
      for (const c of TAP_COLUMNS) {
        const [lo, hi] = DELAY_TAP_RANGES[c.key];
        r[c.key] = el('input', 'fx-taps__num', { type: 'number', id: `${idBase}-${c.key}-${i}`, min: toView(lo, c.factor), max: toView(hi, c.factor), step: c.step, value: toView(t[c.key], c.factor), inputmode: 'decimal' });
        cells.push(['', r[c.key]]);
      }
      r.del = el('button', 'btn btn--sm btn--ghost fx-taps__del', { type: 'button', id: `${idBase}-del-${i}` }); r.del.textContent = '✕';
      cells.push(['fx-taps__c-del', r.del]);
      for (const [cls, node] of cells) { const td = el('td', cls || null); td.appendChild(node); tr.appendChild(td); }
      tbody.appendChild(tr); rows.push(r);

      // Echte Eingaben (isTrusted) erreichen den Vorschau-Hook des Formulars selbst; hier nur den Zustand setzen und die Zeile nachzeichnen.
      const apply = p => { const nt = patch(i, p); paintRow(r, nt, i); };
      on.addEventListener('change', () => apply({ on: on.checked }));
      for (const c of TAP_COLUMNS) {
        const input = r[c.key];
        input.addEventListener('input', e => { if (e.fxUser) return; const v = parseFloat(input.value); if (Number.isFinite(v)) patch(i, { [c.key]: v / c.factor }); });
        input.addEventListener('change', () => { const v = parseFloat(input.value); apply({ [c.key]: Number.isFinite(v) ? v / c.factor : getTaps()[i][c.key] }); });   // beim Verlassen klemmen/zurücksetzen
      }
      r.del.addEventListener('click', () => {
        const name = tapName(getTaps()[i], i);
        commit(removeTap(getTaps(), i)); buildRows(); paintInfo(); live.textContent = `${name} entfernt`;
        emitUserEvent(root, 'input');
        (tbody.querySelector('input[type=number]') || addBtn).focus?.();
      });
      paintRow(r, t, i);
    });
  };
  const paintInfo = () => {
    const taps = getTaps(), h = hiddenTapCount(taps);
    info.hidden = h === 0; info.textContent = h ? `${h} weitere Tap(s) bleiben gespeichert, klingen aber nicht (höchstens ${DELAY_TAPS_MAX_BUILD} Taps).` : '';
    addBtn.disabled = !canAddTap(taps);
  };
  addBtn.addEventListener('click', () => {
    if (!canAddTap(getTaps())) return;
    commit(addTap(getTaps())); buildRows(); paintInfo();
    live.textContent = `Tap ${getTaps().length} hinzugefügt`;
    emitUserEvent(root, 'input');
    rows[rows.length - 1]?.time.focus();
  });

  const sync = () => { buildRows(); paintInfo(); };
  return { root, sync };
}
