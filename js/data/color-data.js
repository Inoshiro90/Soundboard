/**
 * data/color-data.js — Akzent-/Kachelfarben-Palette und Anzeige-Namen
 * Ausgelagert aus state.js (Phase 1 der Refaktorierung).
 */

/**
 * Accent/tile-background colour options.
 * Prompt 1 (Farbsystem): 20 feste Farben + 'none'. 'none' ist ein eigener
 * Zustand für "keine Akzentfarbe" und zählt nicht zu den 20 Farben.
 * Reihenfolge ist bewusst so gewählt, wie sie im Picker erscheinen soll.
 */
export const COLORS = [
  'none',
  '#1abc9c', '#16a085', '#2ecc71', '#27ae60',
  '#3498db', '#2980b9', '#9b59b6', '#8e44ad',
  '#34495e', '#2c3e50', '#f1c40f', '#f39c12',
  '#e67e22', '#d35400', '#e74c3c', '#c0392b',
  '#ecf0f1', '#bdc3c7', '#95a5a6', '#7f8c8d'
];

/**
 * Anzeige-Namen der Palette (Prompt 1, Kap. 1) — dienen als Metadaten für
 * `title`/ARIA-Label im Farbpicker (buildColorOpts() in ui/color-picker.js). Gespeichert
 * wird weiterhin ausschließlich der Hex-Wert; dieses Mapping ist rein
 * kosmetisch und niemals Teil des persistierten Datenmodells.
 */
export const COLOR_NAMES = {
  '#1abc9c': 'Turquoise',
  '#16a085': 'Green Sea',
  '#2ecc71': 'Emerald',
  '#27ae60': 'Nephritis',
  '#3498db': 'Peter River',
  '#2980b9': 'Belize Hole',
  '#9b59b6': 'Amethyst',
  '#8e44ad': 'Wisteria',
  '#34495e': 'Wet Asphalt',
  '#2c3e50': 'Midnight Blue',
  '#f1c40f': 'Sunflower',
  '#f39c12': 'Orange',
  '#e67e22': 'Carrot',
  '#d35400': 'Pumpkin',
  '#e74c3c': 'Alizarin',
  '#c0392b': 'Pomegranate',
  '#ecf0f1': 'Clouds',
  '#bdc3c7': 'Silver',
  '#95a5a6': 'Concrete',
  '#7f8c8d': 'Asbestos'
};
