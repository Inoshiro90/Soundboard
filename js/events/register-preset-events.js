/**
 * events/register-preset-events.js — Eigene Audio-Effekt-Presets:
 * Auswahl/Speichern/Duplizieren/Löschen, Preset-Meta-Modal
 */

import { toast } from '../notifications.js';
import {
  getPresetById, createUserPreset, updateUserPreset, deleteUserPreset,
  duplicatePreset, isUserPreset, PRESET_CATEGORIES
} from '../presets.js';
import { exportPreset, exportUserPresets, importData } from '../storage/import-export.js';
import { _saveRaw } from '../storage/persistence.js';
import { renderPresetDropdown } from '../ui/tabs.js';
import { readEffectsFromUI } from '../dialogs/sound-modal.js';

// ─── EIGENE AUDIO-EFFEKT-PRESETS ─────────────────────────
// UI-Logik für Preset-Verwaltung im Audio-Effekte-Dialog. Nutzt bewusst
// dieselben Formularsteuerelemente (readEffectsFromUI/writeEffectsToUI),
// dieselben Toasts (toast()) und dasselbe Import/Export-Muster
// (importData()/kind-Feld) wie der Rest der Anwendung — keine parallele
// Infrastruktur.

export let _fxPresetMetaMode   = 'create'; // 'create' | 'edit'
export let _fxPresetMetaEditId = null;

/** Blendet Bearbeiten/Duplizieren/Löschen/Export je nach aktueller
 *  Preset-Auswahl im Dropdown ein/aus (Built-ins dürfen nicht
 *  bearbeitet/gelöscht werden, aber dupliziert/exportiert). */
export function updateFxPresetActionButtons() {
  const val = document.getElementById('fxPreset')?.value || '';
  const editBtn = document.getElementById('btnFxPresetEdit');
  const dupBtn  = document.getElementById('btnFxPresetDuplicate');
  const delBtn  = document.getElementById('btnFxPresetDelete');
  const expBtn  = document.getElementById('btnFxPresetExport');
  const isUser  = !!val && isUserPreset(val);
  if (editBtn) editBtn.style.display = isUser ? '' : 'none';
  if (delBtn)  delBtn.style.display  = isUser ? '' : 'none';
  if (dupBtn)  dupBtn.style.display  = val ? '' : 'none';
  if (expBtn)  expBtn.style.display  = val ? '' : 'none';
}

export function _openFxPresetMetaModal(mode, prefill) {
  _fxPresetMetaMode   = mode;
  _fxPresetMetaEditId = mode === 'edit' ? prefill.id : null;
  const titleEl = document.getElementById('fxPresetMetaModalTitle');
  if (titleEl) titleEl.textContent = mode === 'edit' ? 'Preset bearbeiten' : 'Preset speichern';
  const nameEl = document.getElementById('fxPresetNameInput');
  const catEl  = document.getElementById('fxPresetCategoryInput');
  const descEl = document.getElementById('fxPresetDescInput');
  if (nameEl) nameEl.value = prefill?.name || '';
  if (catEl)  catEl.value  = prefill?.category && PRESET_CATEGORIES[prefill.category] ? prefill.category : 'supernatural';
  if (descEl) descEl.value = prefill?.description || '';
  new bootstrap.Modal(document.getElementById('fxPresetMetaModal')).show();
  setTimeout(() => nameEl?.focus(), 200);
}

/** Liest die aktuell im Formular eingestellten Effektwerte als reines
 *  Preset-Effekte-Objekt (ohne die Sound-Laufzeitfelder enabled/preset). */
export function _currentEffectsForPreset() {
  const fx = readEffectsFromUI();
  const { enabled, preset, ...effects } = fx;
  return effects;
}

/**
 * Registriert alle Event-Handler rund um eigene Presets. Wird von
 * registerEvents() aufgerufen.
 */
export function registerPresetEvents() {
  renderPresetDropdown();
  updateFxPresetActionButtons();

  document.getElementById('fxPreset')?.addEventListener('change', updateFxPresetActionButtons);
  document.getElementById('btnOpenFxModal')?.addEventListener('click', updateFxPresetActionButtons);

  // "Als eigenes Preset speichern" — übernimmt die aktuell im Formular
  // eingestellten Effektwerte (ein vorhandenes Preset auswählen → verändern → als
  // eigenes Preset speichern funktioniert dadurch von selbst, ohne eigene Zwischenschritte).
  document.getElementById('btnFxPresetSaveAs')?.addEventListener('click', () => {
    const curVal = document.getElementById('fxPreset')?.value;
    const cur    = curVal ? getPresetById(curVal) : null;
    _openFxPresetMetaModal('create', cur ? { name: cur.name + ' (Kopie)', category: cur.category, description: cur.description } : null);
  });

  // Bearbeiten: nur für eigene Presets sichtbar (siehe updateFxPresetActionButtons).
  // Übernimmt beim Speichern sowohl die Metadaten als auch die aktuell im
  // Formular stehenden Effektwerte unter derselben ID (der volle Preset-Zustand wird
  // beim Öffnen bereits über das Dropdown/writeEffectsToUI vollständig wiederhergestellt,
  // siehe fxPreset change-Handler oben).
  document.getElementById('btnFxPresetEdit')?.addEventListener('click', () => {
    const val = document.getElementById('fxPreset')?.value;
    if (!val || !isUserPreset(val)) return;
    const p = getPresetById(val);
    _openFxPresetMetaModal('edit', p);
  });

  document.getElementById('btnFxPresetMetaSave')?.addEventListener('click', () => {
    const name        = document.getElementById('fxPresetNameInput')?.value || '';
    const category     = document.getElementById('fxPresetCategoryInput')?.value || 'supernatural';
    const description   = document.getElementById('fxPresetDescInput')?.value || '';
    const effects        = _currentEffectsForPreset();
    let result;
    if (_fxPresetMetaMode === 'edit' && _fxPresetMetaEditId) {
      result = updateUserPreset(_fxPresetMetaEditId, { name, category, description, effects });
    } else {
      result = createUserPreset({ name, category, description, effects });
    }
    if (!result) { toast('Preset konnte nicht gespeichert werden', 'err'); return; }
    _saveRaw();
    renderPresetDropdown();
    const sel = document.getElementById('fxPreset');
    if (sel) sel.value = result.id;
    updateFxPresetActionButtons();
    bootstrap.Modal.getInstance(document.getElementById('fxPresetMetaModal'))?.hide();
    toast(_fxPresetMetaMode === 'edit' ? 'Preset geändert ✓' : 'Preset gespeichert ✓', 'ok');
  });

  // Duplizieren: sofort, ohne Zwischendialog — funktioniert
  // sowohl für Built-ins als auch für eigene Presets; das Original bleibt
  // in jedem Fall unverändert (duplicatePreset() erzeugt immer ein neues
  // User-Preset).
  document.getElementById('btnFxPresetDuplicate')?.addEventListener('click', () => {
    const val = document.getElementById('fxPreset')?.value;
    if (!val) return;
    const dup = duplicatePreset(val);
    if (!dup) { toast('Preset konnte nicht dupliziert werden', 'err'); return; }
    _saveRaw();
    renderPresetDropdown();
    const sel = document.getElementById('fxPreset');
    if (sel) sel.value = dup.id;
    sel?.dispatchEvent(new Event('change'));
    toast('Preset dupliziert ✓', 'ok');
  });

  document.getElementById('btnFxPresetDelete')?.addEventListener('click', () => {
    const val = document.getElementById('fxPreset')?.value;
    if (!val || !isUserPreset(val)) return;
    const p = getPresetById(val);
    if (!confirm(`Eigenes Preset "${p?.name || val}" wirklich löschen?`)) return;
    deleteUserPreset(val);
    _saveRaw();
    renderPresetDropdown();
    const sel = document.getElementById('fxPreset');
    if (sel) { sel.value = ''; sel.dispatchEvent(new Event('change')); }
    toast('Preset gelöscht', 'ok');
  });

  document.getElementById('btnFxPresetExport')?.addEventListener('click', () => {
    const val = document.getElementById('fxPreset')?.value;
    if (!val) return;
    exportPreset(val);
  });

  document.getElementById('btnFxPresetExportAll')?.addEventListener('click', () => {
    exportUserPresets();
  });

  document.getElementById('btnFxPresetImportTrigger')?.addEventListener('click', () => {
    document.getElementById('fxPresetImportInput')?.click();
  });
  document.getElementById('fxPresetImportInput')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f) return;
    importData(f, {
      onSuccess: () => {
        renderPresetDropdown();
        updateFxPresetActionButtons();
        toast('Preset(s) importiert ✓', 'ok');
      }
    });
    this.value = '';
  });
}

/**
 * Greys out sub-sections when their enable-checkbox is off.
 * Also disables the whole panel when master toggle is off.
 */
