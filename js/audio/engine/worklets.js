/**
 * audio/engine/worklets.js — Worklet-Registry (Phase 5, AE-06): die EINZIGE Liste der AudioWorklet-Module der App.
 * ----------------------------------------------------------------------------------------------------------
 * Getrennt von der Modul-Registry (registry.js), weil nicht jedes Worklet ein Effektmodul ist: `envfollower` ist ein
 * Steuersignal, `noise` eine Quelle. Effektmodule verweisen über `workletModules: [id]` hierher.
 *
 * Eintrag:
 *   url        Pfad relativ zur App-Wurzel (Browser: relativ zur Seite; Tests lösen über setWorkletUrlResolver() auf)
 *   processor  Name in registerProcessor()
 *   imports    true, wenn das Modul per `import` Hilfsmodule lädt (dsp-lib). Browserabhängig: Chrome/Firefox/Node [S],
 *              Safari/iOS offen [H]; scheitert addModule(), meldet ensureWorklets() `false` (kein Absturz).
 *   fallback   was der Aufrufer bei `false` tut: 'detune' (Pitch ändert dann das Tempo), 'none' (Quelle/Signal fehlt,
 *              Aufrufer überspringt den Baustein)
 *   cost       Kostenpunkte je Instanz (AE-13′). `measured:false` ⇒ noch NICHT gemessen (M-1-Methode, Suite 13);
 *              der Wert `null` heißt „unbekannt“, nicht „kostenlos“ (gilt für `noise`, nur Quelle). Pitch: Zahl steht in der Modul-Registry (pitchShift).
 */
import { MODULES } from './registry.js';

export const WORKLETS = {
  pitch: {
    url: './js/worklets/pitch-processor.js', processor: 'pitch-shifter-processor', imports: false, fallback: 'detune',
    cost: { base: null, measured: true, see: 'registry.pitchShift' }
  },
  noise: {
    url: './js/worklets/noise-generator-processor.js', processor: 'noise-generator-processor', imports: false, fallback: 'none',
    cost: { base: null, measured: false }
  },
  envfollower: {
    url: './js/worklets/envfollower.js', processor: 'envelope-follower-processor', imports: true, fallback: 'none',
    // M-1-Methode (Suite 13, 16 Instanzen, Punkte relativ zum Tiefpass): Chrome 155 ≈ 4,8; Firefox 158 ≈ 3,5 (Lauf überlappte mit
    // Chrome, Firefox-Timer ganzzahlig in ms → eher Obergrenze). Registry-Konvention: Maximum, aufgerundet. Noch kein Verbraucher.
    cost: { base: 5, measured: true }
  }
};

export const WORKLET_IDS = Object.keys(WORKLETS);

/** Worklet-IDs, die ein Effektmodul braucht (Feld `workletModules` in registry.js). */
export function workletsOfModule(key) {
  const m = MODULES.find(x => x.key === key);
  return m && Array.isArray(m.workletModules) ? m.workletModules.slice() : [];
}

/**
 * Worklets, die vor dem Bau eines Plans im Ziel-Context geladen sein müssen.
 * Verhalten wie bisher: nur Pitch (aktiv, Halbtöne ≠ 0) und nur, wenn das Ziel Worklets nutzt (caps.pitch === 'worklet').
 * Künftige Module (P10 ff.) ergänzen ihre Bedingung hier.
 */
export function workletsForPlan(plan, caps) {
  const ids = new Set();
  if (plan?.hasPitch && caps?.pitch === 'worklet') for (const id of workletsOfModule('pitchShift')) ids.add(id);
  return [...ids];
}
