/**
 * dialogs/sound-modal.js — Sound-/Ambient-Effekt-Editor-Modal: Formular-I/O,
 * Draft-Guard, Audio-Rollback
 * Der Dialog wird sowohl für Sound-Kacheln als auch für Ambient-Track-Effekte genutzt
 * (dasselbe FX-Akkordeon) — s. openAmbientEffectsModal() in ambient-modal.js,
 * das mehrere Funktionen von hier importiert.
 */

import { APP, CItems } from '../core/state.js';
import { uid, isCustomIcon } from '../utils.js';
import { actx } from '../audio/context.js';
import { stopEffectPreview } from '../audio/preview.js';
import { defaultEffects, defaultPlayback } from '../audio/effect-graph.js';
import '../storage/persistence.js';
import { STAGE_ORDER, PIPELINE_STAGES, defaultPipelineEffects, fillLayerParams, sparsifyParams } from '../audio/fx-pipeline.js';
import { createEffectEditor } from '../ui/effects/effect-editor.js';
import { ensureEffectsV2 } from '../fx-model.js';
import { getDraft, setDraft, render as renderPipelineEditor } from '../ui/fx-pipeline-editor.js';
import { idbGet, idbSet, idbDelete, isIdbRef, audioKey } from '../db.js';
import { renderSlotList } from '../ui/slot-editor.js';
import { buildIconGrid, syncEntryCardPreview } from '../ui/icon-picker.js';
import { buildColorOpts } from '../ui/color-picker.js';
import { setDisclosureActive } from '../ui/disclosure.js';
import { normalizeVolumeRange, VOLUME_MODE_VARYING, VOLUME_MODE_CONSTANT } from '../ambient/ambient-volume.js';
// Zirkulärer Import (utils-modal.js importiert umgekehrt readEffectsFromUI/
// readPlaybackFromUI/_commitAudioRollback aus diesem Modul) — unkritisch,
// s. Kommentar in utils-modal.js.
import { _setModalContext, _armSoundDraftGuard } from '../events/utils-modal.js';

// ─── EFFECTS UI HELPERS ──────────────────────────────────────

// Registry-generierte Module (Phase 8, Strangler): Zustand und Karten im Editor, hier nur Lesen/Schreiben der Werte.
const _fxEditor = createEffectEditor();
/** Editor der generierten Effektmodule (für Tests und Verdrahtung). */
export function getFxEditor() { return _fxEditor; }

/**
 * Reads all current effect control values from the DOM and returns an
 * effects object ready to be stored on s.effects.
 */
function _readFlatFromUI() {
  return {
    enabled: !!document.getElementById('fxEnabled')?.checked,
    ..._fxEditor.getValues(),                       // alle Effektmodule (Registry ui.generated)
  };
}

/**
 * Writes an effects object into all effect DOM controls.
 */
function _writeFlatToUI(fx) {
  if (!fx) fx = defaultEffects();
  const master = document.getElementById('fxEnabled'); if (master) master.checked = !!fx.enabled;

  // Alle Effektmodule sind registry-generiert: Zustand im Editor, Karten werden mit aktualisiert.
  _fxEditor.setValues(fx);

  // updateEffectSectionVisibility() also refreshes the active-fx badges/
  // summary (see below) — one call covers both concerns.
  updateEffectSectionVisibility();
}


// ─── EFFEKT-DRAFT (ganzes Objekt) UND LAYER-FORMULAR (ein Layer) ─────────────
// Zwei getrennte Dinge:
//   • Der DRAFT (v2-Effektobjekt eines Sounds/Ambient-Tracks/Musikstücks) liegt in ui/fx-pipeline-editor.js.
//     readEffectsFromUI()/writeEffectsToUI() sind weiterhin die einzige Schnittstelle der Speicherwege dorthin.
//   • Das Formular (alle fx*-Regler, genau einmal im DOM, im Layer-Modal) bearbeitet IMMER genau einen Layer.
//     Es wird nur über loadLayerParamsToForm()/readLayerParamsFromForm() befüllt/gelesen (dialogs/fx-pipeline-modals.js);
//     kein Formularstand fließt je implizit in den Draft.

let _layerFormDirty = false;

/** True, wenn der Benutzer seit dem letzten Laden des Layer-Formulars einen Regler bedient hat. */
export function isLayerFormDirty() { return _layerFormDirty; }

/** Aktuelles Gesamtobjekt (v2): Kopie des Drafts + Master-Schalter. */
export function readEffectsFromUI() {
  const draft = getDraft();
  if (!draft) return defaultPipelineEffects();
  const out = JSON.parse(JSON.stringify(draft));
  out.enabled = !!document.getElementById('fxEnabled')?.checked;
  return out;
}

/** Befüllt den Draft aus einem Effekt-Objekt (v2 oder — wird migriert — Alt-Format), Master-Schalter und Übersicht. */
export function writeEffectsToUI(fx) {
  setDraft(JSON.parse(JSON.stringify(ensureEffectsV2(fx ?? defaultPipelineEffects()))));
  const master = document.getElementById('fxEnabled');
  if (master) master.checked = !!getDraft().enabled;
  renderPipelineEditor();
  updateEffectSectionVisibility();
}

/** Layer-Formular ← Layer-Parameter (sparse oder vollständig). Der Master-Schalter bleibt unverändert. */
export function loadLayerParamsToForm(params) {
  const master = !!document.getElementById('fxEnabled')?.checked;
  _writeFlatToUI({ ...fillLayerParams(params), enabled: master });
  _layerFormDirty = false;
}

/** Layer-Formular → sparse Layer-Parameter. Nur aufrufen, wenn isLayerFormDirty() (das Formular ist verlustbehaftet). */
export function readLayerParamsFromForm() { return sparsifyParams(_readFlatFromUI()); }

/** Setzt das Layer-Formular auf Standardwerte (alle Module aus). Gilt als Änderung. */
export function resetLayerForm() {
  loadLayerParamsToForm(fillLayerParams({}));
  _layerFormDirty = true;
}

/** Einmalig: Eingaben im Layer-Formular markieren den Layer als geändert. Liefert die Dirty-Quelle für den Guard. */
export function wireLayerForm(onDirty) {
  const form = document.getElementById('fxLayerForm');
  const mark = () => { _layerFormDirty = true; onDirty?.(); };
  form?.addEventListener('input', mark);
  form?.addEventListener('change', mark);
  if (form) {
    _fxEditor.mount(form);                          // generierte Karten in die `[data-fx-host]`-Container bauen (einmalig)
    _fxEditor.mountToolbar(document.querySelector('[data-fx-toolbar]'));   // „Nur aktive Module zeigen“ (außerhalb des Formulars: keine Effektänderung)
    // Schalter UND Auswahlfelder (z. B. Distortion-Modus) einer generierten Karte → Sektions-Punkt/Überblick nachziehen.
    form.addEventListener('change', e => { if (e.target?.closest?.('[data-fx-module]')) updateEffectSectionVisibility(); });
  }
}

// ─── "WIEDERGABE & VERHALTEN" UI HELPERS ─────────────────────
// Gleiches Muster wie readEffectsFromUI()/writeEffectsToUI() oben: DOM ist
// während der Bearbeitung die einzige Quelle/Senke, keine zweite parallele
// State-Repräsentation. Zufall (#eRnd) bleibt bewusst außen vor — das ist
// ein eigenständiges Sound-Feld (s.random), keine Unterstruktur von
// s.playback, und wird weiterhin direkt in openSoundModal()/dem
// Save-Handler über g('eRnd').checked gelesen/geschrieben.

export function readPlaybackFromUI() {
  const g   = id => document.getElementById(id);
  const num = (id, fallback) => { const v = parseFloat(g(id)?.value); return isNaN(v) ? fallback : v; };
  const chk = id => !!(g(id)?.checked);
  const sel = id => g(id)?.value || 'linear';

  return {
    fadeIn: {
      enabled:  chk('pbFadeInEnabled'),
      duration: num('pbFadeInDuration', 0.5),
      curve:    sel('pbFadeInCurve')
    },
    fadeOut: {
      enabled:  chk('pbFadeOutEnabled'),
      duration: num('pbFadeOutDuration', 0.5),
      curve:    sel('pbFadeOutCurve')
    },
    crossfade: {
      enabled:  chk('pbCrossfadeEnabled'),
      duration: num('pbCrossfadeDuration', 1),
      curve:    sel('pbCrossfadeCurve')
    }
  };
}

export function writePlaybackToUI(pb) {
  if (!pb) pb = defaultPlayback();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
  const lbl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  chk('pbFadeInEnabled',  pb.fadeIn?.enabled);
  set('pbFadeInDuration', pb.fadeIn?.duration ?? 0.5);
  lbl('pbFadeInDurationLbl', (pb.fadeIn?.duration ?? 0.5).toFixed(1) + 's');
  set('pbFadeInCurve',    pb.fadeIn?.curve || 'linear');

  chk('pbFadeOutEnabled',  pb.fadeOut?.enabled);
  set('pbFadeOutDuration', pb.fadeOut?.duration ?? 0.5);
  lbl('pbFadeOutDurationLbl', (pb.fadeOut?.duration ?? 0.5).toFixed(1) + 's');
  set('pbFadeOutCurve',    pb.fadeOut?.curve || 'linear');

  chk('pbCrossfadeEnabled',  pb.crossfade?.enabled);
  set('pbCrossfadeDuration', pb.crossfade?.duration ?? 1);
  lbl('pbCrossfadeDurationLbl', (pb.crossfade?.duration ?? 1).toFixed(1) + 's');
  set('pbCrossfadeCurve',    pb.crossfade?.curve || 'linear');

  updatePlaybackSectionVisibility();
}

/** Analog zu updateEffectSectionVisibility(): Controls je Gruppe ein-/ausblenden. */
export function updatePlaybackSectionVisibility() {
  [['pbFadeInEnabled', 'pbFadeInControls'],
   ['pbFadeOutEnabled', 'pbFadeOutControls'],
   ['pbCrossfadeEnabled', 'pbCrossfadeControls']].forEach(([cbId, panelId]) => {
    const on = !!(document.getElementById(cbId)?.checked);
    const el = document.getElementById(panelId);
    if (el) { el.style.opacity = on ? '1' : '0.45'; el.style.pointerEvents = on ? '' : 'none'; }
  });
  _markActivePlaybackSummary();
}

/**
 * Kompakter Überblick in der "Wiedergabe & Verhalten"-Einstiegskarte —
 * analog zu _markActiveAccordionSections()/smFxActiveSummary, nur für die
 * neue Sektion. Kontextabhängig (_fxEditContext.kind): im Sound-Kontext
 * zählt Zufall (#eRnd) mit (kein s.playback-Feld, aber sichtbar Teil
 * derselben Karte); im Ambient-Kontext Loop/Zeitversetzt/Variantenmodus
 * statt Zufall — Crossfade ist in beiden Kontexten dasselbe Feld.
 */
export function _markActivePlaybackSummary() {
  const pb = readPlaybackFromUI(); // liefert immer pbFadeIn/pbFadeOut/pbCrossfade — pbFadeIn/Out nur im Sound-Kontext relevant
  const chips = [];
  if (_fxEditContext.kind === 'ambient') {
    const fadeInOn  = parseFloat(document.getElementById('ambFadeIn')?.value)  > 0;
    const fadeOutOn = parseFloat(document.getElementById('ambFadeOut')?.value) > 0;
    const loopOn    = !!(document.getElementById('ambLoop')?.checked);
    const intervalOn = !!(document.getElementById('ambIntervalMode')?.checked);
    if (fadeInOn)              chips.push('Fade-In');
    if (fadeOutOn)             chips.push('Fade-Out');
    if (pb.crossfade.enabled)  chips.push('Crossfade');
    if (loopOn)                chips.push('Loop');
    if (intervalOn)            chips.push('Zeitversetzt');
    const volVarying = document.getElementById('ambVolumeMode')?.value === VOLUME_MODE_VARYING;
    if (volVarying)            chips.push('Lautstärke variiert');
    chips.push(_ambVariantMode === 'rotate' ? 'Rotierend' : 'Zufällig');

    // Zusammenfassung auch bei zugeklappten Sektionen: gleicher Punkt-Indikator wie bei den
    // Effekt-Sektionen (.has-active-setting, ui/disclosure.js) — spiegelt die Chips oben.
    // Bei „Bei mehreren Dateien" ist immer genau eine Option aktiv, daher dort nur die
    // abweichende (Rotierend).
    setDisclosureActive('ambSecFadeInToggle',   fadeInOn);
    setDisclosureActive('ambSecFadeOutToggle',  fadeOutOn);
    setDisclosureActive('ambSecLoopToggle',     loopOn || intervalOn);
    setDisclosureActive('ambSecVariantsToggle', _ambVariantMode === 'rotate');
    setDisclosureActive('ambSecVolumeToggle',   volVarying);
    setDisclosureActive('pbSecCrossfadeToggle', pb.crossfade.enabled);
  } else {
    const random = !!(document.getElementById('eRnd')?.checked);
    if (pb.fadeIn.enabled)    chips.push('Fade-In');
    if (pb.fadeOut.enabled)   chips.push('Fade-Out');
    if (pb.crossfade.enabled) chips.push('Crossfade');
    if (random)                chips.push('Zufall');
    setDisclosureActive('pbSecCrossfadeToggle', pb.crossfade.enabled);
  }

  const summaryEl = document.getElementById('smPlaybackActiveSummary');
  if (summaryEl) {
    // Bewusst kein Verlass auf .sm-fx-summary:empty::before (dessen Text
    // "Keine Effekte aktiv" für diese Sektion falsch wäre) — eigener,
    // passender Platzhalter, wenn nichts aktiv ist.
    summaryEl.innerHTML = chips.length
      ? chips.map(label => `<span class="sm-fx-summary__chip">${label}</span>`).join('')
      : '<span class="u-text-muted u-text-badge" style="font-style:italic">Standardwiedergabe</span>';
  }
  const badge = document.getElementById('smPlaybackBadge');
  if (badge) badge.style.display = chips.length ? '' : 'none';
}

/**
 * Ambient "Loop" und "Zeitversetzt" schließen sich gegenseitig aus — reine
 * Editor-Draft-UI-Logik (keine gespeicherten Tracks betroffen, kein Aufruf von
 * toggleAmbientLoop()/toggleAmbientInterval(), die auf GESPEICHERTEN Tracks arbeiten und
 * sofort die Wiedergabe neu starten würden — hier wird nur der Formular-Entwurf bearbeitet,
 * bis "Speichern" geklickt wird). Aktive Option wird per .is-active markiert (analog
 * ambVariantRandom/Rotate), Intervall-Min/Max werden bei deaktiviertem Zeitversetzt
 * ausgegraut.
 */
export function _syncAmbientLoopIntervalExclusivity() {
  const loopEl = document.getElementById('ambLoop');
  const intEl  = document.getElementById('ambIntervalMode');
  const loopBtn = document.getElementById('ambLoopRow');
  const intBtn  = document.getElementById('ambIntervalRow');
  loopBtn?.classList.toggle('is-active', !!loopEl?.checked);
  loopBtn?.setAttribute('aria-pressed', String(!!loopEl?.checked));
  intBtn?.classList.toggle('is-active', !!intEl?.checked);
  intBtn?.setAttribute('aria-pressed', String(!!intEl?.checked));
  const mmRow = document.getElementById('ambIntervalMinMaxRow');
  if (mmRow) {
    const on = !!intEl?.checked;
    mmRow.style.opacity = on ? '1' : '0.45';
    mmRow.querySelectorAll('input').forEach(el => { el.disabled = !on; });
  }
  _markActivePlaybackSummary();
}

/**
 * Ambient-Lautstärkevarianz: Konstant ⇄ Variierend — genau eine Option ist aktiv (wie
 * Loop/Zeitversetzt: .is-active + aria-pressed). Zustand liegt im versteckten Feld
 * #ambVolumeMode; Min/Max werden bei „Konstant" ausgegraut und deaktiviert. Reine
 * Editor-Draft-Logik — gespeichert wird erst per „Speichern".
 */
export function _syncAmbientVolumeVariance() {
  const varying = document.getElementById('ambVolumeMode')?.value === VOLUME_MODE_VARYING;
  [['ambVolConstant', !varying], ['ambVolVarying', varying]].forEach(([id, on]) => {
    const btn = document.getElementById(id);
    btn?.classList.toggle('is-active', on);
    btn?.setAttribute('aria-pressed', String(on));
  });
  const row = document.getElementById('ambVolumeMinMaxRow');
  if (row) {
    row.style.opacity = varying ? '1' : '0.45';
    row.querySelectorAll('input').forEach(el => { el.disabled = !varying; });
  }
  _markActivePlaybackSummary();
}

/** Setzt den Modus (Konstant/Variierend) im Editor-Draft und aktualisiert die Darstellung. */
export function _setAmbientVolumeMode(mode) {
  const el = document.getElementById('ambVolumeMode');
  if (el) el.value = mode === VOLUME_MODE_VARYING ? VOLUME_MODE_VARYING : VOLUME_MODE_CONSTANT;
  _syncAmbientVolumeVariance();
}

/**
 * Korrigiert die Min/Max-Eingaben (Prozent): auf 0–100 begrenzen, ungültige Eingaben
 * (leer/NaN) auf den zuletzt gültigen Wert zurücksetzen, vertauschte Werte tauschen.
 * Läuft bei `change` und vor dem Lesen/Speichern.
 */
export function _correctAmbientVolumeInputs() {
  const minEl = document.getElementById('ambVolumeMin');
  const maxEl = document.getElementById('ambVolumeMax');
  if (!minEl || !maxEl) return;
  const last = el => parseFloat(el.dataset.last) / 100;
  const r = normalizeVolumeRange(
    parseFloat(minEl.value) / 100, parseFloat(maxEl.value) / 100,
    { min: last(minEl), max: last(maxEl) }
  );
  minEl.value = Math.round(r.min * 100);
  maxEl.value = Math.round(r.max * 100);
  minEl.dataset.last = minEl.value;
  maxEl.dataset.last = maxEl.value;
}

/** Befüllt die Lautstärkevarianz-Felder aus einer normalisierten Konfiguration ({mode,min,max}, 0…1). */
export function _writeAmbientVolumeToUI(cfg) {
  const minEl = document.getElementById('ambVolumeMin');
  const maxEl = document.getElementById('ambVolumeMax');
  if (minEl) { minEl.value = Math.round(cfg.min * 100); minEl.dataset.last = minEl.value; }
  if (maxEl) { maxEl.value = Math.round(cfg.max * 100); maxEl.dataset.last = maxEl.value; }
  _setAmbientVolumeMode(cfg.mode);
}

/** Liest die (korrigierten) Lautstärkevarianz-Felder: {mode, min, max} im 0…1-Maßstab. */
export function _readAmbientVolumeFromUI() {
  _correctAmbientVolumeInputs();
  return {
    mode: document.getElementById('ambVolumeMode')?.value === VOLUME_MODE_VARYING ? VOLUME_MODE_VARYING : VOLUME_MODE_CONSTANT,
    min:  parseFloat(document.getElementById('ambVolumeMin')?.value) / 100,
    max:  parseFloat(document.getElementById('ambVolumeMax')?.value) / 100
  };
}

/**
 * Mark accordion section headers with 'has-active-setting' (central disclosure indicator) if they contain active effects.
 * Improves visual hierarchy: users can see at a glance which sections are active.
 */
/** Welche Effekt-Gruppen (Sektions-IDs des FX-Dialogs) in `fx` aktive Module enthalten. Einzige Quelle
 *  für Sektions-Punkte, Sound-Karten-Überblick UND den Überblick der Musik-Karte. */
function _activeEffectSections(fx) {
  // `fx` = Formularstand des GEWÄHLTEN Layers (flach). Die Zuordnung Modul → Sektion ergibt sich aus der Lage der Hosts im
  // Formular-HTML (effect-editor.js); es gibt keine zweite, handgepflegte Liste mehr.
  return _fxEditor.activeSections(fx);
}
/** Überblick einer Pipeline für Karten/Chips: aktive Stufen mit Layer-Anzahl in Verarbeitungsreihenfolge. */
export function getActiveEffectGroupLabels(fx) {
  if (!fx || fx.v !== 2) return [];
  const out = STAGE_ORDER
    .filter(st => fx.stages[st].enabled && fx.stages[st].layers.some(l => l.enabled))
    .map(st => `${PIPELINE_STAGES[st].label} ${fx.stages[st].layers.filter(l => l.enabled).length}`);
  return out;
}

export function _markActiveAccordionSections(fx) {
  if (!fx) return;
  const sections = _activeEffectSections(fx);
  Object.entries(sections).forEach(([bodyId, isActive]) => {
    const body   = document.getElementById(bodyId);
    const toggle = body?.previousElementSibling;
    if (toggle) toggle.classList.toggle('has-active-setting', !!isActive);
  });
  // Show/hide the effects active badge on the master toggle
  const badge = document.getElementById('smFxBadge');
  if (badge) badge.style.display = fx.enabled ? '' : 'none';

  // Kompakter Überblick in der "Audio-Effekte"-Sektion: Namen der aktiven
  // Effekt-Gruppen als Chips, statt jeden Abschnitt einzeln öffnen zu müssen.
  const summaryEl = document.getElementById('smFxActiveSummary');
  if (summaryEl) {
    summaryEl.replaceChildren(...getActiveEffectGroupLabels(readEffectsFromUI()).map(label => {
      const chip = document.createElement('span'); chip.className = 'sm-fx-summary__chip'; chip.textContent = label; return chip;
    }));
  }
}

/**
 * Marks the "Wiedergabe" dialog trigger button (#fxToolbar) when a
 * playback setting differs from its default — same idea as
 * _markActiveAccordionSections() above, so a non-default choice stays
 * visible even while #playbackSettingsModal is closed.
 */
export function _syncPlaybackSettingsIndicator() {
  const gs = APP.globalSettings;
  const isDefault = gs.overlap !== false && gs.stopReplay !== true && gs.multiClick !== false && gs.reverbShare !== false && gs.safetyLimiter !== false && (gs.voiceLimit ?? 'auto') === 'auto' && !gs.autoDuck?.enabled;
  document.getElementById('btnPlaybackSettingsToggle')?.classList.toggle('has-active-setting', !isDefault);
}


export function updateEffectSectionVisibility() {
  // Das Formular bleibt bei ausgeschaltetem Master-Schalter (#fxEnabled) bedienbar: Effekte lassen sich vorbereiten, ohne dass sie laufen.
  // (Das frühere Abblenden/Sperren von #fxPanel wirkte nur auf einen leeren, unsichtbaren Platzhalter und ist entfernt, Phase 8.)

  // Aktive-Effekte-Badges/-Übersicht live nachziehen (nicht erst beim
  // nächsten Öffnen des Modals) — siehe _markActiveAccordionSections().
  _markActiveAccordionSections(_readFlatFromUI());
}


// ─── SOUND MODAL ─────────────────────────────────────────────
// The modal is shared between sound-tile editing and ambient-track effects
// editing (same FX accordion — Filter/EQ/Dynamics/Distortion/Reverb/Delay/
// 3D/Pitch — reused as-is). _fxEditContext tracks which one is currently open.
export let _fxEditContext = { kind: 'sound', id: null };
export let _ambVariantMode = 'random';

// Exportierte Setter: ES-Module erlauben kein Neuzuweisen eines importierten
// `let`-Bindings aus einem anderen Modul. _fxEditContext wird auch von ambient-modal.js
// (openAmbientEffectsModal) neu zugewiesen, _ambVariantMode von den Variant-Mode-Radios
// (events/register-tile-events.js).
export function _setFxEditContext(ctx) { _fxEditContext = ctx; }
export function _setAmbVariantMode(mode) { _ambVariantMode = mode; }

// ─── SOUND-EDITOR DRAFT GUARD (Unsaved-Changes-Schutz) ────────
// _soundDraftGuard/_soundDraftBaseline leben in events/utils-modal.js (dort
// auch gelesen/geschrieben von _armSoundDraftGuard()/_releaseSoundDraftGuard()).
// Hier nur der einmalige Setup-Aufruf über _setSoundDraftGuard()
// (aus events/register-tile-events.js).

// ─── AUDIO-ROLLBACK FÜR DIE EDITIERSITZUNG ─────────────────
// slotFile/bulkFile/Tone-Generator schreiben neue Audiodaten bereits WÄHREND
// der Bearbeitung direkt unter ihrem endgültigen IndexedDB-Key (saveSlotAudio()/
// idbSet()) — nicht erst beim Speichern. Damit "Änderungen verwerfen" dadurch
// nicht unbemerkt bereits gespeicherte Audiodaten stehen lässt, wird pro
// Editiersitzung der jeweils ERSTE bisherige Wert jedes betroffenen Keys
// gesichert (Map: Key -> alter Wert, oder `null` falls der Key vorher nicht
// existierte). Mehrfaches Ändern desselben Slots in einer Sitzung überschreibt
// diese Sicherung NICHT (Map.has-Check in _backupAudioKeyOnce). Beim
// Verwerfen wird daraus der Vorzustand wiederhergestellt (vorhandene Werte
// zurückgeschrieben, vorher nicht existente Keys gelöscht); beim Speichern
// wird die Tabelle einfach verworfen, die neuen Daten bleiben.
export let _audioRollback = null;

export function _resetAudioRollback() {
  _audioRollback = new Map();
}

export async function _backupAudioKeyOnce(key) {
  if (!_audioRollback || _audioRollback.has(key)) return;
  let prev = null;
  try { prev = await idbGet(key); } catch (e) { console.warn('[events] Rollback-Backup fehlgeschlagen für', key, e); }
  _audioRollback.set(key, prev);
}

export async function _discardAudioRollback() {
  if (!_audioRollback) return;
  const entries = [..._audioRollback.entries()];
  _audioRollback = null;
  for (const [key, prev] of entries) {
    try {
      if (prev == null) await idbDelete(key);
      else               await idbSet(key, prev);
    } catch (e) { console.warn('[events] Audio-Rollback fehlgeschlagen für', key, e); }
  }
}

export function _commitAudioRollback() {
  // Neue Daten bleiben unangetastet — nur die Sicherungstabelle wird verworfen.
  _audioRollback = null;
}

/**
 * Übersicht in der Makro-Einstiegskarte „Wiedergabe & Verhalten“ — gleiches Muster
 * wie _markActivePlaybackSummary() beim Sound: Chips für abweichende Einstellungen
 * (Abspiel-Modus ≠ Parallel, Wiederholungs-Pause ≠ 500 ms), sonst Platzhalter.
 */
export function _syncMacroPlaybackSummary() {
  const mode  = document.getElementById('mPlayMode')?.value || 'parallel';
  const delay = parseInt(document.getElementById('mRepDelay')?.value);
  const chips = [];
  if (mode === 'sequential') chips.push('Sequenziell');
  if (mode === 'random')     chips.push('Zufällig');
  if (!isNaN(delay) && delay !== 500) chips.push(`Pause ${delay} ms`);

  const summaryEl = document.getElementById('mPlaybackSummary');
  if (summaryEl) {
    summaryEl.innerHTML = chips.length
      ? chips.map(label => `<span class="sm-fx-summary__chip">${label}</span>`).join('')
      : '<span class="u-text-muted u-text-badge" style="font-style:italic">Standardwiedergabe</span>';
  }
  const badge = document.getElementById('mPlaybackBadge');
  if (badge) badge.style.display = chips.length ? '' : 'none';
}

/**
 * Icon + Akzentfarbe in der "Darstellung & Organisation"-Einstiegskarte
 * nachziehen, damit die aktuelle Wahl sichtbar bleibt, auch wenn die
 * Dialogbox mit dem eigentlichen Icon-/Farb-Picker geschlossen ist —
 * gleiches Prinzip wie die Aktive-Effekte-Übersicht bei Audio-Effekte.
 */
export function _syncAppearancePreview() {
  syncEntryCardPreview({
    iconElId: 'smAppearancePreviewIcon', inputId: 'eIcon', fallbackIcon: '🔊',
    colorElId: 'smAppearancePreviewColor', colorOptsId: 'clrOpts'
  });
}


export async function _preloadEditBuffers() {
  const ctx = actx();
  let changed = false;
  for (let i = 0; i < APP.editSlots.length; i++) {
    const sl = APP.editSlots[i];
    if (!sl?.data || APP.audioBuffers[`_ed_${i}`]) continue;
    try {
      let b64 = sl.data;
      if (isIdbRef(b64)) {
        const key = _fxEditContext.kind === 'ambient'
          ? audioKey(sl._fileId, 0)
          : audioKey(_fxEditContext.id || APP._pendingSoundId, i);
        b64 = await idbGet(key);
      }
      if (!b64) continue;
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
      APP.audioBuffers[`_ed_${i}`] = await ctx.decodeAudioData(arr.buffer.slice(0));
      changed = true;
    } catch (e) { console.warn('[events] preload edit buffer failed:', e); }
  }
  if (changed) renderSlotList();
}

export function openSoundModal(id, placeholderId = null) {
  _fxEditContext      = { kind: 'sound', id };
  APP.editId          = id;
  APP._phReplacingId  = placeholderId;
  APP._pendingSoundId = id ? null : uid();

  // Clear any leftover _ed_N buffers from the previous modal session.
  // Without this, editing Sound A after loading audio for Sound B would
  // copy Sound B's buffer into Sound A's cache on save.
  Object.keys(APP.audioBuffers).forEach(k => {
    if (k.startsWith('_ed_')) delete APP.audioBuffers[k];
  });
  // Frische Audio-Rollback-Sicherung für diese Editiersitzung —
  // eine evtl. Sicherung der vorherigen Sitzung darf hier keinesfalls erben.
  _resetAudioRollback();
  // Defensiv — eine Preview aus einer vorherigen Sitzung darf
  // niemals in eine neue "erben" (normalerweise bereits durch den
  // hide.bs.modal-Listener beim letzten Schließen erledigt).
  stopEffectPreview();

  const s = id ? CItems().find(x => x.id === id) : null;

  _setModalContext('sound');
  document.getElementById('sMTitle').textContent = id ? 'SOUND BEARBEITEN' : 'NEUER SOUND';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  const chk = (elId, val) => { const el = document.getElementById(elId); if (el) el.checked = val; };

  set('eName',    s ? s.name     : '');
  set('eVol',     s ? s.vol      : 1);
  set('eVolNum',  Math.round((s ? s.vol : 1) * 100));
  set('eLoop',    '');
  set('eHotkey',  s ? s.hotkey   : '');
  set('eCat',     s ? s.category : '');
  set('eIcon',    s ? s.icon     : '');
  set('eTileW',   s && s.tileW ? s.tileW : '');
  set('eTileH',   s && s.tileH ? s.tileH : '');

  chk('eLoop', s ? !!s.loop   : false);
  chk('eFade', s ? !!s.fade   : false);
  chk('eRnd',  s ? !!s.random : false);

  const delBtn = document.getElementById('btnDelSound');
  if (delBtn) delBtn.style.display = id ? '' : 'none';
  const expBtn = document.getElementById('btnExportSound');
  if (expBtn) expBtn.style.display = id ? '' : 'none';
  // Verschieben/Duplizieren nur für einen bereits gespeicherten Sound (nicht bei „Neuer Sound“).
  ['btnEditMove', 'btnEditDuplicate'].forEach(bid => {
    const b = document.getElementById(bid);
    if (b) b.style.display = id ? '' : 'none';
  });

  // _idbSlot: merkt sich, an welcher Position die Audiodaten dieses Slots
  // GERADE physisch in IndexedDB liegen (= ihre Position im bestehenden
  // Sound). Wird beim Speichern (btnSaveSound) genutzt, um Audiodaten bei
  // einem zwischenzeitlichen Reorder korrekt an die neue Position zu
  // verschieben (siehe normalizeSlotAudioStorage in db.js). Rein internes
  // Editor-Feld, wird vor dem Persistieren wieder entfernt.
  APP.editSlots = s
    ? (s.slots || []).map((sl, i) => ({ ...sl, _idbSlot: isIdbRef(sl.data) ? i : null, _tempId: uid() }))
    : [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null, _tempId: uid() }];
  renderSlotList();
  _preloadEditBuffers();
  buildIconGrid('iconGrid',  s ? s.icon  : '');
  buildColorOpts('clrOpts',  s ? s.color : 'none');
  buildColorOpts('eTileClrOpts', s && s.tileColor ? s.tileColor : 'none');

  // ── Effects UI ────────────────────────────────────────────
  writeEffectsToUI(s?.effects);
  // ─────────────────────────────────────────────────────────
  // ── "Wiedergabe & Verhalten" UI ─────────────────────────────
  writePlaybackToUI(s?.playback || defaultPlayback());
  // ─────────────────────────────────────────────────────────
  _syncAppearancePreview();

  document.getElementById('soundModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#soundModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });

  // Baseline für den Dirty-Vergleich erst JETZT einfrieren —
  // alle Felder (inkl. Effekte/Slots) sind zu diesem Zeitpunkt vollständig befüllt.
  _armSoundDraftGuard();

  new bootstrap.Modal(document.getElementById('soundModal')).show();
}

/** Opens the same modal in "ambient" context — Grundeinstellungen mirrors the sound-tile layout
 *  (file variants with trim, volume, loop/interval, fades, variant-mode) + the full FX accordion. */
