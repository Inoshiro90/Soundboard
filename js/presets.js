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
import { MODULE_KEYS } from './audio/engine/registry.js';
import {
  fillLayerParams, normalizeEffectsObject as _normalizeEffectsObject, normalizeEffectsObjectX, addToBag, cleanX, inheritX, isUnsafeKey
} from './audio/engine/schema.js';
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
// Abgeleitet aus der Modul-Registry (audio/engine/registry.js, AE-01′) — nicht von Hand pflegen. Hüllkurve, Pan und
// Analyzer gehören nicht (mehr) zum Pipeline-Modell; solche Schlüssel in alten Preset-Daten werden bewusst ignoriert
// (REMOVED_KEYS). 'enabled'/'preset' sind Sound-Laufzeitfelder, keine Preset-Inhalte.
export const PRESET_EFFECT_KEYS = MODULE_KEYS.slice();

// ─── GENERISCHE PRESET-ANWENDUNG ─────────────────────────────
// Baut aus einem (Teil-)Effekte-Objekt eines Presets ein vollständiges
// Effekte-Objekt für einen Sound. Deterministisch: hängt nur von presetEffects +
// defaultEffects() ab, NICHT vom bisherigen Zustand des Sounds — nicht im
// Preset gesetzte Module fallen auf Default zurück, exakt gesetzte Felder werden
// übernommen. `enabled`/`preset` werden vom Aufrufer gesetzt (hier nicht enthalten).
export function applyPresetEffects(presetEffects) {
  return fillLayerParams(presetEffects);
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
  const params = sparsifyParams(full);
  // Beutel (AE-18): unbekannte Felder bekannter Module wandern in aktive Module des Layers, unbekannte Module in layer.x
  for (const [k, extra] of Object.entries(preset.x?.params || {})) {
    if (k !== '__skipped' && params[k] && extra && typeof extra === 'object') Object.assign(params[k], JSON.parse(JSON.stringify(extra)));
  }
  const init = { presetId, params };
  if (preset.x?.modules) init.x = { modules: preset.x.modules };
  return { init, preset };
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
    return { id: up.id, builtin: false, name: up.name, stage: st.stage, group: up.group || up.category || DEFAULT_GROUP, stageAuto: st.auto, description: up.description || '', effects: up.effects, ...(up.x ? { x: up.x } : {}) };
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

/**
 * Nimmt beliebiges (potenziell nicht vertrauenswürdiges, z.B. importiertes) Rohdaten-Objekt entgegen und liefert ein
 * vollständiges, garantiert gültiges Effekte-Objekt (alle Registry-Module, alle Zahlenwerte geklemmt). Die Bereiche und
 * Regeln stehen in der Registry (audio/engine/registry.js) und im Schema (audio/engine/schema.js).
 * Unbekannte Module/Felder fließen NICHT in dieses Ergebnis (die Engine bekäme sie nicht); sie bleiben über
 * normalizeEffectsObjectX() im Erweiterungsbeutel erhalten (User-Presets: `preset.x`, AE-18).
 */
export function normalizeEffectsObject(raw) {
  return _normalizeEffectsObject(raw);
}

// ─── USER-PRESET CRUD ──────────────────────────

function _sanitizeMeta({ name, group, category, stage, description }) {
  const cleanName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 60) : 'Eigenes Preset';
  const g = group ?? category;
  const cleanGroup = Object.prototype.hasOwnProperty.call(PRESET_GROUPS, g) ? g : DEFAULT_GROUP;
  const cleanDescription = typeof description === 'string' ? description.trim().slice(0, 300) : '';
  return { name: cleanName, group: cleanGroup, stage: isStageKey(stage) ? stage : null, description: cleanDescription };
}

// Bekannte Felder einer Preset-Datei/eines User-Presets; alles andere (z. B. Makros, `engine` einer neueren Version)
// wird im Beutel `x.fields` erhalten und beim Export wieder ausgegeben.
const _KNOWN_PRESET_FIELDS = new Set(['kind', 'id', 'name', 'group', 'category', 'stage', 'stageAuto', 'description', 'effects', 'version', 'createdAt', 'updatedAt', 'x']);

/** Beutel eines Presets aus (a) unbekannten Teilen der Effekte, (b) einem bestehenden Beutel, (c) unbekannten Preset-Feldern. */
function _presetBag({ ex, xIn, fields }) {
  const base = inheritX(xIn);
  return cleanX({
    modules: addToBag(addToBag({}, base.modules), ex?.modules),
    params:  addToBag(addToBag({}, base.params),  ex?.params),
    fields:  addToBag(addToBag({}, base.fields),  fields)
  });
}

function _unknownPresetFields(raw) {
  const out = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (!_KNOWN_PRESET_FIELDS.has(k) && !isUnsafeKey(k)) out[k] = v;
  return out;
}

/**
 * Form für den Export (JSON-Datei): die Effekte enthalten wieder die unbekannten Module/Felder (wie in der
 * Originaldatei), Zusatzfelder stehen auf oberster Ebene. Ältere App-Versionen ignorieren, was sie nicht kennen.
 */
export function presetEffectsForExport(p) {
  const eff = JSON.parse(JSON.stringify(p.effects || {}));
  for (const [k, extra] of Object.entries(p.x?.params || {})) if (k !== '__skipped' && eff[k] && typeof eff[k] === 'object') Object.assign(eff[k], JSON.parse(JSON.stringify(extra)));
  for (const [k, v] of Object.entries(p.x?.modules || {})) if (k !== '__skipped' && !(k in eff)) eff[k] = JSON.parse(JSON.stringify(v));
  return eff;
}
export function presetFieldsForExport(p) {
  const out = {};
  for (const [k, v] of Object.entries(p.x?.fields || {})) if (k !== '__skipped' && !_KNOWN_PRESET_FIELDS.has(k)) out[k] = JSON.parse(JSON.stringify(v));
  return out;
}

/** Neues User-Preset. IDs sind mit 'user_' präfixt — kann nie mit einer
 *  Built-in-ID (EFFECT_PRESETS-Schlüssel aus presets/effect-presets-data.js) kollidieren.
 *  `stage` ist Pflicht-Metadatum (Rolle in der Pipeline); fehlt sie, wird sie aus den Parametern vorgeschlagen und
 *  das Preset mit stageAuto:true markiert („Stufe prüfen“). */
export function createUserPreset({ name, group, category, stage, description, effects, x, fields }) {
  const meta = _sanitizeMeta({ name, group, category, stage, description });
  const { effects: normEffects, x: ex } = normalizeEffectsObjectX(effects);
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
  const bag = _presetBag({ ex, xIn: x, fields });
  if (bag) preset.x = bag;
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
  if (effects) {
    const { effects: ne, x: ex } = normalizeEffectsObjectX(effects);
    p.effects = ne;
    const bag = _presetBag({ ex, xIn: p.x });          // bestehende unbekannte Teile bleiben erhalten (AE-18)
    if (bag) p.x = bag; else delete p.x;
  }
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
    effects: src.effects,
    x: src.x
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
// abgelehnt; unbekannte Module/Felder bleiben im Beutel `x` erhalten (AE-18, Phase 2); eine Datei mit fehlenden Pflichtfeldern
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
    effects: raw?.effects,
    x: raw?.x,
    fields: _unknownPresetFields(raw)
  });
  p.stageAuto = !!auto;
  return p;
}

export function importPresetCollectionData(rawArray) {
  return rawArray.filter(validatePresetShape).map(importSinglePresetData);
}
