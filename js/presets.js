/**
 * presets.js — Audio-Effekt-Preset-System (Built-in + User Presets)
 *
 * Zentralisiert alles, was NICHT reine Audio-Engine-Zuständigkeit ist
 * (presets/effect-presets-data.js bleibt Eigentümer der eingebauten
 * Effektparameter in EFFECT_PRESETS): Preset-Metadaten, generische Anwendung eines Presets
 * auf ein Effekte-Objekt, User-Preset-CRUD sowie Validierung/Normalisierung
 * importierter Presets.
 *
 * Wichtige Architekturentscheidung: Presets sind reine
 * Datenobjekte. Es gibt keine `if (id === 'cave')`-Sonderfälle — jede
 * Funktion hier arbeitet generisch über PRESET_EFFECT_KEYS, sodass
 * importierte User-Presets exakt wie eingebaute Presets behandelt werden.
 */

import { APP } from './core/state.js';
import { defaultEffects } from './audio/effect-graph.js';
import { IR_IMPULSE_NAMES } from './audio/ir-data.js';
import { EFFECT_PRESETS } from './presets/effect-presets-data.js';
import { uid } from './utils.js';
import { STAGE_ORDER, PIPELINE_STAGES, isStageKey, sparsifyParams, suggestStageForParams } from './audio/fx-pipeline.js';

// ─── PIPELINE-STUFEN vs. ANZEIGE-GRUPPEN ──────────────────────
// ZWEI GETRENNTE ACHSEN — nicht verwechseln:
//   stage  (source | medium | environment | listener) = ROLLE IM SIGNALWEG der Pipeline (audio/fx-pipeline.js).
//                                                       Sie bestimmt, wo ein Preset eingesetzt wird.
//   group  (room, barrier, …)                          = reine ANZEIGE-Gruppierung (Optgroups im Dropdown),
//                                                       die frühere „Kategorie“. Hat keinen Einfluss auf die Verarbeitung.
// Die Stufe beschreibt die künstlerische/akustische Wirkung des GESAMTEN Presets, nicht seine einzelnen Module.
export const PRESET_STAGES = PIPELINE_STAGES;
export { STAGE_ORDER };

// ─── ANZEIGE-GRUPPEN (frühere „Kategorien“) ────────────────────
// Fachlich an der Art der akustischen Transformation orientiert,
// nicht an Entwicklungsphasen oder Fantasy-Settings. Erweitert auf 6
// Kategorien (vom Nutzer vorgegebenes Schema): reine Raumakustik wird von
// physischer Abschirmung (Barriere zwischen Quelle und Hörer) getrennt,
// und Effekte, die den Zustand des HÖRERS selbst betreffen (Somatik/
// Psyche), von externen technischen/übernatürlichen Übertragungswegen.
export const PRESET_GROUPS = {
  room:         { label: 'Akustische Räume & Dimensionen',      icon: '🏛️', order: 1 },
  barrier:      { label: 'Physische Abschirmung & Dämpfung',    icon: '🧱', order: 2 },
  transmission: { label: 'Technische Signalübertragung & Lo-Fi', icon: '📡', order: 3 },
  somatic:      { label: 'Somatische & Psychologische Zustände', icon: '🫁', order: 4 },
  supernatural: { label: 'Übernatürliche & Magische Phänomene',  icon: '🔮', order: 5 },
  creature:     { label: 'Kreaturen-Morphs',                     icon: '🐾', order: 6 }
};
const DEFAULT_GROUP = 'supernatural';
/** Rückwärtskompatibler Alias (frühere Bezeichnung) — neue Aufrufer nutzen PRESET_GROUPS. */
export const PRESET_CATEGORIES = PRESET_GROUPS;
const DEFAULT_CATEGORY = DEFAULT_GROUP;

// ─── BUILT-IN PRESET METADATEN ────────────────────────────────
// Nur Anzeige-/Dokumentationsdaten. Die eigentlichen Effektparameter
// bleiben in presets/effect-presets-data.js EFFECT_PRESETS (Audio-Engine-Daten).
// IDs sind stabil und unverändert gegenüber der bisherigen Version.

export const BUILTIN_PRESET_META = {
  // ── Akustische Räume & Dimensionen ──────────────────────────
  cave:            { name: '🏔️ Höhle',              stage: 'environment', group: 'room', description: 'Große, hallende Steinhöhle mit tiefen Reflexionen und leichtem Echo.' },
  tunnel:          { name: '🚇 Tunnel',              stage: 'environment', group: 'room', description: 'Langgezogener, röhrenförmiger Nachhall mit Flatterecho wie in einem Tunnel.' },
  bathroom:        { name: '🚿 Badezimmer',          stage: 'environment', group: 'room', description: 'Kurzer, harter Nachhall an gefliesten Wänden — kleiner, stark reflektierender Raum.' },
  metal_room:      { name: '🔩 Metallraum',          stage: 'environment', group: 'room', description: 'Scharfe, metallische Reflexionen in einem Raum mit harten Metallflächen.' },
  dark_cave:       { name: '🕳️ Dunkle Höhle',        stage: 'environment', group: 'room', description: 'Sehr langer, dichter Nachhall einer riesigen, bedrohlichen Höhle mit kurzem Flatterecho.' },
  huge_hall:       { name: '🏛️ Riesiger Saal',       stage: 'environment', group: 'room', description: 'Weitläufiger, langer Nachhall wie in einer Kathedrale oder einem riesigen Saal.' },
  tight_room:      { name: '📦 Kleiner Raum',        stage: 'environment', group: 'room', description: 'Sehr kurzer, enger Nachhall wie in einem kleinen, gedämpften Raum.' },
  cathedral_sanctum: { name: '⛪ Monumentaler Sakralraum', stage: 'environment', group: 'room', description: 'Extrem langer, sehr heller Nachhall (Convolver + synthetisches Reverb kombiniert) eines riesigen Sakralbaus — länger und dichter als der Riesige Saal.' },
  narrow_vent:     { name: '🚰 Enger Schacht / Blechrohr', stage: 'medium', group: 'room', description: 'Extrem schmalbandige Resonanz (Hoch-/Tiefpass eng gestapelt) mit metallischem Flackern (Flanger) für Lüftungsschächte oder Rohrsysteme.' },
  endless_abyss:   { name: '🌌 Unendlicher Abgrund',  stage: 'environment', group: 'room', description: 'Der längste, dichteste Nachhall der Bibliothek kombiniert mit weit auseinanderliegenden, lange nachklingenden Echos — für einen Sturz ohne erkennbaren Boden.' },
  // ── Physische Abschirmung & Dämpfung ────────────────────────
  behind_wall:     { name: '🧱 Hinter Wand',         stage: 'medium', group: 'barrier', description: 'Gedämpfter Klang, als würde man ihn durch eine Wand oder geschlossene Tür hören.' },
  distant:         { name: '🌫️ Aus der Ferne',       stage: 'medium', group: 'barrier', description: 'Gedämpfte Höhen und reduzierte Präsenz durch Distanz — für weit entfernt gehörte Geräusche im Freien.' },
  heavy_barricade: { name: '🛡️ Dicke Panzertür',      stage: 'medium', group: 'barrier', description: 'Sehr aggressive Tiefpassfilterung ohne jeden Raumhall plus leichte Sättigung an den Bass-Transienten — für massive, schallisolierte Barrieren.' },
  dense_canopy:    { name: '🌳 Dichter Nebel / Absorption', stage: 'medium', group: 'barrier', description: 'Extrem trockene, stark bedämpfte Übertragung mit kompakter Kompression — für dichten Nebel, Blätterdach oder starke Luftabsorption.' },
  distant_horizon: { name: '🌄 Akustische Ferne',    stage: 'environment', group: 'barrier', description: 'Distanzsimulation über ein rückkehrendes Echo statt Raumhall — für Geräusche, die von einem fernen Horizont zurückgeworfen werden.' },
  // ── Technische Signalübertragung & Lo-Fi ────────────────────
  phone:           { name: '📞 Telefon',             stage: 'medium', group: 'transmission', description: 'Stark bandbegrenzter, leicht verzerrter Klang wie aus einem Telefonhörer.' },
  radio:           { name: '📻 Radio',               stage: 'medium', group: 'transmission', description: 'Komprimierter, verzerrter Klang mit schmalem Frequenzband wie aus einem Radioempfänger.' },
  megaphone:       { name: '📣 Megafon',             stage: 'medium', group: 'transmission', description: 'Extrem bandbegrenzter, stark komprimierter und verzerrter Klang wie aus einem Megafon.' },
  broken_speaker:  { name: '💥 Kaputte Box',         stage: 'medium', group: 'transmission', description: 'Stark übersteuerter, krächzender Klang wie aus einem defekten Lautsprecher.' },
  vintage_tape:    { name: '📼 Vintage Tape',        stage: 'medium', group: 'transmission', description: 'Warmer, leicht flatternder Klang mit Bandsättigung wie von einem alten Tonbandgerät.' },
  lofi:            { name: '🎞️ Lo-Fi',              stage: 'medium', group: 'transmission', description: 'Warmer, gedämpfter Klang mit leichter Sättigung wie von einer alten Aufnahme.' },
  signal_dropout:  { name: '📡 Signalabriss',        stage: 'medium', group: 'transmission', description: 'Pulsierend aussetzendes, verrauschtes Funksignal — für gestörte Übertragung oder abreißenden Kontakt.' },
  intercom_bunker: { name: '🚨 Bunker-Gegensprechanlage', stage: 'medium', group: 'transmission', description: 'Bandbegrenzte, hart übersteuerte Stimme mit kurzem, metallischem Slapback-Echo — für Gegensprechanlagen in engen Betonräumen.' },
  surveillance_bug:{ name: '🕷️ Abhörwanze',          stage: 'medium', group: 'transmission', description: 'Extrem dünnes, resonant überbetontes Hochpasssignal mit starkem Limiting — für winzige, minderwertige Abhörmikrofone.' },
  phonograph_horn: { name: '🎺 Grammophon / Antiker Trichter', stage: 'medium', group: 'transmission', description: 'Sehr schmales, mittenbetontes Frequenzband mit Bitcrush-Verzerrung und langsamem Gleichlauf-Wackeln (Tremolo) — der typische Trichter-Grammophon-Klang.' },
  // ── Somatische & Psychologische Zustände ────────────────────
  underwater:      { name: '🌊 Unterwasser',         stage: 'medium', group: 'somatic', description: 'Dumpfer, stark tiefpassgefilterter Klang wie unter Wasser gehört (Zustand der eigenen Ohren, nicht der Schallquelle).' },
  dying_breath:    { name: '🕯️ Letzter Atemzug',     stage: 'source', group: 'somatic', description: 'Sanft abgesenkte Tonhöhe und langem Hall-Ausklang — für Zeitlupen-/Sterbemomente.' },
  ear_ringing:     { name: '🔔 Tinnitus / Schockzustand', stage: 'listener', group: 'somatic', description: 'Fast vollständige Taubheit für die Außenwelt (starker Tiefpass) plus ein leises, hochfrequentes Ring-Artefakt als Tinnitus-Ton.' },
  drunk_dizzy:     { name: '🥴 Benommenheit / Schwindel', stage: 'listener', group: 'somatic', description: 'Sehr langsame, wabernde Filterschwingung (Wah als Phaser-Ersatz) mit warmem Hall — für Trunkenheit oder Schwindel.' },
  asphyxiation:    { name: '👨\u200d🚀 Atemnot / Unter Visier', stage: 'medium', group: 'somatic', description: 'Näselnde Mittenanhebung und sehr kurzer, enger Kapselhall — für das Sprechen durch Helm, Atemmaske oder Visier.' },
  // ── Übernatürliche & Magische Phänomene ─────────────────────
  dreamy_echo:     { name: '✨ Traumhaftes Echo',     stage: 'environment', group: 'supernatural', description: 'Weiches, langes Echo mit warmem Hall für traumhafte oder surreale Momente.' },
  possessed:       { name: '👁️ Besessen',            stage: 'source', group: 'supernatural', description: 'Metallische Ringmodulation mit hohler Formant-Aussparung und abgesenkter Stimme — für besessene/dämonisch überlagerte Stimmen.' },
  portal_warp:     { name: '🌀 Portal / Dimensionsriss', stage: 'medium', group: 'supernatural', description: 'Schwingender, schneller Wah- und Flanger-Sweep für das Öffnen eines Portals oder eine Teleportation.' },
  phantom_choir:   { name: '👻 Geisterstimme',       stage: 'source', group: 'supernatural', description: 'Mehrstimmig verdoppelte, hallende Chorus-Stimme für Geister oder ätherische Erscheinungen.' },
  mind_control:    { name: '🧠 Telepathie / Im Kopf', stage: 'source', group: 'supernatural', description: 'Absolut trockene, extrem nahe und komprimierte Stimme mit breiter Chorus-Verdopplung anstelle von Raumhall — als würde sie direkt im Kopf erklingen.' },
  shadow_realm:    { name: '🌑 Schattenwelt / Astral', stage: 'environment', group: 'supernatural', description: 'Gedämpfte, dunkle Klangfarbe mit langem, modulierten Hall und leicht abgesenkter Tonhöhe — für die Astralebene oder eine Schattenwelt.' },
  fairy_pixie:     { name: '🧚 Magische Kreatur / Kobold', stage: 'source', group: 'supernatural', description: 'Hell angehobene Höhen mit kurzem, glitzerndem Hall und stark erhöhter Tonhöhe — für kleine, magische Wesen.' },
  // ── Kreaturen-Morphs ─────────────────────────────────────────
  monster:         { name: '👹 Monster',             stage: 'source', group: 'creature', description: 'Tiefe, verzerrte, gutturale Stimme mit angehobenen Bässen für bedrohliche Kreaturen.' },
  hive_mind:       { name: '🐝 Schwarmbewusstsein',  stage: 'source', group: 'creature', description: 'Schnelle Flanger-/Chorus-Modulation mit kurzem Mehrfach-Echo — für insektoide Schwarmwesen mit vielen überlagerten Stimmen.' },
  stone_statue:    { name: '🗿 Steingolem / Lebende Statue', stage: 'source', group: 'creature', description: 'Massiv angehobene Tiefen mit hartem Kompressor-Attack, kurzem Stein-Reflexionshall und leicht abgesenkter Tonhöhe — für schwere, lebende Statuen.' }
};

// ─── EFFEKTMODULE, DIE EIN PRESET SETZEN KANN ─────────────────
// Muss synchron mit defaultEffects()/buildEffectChain() in audio/effect-graph.js
// gehalten werden. Hüllkurve, Pan und Analyzer gehören nicht (mehr) zum Pipeline-Modell; solche Schlüssel
// in alten Preset-Daten werden ignoriert. 'enabled'/'preset' sind Sound-Laufzeitfelder, keine Preset-Inhalte.
export const PRESET_EFFECT_KEYS = [
  'lowpass', 'highpass', 'notch', 'wahwah',
  'reverb', 'delay', 'chorus', 'flanger', 'tremolo',
  'eq', 'eq10', 'compressor', 'limiter', 'distortion', 'ringmod',
  'pitchShift', 'irReverb', 'spatial', 'noiseGate'
];

// ─── GENERISCHE PRESET-ANWENDUNG ─────────────────────────────
// Baut aus einem (Teil-)Effekte-Objekt eines Presets ein vollständiges
// Effekte-Objekt für einen Sound. Deterministisch: hängt nur von presetEffects +
// defaultEffects() ab, NICHT vom bisherigen Zustand des Sounds — nicht im
// Preset gesetzte Module fallen auf Default zurück, exakt gesetzte Felder werden
// übernommen. `enabled`/`preset` werden vom Aufrufer gesetzt (hier nicht enthalten).
export function applyPresetEffects(presetEffects) {
  const def = defaultEffects();
  const src = presetEffects || {};
  const out = {};
  for (const key of PRESET_EFFECT_KEYS) {
    if (key === 'eq10') {
      const bands = Array.isArray(src.eq10?.bands) ? src.eq10.bands.slice(0, 10) : def.eq10.bands.slice();
      while (bands.length < 10) bands.push(0);
      out.eq10 = { ...def.eq10, ...(src.eq10 || {}), bands };
      continue;
    }
    out[key] = { ...def[key], ...(src[key] || {}) };
  }
  return out;
}

// Die Anwendung eines Presets auf eine Sammlung (Sound-Profil, Ambient-Szene, Playlist) liegt jetzt in
// fx-model.js (applyPipelineToCollection) — sie arbeitet auf dem Pipeline-Modell statt auf flachen Effekt-Objekten.

/**
 * Erzeugt aus einem Preset die Bausteine für einen Pipeline-Layer (sparsame Layer-Parameter als Snapshot).
 * Eine im Katalog vorhandene Hüllkurve wird ignoriert; sie ist KEIN
 * Modell-Bestandteil mehr (ignoriert).
 * @returns {{ init:{presetId:string, params:object}, preset:object }|null}
 */
export function presetToLayerInit(presetId) {
  const preset = getPresetById(presetId);
  if (!preset) return null;
  const full = applyPresetEffects(preset.effects);
  return { init: { presetId, params: sparsifyParams(full) }, preset };
}

// ─── ZUGRIFF AUF PRESETS (BUILT-IN + USER, EINHEITLICH) ───────

function _ensureUserPresetsArray() {
  if (!Array.isArray(APP.userPresets)) APP.userPresets = [];
  return APP.userPresets;
}

export function getBuiltinPresetIds() { return Object.keys(EFFECT_PRESETS); }

/** Stufe aus der früheren Kategorie ableiten (nur eindeutige Fälle); sonst null → Heuristik über die Parameter. */
const LEGACY_CATEGORY_TO_STAGE = { room: 'environment', barrier: 'medium', transmission: 'medium', creature: 'source' };

function _userPresetStage(p) {
  if (isStageKey(p.stage)) return { stage: p.stage, auto: p.stageAuto === true };
  const byCat = LEGACY_CATEGORY_TO_STAGE[p.group || p.category];
  if (byCat) return { stage: byCat, auto: true };
  return { stage: suggestStageForParams(p.effects), auto: true };
}

/** Liefert ein einheitliches Preset-Deskriptor-Objekt, egal ob built-in oder User-Preset. */
export function getPresetById(id) {
  if (!id) return null;
  if (Object.prototype.hasOwnProperty.call(EFFECT_PRESETS, id)) {
    const meta = BUILTIN_PRESET_META[id] || { name: id, stage: 'medium', group: DEFAULT_GROUP, description: '' };
    return { id, builtin: true, name: meta.name, stage: meta.stage, group: meta.group, stageAuto: false, description: meta.description || '', effects: EFFECT_PRESETS[id] };
  }
  const up = _ensureUserPresetsArray().find(p => p.id === id);
  if (up) {
    const st = _userPresetStage(up);
    return { id: up.id, builtin: false, name: up.name, stage: st.stage, group: up.group || up.category || DEFAULT_GROUP, stageAuto: st.auto, description: up.description || '', effects: up.effects };
  }
  return null;
}

/** Alle Presets, built-in zuerst (Original-Reihenfolge), dann eigene. */
export function getAllPresets() {
  const builtins = getBuiltinPresetIds().map(getPresetById);
  const users     = _ensureUserPresetsArray().map(p => getPresetById(p.id));
  return [...builtins, ...users];
}

export function getPresetsByStage(stage) {
  return getAllPresets().filter(p => p.stage === stage);
}

export function getPresetsByGroup(group) {
  return getAllPresets().filter(p => p.group === group);
}

// ─── VALIDIERUNG / NORMALISIERUNG ───────────
// Wertebereiche gespiegelt aus den bestehenden Clamp-Grenzen in
// audio/effect-graph.js (buildEffectChain()/_buildX()-Funktionen) bzw. den
// Slider-min/max-Attributen in index.html. Verhindert NaN/Infinity/
// ungültige Strings/Werte außerhalb des sinnvollen Bereichs in
// importierten Presets, bevor sie in die Audio-Engine gelangen.

const NUM_RANGES = {
  'lowpass.frequency': [20, 20000],    'lowpass.Q': [0.1, 20],
  'highpass.frequency': [20, 20000],   'highpass.Q': [0.1, 20],
  'notch.frequency': [20, 20000],      'notch.Q': [0.5, 30],
  'wahwah.frequency': [100, 5000],     'wahwah.depth': [0, 1], 'wahwah.rate': [0.1, 10], 'wahwah.resonance': [1, 20],
  'reverb.amount': [0, 1], 'reverb.duration': [0.05, 10], 'reverb.decay': [0.1, 10],
  'delay.time': [0, 2], 'delay.feedback': [0, 0.95], 'delay.wet': [0, 1],
  'chorus.baseDelay': [1, 40], 'chorus.depth': [0, 20], 'chorus.rate': [0.01, 10], 'chorus.mix': [0, 1],
  'flanger.baseDelay': [0.5, 10], 'flanger.depth': [0, 10], 'flanger.rate': [0.01, 10], 'flanger.feedback': [0, 0.95], 'flanger.mix': [0, 1],
  'tremolo.rate': [0.1, 20], 'tremolo.depth': [0, 1],
  'eq.low': [-18, 18], 'eq.mid': [-18, 18], 'eq.high': [-18, 18],
  'compressor.threshold': [-60, 0], 'compressor.knee': [0, 40], 'compressor.ratio': [1, 20], 'compressor.attack': [0, 1], 'compressor.release': [0, 1],
  'limiter.threshold': [-24, 0],
  'distortion.amount': [0, 100],
  'ringmod.frequency': [20, 5000], 'ringmod.mix': [0, 1],
  'pitchShift.semitones': [-24, 24],
  'irReverb.wet': [0, 1],
  'spatial.x': [-1000, 1000], 'spatial.y': [-1000, 1000], 'spatial.z': [-1000, 1000],
  'spatial.rolloff': [0, 10], 'spatial.maxDistance': [1, 100000], 'spatial.refDistance': [0, 1000],
  'spatial.coneInnerAngle': [0, 360], 'spatial.coneOuterAngle': [0, 360], 'spatial.coneOuterGain': [0, 1],
  'noiseGate.threshold': [-100, 0], 'noiseGate.attack': [0, 1000], 'noiseGate.release': [0, 2000]
};

function _num(val, range, fallback) {
  const n = typeof val === 'number' ? val : parseFloat(val);
  if (!isFinite(n)) return fallback; // fängt NaN und ±Infinity ab
  const [min, max] = range;
  return Math.max(min, Math.min(max, n));
}
function _bool(val, fallback) { return typeof val === 'boolean' ? val : fallback; }
function _enum(val, allowed, fallback) { return allowed.includes(val) ? val : fallback; }

/**
 * Nimmt beliebiges (potenziell nicht vertrauenswürdiges, z.B. importiertes)
 * Rohdaten-Objekt entgegen und liefert ein vollständiges, garantiert
 * gültiges Effekte-Objekt (alle PRESET_EFFECT_KEYS, alle Zahlenwerte
 * geklemmt, unbekannte Felder/Module verworfen). Unbekannte
 * zusätzliche Effektmodule im Rohdaten-Objekt werden dabei stillschweigend
 * ignoriert (nicht Teil von PRESET_EFFECT_KEYS) — der Import wird NICHT
 * abgelehnt, es erscheint aber auch keine Fehlfunktion, da nur bekannte
 * Module überhaupt an die Audio-Engine weitergereicht werden.
 */
export function normalizeEffectsObject(raw) {
  const def = defaultEffects();
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};

  const filt = (key, extra = {}) => {
    const s = (src[key] && typeof src[key] === 'object') ? src[key] : {};
    const d = def[key];
    const o = { enabled: _bool(s.enabled, d.enabled) };
    for (const field of Object.keys(d)) {
      if (field === 'enabled') continue;
      const rangeKey = `${key}.${field}`;
      if (NUM_RANGES[rangeKey]) o[field] = _num(s[field], NUM_RANGES[rangeKey], d[field]);
      else o[field] = (extra.enumFields && extra.enumFields[field]) ? _enum(s[field], extra.enumFields[field], d[field]) : (s[field] ?? d[field]);
    }
    return o;
  };

  out.lowpass  = filt('lowpass');
  out.highpass = filt('highpass');
  out.notch    = filt('notch');
  out.wahwah   = filt('wahwah');
  out.reverb   = filt('reverb');
  out.delay    = filt('delay');
  out.chorus   = filt('chorus');
  out.flanger  = filt('flanger');
  out.tremolo  = filt('tremolo', { enumFields: { waveform: ['sine', 'triangle', 'square'] } });
  out.eq       = filt('eq');
  out.compressor = filt('compressor');
  out.limiter     = filt('limiter');
  out.distortion  = filt('distortion', { enumFields: {
    mode:       ['softClip', 'hardClip', 'bitcrush'],
    oversample: ['none', '2x', '4x']
  } });
  out.ringmod  = filt('ringmod');
  out.pitchShift = filt('pitchShift');

  const irSrc = (src.irReverb && typeof src.irReverb === 'object') ? src.irReverb : {};
  out.irReverb = {
    enabled: _bool(irSrc.enabled, def.irReverb.enabled),
    impulse: IR_IMPULSE_NAMES.includes(irSrc.impulse) ? irSrc.impulse : (irSrc.impulse == null ? null : def.irReverb.impulse),
    wet:     _num(irSrc.wet, NUM_RANGES['irReverb.wet'], def.irReverb.wet)
  };

  out.spatial  = filt('spatial');
  out.noiseGate = filt('noiseGate');

  const eq10Src = (src.eq10 && typeof src.eq10 === 'object') ? src.eq10 : {};
  // eq10.bands: entweder reine Gain-Zahlen (Built-in-Presets) ODER Objekte {freq, gain, Q} (so schreibt der
  // Editor sie, s. dialogs/sound-modal.js readEffectsFromUI()). BEIDE Formen bleiben erhalten — nur die Werte werden
  // geklemmt. (Früher wurden Objekte hier zu 0 dB normalisiert, wodurch EQ10-Werte eigener Presets verloren gingen.)
  const rawBands = Array.isArray(eq10Src.bands) ? eq10Src.bands : def.eq10.bands;
  const bands = [];
  for (let i = 0; i < 10; i++) {
    const b = rawBands[i];
    if (b && typeof b === 'object') {
      const o = { gain: _num(b.gain, [-18, 18], 0) };
      if (b.freq != null) o.freq = _num(b.freq, [20, 20000], 1000);
      if (b.Q != null)    o.Q    = _num(b.Q, [0.3, 10], 1.4);
      bands.push(o);
    } else bands.push(_num(b, [-18, 18], 0));
  }
  out.eq10 = { enabled: _bool(eq10Src.enabled, def.eq10.enabled), bands };

  return out;
}

// ─── USER-PRESET CRUD ──────────────────────────

function _sanitizeMeta({ name, group, category, stage, description }) {
  const cleanName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 60) : 'Eigenes Preset';
  const g = group ?? category;
  const cleanGroup = Object.prototype.hasOwnProperty.call(PRESET_GROUPS, g) ? g : DEFAULT_GROUP;
  const cleanDescription = typeof description === 'string' ? description.trim().slice(0, 300) : '';
  return { name: cleanName, group: cleanGroup, stage: isStageKey(stage) ? stage : null, description: cleanDescription };
}

/** Neues User-Preset. IDs sind mit 'user_' präfixt — kann nie mit einer
 *  Built-in-ID (EFFECT_PRESETS-Schlüssel aus presets/effect-presets-data.js) kollidieren.
 *  `stage` ist Pflicht-Metadatum (Rolle in der Pipeline); fehlt sie, wird sie aus den Parametern vorgeschlagen und
 *  das Preset mit stageAuto:true markiert („Stufe prüfen“). */
export function createUserPreset({ name, group, category, stage, description, effects }) {
  const meta = _sanitizeMeta({ name, group, category, stage, description });
  const normEffects = normalizeEffectsObject(effects);
  const auto = !meta.stage;
  const preset = {
    id: 'user_' + uid(),
    name: meta.name, group: meta.group, description: meta.description,
    stage: meta.stage || suggestStageForParams(normEffects),
    stageAuto: auto,
    effects: normEffects,
    version: 2,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  _ensureUserPresetsArray().push(preset);
  return preset;
}

export function updateUserPreset(id, { name, group, category, stage, description, effects } = {}) {
  const p = _ensureUserPresetsArray().find(x => x.id === id);
  if (!p) return null;
  const cur = getPresetById(id);
  const meta = _sanitizeMeta({ name: name ?? p.name, group: group ?? category ?? cur.group, stage: stage ?? cur.stage, description: description ?? p.description });
  p.name = meta.name; p.group = meta.group; p.description = meta.description;
  delete p.category;
  p.stage = meta.stage || cur.stage;
  // Eine ausdrücklich gesetzte Stufe ist bestätigt; ohne Angabe bleibt der Prüf-Hinweis bestehen.
  p.stageAuto = stage ? false : cur.stageAuto;
  p.version = 2;
  if (effects) p.effects = normalizeEffectsObject(effects);
  p.updatedAt = Date.now();
  return p;
}

export function deleteUserPreset(id) {
  const arr = _ensureUserPresetsArray();
  const idx = arr.findIndex(x => x.id === id);
  if (idx === -1) return false;
  arr.splice(idx, 1);
  return true;
}

/** Preset (built-in ODER eigenes) als neues, unabhängiges User-Preset
 *  duplizieren — das Original (insbesondere ein Built-in) bleibt dabei
 *  unverändert. */
export function duplicatePreset(sourceId, overrideName) {
  const src = getPresetById(sourceId);
  if (!src) return null;
  return createUserPreset({
    name: overrideName || (src.name + ' (Kopie)'),
    group: src.group,
    stage: src.stage,
    description: src.description,
    effects: src.effects
  });
}

export function isUserPreset(id) {
  return typeof id === 'string' && _ensureUserPresetsArray().some(p => p.id === id);
}

/**
 * Migration gespeicherter User-Presets auf das Stufenmodell (idempotent, von storage/persistence.js load() und
 * jedem Vollimport aufgerufen):
 *   - `category` → `group` (reine Anzeige-Gruppe; unbekannte/alte Schlüssel → 'supernatural')
 *   - `stage` ist Pflicht: room→environment, barrier/transmission→medium, creature→source; alles andere
 *     (supernatural war der Default für ungewählte Kategorien, somatic) → Heuristik suggestStageForParams().
 *     Automatisch zugeordnete Presets tragen stageAuto:true — das Meta-Modal zeigt dann „Stufe prüfen“.
 * Presets gehen dabei nie verloren; IDs ändern sich nicht. Gibt true zurück, wenn etwas geändert wurde.
 */
const LEGACY_CATEGORY_MAP = { character: 'supernatural' };

export function migrateUserPresetStages() {
  const arr = _ensureUserPresetsArray();
  let changed = false;
  for (const p of arr) {
    const legacyKey = p.group ?? p.category;
    const group = Object.prototype.hasOwnProperty.call(PRESET_GROUPS, legacyKey) ? legacyKey : (LEGACY_CATEGORY_MAP[legacyKey] || DEFAULT_GROUP);
    if (p.group !== group) { p.group = group; changed = true; }
    if ('category' in p) { delete p.category; changed = true; }
    if (!isStageKey(p.stage)) {
      const byCat = LEGACY_CATEGORY_TO_STAGE[legacyKey];
      p.stage = byCat || suggestStageForParams(p.effects);
      p.stageAuto = true;
      changed = true;
    }
    if (p.version !== 2) { p.version = 2; changed = true; }
  }
  return changed;
}
/** @deprecated frühere Bezeichnung */
export const migratePresetCategories = migrateUserPresetStages;

// ─── IMPORT (aufgerufen von storage/import-export.js importData()) ──
// Eine importierte Preset-Datei mit unbekannten Zusatzfeldern wird NICHT
// abgelehnt (Felder werden ignoriert); eine Datei mit fehlenden Pflichtfeldern
// (kein `effects`-Objekt) WIRD abgelehnt (validatePresetShape). Eine
// unbekannte/neuere `version` wird nicht hart abgelehnt (Vorwärtskompatibilität);
// alle Werte laufen durch normalizeEffectsObject().
// v1-Dateien (nur `category`) bleiben importierbar: die Stufe wird dann wie bei der Migration abgeleitet und
// das Preset als stageAuto markiert. IDs aus der Importdatei werden NIE übernommen — jeder Import erzeugt
// immer eine frische ID.

export function validatePresetShape(raw) {
  return !!(raw && typeof raw === 'object' && raw.effects && typeof raw.effects === 'object');
}

export function importSinglePresetData(raw) {
  const legacyKey = raw?.group ?? raw?.category;
  let stage = isStageKey(raw?.stage) ? raw.stage : null;
  let auto = isStageKey(raw?.stage) && raw?.stageAuto === true;
  if (!stage) {
    stage = LEGACY_CATEGORY_TO_STAGE[legacyKey] || null;
    auto = true;
  }
  const p = createUserPreset({
    name: raw?.name,
    group: legacyKey,
    stage: stage || undefined,
    description: raw?.description,
    effects: raw?.effects
  });
  p.stageAuto = !!auto;
  return p;
}

export function importPresetCollectionData(rawArray) {
  return rawArray.filter(validatePresetShape).map(importSinglePresetData);
}
