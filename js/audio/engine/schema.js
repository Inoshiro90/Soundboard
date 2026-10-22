/**
 * audio/engine/schema.js — Schema-Funktionen auf Basis der Registry (AE-01′, AE-18, AE-19)
 * ----------------------------------------------------------------------------------------
 * Reine Funktionen (kein AudioContext, in Node testbar). Alles Modulwissen kommt aus registry.js.
 *
 * Erweiterungsbeutel `x` (AE-18) — Unbekanntes wird NICHT verworfen, sondern unverändert mitgeführt und exportiert;
 * die Engine ignoriert es:
 *   effects.x = { fields?, stages?, stageFields?, legacyV1? }   (Zusatzfelder, unbekannte Stufen, Rettungsanker)
 *   layer.x   = { modules?, fields? }                           (unbekannte Module in params, Zusatzfelder am Layer)
 *   preset.x  = { modules?, params?, fields? }                  (nur User-Presets; params = unbekannte Felder bekannter Module)
 * Schutz: Schlüssel wie __proto__ werden nie übernommen; ein Beutel ist auf MAX_X_BYTES begrenzt (Überschuss wird
 * gezählt: `__skipped`), damit feindliche Importdateien den localStorage nicht sprengen (B-23).
 */

import {
  MODULES, MODULE_KEYS, MODULE_BY_KEY, NUM_RANGES, REMOVED_KEYS, CURRENT_REV, EXCLUSIVE_GROUPS,
  defaultModule, defaultModules, IR_IMPULSE_NAMES, PEQ_TYPES, PEQ_RANGES, PEQ_MAX_KEEP
} from './registry.js';

export const MAX_X_BYTES = 262144;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const isUnsafeKey = k => UNSAFE_KEYS.has(k);
const clone = x => JSON.parse(JSON.stringify(x));
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// ─── ERWEITERUNGSBEUTEL ─────────────────────────────────────

/** Klont `value` JSON-sicher (undefined/Funktionen entfallen). Gibt `undefined` zurück, wenn nicht klonbar. */
function _safeClone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return undefined; }
}

/** Fügt `entries` (Objekt) in den Beutel `bag` ein; begrenzt auf MAX_X_BYTES. Rückgabe: der Beutel (oder undefined, wenn leer). */
export function addToBag(bag, entries) {
  const out = isObj(bag) ? bag : {};
  let used = JSON.stringify(out).length;
  let skipped = typeof out.__skipped === 'number' ? out.__skipped : 0;
  if (typeof entries?.__skipped === 'number') skipped += entries.__skipped;   // Zähler eines übernommenen Beutels nicht verlieren
  for (const [k, v] of Object.entries(entries || {})) {
    if (isUnsafeKey(k) || k === '__skipped') continue;
    const cv = _safeClone(v);
    if (cv === undefined) { skipped++; continue; }
    const size = k.length + JSON.stringify(cv).length + 4;
    if (used + size > MAX_X_BYTES) { skipped++; continue; }
    out[k] = cv; used += size;
  }
  if (skipped) out.__skipped = skipped;
  return Object.keys(out).length ? out : undefined;
}

/** Entfernt leere Teilbeutel; gibt undefined zurück, wenn nichts übrig bleibt. */
export function cleanX(x) {
  if (!isObj(x)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (isUnsafeKey(k)) continue;
    if (v === undefined) continue;
    if (isObj(v) && !Object.keys(v).length) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Bestehenden Beutel (aus gespeicherten Daten) sicher übernehmen: JSON-Klon, nur Objekte, begrenzt. */
export function inheritX(rawX) {
  if (!isObj(rawX)) return {};
  const out = {};
  for (const [k, v] of Object.entries(rawX)) {
    if (isUnsafeKey(k)) continue;
    if (k === 'legacyV1') { const cv = _safeClone(v); if (cv !== undefined) out.legacyV1 = cv; continue; }
    if (isObj(v)) { const bag = addToBag({}, v); if (bag) out[k] = bag; }
  }
  return out;
}

// ─── ZAHLEN-/FELDNORMALISIERUNG (Importklemmung) ────────────

function _num(val, range, fallback) {
  const n = typeof val === 'number' ? val : parseFloat(val);
  if (!isFinite(n)) return fallback;               // fängt NaN und ±Infinity ab
  const [min, max] = range;
  return Math.max(min, Math.min(max, n));
}
const _bool = (val, fallback) => (typeof val === 'boolean' ? val : fallback);
const _enum = (val, allowed, fallback) => (allowed.includes(val) ? val : fallback);

/**
 * Normalisiert EIN Modul streng gegen die Registry: alle Felder vorhanden, Zahlen geklemmt, Enums gültig.
 * Identisch zum früheren filt()/irReverb/eq10-Zweig von normalizeEffectsObject().
 * @returns {object|null} null bei unbekanntem Modul
 */
/** Ein Band des Parametrischen EQ (10d): bekannte Felder streng, unbekannte Felder bleiben erhalten (AE-18), Prototyp-Schlüssel nie. */
export function normalizePeqBand(b) {
  const s = isObj(b) ? b : {};
  const type = _enum(s.type, PEQ_TYPES, 'bell');
  const o = {};
  for (const [k, v] of Object.entries(s)) if (!['on', 'type', 'freq', 'gain', 'Q'].includes(k) && !['__proto__', 'constructor', 'prototype'].includes(k)) o[k] = v;
  return {
    ...o,
    on: _bool(s.on, true),
    type,
    freq: _num(s.freq, PEQ_RANGES.freq, 1000),
    gain: _num(s.gain, PEQ_RANGES.gain, 0),
    Q: _num(s.Q, PEQ_RANGES.Q, type === 'lowShelf' || type === 'highShelf' ? 0.7 : type === 'lowCut' || type === 'highCut' ? 0.71 : 1)
  };
}

export function normalizeModule(key, raw) {
  const m = MODULE_BY_KEY[key];
  if (!m) return null;
  const d = defaultModule(key);
  const s = isObj(raw) ? raw : {};

  if (key === 'eq10') {
    // Bänder: reine Gain-Zahlen (Built-ins) ODER {freq, gain, Q} (so schreibt der Editor) — beide Formen bleiben erhalten.
    const rawBands = Array.isArray(s.bands) ? s.bands : d.bands;
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
    return { enabled: _bool(s.enabled, d.enabled), bands };
  }

  if (key === 'paramEq') {
    // Bänderliste: bis PEQ_MAX_KEEP Objekte bleiben erhalten (die Engine baut die ersten PEQ_MAX_BUILD); Nicht-Objekte entfallen.
    const rawBands = Array.isArray(s.bands) ? s.bands : d.bands;
    return { enabled: _bool(s.enabled, d.enabled), bands: rawBands.filter(isObj).slice(0, PEQ_MAX_KEEP).map(normalizePeqBand) };
  }

  const o = { enabled: _bool(s.enabled, d.enabled) };
  for (const [field, spec] of Object.entries(m.params)) {
    if (spec.impulse) {
      o[field] = IR_IMPULSE_NAMES.includes(s[field]) ? s[field] : (s[field] == null ? null : d[field]);
    } else if (spec.range) {
      o[field] = _num(s[field], spec.range, d[field]);
    } else if (spec.enum) {
      o[field] = _enum(s[field], spec.enum, d[field]);
    } else {
      o[field] = s[field] ?? d[field];            // raw: wie bisher ohne Klemmung
    }
  }
  return o;
}

/**
 * Normalisiert ein (potenziell nicht vertrauenswürdiges) flaches Effekt-Objekt: alle Registry-Module, geklemmt.
 * Unbekanntes wird NICHT verworfen, sondern in `x` zurückgegeben (AE-18):
 *   x.modules = unbekannte Schlüssel des Objekts (z. B. Module einer neueren Version)
 *   x.params  = unbekannte Felder BEKANNTER Module ({ lowpass: { slope: 24 } })
 * Entfernte Schlüssel (REMOVED_KEYS) und `enabled`/`preset` zählen nicht als unbekannt.
 * @returns {{effects:object, x:object|undefined}}
 */
export function normalizeEffectsObjectX(raw) {
  const src = isObj(raw) ? raw : {};
  const effects = {};
  for (const key of MODULE_KEYS) effects[key] = normalizeModule(key, src[key]);

  const unknownModules = {}, unknownParams = {};
  for (const [k, v] of Object.entries(src)) {
    if (MODULE_BY_KEY[k] || k === 'enabled' || k === 'preset' || REMOVED_KEYS.includes(k) || isUnsafeKey(k)) continue;
    unknownModules[k] = v;
  }
  for (const key of MODULE_KEYS) {
    const s = src[key];
    if (!isObj(s)) continue;
    const spec = MODULE_BY_KEY[key].params;
    const extra = {};
    for (const [f, v] of Object.entries(s)) if (f !== 'enabled' && !(f in spec) && !isUnsafeKey(f)) extra[f] = v;
    if (Object.keys(extra).length) unknownParams[key] = extra;
  }
  const x = cleanX({ modules: addToBag({}, unknownModules), params: addToBag({}, unknownParams) });
  return { effects, x };
}

/** Wie bisher: nur die normalisierten Module (ohne Beutel). */
export function normalizeEffectsObject(raw) { return normalizeEffectsObjectX(raw).effects; }

// ─── LAYER-PARAMETER (Pipeline) ─────────────────────────────

/** Vollständiges Parameterobjekt (alle Registry-Module) aus einem sparsamen/teilweisen. Deterministisch. */
export function fillLayerParams(params) {
  const def = defaultModules();
  const src = (params && typeof params === 'object') ? params : {};
  const out = {};
  for (const key of MODULE_KEYS) {
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

/** Sparsame Form für die Speicherung: nur aktive Module (Defaults ergänzt fillLayerParams()). */
export function sparsifyParams(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const key of MODULE_KEYS) {
    const m = params[key];
    if (m && typeof m === 'object' && m.enabled === true) {
      const c = clone(m);
      for (const u of UNSAFE_KEYS) delete c[u];            // eigene „__proto__“-Schlüssel aus importierten Daten nie speichern/weiterreichen
      out[key] = c;
    }
  }
  return out;
}

/**
 * Wie sparsifyParams(), liefert zusätzlich die UNBEKANNTEN Schlüssel der Parameter (Module einer neueren Version) als
 * Beutel `x.modules`. Entfernte Schlüssel (REMOVED_KEYS) werden bewusst verworfen.
 * @returns {{sparse:object, x:object|undefined}}
 */
export function splitLayerParams(params) {
  const sparse = sparsifyParams(params);
  const unknown = {};
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (MODULE_BY_KEY[k] || REMOVED_KEYS.includes(k) || isUnsafeKey(k)) continue;
      unknown[k] = v;
    }
  }
  return { sparse, x: cleanX({ modules: addToBag({}, unknown) }) };
}

/** Schlüssel der aktiven Module in Registry-Reihenfolge. Wahrheitswert wie in der Engine (`if (effects.x?.enabled)`). */
export function activeKeys(params) {
  if (!params) return [];
  return MODULE_KEYS.filter(k => !!params[k]?.enabled);
}

// ─── STUFENVORSCHLAG ────────────────────────────────────────

/** Punkte je Stufe aus den Registry-`stageHint`s aller aktiven Module: { source, medium, environment }. */
export function stageScores(params) {
  const p = fillLayerParams(params);
  const sc = { source: 0, medium: 0, environment: 0 };
  for (const m of MODULES) {
    if (!p[m.key].enabled || !m.stageHint) continue;
    const h = typeof m.stageHint === 'function' ? m.stageHint(p[m.key]) : m.stageHint;
    if (h && h.stage in sc) sc[h.stage] += h.weight;
  }
  return sc;
}

// ─── EXKLUSIVGRUPPEN (B-02) ─────────────────────────────────

/**
 * Welche aktiven Module werden von einem Vorrangmodul ihrer Gruppe überlagert (und daher von der Engine NICHT gebaut)?
 * @returns {{group:string, active:string, shadowed:string}[]}
 */
export function shadowed(params) {
  const out = [];
  for (const g of EXCLUSIVE_GROUPS) {
    const on = g.members.filter(k => !!params?.[k]?.enabled);   // Wahrheitswert wie die else-if-Kette in _collectSegments()
    for (let i = 1; i < on.length; i++) out.push({ group: g.id, active: on[0], shadowed: on[i] });
  }
  return out;
}

/** Aktive Module ohne die überlagerten = die Module, die tatsächlich klingen. */
export function effectiveActiveKeys(params) {
  const dead = new Set(shadowed(params).map(s => s.shadowed));
  return activeKeys(params).filter(k => !dead.has(k));
}

// ─── REVISION (AE-19) ───────────────────────────────────────

/** Migrationen innerhalb von v:2: { <vonRev>: fn(effects) → effects }. Heute leer (CURRENT_REV = 1). */
export const REV_MIGRATIONS = {};

/** Gültige Revision aus Rohdaten: ganze Zahl ≥ 1, sonst 1. */
export function readRev(raw) {
  const r = raw?.rev;
  return Number.isInteger(r) && r >= 1 ? r : 1;
}

/**
 * Wendet alle Migrationen von `rev` bis CURRENT_REV an. Neuere Revisionen (rev > CURRENT_REV) werden NICHT angefasst
 * (Vorwärtskompatibilität: die Daten stammen aus einer neueren App-Version).
 */
export function migrateRev(fx) {
  let rev = readRev(fx);
  while (rev < CURRENT_REV) {
    const step = REV_MIGRATIONS[rev];
    if (step) fx = step(fx);
    rev++;
    fx.rev = rev;
  }
  return fx;
}

// ─── DIAGNOSE / TEST-HELFER ─────────────────────────────────

/** Felder aktiver Module, die vom Default abweichen: { lowpass: { frequency: 800 } } (Größe/Diff-Anzeige). */
export function diffToDefaults(params) {
  const out = {};
  for (const key of activeKeys(params)) {
    const d = defaultModule(key), m = params[key], diff = {};
    for (const f of Object.keys(m)) if (f !== 'enabled' && JSON.stringify(m[f]) !== JSON.stringify(d[f])) diff[f] = m[f];
    out[key] = diff;
  }
  return out;
}

/** Prüft ein Parameterobjekt: unbekannte Module, Werte außerhalb der Bereiche. Liefert Textmeldungen (leer = gültig). */
export function validate(params) {
  const problems = [];
  if (!isObj(params)) return ['kein Objekt'];
  for (const [k, v] of Object.entries(params)) {
    if (!MODULE_BY_KEY[k]) { problems.push(`unbekanntes Modul: ${k}`); continue; }
    if (!isObj(v)) { problems.push(`${k}: kein Objekt`); continue; }
    for (const [f, spec] of Object.entries(MODULE_BY_KEY[k].params)) {
      const val = v[f];
      if (val === undefined) continue;
      if (spec.range && !(typeof val === 'number' && val >= spec.range[0] && val <= spec.range[1])) problems.push(`${k}.${f}: ${JSON.stringify(val)} außerhalb ${JSON.stringify(spec.range)}`);
      if (spec.enum && !spec.enum.includes(val)) problems.push(`${k}.${f}: ${JSON.stringify(val)} nicht in ${JSON.stringify(spec.enum)}`);
    }
  }
  return problems;
}

export { NUM_RANGES, MODULES, MODULE_KEYS, REMOVED_KEYS, CURRENT_REV };
