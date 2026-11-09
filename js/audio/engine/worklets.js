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
 *              Aufrufer überspringt den Baustein), 'native' (Aufrufer baut die bisherige native Näherung, P12c: Flanger mit B-14-Klemmung),
 *              'legacy' (P17b, Entscheidung E: Tonhöhe über das Legacy-Worklet `pitch`, ohne Mix; scheitert auch das: Detune)
 *   cost       Kostenpunkte je Instanz (AE-13′). `measured:false` ⇒ noch NICHT gemessen (M-1-Methode, Suite 13);
 *              der Wert `null` heißt „unbekannt“, nicht „kostenlos“ (gilt für `noise`, nur Quelle). Pitch: Zahl steht in der Modul-Registry (pitchShift).
 */
import { MODULES, pitchActive, pitchAlgorithm, reverbBuiltMode, delayMode, withBranchSteps } from './registry.js';

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
  },
  // P11a: Gate und Expander (Rechenkern dsp-lib/dynamics.js; weitere Modi — Limiter, Transient — folgen in 11b/11d).
  dynamics: {
    url: './js/worklets/dynamics.js', processor: 'dynamics-processor', imports: true, fallback: 'none',
    cost: { base: 5, measured: false, estimate: 'envfollower' }   // Schätzwert: gleiche Größenordnung wie der Hüllkurvenfolger; M-1 steht aus
  },
  // P12c: Kurzzeit-Verzögerung mit sample-genauer Rückkopplung (Flanger; P12d: Phaser). Rechenkern dsp-lib/delayline.js.
  // P21a: zweiter Prozessor `combbank-processor` (Kamm-Bank, dsp-lib/combbank.js) für `comb` (21a), `resonator` (21b) und `tunedResonator` (21c); ohne Worklet werden beide übersprungen (nicht 'native').
  delayline: {
    url: './js/worklets/delayline.js', processor: 'delayline-processor', imports: true, fallback: 'native',
    cost: { base: 7, measured: false, estimate: 'delayline' }   // Schätzwert (Hermite-Interpolation je Sample und Kanal); M-1 steht aus
  },
  // Phase 17b/17c: Tonhöhe v2 (Algorithmus `music` = Phasenvocoder, pitch-pv.js auf stft.js/fft.js; `voice` = WSOLA, pitch-wsola.js).
  stft: {
    url: './js/worklets/stft.js', processor: 'stft-pitch-processor', imports: true, fallback: 'legacy',
    cost: { base: null, measured: false, see: 'registry.pitchShift' }
  },
  // Phase 15c: Bitcrusher mit Sample-Rate-Reduktion (Rechenkern audio/dsp-lib/crusher.js); ohne Worklet native Quantisierung ohne Reduktion.
  crusher: {
    url: './js/worklets/crusher.js', processor: 'crusher-processor', imports: true, fallback: 'native',
    cost: { base: 3, measured: false, estimate: 'crusher' }     // Schätzwert (Sample-and-Hold + Quantisierung je Sample); M-1 steht aus
  },
  // Phase 20a (AE-09): Time-Buffer-Engine, ein Prozessor für Stutter, Beat Repeat, Retrigger, Reverse- und Granular-Delay
  // (Rechenkern audio/dsp-lib/timebuffer.js, Knoten engine/timebuffer-node.js). Ohne Worklet wird das Modul übersprungen.
  // Verbraucher: `stutter` (20b), `beatRepeat` (20c), `retrigger` (20d), Delay-Modi `reverse` (20e) und `granular` (20f), Bedingungen in workletsForPlan.
  timebuffer: {
    url: './js/worklets/timebuffer.js', processor: 'timebuffer-processor', imports: true, fallback: 'none',
    cost: { base: 6, measured: false, estimate: 'plan-p20' }    // Planwert (Kostenpunkt 6); M-1 im Browser steht aus (Suite 13, Fall timebuffer)
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
 * Pitch: aktiv laut registry.pitchActive, nur wenn das Ziel Worklets nutzt (caps.pitch === 'worklet'); das Worklet je Algorithmus.
 * Künftige Module (P10 ff.) ergänzen ihre Bedingung hier.
 */
export function workletsForPlan(plan, caps) {
  const ids = new Set();
  // P22: Zweigketten der Splitter wie eigene Schritte prüfen (virtuelle Schritte, Tiefe 1); ohne Splitter derselbe Plan.
  plan = withBranchSteps(plan);
  // P22: Transient-Splitter im Worklet `dynamics` (Modus 4); ohne Worklet läuft alles durch den Ausklang-Zweig.
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.transientSplit?.enabled)) for (const id of workletsOfModule('transientSplit')) ids.add(id);
  // Pitch: je aktivem Schritt das Worklet seines Algorithmus (P17b: `legacy` → `pitch`, sonst `stft`).
  if (plan?.hasPitch && caps?.pitch === 'worklet') {
    for (const s of plan.steps || []) {
      const ps = s.params?.pitchShift;
      if (pitchActive(ps)) ids.add(pitchAlgorithm(ps) === 'legacy' ? 'pitch' : 'stft');
    }
  }
  // P19d: Shimmer-Hall: Tonhöhe im Rückkopplungskreis über das Worklet `stft` (Ersatz `pitch` über fallbackWorklets).
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.reverb?.enabled && reverbBuiltMode(s.params.reverb) === 'shimmer')) ids.add('stft');
  // P17f: Gegen-Pitch des Tempos (Tonhöhe halten) im Worklet `stft` (Algorithmus `voice`), nur bei Zielen mit caps.tempo.
  if (plan?.tempo?.counter && caps?.tempo && caps?.pitch === 'worklet') ids.add('stft');
  // P10c: Hüllkurvenfolger, wenn Wah-Wah/Auto-Filter aktiv von der Hüllkurve gesteuert werden.
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => ['wahwah', 'autoFilter'].some(k => s.params?.[k]?.enabled && s.params[k].source === 'envelope'))) {
    for (const id of workletsOfModule('autoFilter')) ids.add(id);
  }
  // P11a/b/d: Gate/Expander/Limiter/Transient laufen im Worklet `dynamics`; ohne Worklet wird Gate/Expander übersprungen (Registry-Fallback „none“),
  // der Limiter fällt auf die Kompressor-Näherung zurück.
  // P19c: Gated-Hall nutzt das Gate des Noise Gate (Worklet `dynamics`) im Wet-Pfad.
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => ['noiseGate', 'expander', 'limiter', 'transient'].some(k => s.params?.[k]?.enabled)
    || (s.params?.reverb?.enabled && reverbBuiltMode(s.params.reverb) === 'gated'))) {
    for (const id of workletsOfModule('noiseGate')) ids.add(id);
  }
  // P12c/d: Flanger und Phaser im Worklet `delayline` (E1: in allen Motoren); ohne Worklet baut der Graph die native Näherung.
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.flanger?.enabled || s.params?.phaser?.enabled)) {
    for (const id of workletsOfModule('flanger')) ids.add(id);
  }
  // P15c: Bitcrusher im Worklet `crusher`; ohne Worklet baut der Graph die native Quantisierung (ohne Sample-Rate-Reduktion).
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.crusher?.enabled)) {
    for (const id of workletsOfModule('crusher')) ids.add(id);
  }
  // P20b: Stutter im Worklet `timebuffer`; ohne Worklet wird das Modul übersprungen (Fallback 'none').
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.stutter?.enabled)) {
    for (const id of workletsOfModule('stutter')) ids.add(id);
  }
  // P20c: Beat Repeat im selben Worklet; ohne Worklet wird das Modul übersprungen (Fallback 'none').
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.beatRepeat?.enabled)) {
    for (const id of workletsOfModule('beatRepeat')) ids.add(id);
  }
  // P20d: Retrigger im selben Worklet; ohne Worklet wird das Modul übersprungen (Fallback 'none').
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.retrigger?.enabled)) {
    for (const id of workletsOfModule('retrigger')) ids.add(id);
  }
  // P21a: Kammfilter im Worklet `delayline` (Prozessor combbank-processor); ohne Worklet wird das Modul übersprungen (Fallback 'none' des Moduls,
  // der Registry-Fallback 'native' des Worklets gilt nur für Flanger/Phaser).
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.comb?.enabled)) {
    for (const id of workletsOfModule('comb')) ids.add(id);
  }
  // P21b: Resonator in derselben Kamm-Bank; ohne Worklet übersprungen (Fallback 'none' des Moduls).
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.resonator?.enabled)) {
    for (const id of workletsOfModule('resonator')) ids.add(id);
  }
  // P21c: Tuned Resonator in derselben Kamm-Bank; ohne Worklet übersprungen (Fallback 'none' des Moduls).
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.tunedResonator?.enabled)) {
    for (const id of workletsOfModule('tunedResonator')) ids.add(id);
  }
  // P20e/P20f: Delay-Modi `reverse` und `granular` im selben Worklet; ohne Worklet baut der Graph den Modus `mono` (Entscheidung Phase 20).
  if (caps?.pitch === 'worklet' && plan?.steps?.some(s => s.params?.delay?.enabled && ['reverse', 'granular'].includes(delayMode(s.params.delay)))) ids.add('timebuffer');
  return [...ids];
}

/**
 * Ersatz-Worklets für nicht geladene (P17b, Entscheidung E): Ergebnis von ensureWorklets → IDs, die zusätzlich geladen werden sollen.
 * Heute nur `stft` → `pitch` (Fallback 'legacy'). Rein, damit beide Vorbereitungsstellen (fx-pipeline, runtime) dieselbe Regel nutzen.
 */
export function fallbackWorklets(res) {
  const out = [];
  for (const [id, ok] of Object.entries(res || {})) if (ok === false && WORKLETS[id]?.fallback === 'legacy') out.push('pitch');
  return [...new Set(out)];
}
