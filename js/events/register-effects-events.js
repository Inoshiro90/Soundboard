/**
 * events/register-effects-events.js — Effekt-UI-Events (Akkordeon,
 * Preset-Dropdown, alle Effekt-Regler), Sound-Modal-Speichern (inkl.
 * Draft-Guard-Freigabe, Audio-Rollback-Commit)
 */

import { APP, CItems } from '../core/state.js';
import { uid, bk } from '../utils.js';
import { toast } from '../notifications.js';
import { stopItem } from '../audio/playback.js';
import { previewSound, stopEffectPreview, syncPreviewAnalyzer, stopAnalyzer } from '../audio/preview.js';
import { defaultEffects } from '../audio/effect-graph.js';
import '../presets/effect-presets-data.js';
import { getPresetById, applyPresetEffects } from '../presets.js';
import { invalidateBuffer } from '../audioCache.js';
import { renderGrid } from '../ui/grid.js';
import { getSlotEditIndex } from '../ui/slot-editor.js';
import { idbDelete, audioKey, normalizeSlotAudioStorage } from '../db.js';
import { exportSoundItem } from '../storage/import-export.js';
import '../export.js';
import '../audio/playback.js';
import '../history.js';
import { toggleAmbientPlay } from '../ambient/ambient-playback.js';
import {
  findAmbientTrack, renameAmbientTrack, setAmbientTrackIcon, setAmbientTrackColor,
  setAmbientTrackEffects, setAmbientTrackVolume, persistAmbientNow
} from '../ambient/ambient-model.js';
import { renderAmbientPanel } from '../ambient/ambient-render.js';
import '../dialogs/ambient-modal.js';
import {
  readEffectsFromUI, writeEffectsToUI, resetEffectParametersPreserveMasterEnabled,
  readPlaybackFromUI, updatePlaybackSectionVisibility, _markActivePlaybackSummary,
  updateEffectSectionVisibility, _fxEditContext, _ambVariantMode,
  _syncAmbientLoopIntervalExclusivity, _syncAppearancePreview
} from '../dialogs/sound-modal.js';
import { _releaseSoundDraftGuard } from './utils-modal.js';
import { updateFxPresetActionButtons } from './register-preset-events.js';
// Zirkulärer Import (index.js importiert umgekehrt registerEffectsEvents aus
// diesem Modul) — unkritisch, s. bereits etabliertes Muster.
import { _updateEnvelopeCurve } from './index.js';

export function registerEffectsEvents() {
  // ── EFFECTS UI EVENTS ──────────────────────────────────────

  // Master enable toggle
  document.getElementById('fxEnabled')?.addEventListener('change', () => {
    updateEffectSectionVisibility();
  });

  // Sub-section enable toggles
  ['fxLpEnabled', 'fxHpEnabled', 'fxRevEnabled', 'fxDelEnabled'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      updateEffectSectionVisibility();
    });
  });

  // Audio-Effekte: eigene Dialogbox statt Accordion im Hauptformular
  // (siehe soundFxModal in index.html). Bleibt technisch unabhängig vom
  // Hauptdialog — alle FX-Feld-IDs sind unverändert.
  document.getElementById('btnOpenFxModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('soundFxModal')).show();
  });

  // Darstellung & Organisation: gleiches Muster wie Audio-Effekte — eigene
  // Dialogbox statt drittem Formular-Block im Hauptdialog.
  document.getElementById('btnOpenAppearanceModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('soundAppearanceModal')).show();
  });
  // Vorschau in der Einstiegskarte nachziehen, sobald die Dialogbox
  // schließt — die Karte ist dann wieder sichtbar und muss den aktuellen
  // Stand zeigen (Prinzip: aktive Auswahl bleibt sichtbar).
  document.getElementById('soundAppearanceModal')?.addEventListener('hidden.bs.modal', _syncAppearancePreview);
  // …und schon während der Dialog offen ist live mitziehen, für den Fall,
  // dass beide Dialoge gleichzeitig sichtbar sind (z. B. sehr breiter Screen).
  document.getElementById('eIcon')?.addEventListener('input', _syncAppearancePreview);
  document.getElementById('clrOpts')?.addEventListener('click', _syncAppearancePreview);

  // Wiedergabe & Verhalten: gleiches Muster wie Audio-Effekte/Darstellung —
  // eigene Dialogbox statt drittem/viertem Formular-Block im Hauptdialog.
  document.getElementById('btnOpenPlaybackModal')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('soundPlaybackModal')).show();
  });

  // Fade-In
  document.getElementById('pbFadeInEnabled')?.addEventListener('change', () => updatePlaybackSectionVisibility());
  document.getElementById('pbFadeInDuration')?.addEventListener('input', function() {
    const lbl = document.getElementById('pbFadeInDurationLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + 's';
  });
  document.getElementById('pbFadeInCurve')?.addEventListener('change', () => _markActivePlaybackSummary());

  // Fade-Out
  document.getElementById('pbFadeOutEnabled')?.addEventListener('change', () => updatePlaybackSectionVisibility());
  document.getElementById('pbFadeOutDuration')?.addEventListener('input', function() {
    const lbl = document.getElementById('pbFadeOutDurationLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + 's';
  });
  document.getElementById('pbFadeOutCurve')?.addEventListener('change', () => _markActivePlaybackSummary());

  // Crossfade
  document.getElementById('pbCrossfadeEnabled')?.addEventListener('change', () => updatePlaybackSectionVisibility());
  document.getElementById('pbCrossfadeDuration')?.addEventListener('input', function() {
    const lbl = document.getElementById('pbCrossfadeDurationLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + 's';
  });
  document.getElementById('pbCrossfadeCurve')?.addEventListener('change', () => _markActivePlaybackSummary());

  // Zufall (#eRnd) lebt in #soundPlaybackModal, ist aber ein eigenständiges Sound-Feld
  // (s.random) — Summary/Badge trotzdem live mitziehen, wenn es umgeschaltet wird.
  document.getElementById('eRnd')?.addEventListener('change', () => _markActivePlaybackSummary());

  // AMBIENT-Kontext: Fade-In/Fade-Out-Kurven, Loop⇄Zeitversetzt-Ausschließlichkeit.
  document.getElementById('ambFadeIn')?.addEventListener('input',  () => _markActivePlaybackSummary());
  document.getElementById('ambFadeOut')?.addEventListener('input', () => _markActivePlaybackSummary());
  document.getElementById('ambFadeInCurve')?.addEventListener('change',  () => _markActivePlaybackSummary());
  document.getElementById('ambFadeOutCurve')?.addEventListener('change', () => _markActivePlaybackSummary());
  // Loop/Zeitversetzt sind echte Buttons (#ambLoopRow/#ambIntervalRow); die internen
  // Boolean-Felder (#ambLoop/#ambIntervalMode) bleiben als verstecktes Zustandsfeld
  // erhalten (Speichern liest .checked).
  document.getElementById('ambLoopRow')?.addEventListener('click', function() {
    const loopEl = document.getElementById('ambLoop');
    const intEl  = document.getElementById('ambIntervalMode');
    if (!loopEl) return;
    loopEl.checked = !loopEl.checked;
    if (loopEl.checked && intEl) intEl.checked = false;
    _syncAmbientLoopIntervalExclusivity();
  });
  document.getElementById('ambIntervalRow')?.addEventListener('click', function() {
    const loopEl = document.getElementById('ambLoop');
    const intEl  = document.getElementById('ambIntervalMode');
    if (!intEl) return;
    intEl.checked = !intEl.checked;
    if (intEl.checked && loopEl) loopEl.checked = false;
    _syncAmbientLoopIntervalExclusivity();
  });

  // Preset dropdown
  // applyPresetEffects() (presets.js) ist generisch über ALLE von der Engine
  // unterstützten Effektmodule (inkl. pitchShift/irReverb/envelope/spatial/noiseGate
  // sowie notch/wahwah/chorus/flanger/tremolo/ringmod) und einheitlich für Built-in-
  // UND User-Presets nutzbar — keine Preset-spezifischen Sonderfälle nötig.
  document.getElementById('fxPreset')?.addEventListener('change', function() {
    const val = this.value;
    if (!val) {
      // "Kein Preset" gewählt — Effekte auf Standardwerte zurücksetzen
      writeEffectsToUI(defaultEffects());
      updateFxPresetActionButtons();
      return;
    }
    const preset = getPresetById(val);
    if (!preset) { updateFxPresetActionButtons(); return; }
    const merged = applyPresetEffects(preset.effects);
    merged.enabled = true;
    merged.preset  = val;
    writeEffectsToUI(merged);
    updateFxPresetActionButtons();
  });

  // Lowpass slider
  document.getElementById('fxLpFreq')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxLpFreqLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' Hz';
  });

  // Highpass slider
  document.getElementById('fxHpFreq')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxHpFreqLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' Hz';
  });

  // Pan slider
  document.getElementById('fxPan')?.addEventListener('input', function() {
    const v = parseFloat(this.value);
    const lbl = document.getElementById('fxPanLbl');
    if (lbl) lbl.textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
  });

  // Notch
  document.getElementById('fxNotchEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxNotchFreq')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxNotchFreqLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' Hz';
  });
  document.getElementById('fxNotchQ')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxNotchQLbl');
    if (lbl) lbl.textContent = 'Q ' + this.value;
  });

  // Wahwah
  document.getElementById('fxWahwahEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxWahwahFrequency')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxWahwahFrequencyLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' Hz';
  });
  document.getElementById('fxWahwahDepth')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxWahwahDepthLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });
  document.getElementById('fxWahwahRate')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxWahwahRateLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + ' Hz';
  });
  document.getElementById('fxWahwahResonance')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxWahwahResonanceLbl');
    if (lbl) lbl.textContent = 'Q' + parseFloat(this.value).toFixed(1);
  });

  // Reverb sliders
  document.getElementById('fxRevAmount')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxRevAmountLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });
  document.getElementById('fxRevDuration')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxRevDurationLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + 's';
  });
  document.getElementById('fxRevDecay')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxRevDecayLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1);
  });

  // Delay sliders
  document.getElementById('fxDelTime')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxDelTimeLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(2) + 's';
  });
  document.getElementById('fxDelFeedback')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxDelFeedbackLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });
  document.getElementById('fxDelWet')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxDelWetLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });

  // Reset effects button
  document.getElementById('btnFxReset')?.addEventListener('click', () => {
    resetEffectParametersPreserveMasterEnabled();
    toast('Effekte zurückgesetzt');
  });

  // EQ
  document.getElementById('fxEqEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  const eqSliders = [
    ['fxEqLow',  'fxEqLowLbl'],
    ['fxEqMid',  'fxEqMidLbl'],
    ['fxEqHigh', 'fxEqHighLbl'],
  ];
  eqSliders.forEach(([sid, lid]) => {
    document.getElementById(sid)?.addEventListener('input', function() {
      const v   = parseFloat(this.value);
      const lbl = document.getElementById(lid);
      if (lbl) lbl.textContent = (v >= 0 ? '+' : '') + v.toFixed(0) + ' dB';
    });
  });

  // Compressor
  document.getElementById('fxCompEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxCompThreshold')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxCompThresholdLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(0) + ' dB';
  });
  document.getElementById('fxCompKnee')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxCompKneeLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(0);
  });
  document.getElementById('fxCompRatio')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxCompRatioLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(0) + ':1';
  });
  document.getElementById('fxCompAttack')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxCompAttackLbl');
    if (lbl) lbl.textContent = (parseFloat(this.value) * 1000).toFixed(1) + ' ms';
  });
  document.getElementById('fxCompRelease')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxCompReleaseLbl');
    if (lbl) lbl.textContent = (parseFloat(this.value) * 1000).toFixed(0) + ' ms';
  });

  // Limiter
  document.getElementById('fxLimEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxLimThreshold')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxLimThresholdLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + ' dB';
  });

  // Distortion
  document.getElementById('fxDistEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxDistMode')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxDistAmount')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxDistAmountLbl');
    if (lbl) lbl.textContent = Math.round(this.value);
  });

  // Ring Modulation
  document.getElementById('fxRingmodEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxRingmodFrequency')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxRingmodFrequencyLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' Hz';
  });

  // Tremolo
  document.getElementById('fxTremoloEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxTremoloRate')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxTremoloRateLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + ' Hz';
  });
  document.getElementById('fxTremoloDepth')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxTremoloDepthLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });

  // Chorus
  document.getElementById('fxChorusEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxChorusBaseDelay')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxChorusBaseDelayLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' ms';
  });
  document.getElementById('fxChorusDepth')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxChorusDepthLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' ms';
  });
  document.getElementById('fxChorusRate')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxChorusRateLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(2) + ' Hz';
  });
  document.getElementById('fxChorusMix')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxChorusMixLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });

  // Flanger
  document.getElementById('fxFlangerEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxFlangerBaseDelay')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxFlangerBaseDelayLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + ' ms';
  });
  document.getElementById('fxFlangerDepth')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxFlangerDepthLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + ' ms';
  });
  document.getElementById('fxFlangerRate')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxFlangerRateLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(2) + ' Hz';
  });
  document.getElementById('fxFlangerFeedback')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxFlangerFeedbackLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });
  document.getElementById('fxFlangerMix')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxFlangerMixLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });

  // WAV Export Button
  document.getElementById('btnExportWav')?.addEventListener('click', () => {
    const id = APP.editId;
    if (!id) { toast('Kein Sound gewählt', 'err'); return; }
    const s = CItems().find(x => x.id === id);
    if (!s) { toast('Sound nicht gefunden', 'err'); return; }
    // Save current UI state to sound before exporting
    const effects = readEffectsFromUI();
    s.effects = effects;
    import('../audio/playback.js').then(m => m.exportSoundToWav(s));
  });

  // Pitch Shift
  document.getElementById('fxPitchEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxPitchSemitones')?.addEventListener('input', function() {
    const v = parseInt(this.value) || 0;
    const lbl = document.getElementById('fxPitchSemitonesLbl');
    if (lbl) lbl.textContent = (v >= 0 ? '+' : '') + v;
  });

  // EQ10 sliders (10 bands)
  document.getElementById('fxEq10Enabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  for (let i = 0; i < 10; i++) {
    document.getElementById('fxEq10_' + i)?.addEventListener('input', function() {
      const v = parseFloat(this.value);
      const lbl = document.getElementById('fxEq10Lbl_' + i);
      if (lbl) lbl.textContent = (v >= 0 ? '+' : '') + v.toFixed(0);
      // A11y: Wert inkl. Einheit für Screenreader nachziehen (s. writeEffectsToUI).
      this.setAttribute('aria-valuetext', (v >= 0 ? '+' : '') + v.toFixed(0) + ' dB');
    });
    // Q-Regler pro Band
    document.getElementById('fxEq10Q_' + i)?.addEventListener('input', function() {
      const v = parseFloat(this.value);
      const lbl = document.getElementById('fxEq10QLbl_' + i);
      if (lbl) lbl.textContent = 'Q' + v.toFixed(1);
      this.setAttribute('aria-valuetext', 'Q ' + v.toFixed(1));
    });
  }
  document.getElementById('btnEq10Reset')?.addEventListener('click', () => {
    for (let i = 0; i < 10; i++) {
      const sl = document.getElementById('fxEq10_' + i);
      if (sl) { sl.value = 0; sl.setAttribute('aria-valuetext', '+0 dB'); }
      const lb = document.getElementById('fxEq10Lbl_' + i); if (lb) lb.textContent = '+0';
      // Q-Werte auf Standard (1.4) zurücksetzen
      const qsl = document.getElementById('fxEq10Q_' + i);
      if (qsl) { qsl.value = 1.4; qsl.setAttribute('aria-valuetext', 'Q 1.4'); }
      const qlb = document.getElementById('fxEq10QLbl_' + i); if (qlb) qlb.textContent = 'Q1.4';
    }
  });

  // ADSR Envelope
  document.getElementById('fxEnvEnabled')?.addEventListener('change', () => {
    updateEffectSectionVisibility();
    _updateEnvelopeCurve();
  });
  [['fxEnvAttack','fxEnvAttackLbl','ms'], ['fxEnvDecay','fxEnvDecayLbl','ms'],
   ['fxEnvSustain','fxEnvSustainLbl','%'], ['fxEnvRelease','fxEnvReleaseLbl','ms']].forEach(([sid, lid, unit]) => {
    document.getElementById(sid)?.addEventListener('input', function() {
      const v = parseFloat(this.value);
      const lbl = document.getElementById(lid);
      if (lbl) {
        if (unit === 'ms') lbl.textContent = (v * 1000).toFixed(0) + ' ms';
        else lbl.textContent = Math.round(v * 100) + '%';
      }
      _updateEnvelopeCurve();
    });
  });

  // IR Reverb
  document.getElementById('fxIrEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxIrWet')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxIrWetLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });

  // Analyzer
  document.getElementById('fxAnalyzerEnabled')?.addEventListener('change', function() {
    updateEffectSectionVisibility();
    // "Analyzer AUS ≠ Preview AUS" — betrifft nur die
    // Visualisierung, eine laufende Preview spielt unverändert weiter.
    if (!this.checked) stopAnalyzer();
    else syncPreviewAnalyzer(true);
  });
  document.getElementById('fxAnalyzerMode')?.addEventListener('change', function() {
    // Ein laufender Analyzer (Live ODER Preview) wechselt
    // sofort den Darstellungsmodus, ohne den Audio-Graph neu aufzubauen —
    // die Zeichenschleife liest APP.analyzer.mode bei jedem Frame neu.
    // Bestehende Modusvariable wiederverwendet, keine zweite eingeführt.
    if (APP.analyzer.active) APP.analyzer.mode = this.value;
  });

  // Full export (with audio)
  document.getElementById('btnExportFull')?.addEventListener('click', () => {
    import('../storage/import-export.js').then(m => m.exportDataWithAudio());
  });

  // Spatial 3D controls
  document.getElementById('fxSpatialEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  [['fxSpatialX','fxSpatialXLbl'], ['fxSpatialY','fxSpatialYLbl'],
   ['fxSpatialZ','fxSpatialZLbl'], ['fxSpatialRolloff','fxSpatialRolloffLbl']].forEach(([sid, lid]) => {
    document.getElementById(sid)?.addEventListener('input', function() {
      const lbl = document.getElementById(lid); if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1);
    });
  });

  // Noise Gate
  document.getElementById('fxNoiseGateEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxNoiseGateThreshold')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxNoiseGateThresholdLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(0) + ' dB';
  });

  // Undo / Redo buttons
  document.getElementById('btnUndo')?.addEventListener('click', () => import('../history.js').then(m => m.undo()));
  document.getElementById('btnRedo')?.addEventListener('click', () => import('../history.js').then(m => m.redo()));

  // Sound Modal: MP3 Export button
  document.getElementById('btnExportMp3')?.addEventListener('click', async () => {
    const id = APP.editId; if (!id) return;
    const s  = CItems().find(x => x.id === id); if (!s) return;
    s.effects = readEffectsFromUI();
    const { exportSoundMp3 } = await import('../export.js');
    await exportSoundMp3(s);
  });

  // ── SOUND MODAL SAVE ───────────────────────────────────────

  document.getElementById('btnSaveSound')?.addEventListener('click', async () => {
    // Preview zuerst stoppen, dann speichern, dann schließen.
    // Der hide.bs.modal-Listener oben würde das ohnehin beim anschließenden
    // .hide() nachholen — hier zusätzlich explizit, um die geforderte
    // Reihenfolge unmissverständlich abzubilden.
    stopEffectPreview();
    if (_fxEditContext.kind === 'ambient') {
      const g = id => document.getElementById(id);
      const t = findAmbientTrack(_fxEditContext.id);
      if (!t) { _releaseSoundDraftGuard(); bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide(); return; }

      const name = g('eName').value.trim() || 'Ambient';
      const vol  = parseFloat(g('eVol').value);
      renameAmbientTrack(_fxEditContext.id, name);
      if (!isNaN(vol)) setAmbientTrackVolume(_fxEditContext.id, vol);
      setAmbientTrackEffects(_fxEditContext.id, readEffectsFromUI());

      // Icon + Akzentfarbe ("Darstellung & Organisation") werden auch im Ambient-Kontext
      // angezeigt (s. openAmbientEffectsModal) und müssen deshalb hier gespeichert werden —
      // Kachel-Hintergrund (eTileClr) bleibt bewusst außen vor, da sm-sound-only.
      const icon = g('eIcon')?.value.trim();
      if (icon) setAmbientTrackIcon(_fxEditContext.id, icon);
      const clrEl = document.querySelector('#clrOpts .color-swatch.is-selected');
      setAmbientTrackColor(_fxEditContext.id, clrEl?.dataset.color || 'none');

      // Reconcile file variants (incl. trim) from APP.editSlots back into t.files.
      const keptIds  = new Set();
      const newFiles = [];
      APP.editSlots.forEach(sl => {
        if (!sl || !sl.data) return;
        const fid = sl._fileId || uid();
        keptIds.add(fid);
        newFiles.push({
          id: fid, data: sl.data, fileName: sl.name || 'Datei',
          trimStart: sl.trimStart || 0, trimEnd: sl.trimEnd ?? null
        });
      });
      (t.files || []).forEach(f => {
        if (!keptIds.has(f.id)) { invalidateBuffer(f.id, 0); idbDelete(audioKey(f.id, 0)).catch(() => {}); }
      });
      t.files = newFiles;

      t.loop         = !!g('ambLoop').checked;
      t.intervalMode = !!g('ambIntervalMode').checked;
      const iMin = parseFloat(g('ambIntervalMin').value);
      const iMax = parseFloat(g('ambIntervalMax').value);
      if (!isNaN(iMin)) t.intervalMin = Math.max(0, iMin);
      if (!isNaN(iMax)) t.intervalMax = Math.max(0, iMax);
      const fIn  = parseFloat(g('ambFadeIn').value);
      const fOut = parseFloat(g('ambFadeOut').value);
      if (!isNaN(fIn))  t.fadeIn  = Math.max(0, fIn);
      if (!isNaN(fOut)) t.fadeOut = Math.max(0, fOut);
      t.fadeInCurve  = g('ambFadeInCurve')?.value  || 'linear';
      t.fadeOutCurve = g('ambFadeOutCurve')?.value || 'linear';
      // Crossfade: gemeinsame Felder mit dem Sound-Kontext (pbCrossfade*,
      // s. #soundPlaybackModal) — hier nach t.crossfade statt s.playback.crossfade.
      t.crossfade = readPlaybackFromUI().crossfade;
      t.variantMode = _ambVariantMode;

      persistAmbientNow();
      renderAmbientPanel();
      // Erfolgreich gespeichert — Guard für DIESES eine
      // programmgesteuerte Schließen deaktivieren, sonst würde die
      // Verwerfen-Rückfrage direkt nach dem Speichern nochmal erscheinen.
      _releaseSoundDraftGuard();
      bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
      toast('Gespeichert ✓', 'ok');
      return;
    }
    const g = id => document.getElementById(id);
    const name     = g('eName').value.trim()      || 'SOUND';
    const vol      = parseFloat(g('eVol').value);
    // Pitch hat keine UI mehr (siehe Audio-Effekte → Pitch Shift) — beim
    // Bearbeiten bleibt ein evtl. vorhandener alter Wert einfach erhalten,
    // neue Sounds starten bei 1 (unverändert).
    const pitch    = APP.editId ? (CItems().find(x => x.id === APP.editId)?.pitch || 1) : 1;
    const loop     = g('eLoop').checked;
    const fade     = g('eFade').checked;
    const random   = g('eRnd').checked;
    const hotkey   = g('eHotkey').value.trim();
    const category = g('eCat').value.trim();
    const icon     = g('eIcon').value.trim()      || '🔊';
    const sel      = document.querySelector('#clrOpts .color-swatch.is-selected');
    const color    = sel ? sel.dataset.color : 'none';
    const tcSel    = document.querySelector('#eTileClrOpts .color-swatch.is-selected');
    const tileColor = (tcSel && tcSel.dataset.color !== 'none') ? tcSel.dataset.color : '';
    const tileW    = parseInt(g('eTileW').value)  || null;
    const tileH    = parseInt(g('eTileH').value)  || null;
    const effects  = readEffectsFromUI();
    const playback = readPlaybackFromUI();
    const items    = CItems();

    // BEVOR die internen Tracking-Felder entfernt werden, muss die physische
    // IndexedDB-Position jedes Slots an seine finale (evtl. per Drag-and-Drop veränderte)
    // Reihenfolge angeglichen werden — sonst bleibt Audio nach einem Reorder unter dem
    // alten Index liegen, während die Metadaten schon die neue Reihenfolge zeigen.
    const stableIdForNormalize = APP.editId || APP._pendingSoundId;
    if (stableIdForNormalize) {
      const existingSound   = APP.editId ? items.find(x => x.id === APP.editId) : null;
      const previousSlotCnt = existingSound ? (existingSound.slots || []).length : 0;
      try {
        await normalizeSlotAudioStorage(stableIdForNormalize, APP.editSlots, previousSlotCnt);
      } catch (err) {
        console.error('[events] normalizeSlotAudioStorage fehlgeschlagen:', err);
      }
    }

    // Strip internal-only fields from slots before persisting
    const cleanSlots = APP.editSlots.map(sl => {
      if (!sl) return sl;
      const { _tempId, _idbSlot, _loading, ...rest } = sl; // remove temporary editor-only fields
      return rest;
    });

    if (APP.editId) {
      const s = items.find(x => x.id === APP.editId);
      if (!s) { toast('Sound nicht gefunden', 'err'); return; }
      const oldSlotCount = (s.slots || []).length;
      Object.assign(s, { name, vol, pitch, loop, fade, random, hotkey, category, icon, color, tileColor, tileW, tileH, slots: cleanSlots, curSlot: 0, effects, playback });
      // Der Laufzeit-Cache (APP.audioBuffers, bk()-Keys) ist POSITIONSBEZOGEN. Da Slots
      // reordert/ersetzt/entfernt worden sein können, wird er für den gesamten (alten UND
      // neuen) Index-Bereich zunächst komplett invalidiert und danach NUR mit sicher
      // korrekten Buffern (aus _ed_N, das ui/slot-editor.js bei jedem Reorder synchron zur
      // jeweiligen Slot-Objekt-Identität hält) neu befüllt. Für alle übrigen Slots lädt
      // getOrDecodeBuffer() beim nächsten Abspielen zuverlässig aus dem gerade
      // normalisierten IndexedDB nach — dadurch kann kein veralteter positionaler
      // Cache-Eintrag (z.B. von einer VOR dem Reorder an diesem Index liegenden Datei)
      // mehr fälschlich weiterverwendet werden.
      const maxIdx = Math.max(oldSlotCount, cleanSlots.length);
      for (let i = 0; i < maxIdx; i++) invalidateBuffer(s.id, i);
      cleanSlots.forEach((sl, i) => {
        const edBuf = APP.audioBuffers[`_ed_${i}`];
        if (edBuf) APP.audioBuffers[bk(s.id, i)] = edBuf;
      });
    } else {
      // Use the pre-generated stable ID (so IDB audio keys already match)
      const id    = APP._pendingSoundId || uid();
      APP._pendingSoundId = null;
      const phId  = APP._phReplacingId;
      const phIdx = phId ? items.findIndex(x => x.id === phId) : -1;
      const newS  = { type: 'sound', id, order: phIdx >= 0 ? items[phIdx].order : 99999, name, vol, pitch, loop, fade, random, hotkey, category, icon, color, tileColor, tileW, tileH, slots: cleanSlots, curSlot: 0, locked: false, effects, playback };
      if (phIdx >= 0) items.splice(phIdx, 1, newS);
      else {
        const firstPH = items.findIndex(x => x.type === 'placeholder');
        if (firstPH >= 0) { newS.order = items[firstPH].order; items.splice(firstPH, 1, newS); }
        else              { newS.order = items.length; items.push(newS); }
      }
      // Copy edit-modal buffers into the main cache for immediate playback
      cleanSlots.forEach((sl, i) => {
        invalidateBuffer(id, i);
        const edBuf = APP.audioBuffers[`_ed_${i}`];
        if (edBuf) APP.audioBuffers[bk(id, i)] = edBuf;
      });
    }
    // Erfolgreich gespeichert — Guard für dieses programmgesteuerte
    // Schließen deaktivieren, damit danach keine Verwerfen-Rückfrage erscheint.
    _releaseSoundDraftGuard();
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gespeichert ✓', 'ok');
  });

  document.getElementById('btnDelSound')?.addEventListener('click', () => {
    if (!APP.editId) return;
    if (!confirm('Diesen Sound wirklich löschen?')) return;
    stopEffectPreview();
    stopItem(APP.editId);
    const items = CItems(); const idx = items.findIndex(x => x.id === APP.editId);
    if (idx >= 0) { const order = items[idx].order; items.splice(idx, 1, { type: 'placeholder', id: uid(), order, locked: false }); }
    // Der ganze Sound wird gelöscht (bereits oben eigens bestätigt) — die
    // separate Unsaved-Changes-Rückfrage beim anschließenden Schließen des
    // Dialogs wäre hier nur verwirrend und wird deshalb unterdrückt.
    _releaseSoundDraftGuard();
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gelöscht');
  });
  document.getElementById('btnExportSound')?.addEventListener('click', () => {
    if (APP.editId) exportSoundItem(APP.editId);
  });

  // Gemeinsame Handler-Funktion statt doppelter Logik — #btnPreviewSound (Sticky-Bar
  // des Sound-Editors) und #btnPreviewFx (Footer von "Audio-Effekte") steuern beide
  // dieselbe, einzige Preview (previewSound()/APP.audioPreview).
  async function _handlePreviewClick() {
    if (_fxEditContext.kind === 'ambient') { toggleAmbientPlay(_fxEditContext.id); return; }

    // Ein Klick während einer laufenden ODER ladenden
    // Preview stoppt sie — previewSound() togglet das intern (audio/preview.js).
    if (APP.audioPreview.playing || APP.audioPreview.loading) { await previewSound(); return; }

    const slots = APP.editSlots;
    const hasData = slots.some(sl => sl && sl.data);
    if (!hasData) { toast('Keine Audio-Dateien geladen', 'err'); return; }

    // Den Slot verwenden, der gerade im Slot-Editor offen ist (sofern vorhanden und mit
    // Audio belegt) — sonst den ersten belegten Slot. NICHT hartkodiert Slot 0, der könnte
    // inzwischen leer/entfernt sein (im Draft können einzelne Slots entfernt werden).
    const editIdx = getSlotEditIndex();
    let slotIdx = (editIdx !== null && slots[editIdx]?.data) ? editIdx : slots.findIndex(sl => sl && sl.data);
    if (slotIdx < 0) slotIdx = 0;

    // Build a temporary sound object from the current modal state
    // so preview uses the FULL effect chain (same engine as playback)
    const vol   = parseFloat(document.getElementById('eVol')?.value)   || 1;
    const pitch = APP.editId ? (CItems().find(x => x.id === APP.editId)?.pitch || 1) : 1;
    const effects  = readEffectsFromUI();
    const playback = readPlaybackFromUI();

    // Eigene, von der echten Sound-ID losgelöste Preview-ID
    // statt APP.editId zu übernehmen — verhindert, dass die Preview unter
    // demselben activeAudio/Buffer-Cache-Schlüssel wie der ECHTE,
    // gespeicherte Sound landet (der würde sonst z.B. beim Editieren eines
    // bereits gespeicherten Sounds dessen Kachel als "spielend" markieren).
    const tempSound = {
      id:      '_fxpreview_' + (APP.editId || APP._pendingSoundId || 'draft'),
      name:    document.getElementById('eName')?.value || 'Preview',
      slots:   APP.editSlots,
      vol, pitch, loop: false, fade: false, random: false, curSlot: 0, effects, playback
    };

    // Buffer-Cache für die Preview-ID vorwärmen (nicht unnötig neu dekodieren).
    // Priorität: ein in dieser Sitzung bereits geladener/ersetzter Buffer (_ed_N) vor
    // einem unveränderten, bereits unter der ECHTEN Sound-ID gecachten Buffer.
    APP.editSlots.forEach((sl, i) => {
      const edBuf = APP.audioBuffers[`_ed_${i}`];
      if (edBuf) { APP.audioBuffers[bk(tempSound.id, i)] = edBuf; return; }
      if (APP.editId) {
        const existing = APP.audioBuffers[bk(APP.editId, i)];
        if (existing) APP.audioBuffers[bk(tempSound.id, i)] = existing;
      }
    });

    try {
      await previewSound(tempSound, slotIdx);
    } catch(e) {
      console.error('Preview error:', e);
      toast('Vorschau-Fehler: ' + e.message, 'err');
    }
  }
  document.getElementById('btnPreviewSound')?.addEventListener('click', _handlePreviewClick);
  document.getElementById('btnPreviewFx')?.addEventListener('click', _handlePreviewClick);


}
