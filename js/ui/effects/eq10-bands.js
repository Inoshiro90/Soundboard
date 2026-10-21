/**
 * ui/effects/eq10-bands.js — Spezialcontrol des 10-Band-EQ (Phase 8): je Band ein senkrechter Gain-Regler und ein Q-Regler.
 * ---------------------------------------------------------------------------------------------------------------------
 * Darstellung/Klassen wie im bisherigen Formular (`fx-eq10-grid`, `eq10-band…` in css/components/effects-panel.css), damit Layout und
 * Container-Query unverändert bleiben. Die Mittenfrequenzen sind fest (EQ10_FREQS; frei wählbar erst mit P10).
 *
 * Datenform je Band (wie schema.js/Engine): reine Gain-Zahl (Built-ins) ODER `{ gain, freq?, Q? }`.
 *  • Laden → Auslesen ohne Bedienung ändert nichts (Zahl bleibt Zahl).
 *  • Gain bedienen: Zahl bleibt Zahl, Objekt behält `freq`/`Q`.   • Q bedienen: aus der Zahl wird `{ gain, Q }`.
 *  • Eine eigene Bandfrequenz (`freq`) bleibt erhalten. Das alte Formular überschrieb sie beim Auslesen mit der Standardfrequenz.
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

  const update = (i, patch) => { const b = getBands().slice(); b[i] = patch(b[i]); setBands(b); return b[i]; };
  const paint = (i, b) => {
    const g = bandGain(b), q = bandQ(b), e = bandsEls[i];
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
    bandsEls.push({ gain, q, gv, qv });

    // Künstliche Nutzeraktionen (fxUser) haben den Zustand schon gesetzt → hier nicht noch einmal aus dem Regler lesen.
    gain.addEventListener('input', e => { if (e.fxUser) return; paint(i, update(i, b => withGain(b, parseFloat(gain.value)))); });
    q.addEventListener('input', e => { if (e.fxUser) return; paint(i, update(i, b => withQ(b, parseFloat(q.value)))); });
    // Doppelklick = Standardwert (Gain 0 / Q 1,4); künstliches Ereignis mit fxUser (siehe controls.js)
    gain.addEventListener('dblclick', () => { paint(i, update(i, b => withGain(b, 0))); emitUserEvent(gain, 'input'); });
    q.addEventListener('dblclick', () => { paint(i, update(i, b => withQ(b, qUi.def))); emitUserEvent(q, 'input'); });
  });

  const sync = () => getBands().forEach((b, i) => paint(i, b));

  const headExtra = el('button', 'btn btn--sm btn--ghost fx-eq10-reset', { type: 'button', 'aria-label': `${moduleLabel} zurücksetzen` });
  headExtra.textContent = 'Reset';
  headExtra.addEventListener('click', () => { setBands(resetBands(getBands())); sync(); emitUserEvent(headExtra, 'input'); });

  return { root, sync, headExtra };
}
