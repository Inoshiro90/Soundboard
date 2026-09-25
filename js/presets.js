/**
 * presets.js — Audio-Effekt-Preset-System (Built-in + User Presets)
 *
 * Zentralisiert alles, was NICHT reine Audio-Engine-Zuständigkeit ist
 * (presets/effect-presets-data.js bleibt Eigentümer der eingebauten
 * Effektparameter in EFFECT_PRESETS, verschoben aus audio.js in Phase 1
 * der Refaktorierung): Preset-Metadaten, generische Anwendung eines Presets
 * auf ein Effekte-Objekt, User-Preset-CRUD sowie Validierung/Normalisierung
 * importierter Presets.
 *
 * Wichtige Architekturentscheidung (Kap. 17): Presets sind reine
 * Datenobjekte. Es gibt keine `if (id === 'cave')`-Sonderfälle — jede
 * Funktion hier arbeitet generisch über PRESET_EFFECT_KEYS, sodass
 * importierte User-Presets exakt wie eingebaute Presets behandelt werden.
 */

import { APP } from './core/state.js';
import { defaultEffects, IR_IMPULSE_NAMES } from './audio.js';
import { EFFECT_PRESETS } from './presets/effect-presets-data.js';
import { uid } from './utils.js';

// ─── KATEGORIEN ───────────────────────────────────────────────
// Fachlich an der Art der akustischen Transformation orientiert (Kap. 9),
// nicht an Entwicklungsphasen oder Fantasy-Settings. Erweitert auf 6
// Kategorien (vom Nutzer vorgegebenes Schema): reine Raumakustik wird von
// physischer Abschirmung (Barriere zwischen Quelle und Hörer) getrennt,
// und Effekte, die den Zustand des HÖRERS selbst betreffen (Somatik/
// Psyche), von externen technischen/übernatürlichen Übertragungswegen.
export const PRESET_CATEGORIES = {
  room:         { label: 'Akustische Räume & Dimensionen',      icon: '🏛️', order: 1 },
  barrier:      { label: 'Physische Abschirmung & Dämpfung',    icon: '🧱', order: 2 },
  transmission: { label: 'Technische Signalübertragung & Lo-Fi', icon: '📡', order: 3 },
  somatic:      { label: 'Somatische & Psychologische Zustände', icon: '🫁', order: 4 },
  supernatural: { label: 'Übernatürliche & Magische Phänomene',  icon: '🔮', order: 5 },
  creature:     { label: 'Kreaturen-Morphs',                     icon: '🐾', order: 6 }
};
const DEFAULT_CATEGORY = 'supernatural';

// ─── BUILT-IN PRESET METADATEN ────────────────────────────────
// Nur Anzeige-/Dokumentationsdaten. Die eigentlichen Effektparameter
// bleiben in presets/effect-presets-data.js EFFECT_PRESETS (Audio-Engine-Daten).
// IDs sind stabil und unverändert gegenüber der bisherigen Version.

export const BUILTIN_PRESET_META = {
  // ── Akustische Räume & Dimensionen ──────────────────────────
  cave:            { name: '🏔️ Höhle',              category: 'room', description: 'Große, hallende Steinhöhle mit tiefen Reflexionen und leichtem Echo.' },
  tunnel:          { name: '🚇 Tunnel',              category: 'room', description: 'Langgezogener, röhrenförmiger Nachhall mit Flatterecho wie in einem Tunnel.' },
  bathroom:        { name: '🚿 Badezimmer',          category: 'room', description: 'Kurzer, harter Nachhall an gefliesten Wänden — kleiner, stark reflektierender Raum.' },
  metal_room:      { name: '🔩 Metallraum',          category: 'room', description: 'Scharfe, metallische Reflexionen in einem Raum mit harten Metallflächen.' },
  dark_cave:       { name: '🕳️ Dunkle Höhle',        category: 'room', description: 'Sehr langer, dichter Nachhall einer riesigen, bedrohlichen Höhle mit kurzem Flatterecho.' },
  huge_hall:       { name: '🏛️ Riesiger Saal',       category: 'room', description: 'Weitläufiger, langer Nachhall wie in einer Kathedrale oder einem riesigen Saal.' },
  tight_room:      { name: '📦 Kleiner Raum',        category: 'room', description: 'Sehr kurzer, enger Nachhall wie in einem kleinen, gedämpften Raum.' },
  cathedral_sanctum: { name: '⛪ Monumentaler Sakralraum', category: 'room', description: 'Extrem langer, sehr heller Nachhall (Convolver + synthetisches Reverb kombiniert) eines riesigen Sakralbaus — länger und dichter als der Riesige Saal.' },
  narrow_vent:     { name: '🚰 Enger Schacht / Blechrohr', category: 'room', description: 'Extrem schmalbandige Resonanz (Hoch-/Tiefpass eng gestapelt) mit metallischem Flackern (Flanger) für Lüftungsschächte oder Rohrsysteme.' },
  endless_abyss:   { name: '🌌 Unendlicher Abgrund',  category: 'room', description: 'Der längste, dichteste Nachhall der Bibliothek kombiniert mit weit auseinanderliegenden, lange nachklingenden Echos — für einen Sturz ohne erkennbaren Boden.' },
  // ── Physische Abschirmung & Dämpfung ────────────────────────
  behind_wall:     { name: '🧱 Hinter Wand',         category: 'barrier', description: 'Gedämpfter Klang, als würde man ihn durch eine Wand oder geschlossene Tür hören.' },
  distant:         { name: '🌫️ Aus der Ferne',       category: 'barrier', description: 'Gedämpfte Höhen und reduzierte Präsenz durch Distanz — für weit entfernt gehörte Geräusche im Freien.' },
  heavy_barricade: { name: '🛡️ Dicke Panzertür',      category: 'barrier', description: 'Sehr aggressive Tiefpassfilterung ohne jeden Raumhall plus leichte Sättigung an den Bass-Transienten — für massive, schallisolierte Barrieren.' },
  dense_canopy:    { name: '🌳 Dichter Nebel / Absorption', category: 'barrier', description: 'Extrem trockene, stark bedämpfte Übertragung mit kompakter Kompression — für dichten Nebel, Blätterdach oder starke Luftabsorption.' },
  distant_horizon: { name: '🌄 Akustische Ferne',    category: 'barrier', description: 'Distanzsimulation über ein rückkehrendes Echo statt Raumhall — für Geräusche, die von einem fernen Horizont zurückgeworfen werden.' },
  // ── Technische Signalübertragung & Lo-Fi ────────────────────
  phone:           { name: '📞 Telefon',             category: 'transmission', description: 'Stark bandbegrenzter, leicht verzerrter Klang wie aus einem Telefonhörer.' },
  radio:           { name: '📻 Radio',               category: 'transmission', description: 'Komprimierter, verzerrter Klang mit schmalem Frequenzband wie aus einem Radioempfänger.' },
  megaphone:       { name: '📣 Megafon',             category: 'transmission', description: 'Extrem bandbegrenzter, stark komprimierter und verzerrter Klang wie aus einem Megafon.' },
  broken_speaker:  { name: '💥 Kaputte Box',         category: 'transmission', description: 'Stark übersteuerter, krächzender Klang wie aus einem defekten Lautsprecher.' },
  vintage_tape:    { name: '📼 Vintage Tape',        category: 'transmission', description: 'Warmer, leicht flatternder Klang mit Bandsättigung wie von einem alten Tonbandgerät.' },
  lofi:            { name: '🎞️ Lo-Fi',              category: 'transmission', description: 'Warmer, gedämpfter Klang mit leichter Sättigung wie von einer alten Aufnahme.' },
  signal_dropout:  { name: '📡 Signalabriss',        category: 'transmission', description: 'Pulsierend aussetzendes, verrauschtes Funksignal — für gestörte Übertragung oder abreißenden Kontakt.' },
  intercom_bunker: { name: '🚨 Bunker-Gegensprechanlage', category: 'transmission', description: 'Bandbegrenzte, hart übersteuerte Stimme mit kurzem, metallischem Slapback-Echo — für Gegensprechanlagen in engen Betonräumen.' },
  surveillance_bug:{ name: '🕷️ Abhörwanze',          category: 'transmission', description: 'Extrem dünnes, resonant überbetontes Hochpasssignal mit starkem Limiting — für winzige, minderwertige Abhörmikrofone.' },
  phonograph_horn: { name: '🎺 Grammophon / Antiker Trichter', category: 'transmission', description: 'Sehr schmales, mittenbetontes Frequenzband mit Bitcrush-Verzerrung und langsamem Gleichlauf-Wackeln (Tremolo) — der typische Trichter-Grammophon-Klang.' },
  // ── Somatische & Psychologische Zustände ────────────────────
  underwater:      { name: '🌊 Unterwasser',         category: 'somatic', description: 'Dumpfer, stark tiefpassgefilterter Klang wie unter Wasser gehört (Zustand der eigenen Ohren, nicht der Schallquelle).' },
  dying_breath:    { name: '🕯️ Letzter Atemzug',     category: 'somatic', description: 'Sanft einschwingende Hüllkurve mit abgesenkter Tonhöhe und langem Hall-Ausklang — für Zeitlupen-/Sterbemomente.' },
  ear_ringing:     { name: '🔔 Tinnitus / Schockzustand', category: 'somatic', description: 'Fast vollständige Taubheit für die Außenwelt (starker Tiefpass) plus ein leises, hochfrequentes Ring-Artefakt als Tinnitus-Ton.' },
  drunk_dizzy:     { name: '🥴 Benommenheit / Schwindel', category: 'somatic', description: 'Sehr langsame, wabernde Filterschwingung (Wah als Phaser-Ersatz) mit warmem Hall — für Trunkenheit oder Schwindel.' },
  asphyxiation:    { name: '👨\u200d🚀 Atemnot / Unter Visier', category: 'somatic', description: 'Näselnde Mittenanhebung und sehr kurzer, enger Kapselhall — für das Sprechen durch Helm, Atemmaske oder Visier.' },
  // ── Übernatürliche & Magische Phänomene ─────────────────────
  dreamy_echo:     { name: '✨ Traumhaftes Echo',     category: 'supernatural', description: 'Weiches, langes Echo mit warmem Hall für traumhafte oder surreale Momente.' },
  possessed:       { name: '👁️ Besessen',            category: 'supernatural', description: 'Metallische Ringmodulation mit hohler Formant-Aussparung und abgesenkter Stimme — für besessene/dämonisch überlagerte Stimmen.' },
  portal_warp:     { name: '🌀 Portal / Dimensionsriss', category: 'supernatural', description: 'Schwingender, schneller Wah- und Flanger-Sweep für das Öffnen eines Portals oder eine Teleportation.' },
  phantom_choir:   { name: '👻 Geisterstimme',       category: 'supernatural', description: 'Mehrstimmig verdoppelte, hallende Chorus-Stimme für Geister oder ätherische Erscheinungen.' },
  mind_control:    { name: '🧠 Telepathie / Im Kopf', category: 'supernatural', description: 'Absolut trockene, extrem nahe und komprimierte Stimme mit breiter Chorus-Verdopplung anstelle von Raumhall — als würde sie direkt im Kopf erklingen.' },
  shadow_realm:    { name: '🌑 Schattenwelt / Astral', category: 'supernatural', description: 'Gedämpfte, dunkle Klangfarbe mit langem, modulierten Hall und leicht abgesenkter Tonhöhe — für die Astralebene oder eine Schattenwelt.' },
  fairy_pixie:     { name: '🧚 Magische Kreatur / Kobold', category: 'supernatural', description: 'Hell angehobene Höhen mit kurzem, glitzerndem Hall und stark erhöhter Tonhöhe — für kleine, magische Wesen.' },
  // ── Kreaturen-Morphs ─────────────────────────────────────────
  monster:         { name: '👹 Monster',             category: 'creature', description: 'Tiefe, verzerrte, gutturale Stimme mit angehobenen Bässen für bedrohliche Kreaturen.' },
  hive_mind:       { name: '🐝 Schwarmbewusstsein',  category: 'creature', description: 'Schnelle Flanger-/Chorus-Modulation mit kurzem Mehrfach-Echo — für insektoide Schwarmwesen mit vielen überlagerten Stimmen.' },
  stone_statue:    { name: '🗿 Steingolem / Lebende Statue', category: 'creature', description: 'Massiv angehobene Tiefen mit hartem Kompressor-Attack, kurzem Stein-Reflexionshall und leicht abgesenkter Tonhöhe — für schwere, lebende Statuen.' }
};

// ─── EFFEKTMODULE, DIE EIN PRESET SETZEN KANN ─────────────────
// Muss synchron mit defaultEffects()/buildEffectChain() in audio.js
// gehalten werden. 'analyzer' bewusst ausgeschlossen: reine
// Visualisierungseinstellung ohne akustische Wirkung, kein Teil eines
// Audio-Effekt-Presets. 'enabled'/'preset' sind Sound-Laufzeitfelder,
// keine Preset-Inhalte.
export const PRESET_EFFECT_KEYS = [
  'lowpass', 'highpass', 'notch', 'wahwah', 'pan',
  'reverb', 'delay', 'chorus', 'flanger', 'tremolo',
  'eq', 'eq10', 'compressor', 'limiter', 'distortion', 'ringmod',
  'pitchShift', 'irReverb', 'envelope', 'spatial', 'noiseGate'
];

// ─── GENERISCHE PRESET-ANWENDUNG (Kap. 6, 17, 21) ─────────────
/**
 * Baut aus einem (Teil-)Effekte-Objekt eines Presets ein vollständiges
 * Effekte-Objekt für einen Sound. Deterministisch (Kap. 21): hängt nur
 * von presetEffects + defaultEffects() ab, NICHT vom bisherigen Zustand
 * des Sounds — nicht im Preset gesetzte Module fallen auf Default zurück,
 * exakt gesetzte Felder werden übernommen. `enabled`/`preset` werden vom
 * Aufrufer gesetzt (hier nicht enthalten).
 */
export function applyPresetEffects(presetEffects) {
  const def = defaultEffects();
  const src = presetEffects || {};
  const out = {};
  for (const key of PRESET_EFFECT_KEYS) {
    if (key === 'pan') { out.pan = typeof src.pan === 'number' ? src.pan : def.pan; continue; }
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

// ─── ÜBERGEORDNETE PRESET-ANWENDUNG AUF EINE SAMMLUNG (Prompt 4) ──
/**
 * Wendet ein Preset auf eine Sammlung von Audio-Objekten (Sounds eines
 * Sound-Profils, Ambient-Tracks einer Szene, Musik-Tracks einer Playlist)
 * an — EINMALIGE zentrale Implementierung (Kap. 12), damit Sound-, Ambient-
 * und Musik-Profile dieselbe Logik verwenden, statt sie dreimal zu
 * duplizieren.
 *
 * Der Aufrufer filtert `items` bereits auf die für den jeweiligen
 * Container relevanten Audioobjekte (z.B. nur `type === 'sound'` bei
 * Sound-Profilen, s. Kap. 7) — diese Funktion arbeitet danach generisch
 * über `item.effects`, unabhängig vom konkreten Container-Typ.
 *
 * @param {object} params
 * @param {object[]} params.items - Audioobjekte mit einer `effects`-
 *   Eigenschaft (wird ggf. neu gesetzt).
 * @param {string} params.presetId - ID eines Built-in- oder User-Presets.
 * @param {'all'|'same'|'none'} params.overwriteMode - Kap. 4:
 *   'all'  = Alle: ersetzt IMMER, auch bereits vorhandene andere Presets.
 *   'same' = Gleiche: Elemente ohne Preset bekommen es; Elemente mit
 *            GENAU diesem Preset werden erneut synchronisiert; alles
 *            andere bleibt unangetastet.
 *   'none' = Keine (Default, Kap. 5): NUR Elemente ohne vorhandenes
 *            Preset bekommen es; alles mit einem Preset bleibt unangetastet.
 * @returns {{changed:number, total:number}} - für eine Erfolgsmeldung im UI.
 */
export function applyPresetToCollection({ items, presetId, overwriteMode }) {
  const preset = presetId ? getPresetById(presetId) : null;
  const list = Array.isArray(items) ? items : [];
  if (!preset) return { changed: 0, total: list.length };

  let changed = 0;
  list.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const hasExisting = !!(item.effects && item.effects.preset);

    let apply;
    if (overwriteMode === 'all') apply = true;
    else if (overwriteMode === 'same') apply = !hasExisting || item.effects.preset === presetId;
    else apply = !hasExisting; // 'none' (Default)

    if (!apply) return;
    // Kap. 6: NIEMALS in ein vorhandenes Effekte-Objekt mergen —
    // applyPresetEffects() liefert eine vollständige, normalisierte
    // Konfiguration, die das alte Effekte-Objekt komplett ersetzt.
    const merged = applyPresetEffects(preset.effects);
    merged.enabled = true;
    merged.preset  = presetId;
    item.effects = merged;
    changed++;
  });
  return { changed, total: list.length };
}

// ─── ZUGRIFF AUF PRESETS (BUILT-IN + USER, EINHEITLICH) ───────

function _ensureUserPresetsArray() {
  if (!Array.isArray(APP.userPresets)) APP.userPresets = [];
  return APP.userPresets;
}

export function getBuiltinPresetIds() { return Object.keys(EFFECT_PRESETS); }

/** Liefert ein einheitliches Preset-Deskriptor-Objekt, egal ob built-in oder User-Preset. */
export function getPresetById(id) {
  if (!id) return null;
  if (Object.prototype.hasOwnProperty.call(EFFECT_PRESETS, id)) {
    const meta = BUILTIN_PRESET_META[id] || { name: id, category: DEFAULT_CATEGORY, description: '' };
    return { id, builtin: true, name: meta.name, category: meta.category, description: meta.description || '', effects: EFFECT_PRESETS[id] };
  }
  const up = _ensureUserPresetsArray().find(p => p.id === id);
  if (up) return { id: up.id, builtin: false, name: up.name, category: up.category || DEFAULT_CATEGORY, description: up.description || '', effects: up.effects };
  return null;
}

/** Alle Presets, built-in zuerst (Original-Reihenfolge), dann eigene. */
export function getAllPresets() {
  const builtins = getBuiltinPresetIds().map(getPresetById);
  const users     = _ensureUserPresetsArray().map(p => getPresetById(p.id));
  return [...builtins, ...users];
}

export function getPresetsByCategory(category) {
  return getAllPresets().filter(p => p.category === category);
}

// ─── VALIDIERUNG / NORMALISIERUNG (Kap. 18, 19, 26) ───────────
// Wertebereiche gespiegelt aus den bestehenden Clamp-Grenzen in
// audio.js (buildEffectChain()/_buildX()-Funktionen) bzw. den
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
  'envelope.attack': [0, 5], 'envelope.decay': [0, 5], 'envelope.sustain': [0, 1], 'envelope.release': [0, 5],
  'spatial.x': [-1000, 1000], 'spatial.y': [-1000, 1000], 'spatial.z': [-1000, 1000],
  'spatial.rolloff': [0, 10], 'spatial.maxDistance': [1, 100000], 'spatial.refDistance': [0, 1000],
  'spatial.coneInnerAngle': [0, 360], 'spatial.coneOuterAngle': [0, 360], 'spatial.coneOuterGain': [0, 1],
  'noiseGate.threshold': [-100, 0], 'noiseGate.attack': [0, 1000], 'noiseGate.release': [0, 2000],
  'pan': [-1, 1]
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
 * geklemmt, unbekannte Felder/Module verworfen). Kap. 19: unbekannte
 * zusätzliche Effektmodule im Rohdaten-Objekt werden dabei stillschweigend
 * ignoriert (nicht Teil von PRESET_EFFECT_KEYS) — der Import wird NICHT
 * abgelehnt, es erscheint aber auch keine Fehlfunktion, da nur bekannte
 * Module überhaupt an die Audio-Engine weitergereicht werden.
 */
export function normalizeEffectsObject(raw) {
  const def = defaultEffects();
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};

  out.pan = _num(src.pan, NUM_RANGES.pan, def.pan);

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

  out.envelope = filt('envelope');
  out.spatial  = filt('spatial');
  out.noiseGate = filt('noiseGate');

  const eq10Src = (src.eq10 && typeof src.eq10 === 'object') ? src.eq10 : {};
  // eq10.bands ist laut audio.js (_buildEQ10/EQ10_FREQS) immer ein flaches
  // Array aus 10 reinen Gain-Werten (dB) für feste Frequenzen — keine
  // Objekte. Jeden Eintrag auf eine gültige Zahl im zulässigen Bereich
  // normalisieren, fehlende/ungültige Einträge auf 0 dB.
  const rawBands = Array.isArray(eq10Src.bands) ? eq10Src.bands : def.eq10.bands;
  const bands = [];
  for (let i = 0; i < 10; i++) bands.push(_num(rawBands[i], [-18, 18], 0));
  out.eq10 = { enabled: _bool(eq10Src.enabled, def.eq10.enabled), bands };

  return out;
}

// ─── USER-PRESET CRUD (Kap. 7, 8, 20) ──────────────────────────

function _sanitizeMeta({ name, category, description }) {
  const cleanName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 60) : 'Eigenes Preset';
  const cleanCategory = Object.prototype.hasOwnProperty.call(PRESET_CATEGORIES, category) ? category : DEFAULT_CATEGORY;
  const cleanDescription = typeof description === 'string' ? description.trim().slice(0, 300) : '';
  return { name: cleanName, category: cleanCategory, description: cleanDescription };
}

/** Neues User-Preset. IDs sind mit 'user_' präfixt — kann nie mit einer
 *  Built-in-ID (EFFECT_PRESETS-Schlüssel aus presets/effect-presets-data.js) kollidieren (Kap. 8). */
export function createUserPreset({ name, category, description, effects }) {
  const meta = _sanitizeMeta({ name, category, description });
  const preset = {
    id: 'user_' + uid(),
    ...meta,
    effects: normalizeEffectsObject(effects),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  _ensureUserPresetsArray().push(preset);
  return preset;
}

export function updateUserPreset(id, { name, category, description, effects } = {}) {
  const p = _ensureUserPresetsArray().find(x => x.id === id);
  if (!p) return null;
  const meta = _sanitizeMeta({ name: name ?? p.name, category: category ?? p.category, description: description ?? p.description });
  Object.assign(p, meta);
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
 *  unverändert (Kap. 20). */
export function duplicatePreset(sourceId, overrideName) {
  const src = getPresetById(sourceId);
  if (!src) return null;
  return createUserPreset({
    name: overrideName || (src.name + ' (Kopie)'),
    category: src.category,
    description: src.description,
    effects: src.effects
  });
}

export function isUserPreset(id) {
  return typeof id === 'string' && _ensureUserPresetsArray().some(p => p.id === id);
}

/**
 * Rückwärtskompatibilität (Kap. 16): migriert die Kategorie bereits
 * gespeicherter User-Presets, falls sich der Kategorie-Schlüssel in einer
 * späteren Version geändert hat (z.B. das alte 3er-Schema 'character' ->
 * neues 6er-Schema). Jede Kategorie, die nicht (mehr) in
 * PRESET_CATEGORIES existiert, fällt auf DEFAULT_CATEGORY zurück, statt
 * beim Rendern stillschweigend aus dem Dropdown zu verschwinden. Von
 * storage.js load() direkt nach dem Einlesen von APP.userPresets
 * aufgerufen; idempotent und ohne Wirkung, wenn nichts zu migrieren ist.
 */
const LEGACY_CATEGORY_MAP = { character: 'supernatural' };

export function migratePresetCategories() {
  const arr = _ensureUserPresetsArray();
  let changed = false;
  for (const p of arr) {
    if (Object.prototype.hasOwnProperty.call(PRESET_CATEGORIES, p.category)) continue;
    p.category = LEGACY_CATEGORY_MAP[p.category] || DEFAULT_CATEGORY;
    changed = true;
  }
  return changed;
}

// ─── IMPORT (aufgerufen von storage.js importData(), Kap. 12-13, 19) ──
// Format-Entscheidung (Kap. 19, dokumentiert): eine importierte Preset-
// Datei mit unbekannten Zusatzfeldern wird NICHT abgelehnt (Felder werden
// ignoriert); eine Datei mit fehlenden Pflichtfeldern (kein `effects`-
// Objekt) WIRD abgelehnt (siehe validatePresetShape unten, von storage.js
// vor dem Aufruf dieser Funktionen genutzt). Eine unbekannte/neuere
// `version` wird nicht hart abgelehnt (Vorwärtskompatibilität) — es wird
// lediglich versucht, effects/Metadaten bestmöglich zu übernehmen; alle
// Werte laufen ohnehin durch normalizeEffectsObject().
// IDs aus der Importdatei werden NIE übernommen (Kap. 13 "Doppelte ID") —
// jeder Import erzeugt immer eine frische ID, genau wie bei den
// bestehenden _importXBundle()-Funktionen in storage.js. Ein gleicher
// Anzeigename führt dadurch nie zu Datenverlust (Kap. 13 "Gleicher Name"):
// das bestehende Preset bleibt unter seiner eigenen ID unangetastet.

export function validatePresetShape(raw) {
  return !!(raw && typeof raw === 'object' && raw.effects && typeof raw.effects === 'object');
}

export function importSinglePresetData(raw) {
  return createUserPreset({
    name: raw?.name,
    category: raw?.category,
    description: raw?.description,
    effects: raw?.effects
  });
}

export function importPresetCollectionData(rawArray) {
  return rawArray.filter(validatePresetShape).map(importSinglePresetData);
}
