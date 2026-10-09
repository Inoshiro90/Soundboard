/**
 * events/register-preset-events.js — Eigene Audio-Effekt-Presets:
 * Speichern/Bearbeiten/Duplizieren/Löschen/Export/Import, Preset-Meta-Modal
 *
 * Die Verwaltung ist in den kontextuellen Ablauf des Pipeline-Editors eingebettet (kein globaler „Layer-Preset“-Bereich):
 *   • Layer-Modal (#fxLayerModal): „Als eigenes Preset speichern“, Preset-Details, Duplizieren, Löschen, Export
 *     — jeweils für das Preset des gerade bearbeiteten Layers.
 *   • Preset-Picker (#fxPresetPickerModal): dieselben Aktionen je Preset-Zeile sowie Import und „Alle exportieren“.
 *   • #fxPresetMetaModal: Name/Stufe/Gruppe/Beschreibung (Titel nennt die Aufgabe).
 */

import { toast } from '../notifications.js';
import {
  getPresetById, createUserPreset, updateUserPreset, deleteUserPreset,
  duplicatePreset, isUserPreset, PRESET_GROUPS
} from '../presets.js';
import { STAGE_ORDER } from '../audio/fx-pipeline.js';
import { exportPreset, exportUserPresets, importData } from '../storage/import-export.js';
import { _saveRaw } from '../storage/persistence.js';
import {
  currentLayerEffects, currentLayerStage, currentLayerPresetId, isLayerModalOpen,
  adoptPresetInLayerModal, refreshPresetViews
} from '../dialogs/fx-pipeline-modals.js';

export let _fxPresetMetaMode   = 'create'; // 'create' | 'edit'
export let _fxPresetMetaEditId = null;
let _metaIncludeLayerValues = false;       // speichert das Meta-Modal zusätzlich die Werte des Layers im Layer-Modal?

/**
 * Blendet Bearbeiten/Duplizieren/Löschen/Export im Layer-Modal je nach Preset des bearbeiteten Layers ein/aus
 * (Built-ins dürfen nicht bearbeitet/gelöscht werden, aber dupliziert/exportiert). Ohne Argument: Preset des Layers.
 */
export function updateFxPresetActionButtons(presetId) {
  const val = presetId === undefined ? currentLayerPresetId() : (presetId || '');
  const known = !!val && !!getPresetById(val);
  const isUser = known && isUserPreset(val);
  const set = (id, show) => { const b = document.getElementById(id); if (b) b.hidden = !show; };
  set('btnFxPresetEdit', isUser);
  set('btnFxPresetDelete', isUser);
  set('btnFxPresetDuplicate', known);
  set('btnFxPresetExport', known);
}

export function _openFxPresetMetaModal(mode, prefill, { includeLayerValues = false } = {}) {
  _fxPresetMetaMode   = mode;
  _fxPresetMetaEditId = mode === 'edit' ? prefill.id : null;
  _metaIncludeLayerValues = includeLayerValues;
  const titleEl = document.getElementById('fxPresetMetaModalTitle');
  if (titleEl) titleEl.textContent = mode === 'edit' ? 'Preset-Details bearbeiten' : 'Als eigenes Preset speichern';
  const scope = document.getElementById('fxPresetMetaScope');
  if (scope) scope.textContent = includeLayerValues
    ? 'Gespeichert werden diese Angaben und die aktuellen Einstellungen des Layers.'
    : 'Gespeichert werden nur diese Angaben; die Effektwerte des Presets bleiben unverändert.';
  const nameEl = document.getElementById('fxPresetNameInput');
  const catEl  = document.getElementById('fxPresetCategoryInput');
  const stageEl = document.getElementById('fxPresetStageInput');
  const stageHint = document.getElementById('fxPresetStageHint');
  const descEl = document.getElementById('fxPresetDescInput');
  if (nameEl) nameEl.value = prefill?.name || '';
  const grp = prefill?.group || prefill?.category;
  if (catEl)  catEl.value  = grp && PRESET_GROUPS[grp] ? grp : 'supernatural';
  // Stufe: aus dem Preset, sonst aus der Stufe des bearbeiteten Layers; Pflichtmetadatum jedes Presets.
  if (stageEl) stageEl.value = STAGE_ORDER.includes(prefill?.stage) ? prefill.stage : (currentLayerStage() || 'medium');
  if (stageHint) stageHint.hidden = !prefill?.stageAuto;
  if (descEl) descEl.value = prefill?.description || '';
  const modalEl = document.getElementById('fxPresetMetaModal');
  // Fokus erst NACH dem Einblenden setzen (shown.bs.modal): Bootstraps Fokusfalle fokussiert am Ende
  // der Einblend-Animation das Modal selbst und überschriebe einen früheren (Timeout-)Fokus.
  modalEl.addEventListener('shown.bs.modal', () => nameEl?.focus(), { once: true });
  // Wiederverwendete Instanz statt `new Modal()` bei jedem Öffnen: sonst sammeln sich bei jedem
  // Öffnen weitere Escape-/Backdrop-Listener am Modal an.
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

/** Einstellungen des im Layer-Modal bearbeiteten Layers (alle Layer-Module) als Preset-Effekte-Objekt. */
export function _currentEffectsForPreset() { return currentLayerEffects(); }

/** Aktionen auf einem Preset (Layer-Modal UND Preset-Picker nutzen dieselben Funktionen). */
export const presetActions = {
  /** Metadaten eigener Presets bearbeiten (optional mit den Werten des gerade bearbeiteten Layers). */
  edit(id, { includeLayerValues = false } = {}) {
    if (!id || !isUserPreset(id)) return;
    const p = getPresetById(id); if (!p) return;
    _openFxPresetMetaModal('edit', p, { includeLayerValues });
  },
  /** Duplizieren: Original (auch ein Built-in) bleibt unverändert; Ergebnis ist immer ein neues User-Preset. */
  duplicate(id) {
    if (!id) return null;
    const dup = duplicatePreset(id);
    if (!dup) { toast('Preset konnte nicht dupliziert werden', 'err'); return null; }
    _saveRaw(); refreshPresetViews();
    toast('Preset dupliziert ✓', 'ok');
    return dup;
  },
  remove(id) {
    if (!id || !isUserPreset(id)) return false;
    const p = getPresetById(id);
    if (!confirm(`Eigenes Preset "${p?.name || id}" wirklich löschen? Layer, die es verwenden, behalten ihre Einstellungen.`)) return false;
    deleteUserPreset(id); _saveRaw(); refreshPresetViews();
    toast('Preset gelöscht', 'ok');
    return true;
  },
  exportOne(id) { if (id) exportPreset(id); }
};

/**
 * Registriert alle Event-Handler rund um eigene Presets. Wird von registerEvents() aufgerufen.
 */
export function registerPresetEvents() {
  updateFxPresetActionButtons('');

  // Layer-Modal: „Als eigenes Preset speichern“ — übernimmt die aktuellen Einstellungen des Layers (auch eines
  // Built-in-Preset-Layers oder eines manuellen Layers). Das Original-Preset wird nie verändert.
  document.getElementById('btnFxPresetSaveAs')?.addEventListener('click', () => {
    const cur = currentLayerPresetId() ? getPresetById(currentLayerPresetId()) : null;
    _openFxPresetMetaModal('create',
      cur ? { name: cur.name + ' (Kopie)', group: cur.group, stage: cur.stage, description: cur.description } : null,
      { includeLayerValues: true });
  });
  document.getElementById('btnFxPresetEdit')?.addEventListener('click', () => presetActions.edit(currentLayerPresetId(), { includeLayerValues: true }));
  document.getElementById('btnFxPresetDuplicate')?.addEventListener('click', () => presetActions.duplicate(currentLayerPresetId()));
  document.getElementById('btnFxPresetDelete')?.addEventListener('click', () => presetActions.remove(currentLayerPresetId()));
  document.getElementById('btnFxPresetExport')?.addEventListener('click', () => presetActions.exportOne(currentLayerPresetId()));

  document.getElementById('btnFxPresetMetaSave')?.addEventListener('click', () => {
    const name        = document.getElementById('fxPresetNameInput')?.value || '';
    const group       = document.getElementById('fxPresetCategoryInput')?.value || 'supernatural';
    const stage       = document.getElementById('fxPresetStageInput')?.value || currentLayerStage() || 'medium';
    const description = document.getElementById('fxPresetDescInput')?.value || '';
    const withValues  = _metaIncludeLayerValues && isLayerModalOpen();
    const effects     = withValues ? _currentEffectsForPreset() : undefined;
    let result;
    if (_fxPresetMetaMode === 'edit' && _fxPresetMetaEditId) {
      result = updateUserPreset(_fxPresetMetaEditId, { name, group, stage, description, effects });
    } else {
      result = createUserPreset({ name, group, stage, description, effects: effects || {} });
    }
    if (!result) { toast('Preset konnte nicht gespeichert werden', 'err'); return; }
    _saveRaw();
    // Der bearbeitete Layer verweist ab jetzt auf das gespeicherte Preset (nur, wenn es zu seiner Stufe gehört).
    if (withValues) adoptPresetInLayerModal(result.id);
    refreshPresetViews();
    bootstrap.Modal.getInstance(document.getElementById('fxPresetMetaModal'))?.hide();
    toast(_fxPresetMetaMode === 'edit' ? 'Preset geändert ✓' : 'Preset gespeichert ✓', 'ok');
  });

  // Preset-Picker: Sammel-Export und Import
  document.getElementById('btnFxPresetExportAll')?.addEventListener('click', () => { exportUserPresets(); });
  document.getElementById('btnFxPresetImportTrigger')?.addEventListener('click', () => {
    document.getElementById('fxPresetImportInput')?.click();
  });
  document.getElementById('fxPresetImportInput')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f) return;
    importData(f, {
      onSuccess: () => { refreshPresetViews(); toast('Preset(s) importiert ✓', 'ok'); }
    });
    this.value = '';
  });
}
