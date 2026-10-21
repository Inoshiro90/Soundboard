/**
 * audio/engine/macros.js — Makro-Regler für Presets (Phase 9, AE-11)
 * -------------------------------------------------------------------
 * Reine Funktionen (kein DOM, kein AudioContext, in Node testbar). Ein Makro ist ein Regler 0…1, der mehrere Parameter
 * EINES Layers gleichzeitig setzt. Die Engine kennt Makros nicht: das Auflösen schreibt „gebacken“ in die Layer-Parameter.
 *
 * Datenform (Teil eines Presets, `preset.macros`):
 *   [{ id, label, targets: [{ path: 'modul.parameter', von, bis, kurve?: 'lin'|'log' }] }]
 *   • `path` zeigt auf einen Zahlparameter eines Registry-Moduls. Unbekannte Module/Parameter bleiben erhalten, werden
 *     aber nie angewendet (Datenerhalt, AE-18).
 *   • Wert = von → bis über t (0…1), linear oder logarithmisch (log braucht von, bis > 0), auf den Registry-Bereich geklemmt.
 *   • Entscheidung D (Phase 9): Ein Makro schaltet NIE ein Modul ein. Ziele ausgeschalteter Module werden übersprungen.
 *   • Startposition (Entscheidung B): kein Wert wird beim Anwenden eines Presets geschrieben; die Position des Reglers wird
 *     aus dem ersten anwendbaren Ziel zurückgerechnet (`macroPosition`). Erst die Bedienung schreibt Werte.
 *
 * Normalisierung verwirft nichts still: strukturell ungültige Einträge landen in `rejected` und werden vom Aufrufer im
 * Erweiterungsbeutel des Presets aufbewahrt; unbekannte Zusatzfelder gültiger Einträge bleiben am Eintrag erhalten.
 */

import { MODULE_BY_KEY } from './registry.js';
import { resolveParamUi } from '../../ui/effects/control-math.js';

export const MAX_MACROS = 8;
export const MAX_TARGETS = 8;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PATH_RE = /^([A-Za-z][A-Za-z0-9]{0,39})\.([A-Za-z][A-Za-z0-9]{0,39})$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = x => JSON.parse(JSON.stringify(x));
const clamp01 = t => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0);
const roundTo = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f; };

/** 'lowpass.frequency' → { module, param } oder null. */
export function parsePath(path) {
  const m = typeof path === 'string' ? PATH_RE.exec(path) : null;
  return m ? { module: m[1], param: m[2] } : null;
}

function _extras(src, known) {
  const out = {};
  for (const [k, v] of Object.entries(src)) if (!known.has(k) && !UNSAFE.has(k)) out[k] = v;
  return out;
}
const _KNOWN_TARGET = new Set(['path', 'von', 'bis', 'kurve']);
const _KNOWN_MACRO = new Set(['id', 'label', 'targets']);

function _normTarget(raw) {
  if (!isObj(raw) || !parsePath(raw.path) || !Number.isFinite(raw.von) || !Number.isFinite(raw.bis)) return null;
  let kurve = raw.kurve === 'log' ? 'log' : 'lin';
  if (kurve === 'log' && !(raw.von > 0 && raw.bis > 0)) kurve = 'lin';
  const out = { ..._safeClone(_extras(raw, _KNOWN_TARGET)), path: raw.path, von: raw.von, bis: raw.bis };
  if (kurve === 'log') out.kurve = 'log';
  return out;
}
function _safeClone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return {}; } }

/**
 * Validiert eine Makro-Liste. `macros`: strukturell gültige (Reihenfolge erhalten, höchstens MAX_MACROS, eindeutige ids);
 * `rejected`: alles andere (unverändert geklont, damit der Aufrufer es aufbewahren kann).
 */
export function normalizeMacros(raw) {
  const macros = [], rejected = [];
  if (raw === undefined || raw === null) return { macros, rejected };
  if (!Array.isArray(raw)) return { macros, rejected: [_safeClone(raw)] };
  const seen = new Set();
  for (const m of raw) {
    let ok = isObj(m) && typeof m.id === 'string' && ID_RE.test(m.id) && !UNSAFE.has(m.id) && !seen.has(m.id)
      && typeof m.label === 'string' && m.label.trim() && Array.isArray(m.targets) && m.targets.length >= 1 && macros.length < MAX_MACROS;
    let targets = [];
    if (ok) {
      if (m.targets.length > MAX_TARGETS) ok = false;
      else { targets = m.targets.map(_normTarget); if (targets.some(t => !t)) ok = false; }
    }
    if (!ok) { rejected.push(_safeClone(m)); continue; }
    seen.add(m.id);
    macros.push({ ..._safeClone(_extras(m, _KNOWN_MACRO)), id: m.id, label: m.label.trim().slice(0, 40), targets });
  }
  return { macros, rejected };
}

/** Registry-Beschreibung eines Ziels, falls es ein bekannter, stetiger Zahlparameter ist; sonst null. */
export function targetSpec(target) {
  const p = parsePath(target?.path);
  const spec = p ? MODULE_BY_KEY[p.module]?.params?.[p.param] : null;
  if (!spec || !Array.isArray(spec.range) || spec.enum || spec.impulse || spec.bands) return null;
  return { module: p.module, param: p.param, spec };
}

/** Anwendbar = bekannter Parameter UND das Modul ist im Layer eingeschaltet (Makros schalten nie ein). */
export function isTargetApplicable(target, params) {
  const s = targetSpec(target);
  return !!s && params?.[s.module]?.enabled === true;
}
export const applicableTargets = (macro, params) => (macro?.targets || []).filter(t => isTargetApplicable(t, params));

function _digits(spec) {
  try { const u = resolveParamUi(spec); return u.hidden ? 4 : u.fineDigits; } catch (e) { return 4; }
}

/** Zielwert für Position t (0…1): Kurve, Klemmung auf den Registry-Bereich, Rundung auf die feinste Reglerauflösung. */
export function macroTargetValue(target, t) {
  const s = targetSpec(target); if (!s) return null;
  const x = clamp01(t);
  const raw = (target.kurve === 'log' && target.von > 0 && target.bis > 0)
    ? target.von * (target.bis / target.von) ** x
    : target.von + (target.bis - target.von) * x;
  const [lo, hi] = s.spec.range;
  return roundTo(Math.min(hi, Math.max(lo, raw)), _digits(s.spec));
}

/** Umkehrung: Position 0…1, bei der das Ziel `value` annimmt (außerhalb von von…bis → Rand). */
export function targetPosition(target, value) {
  if (!Number.isFinite(value)) return null;
  const { von, bis } = target;
  if (von === bis) return 0;
  const p = (target.kurve === 'log' && von > 0 && bis > 0 && value > 0)
    ? Math.log(value / von) / Math.log(bis / von)
    : (value - von) / (bis - von);
  return clamp01(p);
}

/** Startposition eines Makros aus dem ersten anwendbaren Ziel; null, wenn kein Ziel anwendbar ist (Regler deaktiviert). */
export function macroPosition(macro, params) {
  const t = applicableTargets(macro, params)[0];
  if (!t) return null;
  const s = targetSpec(t);
  return targetPosition(t, params[s.module][s.param]);
}

/**
 * Wendet das Makro bei Position t auf VOLLSTÄNDIGE Layer-Parameter an (Kopie; Eingabe bleibt unverändert).
 * Rückgabe: { params, written: { 'modul.parameter': wert } } — `written` dient der UI, um spätere manuelle Änderungen zu erkennen.
 */
export function resolveMacro(macro, t, params) {
  const out = clone(params || {});
  const written = {};
  for (const target of applicableTargets(macro, out)) {
    const s = targetSpec(target);
    const v = macroTargetValue(target, t);
    out[s.module][s.param] = v;
    written[target.path] = v;
  }
  return { params: out, written };
}

/** Stimmen die geschriebenen Werte noch mit den aktuellen Parametern überein? (false → Makro durch manuelle Änderung gelöst) */
export function writtenStillValid(macro, written, params) {
  const now = applicableTargets(macro, params);
  const keys = Object.keys(written || {});
  if (now.length !== keys.length) return false;
  for (const t of now) {
    const s = targetSpec(t);
    const w = written[t.path], c = params[s.module][s.param];
    if (!Number.isFinite(w) || !Number.isFinite(c) || Math.abs(w - c) > 1e-9 * Math.max(1, Math.abs(w))) return false;
  }
  return true;
}
