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
 * Rastung (K2): Lineare Regler mit höchstens DETENT_MAX_STOPS Stufen (z. B. Chorus-Stimmen, Phaser-Stufen, Halbtöne) rasten auch mit dem
 * Schieber ein: `ui.detents` = Anzahl der Stufen, der Schieber springt beim Ziehen auf `toPos(snapValue(…))`. Werte aus Daten bleiben unangetastet.
 *
 * Abgestuftes Raster (Phase 21e, `ui.grid`): Liste von Bändern `[{ below, step }, …, { step }]` (aufsteigend, das letzte ohne `below`). Für einen
 * Wert gilt das erste Band mit Wert < below. Nutzeraktionen (Ziehen, Tasten) runden auf das absolute Raster dieses Bands (linear und log); Anzeige
 * und `aria-valuetext` zeigen so viele Nachkommastellen wie die Schrittweite des Bands (z. B. Sekunden: unter 1 s 0,05 → „0,35“, ab 5 s 0,5 → „5,5“).
 * Getippte Zahlen werden auf diese Nachkommastellen gerundet (nicht aufs Raster). Bandgrenzen müssen Vielfache aller Schrittweiten sein.
 * Werte aus Daten/Presets bleiben unangetastet (ein gespeicherter Wert 5,75 bleibt 5,75; die Anzeige rundet auf „5,8“).
 *
 * UI-Bereich (`spec.ui`) ≠ Datenbereich (`spec.range`): Option b (Phase 8) bildet die Bereiche des alten Formulars ab, z. B.
 * Tiefpass 100–20000 Hz im Regler, 20–20000 Hz in den Daten. Ein Datenwert außerhalb des Reglerbereichs bleibt erhalten.
 */

export const POS_MAX = 1000;
/** K2: Ab wie vielen Stufen ein linearer Regler NICHT mehr einrastet (darüber wirkt er stufenlos). */
export const DETENT_MAX_STOPS = 25;

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
 * `spec.ui = { hidden?, min?, max?, step?, scale?, digits?, grid?, fineDigits?, percent?, display?, signed?, unit?, options? }`; fehlende Angaben werden aus `spec.range` abgeleitet.
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
  const grid = normalizeGrid(u.grid);
  const step = grid ? grid[0].step : (u.step ?? (span <= 2 ? 0.01 : span <= 20 ? 0.1 : 1));
  const digits = grid ? Math.max(...grid.map(b => decimalsOf(b.step))) : (u.digits ?? decimalsOf(step));
  // `ui.fineDigits` (Phase 21e): feinste Datenauflösung festschreiben — Makros runden ihre Zielwerte darauf (engine/macros.js); ein neues Raster
  // darf diese Rundung nicht verschieben (Invariante 4).
  const fineDigits = u.fineDigits ?? (scale === 'log' ? digits : Math.max(digits, decimalsOf(step / 10)));
  const percent = !!u.percent;
  const factor = percent ? 100 : (u.display?.factor ?? 1);
  if (!(factor > 0)) throw new Error('Ungültiger Anzeigefaktor');
  const dispDigits = Math.max(0, fineDigits - Math.round(Math.log10(factor)));   // Nachkommastellen der ANZEIGE (Daten 0,001 → „0,1 %“)
  const unit = percent ? '%' : (u.display?.unit ?? u.unit ?? spec.unit ?? '');
  // K2: Anzahl der Raststufen (0 = stufenlos). Nur linear und nur, wenn der Bereich ein ganzzahliges Vielfaches des Rasters ist.
  const intervals = span / step, whole = Math.round(intervals);
  const detents = !grid && scale === 'lin' && Math.abs(intervals - whole) < 1e-9 && whole + 1 <= DETENT_MAX_STOPS ? whole + 1 : 0;
  return { hidden: false, min, max, step, scale, digits, fineDigits, percent, factor, dispDigits, unit, signed: !!u.signed, label: spec.label || '', detents, grid };
}

/** Prüft und kopiert `ui.grid` (Phase 21e); ohne Raster `null`. */
function normalizeGrid(g) {
  if (g == null) return null;
  if (!Array.isArray(g) || !g.length) throw new Error('Ungültiges Raster');
  const out = g.map((b, i) => {
    const last = i === g.length - 1;
    if (!(b?.step > 0) || (last ? b.below != null : !(b.below > 0))) throw new Error('Ungültiges Rasterband');
    return last ? { step: b.step } : { below: b.below, step: b.step };
  });
  for (let i = 0; i < out.length - 1; i++) {
    if (i && !(out[i].below > out[i - 1].below)) throw new Error('Rasterbänder nicht aufsteigend');
    for (const b of out) { const r = out[i].below / b.step; if (Math.abs(r - Math.round(r)) > 1e-9) throw new Error('Rastergrenze kein Vielfaches der Schrittweite'); }
  }
  return out;
}

/** Schrittweite des Rasterbands für v (ohne Raster: `ui.step`). `dir` < 0: Band knapp unterhalb von v (Schritt abwärts über eine Bandgrenze). */
export function gridStepAt(ui, v, dir = 0) {
  if (!ui.grid) return ui.step;
  const x = dir < 0 ? v - 1e-9 * Math.max(1, Math.abs(v)) : v;
  for (const b of ui.grid) if (b.below === undefined || x < b.below) return b.step;
  return ui.grid[ui.grid.length - 1].step;
}
/** Nachkommastellen der Anzeige für v (mit Raster je Band, sonst fest). */
const dispDigitsAt = (ui, v) => ui.grid ? Math.max(0, decimalsOf(gridStepAt(ui, v)) - Math.round(Math.log10(ui.factor))) : ui.dispDigits;

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

/** K2: Schieberposition beim Ziehen. Rastende Regler (`ui.detents`) springen auf die Position des gerundeten Werts, sonst bleibt `pos`. */
export function dragPos(ui, pos, value) {
  return ui.detents ? toPos(ui, value) : pos;
}

/** Rundet einen Wert für eine Nutzeraktion: linear aufs Raster (ab `min`), log auf `digits`; immer im UI-Bereich.
 *  Ist `min` kein Vielfaches von `step` (Kompressor-Attack: min 0,0001, Schritt 0,001), landet das Ergebnis durch die Rundung auf die
 *  Datenstellen auf dem absoluten Raster (ganze Millisekunden) — das ist gewollt; nur der untere Rand bleibt `min`. */
export function snapValue(ui, v, fine = false) {
  const x = clampUi(ui, v);
  if (ui.grid) {
    const s = gridStepAt(ui, x) / (fine && ui.scale === 'lin' ? 10 : 1);
    return clampUi(ui, roundTo(Math.round(x / s) * s, decimalsOf(s)));
  }
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
    if (next === cur) {
      const u = ui.grid ? gridStepAt(ui, cur, dir) : 10 ** -ui.digits;
      next = ui.grid ? snapValue(ui, cur + dir * u) : clampUi(ui, roundTo(cur + dir * u, ui.digits));
    }
  } else {
    const st = gridStepAt(ui, cur, dir), base = (fine ? st / 10 : st) * (page ? 10 : 1);
    next = snapValue(ui, cur + dir * base, fine);
    if (next === cur) next = snapValue(ui, cur + dir * base * 1.5, fine);
  }
  return next;
}

/** Datenwert → Zahl der Anzeige (Prozent: ×100). */
export const toDisplay = (ui, v) => roundTo(v * ui.factor, dispDigitsAt(ui, v));
/** Zahl der Anzeige → Datenwert, auf die feinste Datenauflösung gerundet (mit Raster: auf die Nachkommastellen des Bands). */
export const fromDisplay = (ui, x) => {
  const v = x / ui.factor;
  return ui.grid ? roundTo(v, decimalsOf(gridStepAt(ui, v))) : roundTo(v, ui.fineDigits);
};

/** Anzeige im Zahlfeld (ohne Einheit), ohne überflüssige Nullen. */
export const formatNumber = (ui, v) => String(toDisplay(ui, v));

/** Text für `aria-valuetext`, z. B. „440 Hz“, „30 %“, „+3 dB“, „12:1“ (Einheiten mit „:“ ohne Leerzeichen). */
export const formatValueText = (ui, v) => {
  const x = toDisplay(ui, v);
  return (ui.signed && x > 0 ? '+' : '') + String(x) + (ui.unit ? (ui.unit.startsWith(':') ? '' : ' ') + ui.unit : '');
};
