/**
 * dialogs/fx-pipeline-modals.js — Pipeline-Editor, Ebenen 2 und 3
 * ----------------------------------------------------------------
 *   Ebene 1  Übersicht (ui/fx-pipeline-editor.js, im #soundFxModal): vier kompakte Stufen-Karten.
 *   Ebene 2  #fxStageModal        „<Stufe> verwalten“: Layer in Verarbeitungsreihenfolge, hinzufügen,
 *                                 bearbeiten, verschieben, duplizieren, entfernen.
 *            #fxPresetPickerModal „Preset hinzufügen“: nur Presets dieser Stufe, nach Gruppen; Verwaltung eigener Presets.
 *   Ebene 3  #fxLayerModal        „Layer bearbeiten“: das vollständige Effektformular für GENAU EINEN Layer.
 *            #fxPresetMetaModal   (sound-core.html) „Preset speichern / Preset-Details“: Metadaten eines eigenen Presets.
 *
 * Ein Stufen- und ein Layer-Modal für alle vier Stufen und alle drei Kontexte (Sound, Ambient-Track, Musikstück).
 *
 * ARBEITSKOPIE-PROTOKOLL (kein globaler Zwischenzustand, der beim Wechsel verloren gehen könnte):
 *   Draft (ui/fx-pipeline-editor.js)          ← „Übernehmen“ im Stufen-Modal (nur diese EINE Stufe)
 *     └ M.eff  Arbeitskopie des ganzen Drafts  ← „Übernehmen“ im Layer-Modal (nur dieser EINE Layer)
 *         └ L.draft  Kopie des Layers + Formular
 *   „Abbrechen“/X/Escape/Backdrop verwerfen die jeweils oberste Ebene (Rückfrage bei Änderungen über
 *   modalGuards.createModalDraftGuard). Zum echten Sound/Ambient-Track/Musikstück gelangt nichts außer über die
 *   bestehenden Speicherwege (readEffectsFromUI() → Sound-Modal speichern / setAmbientTrackEffects / commitMusicFxDraft).
 *
 * Kein innerHTML mit Nutzerdaten (Preset-/Layer-Namen können benutzerdefiniert sein): nur textContent und iconSvg().
 */

import { _fxEditContext, loadLayerParamsToForm, readLayerParamsFromForm, isLayerFormDirty, resetLayerForm, wireLayerForm, updateEffectSectionVisibility } from './sound-modal.js';
import { getDraft, commitStage, initFxPipelineEditor, layerLabel, render as renderOverview } from '../ui/fx-pipeline-editor.js';
import {
  STAGE_ORDER, PIPELINE_STAGES, findLayer, moveLayer, duplicateLayer, removeLayer, isLayerModified, fillLayerParams, sparsifyParams
} from '../audio/fx-pipeline.js';
import { addPresetLayer, addManualLayer } from '../fx-model.js';
import { getPresetById, getPresetsByStage, presetToLayerInit, PRESET_GROUPS, isUserPreset } from '../presets.js';
import { createModalDraftGuard } from '../modalGuards.js';
import { setupTouchRowReorder } from '../ui/row-reorder.js';
import { iconSvg } from '../ui/icons.js';
import { updateFxPresetActionButtons, presetActions } from '../events/register-preset-events.js';

const clone = x => JSON.parse(JSON.stringify(x));
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** Stufen-Modal: Stufe + Arbeitskopie (M.eff = Kopie des GANZEN Drafts, damit die reinen Operationen laufen). */
const M = { stage: null, eff: null, baseline: '', dragId: null };
/** Layer-Modal: bearbeiteter Layer (Kopie) + Änderungsmerker. */
const L = { id: null, stage: null, draft: null, touched: false };
let _wired = false, _stageGuard = null, _layerGuard = null;

// ─── KONTEXT ─────────────────────────────────────────────────

const KIND_LABEL = { sound: 'Sound', ambient: 'Ambient-Track', music: 'Musikstück' };

/** Eindeutiger Bearbeitungskontext, z. B. „Sound „Donner“ · Quelle“ — steht in jedem der drei Modals. */
export function contextLabel(stage) {
  const kind = _fxEditContext?.kind || 'sound';
  const nameEl = $(kind === 'music' ? 'musicEditName' : 'eName');
  const name = (nameEl?.value || '').trim();
  const who = `${KIND_LABEL[kind] || 'Sound'}${name ? ` „${name}“` : ''}`;
  return stage ? `${who} · ${PIPELINE_STAGES[stage].label}` : who;
}

function _setTitle(iconId, textId, stage, text) {
  const ic = $(iconId); if (ic) ic.innerHTML = iconSvg(PIPELINE_STAGES[stage].icon);
  const t = $(textId); if (t) t.textContent = text;
}

function _show(id) { bootstrap.Modal.getOrCreateInstance($(id)).show(); }
function _hide(id) { bootstrap.Modal.getInstance($(id))?.hide(); }

// ─── EBENE 2 · STUFE VERWALTEN ───────────────────────────────

const _stageObj = () => M.eff?.stages[M.stage];
const _stageDirty = () => !!M.eff && JSON.stringify(_stageObj()) !== M.baseline;

export function openStageModal(stage) {
  const draft = getDraft();
  if (!draft || !STAGE_ORDER.includes(stage)) return;
  M.stage = stage; M.eff = clone(draft); M.baseline = JSON.stringify(M.eff.stages[stage]);
  _renderStageModal();
  _stageGuard?.arm();
  _show('fxStageModal');
}

function _iconBtn(icon, label, act, { disabled = false } = {}) {
  const b = el('button', 'btn btn--ghost fx-icon-btn fx-layer__act'); b.type = 'button';
  b.innerHTML = iconSvg(icon); b.dataset.act = act; b.title = label; b.setAttribute('aria-label', label); b.disabled = disabled;
  return b;
}

function _layerRow(layer, idx, count) {
  const label = layerLabel(layer);
  const li = el('li', 'fx-layer' + (layer.enabled ? '' : ' is-off'));
  li.dataset.id = layer.id; li.draggable = true;

  const handle = el('span', 'fx-layer__handle'); handle.innerHTML = iconSvg('grip-vertical'); handle.title = 'Ziehen zum Sortieren'; handle.setAttribute('aria-hidden', 'true');
  const order = el('span', 'fx-layer__order', String(idx + 1)); order.title = 'Position in der Verarbeitungsreihenfolge';

  const tgl = document.createElement('input'); tgl.type = 'checkbox'; tgl.className = 'fx-layer__toggle';
  tgl.checked = layer.enabled; tgl.setAttribute('aria-label', `${label}: Layer aktiv`); tgl.title = 'Layer ein/aus';

  const name = el('span', 'fx-layer__name');
  name.appendChild(el('span', 'fx-layer__label', label));
  const preset = layer.presetId ? getPresetById(layer.presetId) : null;
  if (layer.presetId && !preset) name.appendChild(el('span', 'fx-layer__tag fx-layer__tag--warn', 'Preset fehlt'));
  else if (preset && isLayerModified(layer, preset.effects)) name.appendChild(el('span', 'fx-layer__tag', 'angepasst'));
  if (layer.stageAuto) { const t = el('span', 'fx-layer__tag fx-layer__tag--warn', 'Stufe prüfen'); t.title = 'Die Stufe wurde automatisch zugeordnet — bitte prüfen'; name.appendChild(t); }

  const acts = el('span', 'fx-layer__actions');
  acts.append(
    _iconBtn('pencil', `Layer bearbeiten: ${label}`, 'edit'),
    _iconBtn('chevron-up', `Nach oben (früher verarbeiten): ${label}`, 'up', { disabled: idx === 0 }),
    _iconBtn('chevron-down', `Nach unten (später verarbeiten): ${label}`, 'down', { disabled: idx === count - 1 }),
    _iconBtn('copy', `Layer duplizieren: ${label}`, 'dup'),
    _iconBtn('trash', `Layer entfernen: ${label}`, 'rm')
  );
  li.append(handle, order, tgl, name, acts);
  return li;
}

function _renderStageModal(focusId) {
  const st = _stageObj(); if (!st) return;
  const meta = PIPELINE_STAGES[M.stage];
  _setTitle('fxStageModalIcon', 'fxStageModalTitleText', M.stage, `${meta.label} verwalten`);
  $('fxStageContext').textContent = contextLabel(M.stage);
  $('fxStageHint').textContent = meta.hint;
  const sw = $('fxStageEnabled'); sw.checked = st.enabled;
  $('fxStageEnabledText').textContent = st.enabled ? 'Stufe aktiv' : 'Stufe deaktiviert — Layer bleiben gespeichert, werden aber nicht verarbeitet';

  const list = $('fxStageLayers');
  const rows = st.layers.map((l, i) => _layerRow(l, i, st.layers.length));
  if (!rows.length) rows.push(el('li', 'fx-layers__empty u-text-muted u-text-badge', 'Keine Layer — diese Stufe wird übersprungen. Preset oder manuellen Layer hinzufügen.'));
  list.replaceChildren(...rows);
  if (focusId) list.querySelector(`[data-id="${focusId}"] [data-act="edit"]`)?.focus();
}

function _stageOp(fn, focusId) { fn(); _renderStageModal(focusId); }

function _onStageListClick(e) {
  const row = e.target.closest('.fx-layer'); const act = e.target.closest('[data-act]');
  if (!row || !act) return;
  const id = row.dataset.id, st = _stageObj(); if (!st) return;
  const f = findLayer(M.eff, id); if (!f) return;
  switch (act.dataset.act) {
    case 'edit': openLayerModal(id); break;
    case 'up':   _stageOp(() => moveLayer(M.eff, M.stage, f.index, f.index - 1), id); break;
    case 'down': _stageOp(() => moveLayer(M.eff, M.stage, f.index, f.index + 1), id); break;
    case 'dup':  { let nid; _stageOp(() => { nid = duplicateLayer(M.eff, id)?.id; }, undefined); if (nid) $('fxStageLayers').querySelector(`[data-id="${nid}"] [data-act="edit"]`)?.focus(); break; }
    case 'rm': {
      const next = st.layers[f.index + 1] || st.layers[f.index - 1] || null;
      _stageOp(() => removeLayer(M.eff, id));
      (next ? $('fxStageLayers').querySelector(`[data-id="${next.id}"] [data-act="edit"]`) : $('btnFxStageAddPreset'))?.focus();
      break;
    }
  }
}

function _moveTo(srcId, dstId) {
  const a = findLayer(M.eff, srcId), b = findLayer(M.eff, dstId);
  if (!a || !b || a.stage !== M.stage || b.stage !== M.stage || a.index === b.index) return;
  _stageOp(() => moveLayer(M.eff, M.stage, a.index, b.index));
}

function _applyStage() {
  commitStage(M.stage, _stageObj());
  _stageGuard?.disarm();
  _hide('fxStageModal');
}

// ─── EBENE 2b · PRESET WÄHLEN ────────────────────────────────

export function openPresetPicker() {
  if (!M.eff) return;
  _renderPicker();
  _show('fxPresetPickerModal');
}

function _pickerAction(icon, label, act) {
  const b = el('button', 'btn btn--ghost fx-icon-btn'); b.type = 'button'; b.innerHTML = iconSvg(icon);
  b.dataset.act = act; b.title = label; b.setAttribute('aria-label', label); return b;
}

function _renderPicker() {
  if (!M.stage) return;
  const meta = PIPELINE_STAGES[M.stage];
  _setTitle('fxPresetPickerIcon', 'fxPresetPickerTitleText', M.stage, `Preset hinzufügen — ${meta.label}`);
  $('fxPresetPickerContext').textContent = `${contextLabel(M.stage)} · nur Presets dieser Stufe. Die Auswahl fügt eine neue, unabhängige Layer-Instanz hinzu.`;

  const byGroup = new Map();
  getPresetsByStage(M.stage).forEach(p => {
    const k = p.builtin ? p.group : '_user';
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k).push(p);
  });
  const keys = [...byGroup.keys()].sort((a, b) => (a === '_user') - (b === '_user') || ((PRESET_GROUPS[a]?.order || 0) - (PRESET_GROUPS[b]?.order || 0)));
  const host = $('fxPresetPickerList');
  if (!keys.length) { host.replaceChildren(el('p', 'u-text-muted u-text-badge', 'Für diese Stufe gibt es noch keine Presets. Mit „Manuell hinzufügen“ oder dem Import eigener Presets weitermachen.')); return; }
  host.replaceChildren(...keys.map(k => {
    const sec = el('section', 'fx-picker__group');
    sec.appendChild(el('h6', 'fx-picker__group-head', k === '_user' ? 'Eigene Presets' : (PRESET_GROUPS[k]?.label || k)));
    byGroup.get(k).forEach(p => {
      const row = el('div', 'fx-picker__row'); row.dataset.presetId = p.id;
      const pick = el('button', 'fx-picker__item'); pick.type = 'button'; pick.dataset.act = 'pick';
      pick.appendChild(el('span', 'fx-picker__name', p.name));
      if (p.stageAuto) { const t = el('span', 'fx-layer__tag fx-layer__tag--warn', 'Stufe prüfen'); t.title = 'Die Stufe wurde automatisch zugeordnet — bitte prüfen'; pick.appendChild(t); }
      if (p.description) pick.appendChild(el('span', 'fx-picker__desc u-text-muted', p.description));
      pick.setAttribute('aria-label', `${p.name} zur Stufe ${meta.label} hinzufügen`);
      const tools = el('span', 'fx-picker__tools');
      if (isUserPreset(p.id)) tools.appendChild(_pickerAction('pencil', `Preset-Details bearbeiten: ${p.name}`, 'edit'));
      tools.appendChild(_pickerAction('copy', `Preset duplizieren: ${p.name}`, 'dup'));
      tools.appendChild(_pickerAction('download', `Preset exportieren: ${p.name}`, 'export'));
      if (isUserPreset(p.id)) tools.appendChild(_pickerAction('trash', `Eigenes Preset löschen: ${p.name}`, 'del'));
      row.append(pick, tools);
      sec.appendChild(row);
    });
    return sec;
  }));
}

function _onPickerClick(e) {
  const row = e.target.closest('.fx-picker__row'); const act = e.target.closest('[data-act]');
  if (!row || !act) return;
  const id = row.dataset.presetId;
  if (act.dataset.act === 'pick') {
    const r = addPresetLayer(M.eff, id, { stage: M.stage });
    if (!r) return;
    _stageObj().enabled = true;
    _hide('fxPresetPickerModal');
    _renderStageModal(r.layer.id);
    return;
  }
  if (act.dataset.act === 'edit') presetActions.edit(id, { includeLayerValues: false });
  else if (act.dataset.act === 'dup') presetActions.duplicate(id);
  else if (act.dataset.act === 'export') presetActions.exportOne(id);
  else if (act.dataset.act === 'del') presetActions.remove(id);
}

// ─── EBENE 3 · LAYER BEARBEITEN ──────────────────────────────

const _layerParamsNow = () => (isLayerFormDirty() ? readLayerParamsFromForm() : L.draft.params);

export function openLayerModal(layerId) {
  const f = M.eff ? findLayer(M.eff, layerId) : null;
  if (!f) return;
  L.id = layerId; L.stage = f.stage; L.draft = clone(f.layer); L.touched = false;
  const count = M.eff.stages[f.stage].layers.length;
  _setTitle('fxLayerModalIcon', 'fxLayerModalTitleText', f.stage, 'Layer bearbeiten');
  $('fxLayerContext').textContent = `${contextLabel(f.stage)} · Layer ${f.index + 1} von ${count}: ${layerLabel(L.draft)}`;
  loadLayerParamsToForm(L.draft.params);
  _renderLayerInfo();
  _layerGuard?.arm();
  _show('fxLayerModal');
}

/** Preset-/Instanz-Info: Preset, „unverändert“ vs. „angepasst“, Hinweis „Preset bleibt unverändert“, passende Aktionen. */
function _renderLayerInfo() {
  if (!L.draft) return;
  const preset = L.draft.presetId ? getPresetById(L.draft.presetId) : null;
  const missing = !!L.draft.presetId && !preset;
  const modified = !!preset && isLayerModified({ ...L.draft, params: _layerParamsNow() }, preset.effects);
  $('fxLayerPresetName').textContent = L.draft.presetId ? (preset ? preset.name : 'Preset nicht mehr vorhanden') : 'Manueller Layer';
  const tag = $('fxLayerPresetTag');
  tag.hidden = !L.draft.presetId;
  tag.textContent = missing ? 'Preset fehlt' : (modified ? 'angepasst' : 'wie Preset');
  tag.className = 'fx-layer__tag' + (missing ? ' fx-layer__tag--warn' : '');
  $('fxLayerPresetHead').textContent = L.draft.presetId ? 'Preset-Layer' : 'Layer';
  $('fxLayerPresetNote').textContent = L.draft.presetId
    ? (preset
      ? `Eigene Instanz des ${isUserPreset(preset.id) ? 'eigenen ' : ''}Presets „${preset.name}“. Änderungen gelten nur für diesen Layer; das Preset und andere Layer bleiben unverändert.`
      : 'Das Preset wurde gelöscht. Dieser Layer behält seine gespeicherten Einstellungen.')
    : 'Layer mit eigenen Einstellungen, kein Preset. Über „Als eigenes Preset speichern“ lässt er sich wiederverwenden.';
  $('btnFxLayerRestore').hidden = !preset || !modified;
  updateFxPresetActionButtons(preset ? preset.id : '');
}

/** Aktuelle Einstellungen des Layers im Modal (vollständig) — für „Als eigenes Preset speichern“. */
export function currentLayerEffects() { return L.draft ? fillLayerParams(_layerParamsNow()) : fillLayerParams({}); }
export function currentLayerStage() { return L.stage; }
export function currentLayerPresetId() { return L.draft?.presetId || ''; }
export function isLayerModalOpen() { return !!L.draft; }

/** Nach „Als eigenes Preset speichern“/„Details speichern“: Layer verweist auf das Preset, wenn es zu seiner Stufe passt. */
export function adoptPresetInLayerModal(presetId) {
  const p = L.draft ? getPresetById(presetId) : null;
  if (!p || p.stage !== L.stage) { _renderLayerInfo(); return false; }
  L.draft.params = _layerParamsNow();
  L.draft.presetId = presetId;
  if (p.stageAuto) L.draft.stageAuto = true; else delete L.draft.stageAuto;
  L.touched = true;
  _renderLayerInfo();
  return true;
}

/** Aktualisiert Picker, Stufenliste und Layer-Info nach jeder Änderung am Preset-Bestand. */
export function refreshPresetViews() {
  if ($('fxPresetPickerModal')?.classList.contains('show')) _renderPicker();
  if (M.eff) _renderStageModal();
  if (L.draft) _renderLayerInfo();
  renderOverview();
}

function _restorePreset() {
  const r = L.draft?.presetId ? presetToLayerInit(L.draft.presetId) : null;
  if (!r) return;
  L.draft.params = r.init.params;
  loadLayerParamsToForm(L.draft.params);
  L.touched = true;
  _renderLayerInfo();
}

function _applyLayer() {
  const f = M.eff ? findLayer(M.eff, L.id) : null;
  if (f) {
    f.layer.params = sparsifyParams(_layerParamsNow());
    f.layer.presetId = L.draft.presetId || null;
    if (L.draft.stageAuto) f.layer.stageAuto = true; else delete f.layer.stageAuto;
  }
  _layerGuard?.disarm();
  _hide('fxLayerModal');
  _renderStageModal(L.id);
}

// ─── VERDRAHTUNG (einmalig) ──────────────────────────────────

export function initFxPipelineModals() {
  if (_wired) return; _wired = true;

  initFxPipelineEditor({ openStage: openStageModal, changed: () => updateEffectSectionVisibility() });

  _stageGuard = createModalDraftGuard({
    modalId: 'fxStageModal', isDirty: _stageDirty,
    message: 'Änderungen an dieser Stufe verwerfen?'
  });
  _layerGuard = createModalDraftGuard({
    modalId: 'fxLayerModal',
    isDirty: () => !!L.draft && (L.touched || isLayerFormDirty()),
    message: 'Änderungen an diesem Layer verwerfen?'
  });

  // Stufen-Modal
  $('fxStageLayers')?.addEventListener('click', _onStageListClick);
  $('fxStageLayers')?.addEventListener('change', e => {
    const t = e.target; if (!t.classList.contains('fx-layer__toggle')) return;
    const f = findLayer(M.eff, t.closest('.fx-layer').dataset.id);
    if (f) { f.layer.enabled = t.checked; _renderStageModal(); }
  });
  $('fxStageEnabled')?.addEventListener('change', function () { _stageObj().enabled = this.checked; _renderStageModal(); });
  $('btnFxStageAddPreset')?.addEventListener('click', openPresetPicker);
  $('btnFxStageAddManual')?.addEventListener('click', () => {
    const layer = addManualLayer(M.eff, M.stage, {});
    _stageObj().enabled = true;
    _renderStageModal(layer.id);
  });
  $('btnFxStageApply')?.addEventListener('click', _applyStage);
  $('fxStageModal')?.addEventListener('hidden.bs.modal', () => { M.eff = null; M.stage = null; M.baseline = ''; M.dragId = null; });

  // Drag&Drop (Maus/Stift) + Touch-Long-Press, nur innerhalb der Stufe
  const list = $('fxStageLayers');
  list?.addEventListener('dragstart', e => {
    const row = e.target.closest?.('.fx-layer'); if (!row) return;
    M.dragId = row.dataset.id; row.classList.add('is-dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', M.dragId); } catch (err) { /* ältere Browser */ }
  });
  list?.addEventListener('dragover', e => {
    const row = e.target.closest?.('.fx-layer'); if (!row || !M.dragId || row.dataset.id === M.dragId) return;
    e.preventDefault();
    list.querySelectorAll('.fx-layer.is-drag-over').forEach(x => x.classList.remove('is-drag-over'));
    row.classList.add('is-drag-over');
  });
  list?.addEventListener('drop', e => {
    const row = e.target.closest?.('.fx-layer'); if (!row || !M.dragId) return;
    e.preventDefault(); const src = M.dragId; M.dragId = null; _moveTo(src, row.dataset.id);
  });
  list?.addEventListener('dragend', () => {
    M.dragId = null; list.querySelectorAll('.fx-layer.is-dragging, .fx-layer.is-drag-over').forEach(x => x.classList.remove('is-dragging', 'is-drag-over'));
  });
  if (list) setupTouchRowReorder({ list, rowSelector: '.fx-layer', handleSelector: '.fx-layer__handle', onSwap: _moveTo });

  // Preset-Picker
  $('fxPresetPickerList')?.addEventListener('click', _onPickerClick);

  // Layer-Modal
  wireLayerForm(() => { if ($('fxLayerModal')?.classList.contains('show')) _renderLayerInfo(); });
  $('btnFxLayerApply')?.addEventListener('click', _applyLayer);
  $('btnFxLayerRestore')?.addEventListener('click', _restorePreset);
  $('btnFxReset')?.addEventListener('click', () => { resetLayerForm(); _renderLayerInfo(); });
  $('fxLayerModal')?.addEventListener('hidden.bs.modal', () => { L.id = null; L.stage = null; L.draft = null; L.touched = false; updateFxPresetActionButtons(''); });
}
