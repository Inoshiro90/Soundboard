/**
 * ui/effects/control-math.js — Reine Rechenlogik der generierten Effekt-Regler (Phase 8). Kein DOM, kein Audio.
 * ----------------------------------------------------------------------------------------------------------
 * Der Schieberegler arbeitet immer in einer Positionsachse 0…1000 (POS_MAX). Linear: Position ↔ Wert proportional.
 * Logarithmisch (`scale:'log'`, für Frequenzen): Position ↔ Wert exponentiell. Der Wert wird bei Nutzeraktionen auf das
 * Raster `step` (linear) bzw. auf `digits` Nachkommastellen (log) gerundet; Werte aus Daten/Presets bleiben unangetastet.
 *
 * Anzeige-Umrechnung: `ui.percent` (Daten 0…1 → 0…100 %) bzw. `ui.display = { factor, unit }` (z. B. Sekunden → Millisekunden:
 * `{ factor: 1000, unit: 'ms' }`). Der Datenwert bleibt unverändert, nur Zahlfeld, Einheit und `aria-valuetext` rechnen um.
 * `ui.signed`: positive Werte mit „+“ im `aria-valuetext` (EQ-Gain, Halbtöne). `ui.unit`: Einheit überschreiben (z. B. „:1“).
 *
 * UI-Bereich (`spec.ui`) ≠ Datenbereich (`spec.range`): Option b (Phase 8) bildet die Bereiche des alten Formulars ab, z. B.
 * Tiefpass 100–20000 Hz im Regler, 20–20000 Hz in den Daten. Ein Datenwert außerhalb des Reglerbereichs bleibt erhalten.
 */

export const POS_MAX = 1000;

/** Anzahl Nachkommastellen von x (auch für 1e-7). */
export function decimalsOf(x) {
  if (!Number.isFinite(x) || Number.isInteger(x)) return 0;
  const [m, e] = String(x).split('e-');
  const frac = (m.split('.')[1] || '').length;
  return e ? Math.min(12, frac + parseInt(e, 10)) : frac;
}

const roundTo = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };

/**
 * Löst die UI-Beschreibung eines Registry-Parameters auf.
 * `spec.ui = { hidden?, min?, max?, step?, scale?, digits?, percent?, display?, signed?, unit?, options? }`; fehlende Angaben werden aus `spec.range` abgeleitet.
 * Rückgabe `{ hidden:true }` für nicht bediente Parameter (werden nur mitgeführt).
 */
export function resolveParamUi(spec) {
  const u = spec?.ui || {};
  if (u.hidden) return { hidden: true };
  const min = u.min ?? spec?.range?.[0], max = u.max ?? spec?.range?.[1];
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) throw new Error('Parameter ohne gültigen UI-Bereich');
  const span = max - min;
  const scale = u.scale === 'log' ? 'log' : 'lin';
  if (scale === 'log' && !(min > 0)) throw new Error('Logarithmische Skala braucht min > 0');
  const step = u.step ?? (span <= 2 ? 0.01 : span <= 20 ? 0.1 : 1);
  const digits = u.digits ?? decimalsOf(step);
  const fineDigits = scale === 'log' ? digits : Math.max(digits, decimalsOf(step / 10));
  const percent = !!u.percent;
  const factor = percent ? 100 : (u.display?.factor ?? 1);
  if (!(factor > 0)) throw new Error('Ungültiger Anzeigefaktor');
  const dispDigits = Math.max(0, fineDigits - Math.round(Math.log10(factor)));   // Nachkommastellen der ANZEIGE (Daten 0,001 → „0,1 %“)
  const unit = percent ? '%' : (u.display?.unit ?? u.unit ?? spec.unit ?? '');
  return { hidden: false, min, max, step, scale, digits, fineDigits, percent, factor, dispDigits, unit, signed: !!u.signed, label: spec.label || '' };
}

export const clampUi = (ui, v) => Math.min(ui.max, Math.max(ui.min, v));

/** Wert → Position 0…1000 (ganzzahlig). Werte außerhalb des Bereichs werden auf den Rand gelegt. */
export function toPos(ui, v) {
  const x = clampUi(ui, v);
  const p = ui.scale === 'log' ? Math.log(x / ui.min) / Math.log(ui.max / ui.min) : (x - ui.min) / (ui.max - ui.min);
  return Math.round(p * POS_MAX);
}

/** Position → roher (ungerundeter) Wert. */
export function fromPos(ui, pos) {
  const p = Math.min(POS_MAX, Math.max(0, pos)) / POS_MAX;
  return ui.scale === 'log' ? ui.min * (ui.max / ui.min) ** p : ui.min + p * (ui.max - ui.min);
}

/** Rundet einen Wert für eine Nutzeraktion: linear aufs Raster (ab `min`), log auf `digits`; immer im UI-Bereich.
 *  Ist `min` kein Vielfaches von `step` (Kompressor-Attack: min 0,0001, Schritt 0,001), landet das Ergebnis durch die Rundung auf die
 *  Datenstellen auf dem absoluten Raster (ganze Millisekunden) — das ist gewollt; nur der untere Rand bleibt `min`. */
export function snapValue(ui, v, fine = false) {
  const x = clampUi(ui, v);
  if (ui.scale === 'log') return clampUi(ui, roundTo(x, ui.digits));
  const s = fine ? ui.step / 10 : ui.step;
  const q = ui.min + Math.round((x - ui.min) / s) * s;
  return clampUi(ui, roundTo(q, Math.max(fine ? ui.fineDigits : ui.digits, decimalsOf(s))));
}

/**
 * Tastaturschritt. dir = +1/−1. `fine` (Shift): linear step/10, log 1 Positionsschritt. `page`: linear 10 × step, log 100 Positionsschritte.
 * Linear ohne Zusatz: ein `step`; log: 10 Positionsschritte (≈ 1 % der Skala). Bleibt der Wert stehen (Rundung), wird um die
 * kleinste Anzeigeeinheit weitergeschoben — der Regler „hängt“ nie.
 */
export function stepValue(ui, v, dir, { fine = false, page = false } = {}) {
  const cur = clampUi(ui, v);
  let next;
  if (ui.scale === 'log') {
    const ticks = page ? 100 : fine ? 1 : 10;
    next = snapValue(ui, fromPos(ui, toPos(ui, cur) + dir * ticks));
    if (next === cur) next = clampUi(ui, roundTo(cur + dir * 10 ** -ui.digits, ui.digits));
  } else {
    const base = (fine ? ui.step / 10 : ui.step) * (page ? 10 : 1);
    next = snapValue(ui, cur + dir * base, fine);
    if (next === cur) next = snapValue(ui, cur + dir * base * 1.5, fine);
  }
  return next;
}

/** Datenwert → Zahl der Anzeige (Prozent: ×100). */
export const toDisplay = (ui, v) => roundTo(v * ui.factor, ui.dispDigits);
/** Zahl der Anzeige → Datenwert, auf die feinste Datenauflösung gerundet. */
export const fromDisplay = (ui, x) => roundTo(x / ui.factor, ui.fineDigits);

/** Anzeige im Zahlfeld (ohne Einheit), ohne überflüssige Nullen. */
export const formatNumber = (ui, v) => String(toDisplay(ui, v));

/** Text für `aria-valuetext`, z. B. „440 Hz“, „30 %“, „+3 dB“, „12:1“ (Einheiten mit „:“ ohne Leerzeichen). */
export const formatValueText = (ui, v) => {
  const x = toDisplay(ui, v);
  return (ui.signed && x > 0 ? '+' : '') + String(x) + (ui.unit ? (ui.unit.startsWith(':') ? '' : ' ') + ui.unit : '');
};
