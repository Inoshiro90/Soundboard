/**
 * ui/effects/eq10-bands.js — Spezialcontrol des 10-Band-EQ (Phase 8): je Band ein senkrechter Gain-Regler und ein Q-Regler.
 * ---------------------------------------------------------------------------------------------------------------------
 * Darstellung/Klassen wie im bisherigen Formular (`fx-eq10-grid`, `eq10-band…` in css/components/effects-panel.css), damit Layout und
 * Container-Query unverändert bleiben. Die Mittenfrequenzen sind ab P10e frei wählbar: unterhalb des Rasters liegt ein einklappbarer
 * Bereich „Frequenzen“ mit je einem Zahlfeld (20…20 000 Hz) je Band; Standard bleibt EQ10_FREQS.
 *
 * Datenform je Band (wie schema.js/Engine): reine Gain-Zahl (Built-ins) ODER `{ gain, freq?, Q? }`.
 *  • Laden → Auslesen ohne Bedienung ändert nichts (Zahl bleibt Zahl).
 *  • Gain bedienen: Zahl bleibt Zahl, Objekt behält `freq`/`Q`.   • Q bedienen: aus der Zahl wird `{ gain, Q }`.
 *  • Eine eigene Bandfrequenz (`freq`) bleibt erhalten. Das alte Formular überschrieb sie beim Auslesen mit der Standardfrequenz.
 *  • Frequenz bedienen (P10e): ein Wert ≠ Standardfrequenz schreibt `freq` (aus einer Zahl wird `{ gain, freq }`); ein Wert = Standardfrequenz
 *    entfernt `freq` wieder (hat das Objekt dann nur `gain`, wird es wieder die reine Zahl) — Daten bleiben so kompakt wie bisher.
 * Die reinen Modell-Funktionen (oben) brauchen kein DOM und sind in Node getestet; `createBandsControl` ist Browser-Code.
 */
import { EQ10_FREQS } from '../../audio/effect-graph.js';
import { el, emitUserEvent } from './controls.js';

export const Q_DEFAULT = 1.4;

const isObj = b => typeof b === 'object' && b !== null;
export const bandGain = b => (isObj(b) ? (b.gain ?? 0) : (b ?? 0));
export const bandQ = b => (isObj(b) && b.Q ? b.Q : Q_DEFAULT);
/** Gain setzen: Zahl bleibt Zahl, Objekt behält seine übrigen Felder. */
export const withGain = (b, gain) => (isObj(b) ? { ...b, gain } : gain);
/** Q setzen: aus einer Zahl wird { gain, Q }. */
export const withQ = (b, Q) => (isObj(b) ? { ...b, Q } : { gain: b ?? 0, Q });
/** Ein Band zurücksetzen (Gain 0, Q Standard); eine eigene Frequenz bleibt. */
export const resetBand = b => (isObj(b) && b.freq != null ? { gain: 0, freq: b.freq } : 0);
export const resetBands = bands => bands.map(resetBand);
export const FREQ_RANGE = [20, 20000];
/** Wirksame Bandfrequenz (eigene oder Standard). */
export const bandFreq = (b, i) => (isObj(b) && b.freq ? b.freq : EQ10_FREQS[i]);
/** Frequenz setzen (geklemmt, ganze Hz). Standardfrequenz entfernt das Feld; ungültige Eingabe lässt das Band unverändert. */
export const withFreq = (b, f, i) => {
  if (!Number.isFinite(f)) return b;
  const v = Math.max(FREQ_RANGE[0], Math.min(FREQ_RANGE[1], Math.round(f)));
  if (v === EQ10_FREQS[i]) {
    if (!isObj(b)) return b ?? 0;
    const { freq, ...rest } = b;                    // eslint-disable-line no-unused-vars
    const keys = Object.keys(rest);
    return keys.length === 1 && keys[0] === 'gain' ? rest.gain : rest;
  }
  return isObj(b) ? { ...b, freq: v } : { gain: b ?? 0, freq: v };
};
/** Alle Frequenzen auf den Standard (Gain und Q bleiben). */
export const resetFreqs = bands => bands.map((b, i) => withFreq(b, EQ10_FREQS[i], i));
/** „1k“ / „31“ (sichtbar) und „1 kHz“ / „31 Hz“ (Screenreader). */
export const freqText = f => (f >= 1000 ? f / 1000 + 'k' : String(f));
export const freqSpoken = f => (f >= 1000 ? f / 1000 + ' kHz' : f + ' Hz');
export const gainText = g => (g >= 0 ? '+' : '') + g.toFixed(0);
export const qText = q => 'Q' + q.toFixed(1);

/**
 * @param {{idBase:string, moduleLabel:string, spec:object, getBands:()=>Array, setBands:(b:Array)=>void}} o
 * @returns {{root:HTMLElement, sync:()=>void, headExtra:HTMLElement}}
 */
export function createBandsControl({ idBase, moduleLabel, spec, getBands, setBands }) {
  const gUi = spec.ui?.gain, qUi = spec.ui?.q;
  if (!gUi || !qUi) throw new Error('Effekt-UI: bands braucht ui.gain und ui.q');
  const root = el('div', 'fx-eq10-grid');
  const bandsEls = [];
  // einklappbarer Bereich „Frequenzen“ (P10e), vom Modulkarten-Code hinter dem Raster eingehängt
  const after = el('details', 'fx-eq10-freqs');
  const sum = el('summary'); sum.textContent = 'Frequenzen anpassen';
  const freqsBody = el('div', 'fx-eq10-freqs__body');
  const freqReset = el('button', 'btn btn--sm btn--ghost fx-eq10-freqs__reset', { type: 'button', 'aria-label': `${moduleLabel}: Frequenzen auf Standard zurücksetzen` }); freqReset.textContent = 'Standard';
  after.append(sum, freqsBody);

  const update = (i, patch) => { const b = getBands().slice(); b[i] = patch(b[i]); setBands(b); return b[i]; };
  const paint = (i, b, typing = false) => {          // typing: Frequenzfeld nicht überschreiben, während getippt wird
    const g = bandGain(b), q = bandQ(b), e = bandsEls[i], f = bandFreq(b, i);
    e.fr.textContent = freqText(f); if (!typing) e.fin.value = String(f);
    e.gain.setAttribute('aria-label', `${moduleLabel}: ${freqSpoken(f)} Gain`); e.q.setAttribute('aria-label', `${moduleLabel}: ${freqSpoken(f)} Q (Bandbreite)`);
    e.gain.value = String(g); e.gv.textContent = gainText(g); e.gain.setAttribute('aria-valuetext', gainText(g) + ' dB');
    e.q.value = String(q);    e.qv.textContent = qText(q);    e.q.setAttribute('aria-valuetext', 'Q ' + q.toFixed(1));
  };

  EQ10_FREQS.forEach((f, i) => {
    const band = el('div', 'eq10-band');
    const gv = el('span', 'eq10-band__gain-value', { 'aria-hidden': 'true' });
    const gw = el('div', 'eq10-gain-wrap');
    const gain = el('input', 'eq10-band__gain', { type: 'range', id: `${idBase}-gain-${i}`, min: gUi.min, max: gUi.max, step: gUi.step, 'aria-label': `${moduleLabel}: ${freqSpoken(f)} Gain` });
    gw.appendChild(gain);
    const fr = el('span', 'eq10-band__freq'); fr.textContent = freqText(f);
    const dv = el('div', 'eq10-band__divider', { 'aria-hidden': 'true' });
    const qw = el('div', 'eq10-q-wrap');
    const q = el('input', 'eq10-band__q', { type: 'range', id: `${idBase}-q-${i}`, min: qUi.min, max: qUi.max, step: qUi.step, 'aria-label': `${moduleLabel}: ${freqSpoken(f)} Q (Bandbreite)` });
    qw.appendChild(q);
    const qv = el('span', 'eq10-band__q-value', { 'aria-hidden': 'true' });
    band.append(gv, gw, fr, dv, qw, qv); root.appendChild(band);
    const fin = el('input', 'fx-eq10-freqs__num', { type: 'number', id: `${idBase}-freq-${i}`, min: FREQ_RANGE[0], max: FREQ_RANGE[1], step: 1, inputmode: 'numeric', 'aria-label': `${moduleLabel}: Band ${i + 1} Frequenz in Hertz` });
    const flab = el('label', 'fx-eq10-freqs__item', { for: fin.id }); const fnum = el('span', 'fx-eq10-freqs__n'); fnum.textContent = String(i + 1); flab.append(fnum, fin); freqsBody.appendChild(flab);
    bandsEls.push({ gain, q, gv, qv, fr, fin });
    fin.addEventListener('input', e => { if (e.fxUser) return; const v = parseFloat(fin.value); if (Number.isFinite(v)) paint(i, update(i, b => withFreq(b, v, i)), true); });
    fin.addEventListener('change', () => { const v = parseFloat(fin.value); paint(i, update(i, b => (Number.isFinite(v) ? withFreq(b, v, i) : b))); });

    // Künstliche Nutzeraktionen (fxUser) haben den Zustand schon gesetzt → hier nicht noch einmal aus dem Regler lesen.
    gain.addEventListener('input', e => { if (e.fxUser) return; paint(i, update(i, b => withGain(b, parseFloat(gain.value)))); });
    q.addEventListener('input', e => { if (e.fxUser) return; paint(i, update(i, b => withQ(b, parseFloat(q.value)))); });
    // Doppelklick = Standardwert (Gain 0 / Q 1,4); künstliches Ereignis mit fxUser (siehe controls.js)
    gain.addEventListener('dblclick', () => { paint(i, update(i, b => withGain(b, 0))); emitUserEvent(gain, 'input'); });
    q.addEventListener('dblclick', () => { paint(i, update(i, b => withQ(b, qUi.def))); emitUserEvent(q, 'input'); });
  });

  const sync = () => getBands().forEach((b, i) => paint(i, b));
  freqReset.addEventListener('click', () => { setBands(resetFreqs(getBands())); sync(); emitUserEvent(freqReset, 'input'); });
  after.appendChild(freqReset);

  const headExtra = el('button', 'btn btn--sm btn--ghost fx-eq10-reset', { type: 'button', 'aria-label': `${moduleLabel} zurücksetzen` });
  headExtra.textContent = 'Reset';
  headExtra.addEventListener('click', () => { setBands(resetBands(getBands())); sync(); emitUserEvent(headExtra, 'input'); });

  return { root, sync, headExtra, after };
}
