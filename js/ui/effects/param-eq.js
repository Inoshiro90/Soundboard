/**
 * ui/effects/param-eq.js — Bandtabelle des Parametrischen EQ (Phase 10d).
 * ---------------------------------------------------------------------------------------------------------------------
 * Je Band eine Tabellenzeile: Schalter „aktiv“, Typ, Frequenz (Hz), Gain (dB), Q, Entfernen. Dazu „Band hinzufügen“ (höchstens 8) und
 * „Reset“ (alle Gains auf 0) im Kartenkopf. Bewusst eine ZAHLENTABELLE statt Ziehen (Zahlfeld + Pfeiltasten, Touch-tauglich, Screenreader-
 * freundlich); eine Frequenzgangkurve ist ein eigener Folgeschritt.
 *
 * Zustand liegt im Aufrufer (`getBands`/`setBands`, siehe module-card.js/effect-editor.js); das DOM ist nur Ansicht. Datenform je Band:
 * `{ on, type, freq, gain, Q }` (+ unbekannte Felder, die erhalten bleiben). Änderungen laufen immer über `patchBand`, also über
 * dieselbe Normalisierung wie beim Laden (schema.js `normalizePeqBand`) — ungültige Eingaben werden geklemmt, nie gespeichert.
 *
 * Die reinen Modellfunktionen (oben) brauchen kein DOM und sind in Node getestet; `createParamEqControl` ist Browser-Code.
 */
import { PEQ_TYPES, PEQ_TYPE_LABELS, PEQ_MAX_BUILD, PEQ_RANGES, peqGainUsed, peqQUsed } from '../../audio/engine/registry.js';
import { normalizePeqBand } from '../../audio/engine/schema.js';
import { el, emitUserEvent } from './controls.js';

/** Neues Band (Glocke, 1 kHz, 0 dB). */
export const newBand = () => normalizePeqBand({ type: 'bell', freq: 1000, gain: 0, Q: 1 });
/** Band anhängen, solange weniger als PEQ_MAX_BUILD Bänder existieren; sonst unverändert. */
export const addBand = bands => (bands.length >= PEQ_MAX_BUILD ? bands : [...bands, newBand()]);
export const removeBand = (bands, i) => bands.filter((_, k) => k !== i);
/** Felder eines Bandes ändern; normalisiert (klemmt) und behält unbekannte Felder. Außerhalb liegender Index → unverändert. */
export const patchBand = (bands, i, patch) => (i >= 0 && i < bands.length ? bands.map((b, k) => (k === i ? normalizePeqBand({ ...b, ...patch }) : b)) : bands);
/** Alle Gains auf 0 (Typ, Frequenz, Q, an/aus bleiben). */
export const resetGains = bands => bands.map(b => ({ ...b, gain: 0 }));
export const canAdd = bands => bands.length < PEQ_MAX_BUILD;
/** Anzahl der Bänder jenseits der gebauten (bleiben in den Daten, klingen nicht). */
export const hiddenCount = bands => Math.max(0, bands.length - PEQ_MAX_BUILD);
/** Text für Screenreader / Zeilenbeschriftung. */
export const freqSpoken = f => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);
export const bandName = (b, i) => `Band ${i + 1}: ${PEQ_TYPE_LABELS[b.type] || b.type}, ${freqSpoken(b.freq)}`;

/**
 * @param {{idBase:string, moduleLabel:string, getBands:()=>Array, setBands:(b:Array)=>void}} o
 * @returns {{root:HTMLElement, sync:()=>void, headExtra:HTMLElement}}
 */
export function createParamEqControl({ idBase, moduleLabel, getBands, setBands }) {
  const root = el('div', 'fx-peq');
  const wrap = el('div', 'fx-peq__wrap');
  const table = el('table', 'fx-peq__table');
  const cap = el('caption', 'fx-sr-only'); cap.textContent = `${moduleLabel}: Bänder`;
  const thead = el('thead'), hr = el('tr');
  for (const [txt, cls] of [['Aktiv', 'fx-peq__c-on'], ['Typ', 'fx-peq__c-type'], ['Frequenz (Hz)', ''], ['Gain (dB)', ''], ['Q', ''], ['Entfernen', 'fx-peq__c-del']]) {
    const th = el('th', cls, { scope: 'col' }); th.textContent = txt; hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = el('tbody');
  table.append(cap, thead, tbody); wrap.appendChild(table);
  const info = el('p', 'fx-card__note', { hidden: true });          // Hinweis auf nicht gebaute Bänder
  const live = el('p', 'fx-sr-only', { role: 'status', 'aria-live': 'polite' });
  root.append(wrap, info, live);

  let rows = [];
  const commit = next => { setBands(next); };
  const patch = (i, p) => { const next = patchBand(getBands(), i, p); commit(next); return next[i]; };
  const num = (id, label, min, max, step, value) => el('input', 'fx-peq__num', { type: 'number', id, min, max, step, value, inputmode: 'decimal', 'aria-label': label });

  const paintRow = (r, b, i) => {
    r.on.checked = b.on !== false; r.type.value = b.type;
    r.freq.value = String(b.freq); r.gain.value = String(b.gain); r.q.value = String(b.Q);
    r.gain.disabled = !peqGainUsed(b.type); r.q.disabled = !peqQUsed(b.type);
    r.tr.classList.toggle('is-off', b.on === false);
    const n = bandName(b, i);
    r.on.setAttribute('aria-label', `${n} aktiv`); r.type.setAttribute('aria-label', `Band ${i + 1} Typ`);
    r.freq.setAttribute('aria-label', `${n} Frequenz in Hertz`); r.gain.setAttribute('aria-label', `${n} Gain in Dezibel`);
    r.q.setAttribute('aria-label', `${n} Q`); r.del.setAttribute('aria-label', `${n} entfernen`);
  };

  const buildRows = () => {
    tbody.textContent = ''; rows = [];
    getBands().forEach((b, i) => {
      const tr = el('tr', 'fx-peq__row');
      const on = el('input', null, { type: 'checkbox', id: `${idBase}-on-${i}` });
      const type = el('select', 'fx-peq__type', { id: `${idBase}-type-${i}` });
      for (const t of PEQ_TYPES) { const o = el('option', null, { value: t }); o.textContent = PEQ_TYPE_LABELS[t]; type.appendChild(o); }
      const freq = num(`${idBase}-freq-${i}`, '', PEQ_RANGES.freq[0], PEQ_RANGES.freq[1], 1, b.freq);
      const gain = num(`${idBase}-gain-${i}`, '', PEQ_RANGES.gain[0], PEQ_RANGES.gain[1], 0.5, b.gain);
      const q = num(`${idBase}-q-${i}`, '', PEQ_RANGES.Q[0], PEQ_RANGES.Q[1], 0.1, b.Q);
      const del = el('button', 'btn btn--sm btn--ghost fx-peq__del', { type: 'button', id: `${idBase}-del-${i}` }); del.textContent = '✕';
      const cells = [['fx-peq__c-on', on], ['fx-peq__c-type', type], ['', freq], ['', gain], ['', q], ['fx-peq__c-del', del]];
      for (const [cls, node] of cells) { const td = el('td', cls || null); td.appendChild(node); tr.appendChild(td); }
      tbody.appendChild(tr);
      const r = { tr, on, type, freq, gain, q, del }; rows.push(r);

      // Echte Eingaben (isTrusted) erreichen den Vorschau-Hook des Formulars selbst; hier nur den Zustand setzen und die Zeile nachzeichnen.
      const apply = p => { const nb = patch(i, p); paintRow(r, nb, i); };
      on.addEventListener('change', () => apply({ on: on.checked }));
      type.addEventListener('change', () => apply({ type: type.value }));
      const readNum = (input, key) => () => { const v = parseFloat(input.value); if (Number.isFinite(v)) patch(i, { [key]: v }); };
      const settle = (input, key) => () => { const v = parseFloat(input.value); apply({ [key]: Number.isFinite(v) ? v : getBands()[i][key] }); };   // beim Verlassen klemmen/zurücksetzen
      for (const [input, key] of [[freq, 'freq'], [gain, 'gain'], [q, 'Q']]) {
        input.addEventListener('input', e => { if (!e.fxUser) readNum(input, key)(); });
        input.addEventListener('change', settle(input, key));
      }
      del.addEventListener('click', () => {
        const name = bandName(getBands()[i], i);
        commit(removeBand(getBands(), i)); buildRows(); paintInfo(); live.textContent = `${name} entfernt`;
        emitUserEvent(root, 'input');
        (tbody.querySelector('select') || addBtn).focus?.();
      });
      paintRow(r, b, i);
    });
  };
  const paintInfo = () => {
    const bands = getBands(), h = hiddenCount(bands);
    info.hidden = h === 0; info.textContent = h ? `${h} weitere Band/Bänder bleiben gespeichert, klingen aber nicht (höchstens ${PEQ_MAX_BUILD} Bänder).` : '';
    addBtn.disabled = !canAdd(bands);
  };

  const headExtra = el('span', 'fx-peq__head');
  const addBtn = el('button', 'btn btn--sm btn--ghost fx-peq__add', { type: 'button', 'aria-label': `${moduleLabel}: Band hinzufügen` }); addBtn.textContent = '+ Band';
  const resetBtn = el('button', 'btn btn--sm btn--ghost fx-eq10-reset', { type: 'button', 'aria-label': `${moduleLabel} zurücksetzen (alle Gains auf 0)` }); resetBtn.textContent = 'Reset';
  headExtra.append(addBtn, resetBtn);
  addBtn.addEventListener('click', () => {
    if (!canAdd(getBands())) return;
    commit(addBand(getBands())); buildRows(); paintInfo();
    live.textContent = `Band ${getBands().length} hinzugefügt`;
    emitUserEvent(root, 'input');
    rows[rows.length - 1]?.type.focus();
  });
  resetBtn.addEventListener('click', () => { commit(resetGains(getBands())); sync(); emitUserEvent(root, 'input'); });

  const sync = () => { buildRows(); paintInfo(); };
  return { root, sync, headExtra };
}
