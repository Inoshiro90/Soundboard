/**
 * ambient/ambient-volume.js — reine Hilfsfunktionen für die Ambient-Lautstärkevarianz
 *
 * Bewusst ohne Imports (keine Zirkelbezüge): wird von storage/normalization.js,
 * ambient-model.js, ambient-playback.js, ambient-render.js und den Modal-Skripten genutzt.
 *
 * Datenmodell pro Ambient-Track (alle Werte im selben 0…1-Maßstab wie `vol`):
 *   volumeMode: 'constant' | 'varying'   (Default 'constant' → bisheriges Verhalten)
 *   volumeMin / volumeMax                (nur bei 'varying' wirksam, immer min ≤ max)
 */

export const VOLUME_MODE_CONSTANT = 'constant';
export const VOLUME_MODE_VARYING  = 'varying';

const _r2 = v => Math.round(v * 100) / 100;

function _unit(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * Begrenzt min/max auf 0…1, ersetzt ungültige Werte (NaN/Infinity/undefined) durch
 * `fallback` und vertauscht sie, falls min > max. Ergebnis auf 2 Nachkommastellen gerundet.
 */
export function normalizeVolumeRange(min, max, fallback = { min: 0.5, max: 1 }) {
  const fbMin = _unit(fallback?.min, 0.5);
  const fbMax = _unit(fallback?.max, 1);
  let a = _unit(min, fbMin);
  let b = _unit(max, fbMax);
  if (a > b) [a, b] = [b, a];
  return { min: _r2(a), max: _r2(b) };
}

/**
 * Liefert die gültige Lautstärkevarianz-Konfiguration eines (ggf. unvollständigen oder
 * importierten) Tracks, ohne ihn zu verändern. Fehlende min/max-Werte leiten sich aus
 * `vol` ab (max = vol, min = halbe vol) — ein späteres Umschalten auf „Variierend"
 * wird dadurch nie lauter als die bisher eingestellte Lautstärke.
 */
export function getAmbientVolumeConfig(t) {
  const vol = _unit(t?.vol, 0.7);
  const r = normalizeVolumeRange(t?.volumeMin, t?.volumeMax, { min: vol * 0.5, max: vol });
  return { mode: t?.volumeMode === VOLUME_MODE_VARYING ? VOLUME_MODE_VARYING : VOLUME_MODE_CONSTANT, min: r.min, max: r.max };
}

/** Schreibt die normalisierten Felder in den Track (Migration/Normalisierung). `vol` bleibt unberührt. */
export function normalizeAmbientVolumeFields(t) {
  const c = getAmbientVolumeConfig(t);
  t.volumeMode = c.mode;
  t.volumeMin  = c.min;
  t.volumeMax  = c.max;
  return t;
}

/** Gleichverteilter Zufallswert in [min, max]; bei min === max exakt dieser Wert. */
export function pickRandomVolume(min, max) {
  if (!(max > min)) return min;
  return Math.max(min, Math.min(max, min + Math.random() * (max - min)));
}
