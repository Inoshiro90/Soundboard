/**
 * fx-model.js — Anwendungsschicht des Pipeline-Datenmodells (effects v2)
 * ----------------------------------------------------------------------
 * Verbindet den reinen Pipeline-Kern (audio/fx-pipeline.js) mit dem Preset-Katalog (presets.js):
 *   - normalizeEffectsV2()      Struktur + Wertebereiche eines v2-Objekts (Import/Laden)
 *   - migrateEffectsV1toV2()    flaches Alt-Objekt (effects.preset + Module) → Pipeline
 *   - ensureEffectsV2()         idempotent: v2 normalisieren, v1 migrieren, Unbekanntes → Default
 *   - addPresetLayer()          Preset als eigene Layer-Instanz in seine Stufe einfügen
 *   - applyPipelineToCollection()  „Preset auf Sammlung anwenden“ (Profil/Szene/Playlist)
 *
 * Migrationsprinzip: Klangcharakter vor Bit-Identität. Ein v1-Objekt wird NIE auf mehrere Layer aufgeteilt
 * (Presets bleiben künstlerische Einheiten): genau EIN Layer, in der Stufe des Presets, mit allen aktiven Modulen.
 * Die alte feste Modulreihenfolge bleibt dadurch innerhalb des Layers exakt erhalten. Automatische Zuordnungen
 * ohne eindeutige Quelle (kein/gelöschtes Preset) werden mit stageAuto:true markiert („Stufe prüfen“).
 */

import {
  PIPELINE_VERSION, STAGE_ORDER, normalizePipelineStructure, defaultPipelineEffects, makeLayer,
  fillLayerParams, sparsifyParams, hasActiveModules, suggestStageForParams, isStageKey
} from './audio/fx-pipeline.js';
import { getPresetById, presetToLayerInit } from './presets.js';


// ─── NORMALISIERUNG (v2) ─────────────────────────────────────

/**
 * Struktur (fx-pipeline.normalizePipelineStructure). Bewusst KEINE Klemmung der Parameterwerte: Built-in-Presets
 * enthalten Werte außerhalb der Editor-Bereiche (z. B. flanger.rate 14), die bisher unverändert klangen — sie
 * dürfen beim Migrieren/Laden nicht verändert werden („Klangcharakter vor Bit-Identität“). Die Klemmung bleibt dem
 * Import fremder Preset-Dateien vorbehalten (presets.js normalizeEffectsObject).
 */
export function normalizeEffectsV2(raw) {
  return normalizePipelineStructure(raw);
}

/** v2-Objekt für Wiedergabe/Export: v2 unverändert (kein Kopieren/Umsortieren), alles andere wird migriert. */
export function asPipelineEffects(fx) {
  return (fx && typeof fx === 'object' && fx.v === PIPELINE_VERSION) ? fx : ensureEffectsV2(fx);
}

// ─── MIGRATION v1 → v2 ───────────────────────────────────────

/**
 * @param {object} v1  altes flaches Effekt-Objekt (`preset`, `enabled`, `pan`, Module, `envelope`, `analyzer`)
 * @returns {object}   v2-Objekt. Reine Funktion (verändert `v1` nicht); wirft nie.
 */
export function migrateEffectsV1toV2(v1) {
  const src = (v1 && typeof v1 === 'object') ? v1 : {};
  const out = defaultPipelineEffects();

  // Alte Hüllkurve (`envelope`), Pan (`pan`) und Analyzer (`analyzer`) gehören nicht mehr zum Modell: sie werden
  // bewusst verworfen (das Original bleibt im Backup <STORAGE_KEY>:pre-pipeline erhalten, s. storage/migration.js).
  out.enabled = src.enabled === true;

  const params = sparsifyParams(fillLayerParams(src));
  const presetId = (typeof src.preset === 'string' && src.preset) ? src.preset : null;
  const preset = presetId ? getPresetById(presetId) : null;

  if (preset) {
    // Preset-Layer in der Stufe des Presets. Weichen die Parameter vom Katalog ab, zeigt die UI „angepasst“.
    out.stages[preset.stage].layers.push(makeLayer({ presetId, params, stageAuto: preset.stageAuto === true }));
  } else if (hasActiveModules(params)) {
    // Kein (oder ein gelöschtes) Preset: manueller Layer; Stufe nur vorgeschlagen → „Stufe prüfen“.
    out.stages[suggestStageForParams(params)].layers.push(makeLayer({ presetId: null, params, stageAuto: true }));
  }
  if (presetId) out.legacy = { preset: presetId };
  return normalizeEffectsV2(out);
}

/** Idempotent: v2 → normalisiert; v1/Unbekanntes → migriert. Gibt immer ein gültiges v2-Objekt zurück. */
export function ensureEffectsV2(fx) {
  if (fx && typeof fx === 'object' && fx.v === PIPELINE_VERSION) return normalizeEffectsV2(fx);
  return migrateEffectsV1toV2(fx);
}

// ─── LAYER-OPERATIONEN MIT PRESET-BEZUG ──────────────────────

/**
 * Fügt ein Preset als NEUE Layer-Instanz ein (dasselbe Preset darf mehrfach vorkommen).
 * Stufe = Stufe des Presets (oder `opts.stage`), Position = Ende (oder `opts.index`).
 * @returns {{layer:object, stage:string}|null}
 */
export function addPresetLayer(effects, presetId, opts = {}) {
  const r = presetToLayerInit(presetId);
  if (!r) return null;
  const stage = isStageKey(opts.stage) ? opts.stage : r.preset.stage;
  const layer = makeLayer({ ...r.init, stageAuto: r.preset.stageAuto === true && !isStageKey(opts.stage) });
  const arr = effects.stages[stage].layers;
  if (Number.isInteger(opts.index) && opts.index >= 0 && opts.index <= arr.length) arr.splice(opts.index, 0, layer); else arr.push(layer);
  return { layer, stage };
}

/** Manueller Layer (presetId null) mit eigenen Einstellungen — eigene Instanz in der Reihenfolge. */
export function addManualLayer(effects, stage, params = {}, index) {
  if (!isStageKey(stage)) throw new Error('Unbekannte Stufe: ' + stage);
  const layer = makeLayer({ presetId: null, params });
  const arr = effects.stages[stage].layers;
  if (Number.isInteger(index) && index >= 0 && index <= arr.length) arr.splice(index, 0, layer); else arr.push(layer);
  return layer;
}

// ─── PRESET AUF SAMMLUNG ANWENDEN ────────────────────────────

/**
 * Wendet ein Preset auf mehrere Sounds/Ambient-Tracks/Musik-Tracks an. Das Preset ersetzt NUR die Layer seiner
 * eigenen Stufe (durch genau eine Layer-Instanz); die übrigen drei Stufen und die Reihenfolge darin bleiben
 * unangetastet. `enabled` wird gesetzt. Modi (unverändert in der Bedeutung, bezogen auf die Stufe des Presets):
 *   'all'  immer · 'same' Stufe ohne Preset-Layer ODER mit genau diesem Preset · 'none' nur Stufe ohne Preset-Layer
 * Manuelle Layer zählen nicht als „vorhandenes Preset“.
 */
export function applyPipelineToCollection({ items, presetId, overwriteMode }) {
  const preset = presetId ? getPresetById(presetId) : null;
  const list = Array.isArray(items) ? items : [];
  if (!preset) return { changed: 0, total: list.length };
  const stage = preset.stage;

  let changed = 0;
  list.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const fx = ensureEffectsV2(item.effects);
    const layers = fx.stages[stage].layers;
    const hasExisting = layers.some(l => l.presetId);

    let apply;
    if (overwriteMode === 'all') apply = true;
    else if (overwriteMode === 'same') apply = !hasExisting || layers.some(l => l.presetId === presetId);
    else apply = !hasExisting;
    if (!apply) { item.effects = fx; return; }

    fx.stages[stage].layers = [];
    fx.stages[stage].enabled = true;
    addPresetLayer(fx, presetId, { stage });
    fx.enabled = true;
    item.effects = fx;
    changed++;
  });
  return { changed, total: list.length };
}

/** Kompatibilitätsname (frühere Signatur in presets.js). */
export const applyPresetToCollection = applyPipelineToCollection;

/** True, wenn irgendein Layer des Objekts auf ein Preset verweist (Ersatz für das frühere `effects.preset`). */
export function hasPresetLayer(fx) {
  return !!fx && fx.v === PIPELINE_VERSION && STAGE_ORDER.some(s => fx.stages[s].layers.some(l => l.presetId));
}

/** Kurzbeschreibung der Pipeline für Statusanzeigen: „Quelle 2 · Medium 1“. Aktive Stufen mit Layern. */
export function summarizePipeline(fx, labels) {
  if (!fx || fx.v !== PIPELINE_VERSION) return '';
  return STAGE_ORDER
    .filter(s => fx.stages[s].enabled && fx.stages[s].layers.some(l => l.enabled))
    .map(s => `${labels?.[s]?.label || s} ${fx.stages[s].layers.filter(l => l.enabled).length}`)
    .join(' · ');
}
