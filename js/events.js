/**
 * events.js — Event Listeners, Modal Controllers, Grid Operations
 * Phase 1: Effects UI (Preset-Dropdown, Lowpass, Highpass, Pan, Reverb, Delay)
 */

import { APP, CP, CItems } from './state.js';
import { uid, hotkeyStr, hotkeyMatch, bk, iconHtmlOr, isCustomIcon } from './utils.js';
import { toast }          from './notifications.js';
import { actx, stopAll, stopItem, runMacro, previewSound, EFFECT_PRESETS, defaultEffects, exportSoundToWav, startAnalyzerLoop, stopAnalyzer, EQ10_FREQS } from './audio.js';
import {
  getPresetById, applyPresetEffects, createUserPreset, updateUserPreset,
  deleteUserPreset, duplicatePreset, isUserPreset, PRESET_CATEGORIES
} from './presets.js';
import { invalidateBuffer, getOrDecodeBuffer } from './audioCache.js';
import {
  renderGrid, renderProfileTabs, applyProfileSettings, updateStatus,
  buildIconGrid, buildColorOpts, renderSlotList, renderMacroSteps,
  openTrimModal, drawTrimWaveform, drawTrimSpectrogram, updateTrimDurLabel, normaliseOrders,
  startPeakRmsMeter, stopPeakRmsMeter,
  syncThemeIcon, isTileEditMode, setTileEditMode, getSlotEditIndex,
  renderPresetDropdown
} from './ui.js';
import {
  save, exportDataWithAudio, importData, resetAll,
  exportProfile, exportAmbientProfile, exportMusicProfile,
  exportSoundItem, exportAmbientTrack, exportMusicTrack,
  exportPreset, exportUserPresets,
  mkProfile, mkSound, mkMacro, mkPH, saveSlotAudio, STARTER_PLACEHOLDER_COUNT,
  _saveRaw
} from './storage.js';
import { IDB_SENTINEL, idbGet, idbSet, idbDelete, isIdbRef, audioKey } from './db.js';
import {
  renderAmbientPanel, resetAmbient, renderAmbientProfileTabs,
  switchAmbientProfile, saveAmbientProfile, deleteAmbientProfile,
  setAmbientTrackIcon, setAmbientTrackEffects, renameAmbientTrack,
  setAmbientTrackVolume, toggleAmbientPlay, findAmbientTrack, persistAmbientNow
} from './ambient.js';
import { editMusicTrackMeta, setMusicTrackVolume, removeMusicTrack } from './music.js';
import { generateToneBuffer } from './generators.js';
import { audioBufferToWavBlob } from './export.js';
import {
  editTrimApply, editNormalize, editReverse, editFadeIn, editFadeOut,
  editGainApply, editRemoveSilence, editNoiseGate, learnNoiseProfile, editNoiseReduce,
  editLoudnessNormalize, editTruncateSilence
} from './editor.js';

// ─── EFFECTS UI HELPERS ──────────────────────────────────────

/**
 * Reads all current effect control values from the DOM and returns an
 * effects object ready to be stored on s.effects.
 */
function readEffectsFromUI() {
  const g    = id => document.getElementById(id);
  const num  = (id, fallback) => { const v = parseFloat(g(id)?.value); return isNaN(v) ? fallback : v; };
  const chk  = id => !!(g(id)?.checked);
  const sel  = id => g(id)?.value ?? '';

  return {
    enabled:  chk('fxEnabled'),
    preset:   g('fxPreset')?.value || null,
    lowpass: {
      enabled:   chk('fxLpEnabled'),
      frequency: num('fxLpFreq', 20000),
      Q:         0.7
    },
    highpass: {
      enabled:   chk('fxHpEnabled'),
      frequency: num('fxHpFreq', 20),
      Q:         0.7
    },
    pan:  num('fxPan', 0),
    notch: {
      enabled:   chk('fxNotchEnabled'),
      frequency: num('fxNotchFreq', 50),
      Q:         num('fxNotchQ', 10)
    },
    wahwah: {
      enabled:   chk('fxWahwahEnabled'),
      frequency: num('fxWahwahFrequency', 800),
      depth:     num('fxWahwahDepth', 0.7),
      rate:      num('fxWahwahRate', 2),
      resonance: num('fxWahwahResonance', 5)
    },
    reverb: {
      enabled:  chk('fxRevEnabled'),
      amount:   num('fxRevAmount', 0.35),
      duration: num('fxRevDuration', 2.2),
      decay:    num('fxRevDecay', 2.0)
    },
    delay: {
      enabled:  chk('fxDelEnabled'),
      time:     num('fxDelTime', 0.22),
      feedback: num('fxDelFeedback', 0.35),
      wet:      num('fxDelWet', 0.35)
    },
    // Phase 2
    eq: {
      enabled: chk('fxEqEnabled'),
      low:     num('fxEqLow',  0),
      mid:     num('fxEqMid',  0),
      high:    num('fxEqHigh', 0)
    },
    compressor: {
      enabled:   chk('fxCompEnabled'),
      threshold: num('fxCompThreshold', -24),
      knee:      num('fxCompKnee',       30),
      ratio:     num('fxCompRatio',      12),
      attack:    num('fxCompAttack',     0.003),
      release:   num('fxCompRelease',    0.25)
    },
    limiter: {
      enabled:   chk('fxLimEnabled'),
      threshold: num('fxLimThreshold', -1),
      knee:      0,
      ratio:     20,
      attack:    0.001,
      release:   0.08
    },
    distortion: {
      enabled:   chk('fxDistEnabled'),
      mode:      sel('fxDistMode') || 'softClip',
      amount:    num('fxDistAmount', 40),
      oversample: sel('fxDistOversample') || '4x'
    },
    ringmod: {
      enabled:   chk('fxRingmodEnabled'),
      frequency: num('fxRingmodFrequency', 440),
      mix:       num('fxRingmodMix', 1)
    },
    tremolo: {
      enabled:  chk('fxTremoloEnabled'),
      rate:     num('fxTremoloRate', 5),
      depth:    num('fxTremoloDepth', 0.5),
      waveform: sel('fxTremoloWaveform') || 'sine'
    },
    chorus: {
      enabled:   chk('fxChorusEnabled'),
      baseDelay: num('fxChorusBaseDelay', 15),
      depth:     num('fxChorusDepth', 8),
      rate:      num('fxChorusRate', 0.8),
      mix:       num('fxChorusMix', 0.3)
    },
    flanger: {
      enabled:   chk('fxFlangerEnabled'),
      baseDelay: num('fxFlangerBaseDelay', 2),
      depth:     num('fxFlangerDepth', 1.5),
      rate:      num('fxFlangerRate', 0.2),
      feedback:  num('fxFlangerFeedback', 0.5),
      mix:       num('fxFlangerMix', 0.5)
    },
    // Phase 3
    pitchShift: {
      enabled:  chk('fxPitchEnabled'),
      semitones: num('fxPitchSemitones', 0)
    },
    eq10: {
      enabled: chk('fxEq10Enabled'),
      // P3: neues Objekt-Format {freq, gain, Q} statt reiner Gain-Zahl —
      // EQ10_FREQS liefert die (unveränderlichen) Standard-Mittenfrequenzen,
      // Q ist jetzt pro Band editierbar statt fest auf 1.4.
      bands: EQ10_FREQS.map((freq, i) => ({
        freq,
        gain: num('fxEq10_' + i, 0),
        Q:    num('fxEq10Q_' + i, 1.4)
      }))
    },
    envelope: {
      enabled: chk('fxEnvEnabled'),
      attack:  num('fxEnvAttack',  0.01),
      decay:   num('fxEnvDecay',   0.15),
      sustain: num('fxEnvSustain', 0.8),
      release: num('fxEnvRelease', 0.25)
    },
    irReverb: {
      enabled: chk('fxIrEnabled'),
      impulse: g('fxIrImpulse')?.value || null,
      wet:     num('fxIrWet', 0.35)
    },
    analyzer: {
      enabled: chk('fxAnalyzerEnabled'),
      mode: g('fxAnalyzerMode')?.value || 'bars'
    },
    // Phase 4
    spatial: {
      enabled:        chk('fxSpatialEnabled'),
      x:              num('fxSpatialX',    0),
      y:              num('fxSpatialY',    0),
      z:              num('fxSpatialZ',   -1),
      rolloff:        num('fxSpatialRolloff', 1),
      maxDistance:    num('fxSpatialMaxDist', 10000),
      refDistance:    1,
      coneInnerAngle: 360,
      coneOuterAngle: 360,
      coneOuterGain:  0
    },
    noiseGate: {
      enabled:   chk('fxNoiseGateEnabled'),
      threshold: num('fxNoiseGateThreshold', -50)
    }
  };
}

/**
 * Writes an effects object into all effect DOM controls.
 */
function writeEffectsToUI(fx) {
  if (!fx) fx = defaultEffects();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
  const lbl = (id, val, unit) => { const el = document.getElementById(id); if (el) el.textContent = val + (unit || ''); };

  chk('fxEnabled', fx.enabled);
  set('fxPreset',  fx.preset || '');

  chk('fxLpEnabled', fx.lowpass?.enabled);
  set('fxLpFreq',    fx.lowpass?.frequency ?? 20000);
  lbl('fxLpFreqLbl', Math.round(fx.lowpass?.frequency ?? 20000), ' Hz');

  chk('fxHpEnabled', fx.highpass?.enabled);
  set('fxHpFreq',    fx.highpass?.frequency ?? 20);
  lbl('fxHpFreqLbl', Math.round(fx.highpass?.frequency ?? 20), ' Hz');

  set('fxPan', fx.pan ?? 0);
  lbl('fxPanLbl', ((fx.pan ?? 0) >= 0 ? '+' : '') + (fx.pan ?? 0).toFixed(2));

  chk('fxNotchEnabled', fx.notch?.enabled);
  set('fxNotchFreq',    fx.notch?.frequency ?? 50); lbl('fxNotchFreqLbl', Math.round(fx.notch?.frequency ?? 50), ' Hz');
  set('fxNotchQ',       fx.notch?.Q ?? 10);         lbl('fxNotchQLbl', 'Q ' + (fx.notch?.Q ?? 10));

  chk('fxWahwahEnabled', fx.wahwah?.enabled);
  set('fxWahwahFrequency', fx.wahwah?.frequency ?? 800); lbl('fxWahwahFrequencyLbl', Math.round(fx.wahwah?.frequency ?? 800), ' Hz');
  set('fxWahwahDepth',     fx.wahwah?.depth     ?? 0.7); lbl('fxWahwahDepthLbl', Math.round((fx.wahwah?.depth ?? 0.7) * 100), '%');
  set('fxWahwahRate',      fx.wahwah?.rate      ?? 2);   lbl('fxWahwahRateLbl', (fx.wahwah?.rate ?? 2).toFixed(1), ' Hz');
  set('fxWahwahResonance', fx.wahwah?.resonance ?? 5);   lbl('fxWahwahResonanceLbl', 'Q' + (fx.wahwah?.resonance ?? 5).toFixed(1));

  chk('fxRevEnabled',  fx.reverb?.enabled);
  set('fxRevAmount',   fx.reverb?.amount   ?? 0.35);
  lbl('fxRevAmountLbl', Math.round((fx.reverb?.amount ?? 0.35) * 100), '%');
  set('fxRevDuration', fx.reverb?.duration ?? 2.2);
  lbl('fxRevDurationLbl', (fx.reverb?.duration ?? 2.2).toFixed(1), 's');
  set('fxRevDecay',    fx.reverb?.decay    ?? 2.0);
  lbl('fxRevDecayLbl', (fx.reverb?.decay ?? 2.0).toFixed(1));

  chk('fxDelEnabled',  fx.delay?.enabled);
  set('fxDelTime',     fx.delay?.time     ?? 0.22);
  lbl('fxDelTimeLbl',  (fx.delay?.time ?? 0.22).toFixed(2), 's');
  set('fxDelFeedback', fx.delay?.feedback ?? 0.35);
  lbl('fxDelFeedbackLbl', Math.round((fx.delay?.feedback ?? 0.35) * 100), '%');
  set('fxDelWet',      fx.delay?.wet      ?? 0.35);
  lbl('fxDelWetLbl',   Math.round((fx.delay?.wet ?? 0.35) * 100), '%');

  // Phase 2
  chk('fxEqEnabled', fx.eq?.enabled);
  set('fxEqLow',  fx.eq?.low  ?? 0); lbl('fxEqLowLbl',  (fx.eq?.low  ?? 0) >= 0 ? '+' + (fx.eq?.low ?? 0)  : (fx.eq?.low  ?? 0), ' dB');
  set('fxEqMid',  fx.eq?.mid  ?? 0); lbl('fxEqMidLbl',  (fx.eq?.mid  ?? 0) >= 0 ? '+' + (fx.eq?.mid ?? 0)  : (fx.eq?.mid  ?? 0), ' dB');
  set('fxEqHigh', fx.eq?.high ?? 0); lbl('fxEqHighLbl', (fx.eq?.high ?? 0) >= 0 ? '+' + (fx.eq?.high ?? 0) : (fx.eq?.high ?? 0), ' dB');

  chk('fxCompEnabled',  fx.compressor?.enabled);
  set('fxCompThreshold', fx.compressor?.threshold ?? -24); lbl('fxCompThresholdLbl', (fx.compressor?.threshold ?? -24), ' dB');
  set('fxCompKnee',      fx.compressor?.knee      ?? 30);  lbl('fxCompKneeLbl',      (fx.compressor?.knee      ?? 30));
  set('fxCompRatio',     fx.compressor?.ratio     ?? 12);  lbl('fxCompRatioLbl',     (fx.compressor?.ratio     ?? 12) + ':1');
  set('fxCompAttack',    fx.compressor?.attack    ?? 0.003); lbl('fxCompAttackLbl',  ((fx.compressor?.attack ?? 0.003) * 1000).toFixed(1), ' ms');
  set('fxCompRelease',   fx.compressor?.release   ?? 0.25); lbl('fxCompReleaseLbl',  ((fx.compressor?.release ?? 0.25) * 1000).toFixed(0), ' ms');

  chk('fxLimEnabled',   fx.limiter?.enabled);
  set('fxLimThreshold', fx.limiter?.threshold ?? -1); lbl('fxLimThresholdLbl', (fx.limiter?.threshold ?? -1), ' dB');

  chk('fxDistEnabled', fx.distortion?.enabled);
  set('fxDistMode',    fx.distortion?.mode ?? 'softClip');
  set('fxDistAmount',  fx.distortion?.amount ?? 40); lbl('fxDistAmountLbl', Math.round(fx.distortion?.amount ?? 40));
  set('fxDistOversample', fx.distortion?.oversample ?? '4x');

  chk('fxRingmodEnabled', fx.ringmod?.enabled);
  set('fxRingmodFrequency', fx.ringmod?.frequency ?? 440); lbl('fxRingmodFrequencyLbl', Math.round(fx.ringmod?.frequency ?? 440), ' Hz');
  set('fxRingmodMix',       fx.ringmod?.mix       ?? 1);   

  chk('fxTremoloEnabled', fx.tremolo?.enabled);
  set('fxTremoloRate',  fx.tremolo?.rate  ?? 5);   lbl('fxTremoloRateLbl', (fx.tremolo?.rate ?? 5).toFixed(1), ' Hz');
  set('fxTremoloDepth', fx.tremolo?.depth ?? 0.5); lbl('fxTremoloDepthLbl', Math.round((fx.tremolo?.depth ?? 0.5) * 100), '%');
  set('fxTremoloWaveform', fx.tremolo?.waveform ?? 'sine');

  chk('fxChorusEnabled', fx.chorus?.enabled);
  set('fxChorusBaseDelay', fx.chorus?.baseDelay ?? 15); lbl('fxChorusBaseDelayLbl', (fx.chorus?.baseDelay ?? 15), ' ms');
  set('fxChorusDepth',     fx.chorus?.depth     ?? 8);  lbl('fxChorusDepthLbl',     (fx.chorus?.depth ?? 8), ' ms');
  set('fxChorusRate',      fx.chorus?.rate      ?? 0.8);lbl('fxChorusRateLbl',      (fx.chorus?.rate ?? 0.8).toFixed(2), ' Hz');
  set('fxChorusMix',       fx.chorus?.mix       ?? 0.3);lbl('fxChorusMixLbl',       Math.round((fx.chorus?.mix ?? 0.3) * 100), '%');

  chk('fxFlangerEnabled', fx.flanger?.enabled);
  set('fxFlangerBaseDelay', fx.flanger?.baseDelay ?? 2);   lbl('fxFlangerBaseDelayLbl', (fx.flanger?.baseDelay ?? 2).toFixed(1), ' ms');
  set('fxFlangerDepth',     fx.flanger?.depth     ?? 1.5); lbl('fxFlangerDepthLbl',     (fx.flanger?.depth ?? 1.5).toFixed(1), ' ms');
  set('fxFlangerRate',      fx.flanger?.rate      ?? 0.2); lbl('fxFlangerRateLbl',      (fx.flanger?.rate ?? 0.2).toFixed(2), ' Hz');
  set('fxFlangerFeedback',  fx.flanger?.feedback  ?? 0.5); lbl('fxFlangerFeedbackLbl',  Math.round((fx.flanger?.feedback ?? 0.5) * 100), '%');
  set('fxFlangerMix',       fx.flanger?.mix       ?? 0.5); lbl('fxFlangerMixLbl',       Math.round((fx.flanger?.mix ?? 0.5) * 100), '%');

  // Phase 3
  chk('fxPitchEnabled', fx.pitchShift?.enabled);
  set('fxPitchSemitones', fx.pitchShift?.semitones ?? 0);
  lbl('fxPitchSemitonesLbl', (fx.pitchShift?.semitones ?? 0) >= 0 ? '+' + (fx.pitchShift?.semitones ?? 0) : (fx.pitchShift?.semitones ?? 0));

  chk('fxEq10Enabled', fx.eq10?.enabled);
  const bands = fx.eq10?.bands || new Array(10).fill(0);
  bands.forEach((b, i) => {
    // P3: b kann das alte Format (reine Zahl) oder das neue
    // ({freq, gain, Q}) sein — beim Anzeigen beide unterstützen.
    const isObj = typeof b === 'object' && b !== null;
    const gain  = isObj ? (b.gain ?? 0) : (b ?? 0);
    const q     = isObj && b.Q ? b.Q : 1.4;
    set('fxEq10_' + i, gain);  lbl('fxEq10Lbl_' + i, (gain >= 0 ? '+' : '') + gain.toFixed(0));
    set('fxEq10Q_' + i, q);    lbl('fxEq10QLbl_' + i, 'Q' + q.toFixed(1));
  });

  chk('fxEnvEnabled',  fx.envelope?.enabled);
  set('fxEnvAttack',  fx.envelope?.attack   ?? 0.01);  lbl('fxEnvAttackLbl',  ((fx.envelope?.attack  ?? 0.01)  * 1000).toFixed(0), ' ms');
  set('fxEnvDecay',   fx.envelope?.decay    ?? 0.15);  lbl('fxEnvDecayLbl',   ((fx.envelope?.decay   ?? 0.15)  * 1000).toFixed(0), ' ms');
  set('fxEnvSustain', fx.envelope?.sustain  ?? 0.8);   lbl('fxEnvSustainLbl', Math.round((fx.envelope?.sustain ?? 0.8) * 100),  '%');
  set('fxEnvRelease', fx.envelope?.release  ?? 0.25);  lbl('fxEnvReleaseLbl', ((fx.envelope?.release ?? 0.25)  * 1000).toFixed(0), ' ms');

  chk('fxIrEnabled',  fx.irReverb?.enabled);
  set('fxIrImpulse',  fx.irReverb?.impulse || '');
  set('fxIrWet',      fx.irReverb?.wet      ?? 0.35);  lbl('fxIrWetLbl', Math.round((fx.irReverb?.wet ?? 0.35) * 100), '%');

  chk('fxAnalyzerEnabled', fx.analyzer?.enabled);
  set('fxAnalyzerMode', fx.analyzer?.mode || 'bars');

  // Phase 4
  chk('fxSpatialEnabled', fx.spatial?.enabled);
  set('fxSpatialX', fx.spatial?.x ?? 0); lbl('fxSpatialXLbl', (fx.spatial?.x ?? 0).toFixed(1));
  set('fxSpatialY', fx.spatial?.y ?? 0); lbl('fxSpatialYLbl', (fx.spatial?.y ?? 0).toFixed(1));
  set('fxSpatialZ', fx.spatial?.z ?? -1); lbl('fxSpatialZLbl', (fx.spatial?.z ?? -1).toFixed(1));
  set('fxSpatialRolloff', fx.spatial?.rolloff ?? 1); lbl('fxSpatialRolloffLbl', (fx.spatial?.rolloff ?? 1).toFixed(1));
  set('fxSpatialMaxDist', fx.spatial?.maxDistance ?? 10000);

  chk('fxNoiseGateEnabled', fx.noiseGate?.enabled);
  set('fxNoiseGateThreshold', fx.noiseGate?.threshold ?? -50);
  lbl('fxNoiseGateThresholdLbl', (fx.noiseGate?.threshold ?? -50) + ' dB');

  // updateEffectSectionVisibility() also refreshes the active-fx badges/
  // summary (see below) — one call covers both concerns.
  updateEffectSectionVisibility();
}

/**
 * Mark accordion section headers with 'has-active-fx' if they contain active effects.
 * Improves visual hierarchy: users can see at a glance which sections are active.
 */
function _markActiveAccordionSections(fx) {
  if (!fx) return;
  const sections = {
    'smFxFilters':  fx.lowpass?.enabled || fx.highpass?.enabled || fx.notch?.enabled || fx.pan !== 0,
    'smFxEQ':       fx.eq?.enabled || fx.eq10?.enabled,
    'smFxDyn':      fx.compressor?.enabled || fx.limiter?.enabled,
    'smFxDist':     fx.distortion?.enabled || fx.ringmod?.enabled,
    'smFxMod':      fx.tremolo?.enabled || fx.chorus?.enabled || fx.flanger?.enabled || fx.wahwah?.enabled,
    'smFxReverb':   fx.reverb?.enabled || fx.irReverb?.enabled,
    'smFxDelay':    fx.delay?.enabled,
    'smFxSpatial':  fx.spatial?.enabled,
    'smFxAdvanced': fx.pitchShift?.enabled || fx.envelope?.enabled || fx.noiseGate?.enabled || fx.analyzer?.enabled,
  };
  Object.entries(sections).forEach(([bodyId, isActive]) => {
    const body   = document.getElementById(bodyId);
    const toggle = body?.previousElementSibling;
    if (toggle) toggle.classList.toggle('has-active-fx', !!isActive);
  });
  // Show/hide the effects active badge on the master toggle
  const badge = document.getElementById('smFxBadge');
  if (badge) badge.style.display = fx.enabled ? '' : 'none';

  // Kompakter Überblick in der "Audio-Effekte"-Sektion: Namen der aktiven
  // Effekt-Gruppen als Chips, statt jeden Abschnitt einzeln öffnen zu müssen.
  const summaryLabels = {
    smFxFilters:  'Filter',
    smFxEQ:       'EQ',
    smFxDyn:      'Dynamik',
    smFxDist:     'Distortion',
    smFxMod:      'Modulation',
    smFxReverb:   'Reverb',
    smFxDelay:    'Delay',
    smFxSpatial:  'Spatial',
    smFxAdvanced: 'Erweitert',
  };
  const summaryEl = document.getElementById('smFxActiveSummary');
  if (summaryEl) {
    const active = Object.entries(summaryLabels).filter(([id]) => sections[id]).map(([, label]) => label);
    summaryEl.innerHTML = active.map(label => `<span class="sm-fx-summary__chip">${label}</span>`).join('');
  }
}

/**
 * Marks the "Einstellungen" popover trigger (soundMenubar) when a
 * playback setting differs from its default — same idea as
 * _markActiveAccordionSections() above, applied to the popover system
 * in js/ui/disclosure.js so a non-default choice stays visible even
 * while that popover is collapsed.
 */
function _syncPlaybackSettingsIndicator() {
  const gs = APP.globalSettings;
  const isDefault = gs.overlap !== false && gs.stopReplay !== true && gs.multiClick !== false && !gs.autoDuck?.enabled;
  document.getElementById('btnPlaybackSettingsToggle')?.classList.toggle('has-active-setting', !isDefault);
}

// ─── EIGENE AUDIO-EFFEKT-PRESETS (Kap. 7-14, 20, 25) ─────────
// UI-Logik für Preset-Verwaltung im Audio-Effekte-Dialog. Nutzt bewusst
// dieselben Formularsteuerelemente (readEffectsFromUI/writeEffectsToUI),
// dieselben Toasts (toast()) und dasselbe Import/Export-Muster
// (importData()/kind-Feld) wie der Rest der Anwendung — keine parallele
// Infrastruktur (Kap. 28).

let _fxPresetMetaMode   = 'create'; // 'create' | 'edit'
let _fxPresetMetaEditId = null;

/** Blendet Bearbeiten/Duplizieren/Löschen/Export je nach aktueller
 *  Preset-Auswahl im Dropdown ein/aus (Kap. 8: Built-ins dürfen nicht
 *  bearbeitet/gelöscht werden, aber dupliziert/exportiert). */
function updateFxPresetActionButtons() {
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

function _openFxPresetMetaModal(mode, prefill) {
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
function _currentEffectsForPreset() {
  const fx = readEffectsFromUI();
  const { enabled, preset, ...effects } = fx;
  return effects;
}

/**
 * Registriert alle Event-Handler rund um eigene Presets. Wird von
 * registerEvents() aufgerufen.
 */
function registerPresetEvents() {
  renderPresetDropdown();
  updateFxPresetActionButtons();

  document.getElementById('fxPreset')?.addEventListener('change', updateFxPresetActionButtons);
  document.getElementById('btnOpenFxModal')?.addEventListener('click', updateFxPresetActionButtons);

  // "Als eigenes Preset speichern" — übernimmt die aktuell im Formular
  // eingestellten Effektwerte (Kap. 7: vorhandenes Preset auswählen →
  // verändern → als eigenes Preset speichern funktioniert dadurch von
  // selbst, ohne eigene Zwischenschritte).
  document.getElementById('btnFxPresetSaveAs')?.addEventListener('click', () => {
    const curVal = document.getElementById('fxPreset')?.value;
    const cur    = curVal ? getPresetById(curVal) : null;
    _openFxPresetMetaModal('create', cur ? { name: cur.name + ' (Kopie)', category: cur.category, description: cur.description } : null);
  });

  // Bearbeiten: nur für eigene Presets sichtbar (siehe updateFxPresetActionButtons).
  // Übernimmt beim Speichern sowohl die Metadaten als auch die aktuell im
  // Formular stehenden Effektwerte unter derselben ID (Kap. 11: voller
  // Preset-Zustand wird beim Öffnen bereits über das Dropdown/writeEffectsToUI
  // vollständig wiederhergestellt, siehe fxPreset change-Handler oben).
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

  // Duplizieren: sofort, ohne Zwischendialog (Kap. 20) — funktioniert
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
function updateEffectSectionVisibility() {
  const masterOn = !!(document.getElementById('fxEnabled')?.checked);
  const panel    = document.getElementById('fxPanel');
  if (panel) panel.style.opacity = masterOn ? '1' : '0.45';
  if (panel) panel.style.pointerEvents = masterOn ? '' : 'none';

  const pairs = [
    ['fxLpEnabled',   'fxLpControls'],
    ['fxHpEnabled',   'fxHpControls'],
    ['fxNotchEnabled', 'fxNotchControls'],
    ['fxWahwahEnabled', 'fxWahwahControls'],
    ['fxRevEnabled',  'fxRevControls'],
    ['fxDelEnabled',  'fxDelControls'],
    ['fxEqEnabled',   'fxEqControls'],
    ['fxCompEnabled', 'fxCompControls'],
    ['fxLimEnabled',  'fxLimControls'],
    ['fxDistEnabled', 'fxDistControls'],
    ['fxRingmodEnabled', 'fxRingmodControls'],
    ['fxTremoloEnabled', 'fxTremoloControls'],
    ['fxChorusEnabled',  'fxChorusControls'],
    ['fxFlangerEnabled', 'fxFlangerControls'],
    // Phase 3
    ['fxPitchEnabled',    'fxPitchControls'],
    ['fxEq10Enabled',     'fxEq10Controls'],
    ['fxEnvEnabled',      'fxEnvControls'],
    ['fxIrEnabled',       'fxIrControls'],
    ['fxAnalyzerEnabled', 'fxAnalyzerControls'],
    // Phase 4
    ['fxSpatialEnabled',   'fxSpatialControls'],
    ['fxNoiseGateEnabled', 'fxNoiseGateControls'],
  ];
  pairs.forEach(([cbId, panelId]) => {
    const on = !!(document.getElementById(cbId)?.checked);
    const el = document.getElementById(panelId);
    if (el) { el.style.opacity = on ? '1' : '0.45'; el.style.pointerEvents = on ? '' : 'none'; }
  });

  // Aktive-Effekte-Badges/-Übersicht live nachziehen (nicht erst beim
  // nächsten Öffnen des Modals) — siehe _markActiveAccordionSections().
  _markActiveAccordionSections(readEffectsFromUI());
}

// ─── SOUND MODAL ─────────────────────────────────────────────
// The modal is shared between sound-tile editing and ambient-track effects
// editing (same FX accordion — Filter/EQ/Dynamics/Distortion/Reverb/Delay/
// 3D/Pitch — reused as-is). _fxEditContext tracks which one is currently open.
let _fxEditContext = { kind: 'sound', id: null };
let _ambVariantMode = 'random';

/**
 * Marks the macro modal's "Erweiterte Einstellungen" accordion header when
 * it holds a non-default value (Abspiel-Modus ≠ Parallel) — same idea as
 * has-active-fx in the sound editor, so a relevant setting made inside a
 * collapsed section stays visible without opening it.
 */
function _syncMacroAdvancedIndicator() {
  const nonDefault = document.getElementById('mPlayMode')?.value !== 'parallel';
  const toggle = document.querySelector('#macroModal .sm-section-toggle[data-target="mAdvanced"]');
  toggle?.classList.toggle('has-active-fx', !!nonDefault);
}

/**
 * Icon + Akzentfarbe in der "Darstellung & Organisation"-Einstiegskarte
 * nachziehen, damit die aktuelle Wahl sichtbar bleibt, auch wenn die
 * Dialogbox mit dem eigentlichen Icon-/Farb-Picker geschlossen ist —
 * gleiches Prinzip wie die Aktive-Effekte-Übersicht bei Audio-Effekte.
 */
function _syncAppearancePreview() {
  const iconEl = document.getElementById('smAppearancePreviewIcon');
  if (iconEl) {
    const val = document.getElementById('eIcon')?.value.trim();
    iconEl.textContent = isCustomIcon(val) ? '🖼️' : (val || '🔊');
  }
  const colorEl = document.getElementById('smAppearancePreviewColor');
  if (colorEl) {
    const selected = document.querySelector('#clrOpts .color-swatch.is-selected');
    const color = selected?.dataset.color;
    colorEl.style.background = (color && color !== 'none') ? color : 'transparent';
  }
}

function _setModalContext(kind) {
  document.querySelectorAll('.sm-sound-only').forEach(el => { el.style.display = kind === 'sound' ? '' : 'none'; });
  document.querySelectorAll('.sm-ambient-only').forEach(el => { el.style.display = kind === 'ambient' ? '' : 'none'; });
}

/**
 * Decodes any APP.editSlots entries that don't yet have a `_ed_N` buffer cached
 * (i.e. existing, previously-saved audio that wasn't touched this session) so
 * the waveform/trim/preview tools work immediately, not just for newly-loaded files.
 * Resolves the right IDB key depending on whether we're editing a sound or an
 * ambient track (different key schemes — see _fileId on ambient slot entries).
 */
async function _preloadEditBuffers() {
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

  // BUGFIX: Clear any leftover _ed_N buffers from the previous modal session.
  // Without this, editing Sound A after loading audio for Sound B would
  // copy Sound B's buffer into Sound A's cache on save.
  Object.keys(APP.audioBuffers).forEach(k => {
    if (k.startsWith('_ed_')) delete APP.audioBuffers[k];
  });

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

  APP.editSlots = s ? (s.slots || []).map(sl => ({ ...sl })) : [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null }];
  renderSlotList();
  _preloadEditBuffers();
  buildIconGrid('iconGrid',  s ? s.icon  : '');
  buildColorOpts('clrOpts',  s ? s.color : 'none');
  buildColorOpts('eTileClrOpts', s && s.tileColor ? s.tileColor : 'none');

  // ── Effects UI ────────────────────────────────────────────
  writeEffectsToUI(s?.effects || defaultEffects());
  // ─────────────────────────────────────────────────────────
  _syncAppearancePreview();

  document.getElementById('soundModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#soundModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });

  new bootstrap.Modal(document.getElementById('soundModal')).show();
}

/** Opens the same modal in "ambient" context — Grundeinstellungen mirrors the sound-tile layout
 *  (file variants with trim, volume, loop/interval, fades, variant-mode) + the full FX accordion. */
function openAmbientEffectsModal(trackId) {
  const t = findAmbientTrack(trackId);
  if (!t) return;
  _fxEditContext = { kind: 'ambient', id: trackId };
  APP.editId = null;

  Object.keys(APP.audioBuffers).forEach(k => {
    if (k.startsWith('_ed_')) delete APP.audioBuffers[k];
  });

  _setModalContext('ambient');
  document.getElementById('sMTitle').textContent = 'AMBIENT BEARBEITEN';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  const chk = (elId, val) => { const el = document.getElementById(elId); if (el) el.checked = val; };

  set('eName',   t.name);
  set('eVol',    t.vol ?? 0.7);
  set('eVolNum', Math.round((t.vol ?? 0.7) * 100));

  chk('ambLoop',         !!t.loop);
  chk('ambIntervalMode', !!t.intervalMode);
  set('ambIntervalMin',  t.intervalMin ?? 10);
  set('ambIntervalMax',  t.intervalMax ?? 30);
  set('ambFadeIn',       t.fadeIn  ?? 2);
  set('ambFadeOut',      t.fadeOut ?? 2);

  _ambVariantMode = t.variantMode === 'rotate' ? 'rotate' : 'random';
  document.getElementById('ambVariantRandom')?.classList.toggle('is-active', _ambVariantMode === 'random');
  document.getElementById('ambVariantRotate')?.classList.toggle('is-active', _ambVariantMode === 'rotate');

  const delBtn = document.getElementById('btnDelSound');
  if (delBtn) delBtn.style.display = 'none'; // deletion is handled from the ambient row itself

  APP.editSlots = (t.files || []).map(f => ({
    data: f.data, name: f.fileName || 'Datei', trimStart: f.trimStart || 0, trimEnd: f.trimEnd ?? null, _fileId: f.id
  }));
  if (!APP.editSlots.length) APP.editSlots = [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null, _fileId: null }];
  renderSlotList();
  _preloadEditBuffers();

  writeEffectsToUI(t.effects || defaultEffects());

  document.getElementById('soundModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#soundModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });

  new bootstrap.Modal(document.getElementById('soundModal')).show();
}

document.addEventListener('ambient:editEffects', e => openAmbientEffectsModal(e.detail?.id));

// ─── MUSIC TRACK MODAL ───────────────────────────────────────
// Bewusst ein eigenes, schlankes Modal statt Wiederverwendung des großen
// geteilten Sound/Ambient-Editors — die Feldmenge ist komplett anders
// (Name/Artist/Album/Icon/Farbe/Lautstärke, keine Hotkeys/Zufall/Makro,
// Kap. 24) und ein eigenes Modal minimiert das Risiko, den bestehenden
// Sound-/Ambient-Editor versehentlich zu beschädigen (Kap. 69).
let _musicEditId = null;

function openMusicTrackModal(trackId) {
  const t = findMusicTrack(trackId);
  if (!t) return;
  _musicEditId = trackId;

  document.getElementById('musicEditName').value   = t.name || '';
  document.getElementById('musicEditArtist').value = t.artist || '';
  document.getElementById('musicEditAlbum').value  = t.album || '';
  document.getElementById('musicEditVol').value    = t.vol ?? 1;
  document.getElementById('musicEditVolLbl').textContent = Math.round((t.vol ?? 1) * 100) + '%';

  buildIconGrid('musicIconGrid', t.icon || '🎵');
  buildColorOpts('musicClrOpts', t.color || 'none');

  document.getElementById('musicTrackModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#musicTrackModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });

  new bootstrap.Modal(document.getElementById('musicTrackModal')).show();
}

document.addEventListener('music:editTrack', e => openMusicTrackModal(e.detail?.id));

function findMusicTrack(id) {
  for (const p of APP.music.profiles) {
    const t = (p.tracks || []).find(x => x.id === id);
    if (t) return t;
  }
  return null;
}

// ─── MACRO MODAL ─────────────────────────────────────────────

export function openMacroModal(id, placeholderId = null) {
  APP.editMacroId = id;
  APP._macroPhReplacingId = placeholderId;
  const m = id ? CItems().find(x => x.id === id && x.type === 'macro') : null;

  document.getElementById('mMTitle').textContent = id ? 'MAKRO BEARBEITEN' : 'NEUES MAKRO';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };

  set('mName',      m ? m.name         : '');
  set('mRepeat',    m ? m.repeat        : 1);
  set('mRepDelay',  m ? m.repeatDelay   : 500);
  set('mHotkey',    m ? m.hotkey        : '');
  set('mIcon',      m ? m.icon          : '🪄');
  set('mTileW',     m && m.tileW ? m.tileW : '');
  set('mTileH',     m && m.tileH ? m.tileH : '');
  set('mPlayMode',  m ? m.playMode || 'parallel' : 'parallel');
  set('mTileClr',   m && m.tileColor ? m.tileColor : '#ffffff');
  _syncMacroAdvancedIndicator();

  const delBtn = document.getElementById('btnDelMacro');
  if (delBtn) delBtn.style.display = id ? '' : 'none';

  // Migrate old delay-based steps + init timeline
  APP.macroSteps = m ? (m.steps || []).map(s => ({ ...s })) : [];
  import('./macroTimeline.js').then(mod => {
    APP.macroSteps = mod.migrateStepsToStartTime(APP.macroSteps);
  });
  buildColorOpts('mClrOpts', m ? m.color : 'none');
  buildColorOpts('mTileClrOpts', m && m.tileColor ? m.tileColor : 'none');
  buildIconGrid('mIconGrid',  m ? m.icon  : '🪄');
  renderMacroSteps();
  document.getElementById('macroModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#macroModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
    // Init macro timeline canvas
    const canvas = document.getElementById('macroTimelineCanvas');
    if (canvas) import('./macroTimeline.js').then(mod => mod.initMacroTimeline(canvas, APP.macroSteps));
  }, { once: true });
  new bootstrap.Modal(document.getElementById('macroModal')).show();
}

// ─── PROFILE MODAL ────────────────────────────────────────────

function openProfileModal(id) {
  APP.editProfileId = id;
  const p = id ? APP.profiles.find(x => x.id === id) : null;

  document.getElementById('profModalTitle').textContent = id ? 'PROFIL BEARBEITEN' : 'NEUES PROFIL';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  set('profNameInput', p ? p.name : '');
  set('profIconInput', p ? p.icon : '');

  const delBtn = document.getElementById('btnDelProfile');
  if (delBtn) delBtn.style.display = (id && APP.profiles.length > 1) ? '' : 'none';
  const expBtn = document.getElementById('btnExportProfile');
  if (expBtn) expBtn.style.display = id ? '' : 'none';

  buildIconGrid('profIconGrid', p ? p.icon : '🎵');
  document.getElementById('profModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#profModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('profModal')).show();
}

// ─── AMBIENT SCENE MODAL ───────────────────────────────────────

let _editAmbientProfileId = null;

function openAmbientProfileModal(id) {
  _editAmbientProfileId = id;
  const p = id ? APP.ambient.profiles.find(x => x.id === id) : null;

  document.getElementById('ambProfModalTitle').textContent = id ? 'SZENE BEARBEITEN' : 'NEUE SZENE';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  set('ambProfNameInput', p ? p.name : '');
  set('ambProfIconInput', p ? p.icon : '');

  const delBtn = document.getElementById('btnDelAmbientProfile');
  if (delBtn) delBtn.style.display = (id && APP.ambient.profiles.length > 1) ? '' : 'none';
  const expBtn = document.getElementById('btnExportAmbientProfile');
  if (expBtn) expBtn.style.display = id ? '' : 'none';

  buildIconGrid('ambProfIconGrid', p ? p.icon : '🌫️');
  document.getElementById('ambProfModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#ambProfModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('ambProfModal')).show();
}

document.addEventListener('ambient:editProfile', e => openAmbientProfileModal(e.detail?.id || null));

// ─── AMBIENT TRACK ICON MODAL ───────────────────────────────────

let _editAmbientTrackId = null;

function openAmbientTrackIconModal(trackId) {
  _editAmbientTrackId = trackId;
  const t = APP.ambient.profiles.flatMap(p => p.tracks).find(x => x.id === trackId);

  buildIconGrid('ambTrackIconGrid', t ? t.icon : '🌫️');
  const inp = document.getElementById('ambTrackIconInput');
  if (inp) inp.value = t ? t.icon : '';
  document.getElementById('ambTrackIconModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#ambTrackIconModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('ambTrackIconModal')).show();
}

document.addEventListener('ambient:pickTrackIcon', e => openAmbientTrackIconModal(e.detail?.id));

// ─── PROFILE SWITCH ───────────────────────────────────────────

function switchProfile(id) {
  stopAll();
  APP.activeProfileId = id;
  APP.activeCategory  = 'all';
  renderProfileTabs();
  applyProfileSettings();
  renderGrid();
}

// ─── HOTKEY RECORDING ─────────────────────────────────────────

function handleHotkeyRecord(e) {
  if (!APP.hkTarget) return false;
  const f = document.getElementById(APP.hkTarget); if (!f) return false;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape' || e.key === 'Backspace') {
    f.value = ''; f.classList.remove('is-recording'); APP.hkTarget = null; return true;
  }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return true;
  f.value = hotkeyStr(e); f.classList.remove('is-recording'); APP.hkTarget = null;
  return true;
}

// ─── REGISTER ALL LISTENERS ───────────────────────────────────

export function registerEvents() {
  registerPresetEvents();

  // Theme toggle
  document.getElementById('btnTheme')?.addEventListener('click', () => {
    const html    = document.documentElement;
    const current = html.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    html.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
    syncThemeIcon();
  });

  // Profile bar (event delegation)
  document.getElementById('profBar')?.addEventListener('click', e => {
    const editBtn = e.target.closest('.profile-tab__edit');
    const tab     = e.target.closest('.profile-tab');
    if (editBtn) { const pid = tab?.dataset.pid; if (pid) openProfileModal(pid); return; }
    if (tab)     { switchProfile(tab.dataset.pid); }
  });
  document.getElementById('btnAddProfile')?.addEventListener('click', () => openProfileModal(null));

  // Profile modal
  document.getElementById('btnSaveProfile')?.addEventListener('click', () => {
    const name = document.getElementById('profNameInput').value.trim() || 'Profil';
    const icon = document.getElementById('profIconInput').value.trim() || '🎵';
    if (APP.editProfileId) {
      const p = APP.profiles.find(x => x.id === APP.editProfileId);
      if (p) { p.name = name; p.icon = icon; }
    } else {
      const np = mkProfile(name, icon);
      for (let i = 0; i < STARTER_PLACEHOLDER_COUNT; i++) np.items.push(mkPH(i));
      APP.profiles.push(np);
      APP.activeProfileId = np.id;
    }
    bootstrap.Modal.getInstance(document.getElementById('profModal')).hide();
    renderProfileTabs(); renderGrid(); toast('Profil gespeichert', 'ok');
  });
  document.getElementById('btnDelProfile')?.addEventListener('click', () => {
    if (APP.profiles.length <= 1) { toast('Letztes Profil kann nicht gelöscht werden', 'err'); return; }
    if (!confirm('Profil wirklich löschen?')) return;
    APP.profiles        = APP.profiles.filter(x => x.id !== APP.editProfileId);
    APP.activeProfileId = APP.profiles[0].id;
    bootstrap.Modal.getInstance(document.getElementById('profModal')).hide();
    renderProfileTabs(); renderGrid(); toast('Profil gelöscht');
  });
  document.getElementById('btnExportProfile')?.addEventListener('click', () => {
    if (APP.editProfileId) exportProfile(APP.editProfileId);
  });

  // Ambient scene modal
  document.getElementById('btnAddAmbientProfile')?.addEventListener('click', () => openAmbientProfileModal(null));
  document.getElementById('btnSaveAmbientProfile')?.addEventListener('click', () => {
    const name = document.getElementById('ambProfNameInput').value.trim() || 'Szene';
    const icon = document.getElementById('ambProfIconInput').value.trim() || '🌫️';
    saveAmbientProfile(_editAmbientProfileId, name, icon);
    bootstrap.Modal.getInstance(document.getElementById('ambProfModal')).hide();
    toast('Szene gespeichert', 'ok');
  });
  document.getElementById('btnDelAmbientProfile')?.addEventListener('click', () => {
    if (APP.ambient.profiles.length <= 1) { toast('Letzte Szene kann nicht gelöscht werden', 'err'); return; }
    if (!confirm('Ambient-Szene wirklich löschen? Alle enthaltenen Sounds werden entfernt.')) return;
    deleteAmbientProfile(_editAmbientProfileId);
    bootstrap.Modal.getInstance(document.getElementById('ambProfModal')).hide();
    toast('Szene gelöscht');
  });
  document.getElementById('btnExportAmbientProfile')?.addEventListener('click', () => {
    if (_editAmbientProfileId) exportAmbientProfile(_editAmbientProfileId);
  });

  // Ambient track icon modal
  document.getElementById('btnApplyAmbientTrackIcon')?.addEventListener('click', () => {
    const icon = document.getElementById('ambTrackIconInput').value.trim();
    if (_editAmbientTrackId && icon) setAmbientTrackIcon(_editAmbientTrackId, icon);
    bootstrap.Modal.getInstance(document.getElementById('ambTrackIconModal')).hide();
  });

  // Toolbar — Rastergröße kommt jetzt vollständig aus grid-system.css
  // (--grid-cols je Breakpoint); es gibt keine manuellen Spalten/Reihen-
  // Felder mehr, gegen die man hier lauschen müsste.

  // Master volume
  document.getElementById('masterVol')?.addEventListener('input', function() {
    const val = parseFloat(this.value);
    APP.globalSettings.masterVol = val;
    const numEl = document.getElementById('masterVolNum');
    if (numEl) numEl.value = Math.round(val * 100);
  });
  document.getElementById('masterVolNum')?.addEventListener('input', function() {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const val  = pct / 100;
    APP.globalSettings.masterVol = val;
    const slEl = document.getElementById('masterVol');
    if (slEl) slEl.value = val;
  });
  document.getElementById('btnStop')?.addEventListener('click', stopAll);
  document.getElementById('btnSave')?.addEventListener('click', save);

  // ─── Musik-Track-Bearbeiten-Modal ────────────────────────────
  document.getElementById('musicEditVol')?.addEventListener('input', function () {
    document.getElementById('musicEditVolLbl').textContent = Math.round(parseFloat(this.value) * 100) + '%';
  });
  document.getElementById('btnMusicEditSave')?.addEventListener('click', () => {
    if (!_musicEditId) return;
    const icon  = document.getElementById('musicIconInput').value.trim();
    const clrEl = document.querySelector('#musicClrOpts .color-swatch.is-selected');
    editMusicTrackMeta(_musicEditId, {
      name:   document.getElementById('musicEditName').value,
      artist: document.getElementById('musicEditArtist').value,
      album:  document.getElementById('musicEditAlbum').value,
      icon:   icon || undefined,
      color:  clrEl?.dataset.color
    });
    setMusicTrackVolume(_musicEditId, parseFloat(document.getElementById('musicEditVol').value));
    bootstrap.Modal.getInstance(document.getElementById('musicTrackModal'))?.hide();
  });
  document.getElementById('btnMusicEditDelete')?.addEventListener('click', () => {
    if (!_musicEditId) return;
    if (!confirm('Dieses Musikstück wirklich löschen?')) return;
    removeMusicTrack(_musicEditId);
    bootstrap.Modal.getInstance(document.getElementById('musicTrackModal'))?.hide();
  });
  document.getElementById('btnMusicEditExport')?.addEventListener('click', () => {
    if (_musicEditId) exportMusicTrack(_musicEditId);
  });

  // ─── Bearbeitungsmodus (Kacheln) — Fertig-Button + Tap-außerhalb ──
  // Umschaltung jetzt per Toolbar-Button #btnTileEditMode statt Long-Press
  // (Long-Press verschiebt jetzt direkt die Kachel, siehe ui.js
  // setupTileEditGestures). #btnTileEditMode muss von der "Klick außerhalb
  // schließt den Modus"-Erkennung ausgenommen werden — sonst würde das
  // pointerdown-Ereignis des eigenen Klicks den Modus schon VOR dem
  // click-Handler unten schließen, der ihn dann direkt wieder öffnet
  // (pointerdown feuert vor click → Toggle würde nie richtig "aus" gehen).
  document.getElementById('btnExitEditMode')?.addEventListener('click', () => setTileEditMode(false));
  document.getElementById('btnTileEditMode')?.addEventListener('click', () => setTileEditMode(!isTileEditMode()));
  document.addEventListener('pointerdown', e => {
    if (!isTileEditMode()) return;
    if (e.target.closest('#grid') || e.target.closest('#editModeBar') || e.target.closest('#btnTileEditMode')) return;
    setTileEditMode(false);
  });

  // ─── Direkter Anlege-Einstieg in der Toolbar (+ Sound / + Makro) ──
  document.getElementById('btnToolbarAddSound')?.addEventListener('click', () => openSoundModal(null));
  document.getElementById('btnToolbarAddMacro')?.addEventListener('click', () => openMacroModal(null));

  // Makro-Erstellung lebt außerdem weiterhin im "+"-Menü leerer Kacheln
  // (ui.js: _openTileAddChoice → openMacroModal(null, placeholderId))
  // für den Fall, dass eine bestimmte leere Kachel befüllt werden soll.

  // Wiedergabe-Einstellungen (Popover im soundMenubar)
  document.getElementById('setOverlap')?.addEventListener('change',    e => { APP.globalSettings.overlap    = e.target.checked; _syncPlaybackSettingsIndicator(); });
  document.getElementById('setStopReplay')?.addEventListener('change', e => { APP.globalSettings.stopReplay = e.target.checked; _syncPlaybackSettingsIndicator(); });
  document.getElementById('setMultiClick')?.addEventListener('change', e => { APP.globalSettings.multiClick = e.target.checked; _syncPlaybackSettingsIndicator(); });

  // P2 Auto Duck (Ambient): globale Wiedergabe-Einstellung, siehe
  // audio.js notifyDuckTrigger()/notifyDuckRelease() + ambient.js duckAmbient().
  document.getElementById('setAutoDuck')?.addEventListener('change', e => {
    APP.globalSettings.autoDuck.enabled = e.target.checked;
    _syncPlaybackSettingsIndicator();
  });
  document.getElementById('setAutoDuckAmount')?.addEventListener('input', function() {
    APP.globalSettings.autoDuck.amount = parseFloat(this.value);
    const lbl = document.getElementById('setAutoDuckAmountLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
    _syncPlaybackSettingsIndicator();
  });
  _syncPlaybackSettingsIndicator();

  // Verwalten / Speichern / Undo / Redo — leben gemeinsam im
  // "Einstellungen"-Popover (js/ui/disclosure.js regelt Öffnen/Schließen,
  // hier nur noch die fachliche Aktion je Button; Undo/Redo-Klicks werden
  // weiter unten im Datei-Setup registriert).
  document.getElementById('btnExport')?.addEventListener('click', () => {
    import('./storage.js').then(m => m.exportData());
  });
  document.getElementById('btnImportTrigger')?.addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f) return;
    importData(f, {
      onSuccess: () => {
        applyProfileSettings(); renderProfileTabs(); renderGrid();
        renderAmbientProfileTabs(); renderAmbientPanel();
        import('./music.js').then(m => { m.renderMusicProfileTabs(); m.renderMusicPanel(); m.renderMusicPlayer(); });
        toast('Import ✓', 'ok');
      }
    });
  });
  document.getElementById('btnReset')?.addEventListener('click', () => {
    resetAll({
      onDone: () => {
        applyProfileSettings(); renderProfileTabs(); renderGrid(); resetAmbient();
        import('./music.js').then(m => m.resetMusic());
      }
    });
  });

  // ─── Anordnen / Tauschen ("Werkzeuge") — final entfernt ────────
  // Das neue, breakpoint-gesteuerte Spalten-System (grid-system.css)
  // macht manuelles Anordnen/Tauschen überflüssig: das Grid fließt
  // jetzt automatisch, es gibt kein fixes maxCols/maxRows mehr, gegen
  // das arrangiert werden könnte. Buttons, Bars UND die zugehörigen
  // Implementierungsfunktionen (enterArrangeMode, arrangeRowLeft & co.,
  // addCol/removeCol, swapRows/Cols, updateMoveBarSelects) wurden
  // entfernt statt weiter als totes Cleanup-Kandidat mitgeschleift.


  document.getElementById('btnAddSlot')?.addEventListener('click', () => {
    APP.editSlots.push({ data: null, name: 'Leer', trimStart: 0, trimEnd: null, _fileId: null });
    renderSlotList();
  });
  document.getElementById('slotFile')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f || APP.loadingSlotIdx === null) return;
    const r = new FileReader();
    r.onload = async e => {
      const b64 = e.target.result.split(',')[1];
      const idx = APP.loadingSlotIdx;
      if (_fxEditContext.kind === 'ambient') {
        const fileId = APP.editSlots[idx]?._fileId || uid();
        await idbSet(audioKey(fileId, 0), b64);
        APP.editSlots[idx] = { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null, _fileId: fileId };
      } else {
        // Use the pre-generated stable ID so IDB key matches the eventual sound ID.
        const stableId = APP.editId || APP._pendingSoundId || uid();
        if (!APP._pendingSoundId && !APP.editId) APP._pendingSoundId = stableId;
        await saveSlotAudio(stableId, idx, b64, null);
        APP.editSlots[idx] = { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null };
      }
      try {
        const bin = atob(b64); const arr = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
        const decoded = await actx().decodeAudioData(arr.buffer.slice(0));
        APP.audioBuffers[`_ed_${idx}`] = decoded;
      } catch (err) {
        console.warn('[events] slotFile decode error:', err?.message || err);
      } finally {
        renderSlotList();
      }
    };
    r.readAsDataURL(f);
  });
  document.getElementById('btnBulk')?.addEventListener('click', () => document.getElementById('bulkFile').click());

  // P3 Tone Generator: Sweep-Modus blendet Fest-/Start-End-Frequenzfelder um.
  document.getElementById('toneSweepMode')?.addEventListener('change', function() {
    const fixedRow = document.getElementById('toneFixedFreqRow');
    const sweepRow = document.getElementById('toneSweepFreqRow');
    if (fixedRow) fixedRow.style.display = this.checked ? 'none' : '';
    if (sweepRow) sweepRow.style.display = this.checked ? 'flex' : 'none';
  });

  document.getElementById('btnToneGenerate')?.addEventListener('click', async () => {
    const idx = APP.loadingSlotIdx;
    if (idx === null || idx === undefined) { toast('Kein Slot ausgewählt', 'err'); return; }
    const isSweep = !!document.getElementById('toneSweepMode')?.checked;
    const opts = {
      waveform:    document.getElementById('toneWaveform')?.value || 'sine',
      durationSec: parseFloat(document.getElementById('toneDuration')?.value) || 2,
      amplitudeDb: parseFloat(document.getElementById('toneAmplitude')?.value),
    };
    if (Number.isNaN(opts.amplitudeDb)) opts.amplitudeDb = -12;
    let name;
    if (isSweep) {
      opts.startFrequency = parseFloat(document.getElementById('toneStartFreq')?.value) || 100;
      opts.endFrequency   = parseFloat(document.getElementById('toneEndFreq')?.value)   || 10000;
      name = `Sweep ${opts.startFrequency}–${opts.endFrequency}Hz`;
    } else {
      opts.frequency = parseFloat(document.getElementById('toneFrequency')?.value) || 440;
      name = `Ton ${opts.frequency}Hz`;
    }

    const btn = document.getElementById('btnToneGenerate');
    const origHtml = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    try {
      const ctx  = actx();
      const buf  = generateToneBuffer(ctx, opts);
      const blob = audioBufferToWavBlob(buf);
      const b64  = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload  = e => resolve(e.target.result.split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });

      // Gleicher Ziel-Slot-Schreibpfad wie beim Datei-Upload (#slotFile
      // oben) — der generierte Ton wird wie eine importierte Datei
      // behandelt, kein Sonderfall im restlichen Code nötig.
      if (_fxEditContext.kind === 'ambient') {
        const fileId = APP.editSlots[idx]?._fileId || uid();
        await idbSet(audioKey(fileId, 0), b64);
        APP.editSlots[idx] = { data: IDB_SENTINEL, name, trimStart: 0, trimEnd: null, _fileId: fileId };
      } else {
        const stableId = APP.editId || APP._pendingSoundId || uid();
        if (!APP._pendingSoundId && !APP.editId) APP._pendingSoundId = stableId;
        await saveSlotAudio(stableId, idx, b64, null);
        APP.editSlots[idx] = { data: IDB_SENTINEL, name, trimStart: 0, trimEnd: null };
      }
      APP.audioBuffers[`_ed_${idx}`] = buf;
      renderSlotList();
      bootstrap.Modal.getInstance(document.getElementById('toneGeneratorModal'))?.hide();
      toast(`${name} erzeugt und eingesetzt ✓`, 'ok');
    } catch (err) {
      console.error('[events] Tone-Generator fehlgeschlagen:', err);
      toast('Erzeugen fehlgeschlagen: ' + err.message, 'err');
    } finally {
      btn.disabled = false; btn.innerHTML = origHtml;
    }
  });

  document.getElementById('bulkFile')?.addEventListener('change', function() {
    const files = [...this.files]; if (!files.length) return;
    let pending = files.length;
    files.forEach(f => {
      const r = new FileReader();
      r.onload = async e => {
        const b64      = e.target.result.split(',')[1];
        const emptyIdx = APP.editSlots.findIndex(sl => !sl.data);
        const slotIdx  = emptyIdx >= 0 ? emptyIdx : APP.editSlots.length;
        let slotObj;
        if (_fxEditContext.kind === 'ambient') {
          const fileId = (emptyIdx >= 0 && APP.editSlots[emptyIdx]._fileId) || uid();
          await idbSet(audioKey(fileId, 0), b64);
          slotObj = { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null, _fileId: fileId };
        } else {
          const stableId = APP.editId || APP._pendingSoundId || uid();
          if (!APP._pendingSoundId && !APP.editId) APP._pendingSoundId = stableId;
          await saveSlotAudio(stableId, slotIdx, b64, null);
          slotObj = { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null };
        }
        if (emptyIdx >= 0) APP.editSlots[emptyIdx] = slotObj;
        else               APP.editSlots.push(slotObj);
        try {
          const bin = atob(b64); const arr = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
          const decoded = await actx().decodeAudioData(arr.buffer.slice(0));
          APP.audioBuffers[`_ed_${slotIdx}`] = decoded;
        } catch (err) {
          console.warn('[events] bulkFile decode error:', err?.message || err);
        }
        if (--pending === 0) renderSlotList();
      };
      r.readAsDataURL(f);
    });
    toast(`${files.length} Dateien geladen`, 'ok');
  });

  // Ambient basics: variant-mode toggle (Zufällig / Rotierend)
  document.getElementById('ambVariantRandom')?.addEventListener('click', function() {
    _ambVariantMode = 'random';
    this.classList.add('is-active');
    document.getElementById('ambVariantRotate')?.classList.remove('is-active');
  });
  document.getElementById('ambVariantRotate')?.addEventListener('click', function() {
    _ambVariantMode = 'rotate';
    this.classList.add('is-active');
    document.getElementById('ambVariantRandom')?.classList.remove('is-active');
  });

  // Sound modal: volume slider ↔ number input sync
  document.getElementById('eVol')?.addEventListener('input', function() {
    const numEl = document.getElementById('eVolNum');
    if (numEl) numEl.value = Math.round(parseFloat(this.value) * 100);
  });
  document.getElementById('eVolNum')?.addEventListener('input', function() {
    const pct = Math.max(0, Math.min(100, parseInt(this.value) || 0));
    this.value = pct;
    const slEl = document.getElementById('eVol');
    if (slEl) slEl.value = pct / 100;
  });

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
  // Stand zeigen (Prinzip: aktive Auswahl bleibt sichtbar, Abschnitt 8).
  document.getElementById('soundAppearanceModal')?.addEventListener('hidden.bs.modal', _syncAppearancePreview);
  // …und schon während der Dialog offen ist live mitziehen, für den Fall,
  // dass beide Dialoge gleichzeitig sichtbar sind (z. B. sehr breiter Screen).
  document.getElementById('eIcon')?.addEventListener('input', _syncAppearancePreview);
  document.getElementById('clrOpts')?.addEventListener('click', _syncAppearancePreview);

  // Preset dropdown
  // BUGFIX (Kap. 6): die alte Merge-Logik hier übertrug beim Anwenden eines
  // Presets nur einen fest codierten Teil der Effektfelder (lowpass/
  // highpass/pan/reverb/delay/eq/compressor/limiter/distortion) — obwohl
  // die Preset-Objekte selbst (EFFECT_PRESETS in audio.js) bereits u.a.
  // pitchShift/irReverb/envelope/spatial/noiseGate mitliefern UND die
  // Audio-Engine zusätzlich notch/wahwah/chorus/flanger/tremolo/ringmod
  // beherrscht. Diese Felder wurden beim Anwenden eines Presets bisher
  // stillschweigend ignoriert. applyPresetEffects() (presets.js) ist
  // generisch über ALLE von der Engine unterstützten Effektmodule und
  // behebt das — außerdem einheitlich für Built-in- UND User-Presets
  // nutzbar (Kap. 17: keine Preset-spezifischen Sonderfälle mehr nötig).
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

  // Notch (P2)
  document.getElementById('fxNotchEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxNotchFreq')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxNotchFreqLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' Hz';
  });
  document.getElementById('fxNotchQ')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxNotchQLbl');
    if (lbl) lbl.textContent = 'Q ' + this.value;
  });

  // Wahwah (P3)
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
    writeEffectsToUI(defaultEffects());
    toast('Effekte zurückgesetzt');
  });

  // ── PHASE 2 EFFECT LISTENERS ──────────────────────────────

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

  // Ring Modulation (P3)
  document.getElementById('fxRingmodEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxRingmodFrequency')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxRingmodFrequencyLbl');
    if (lbl) lbl.textContent = Math.round(this.value) + ' Hz';
  });

  // Tremolo (P2)
  document.getElementById('fxTremoloEnabled')?.addEventListener('change', () => updateEffectSectionVisibility());
  document.getElementById('fxTremoloRate')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxTremoloRateLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(1) + ' Hz';
  });
  document.getElementById('fxTremoloDepth')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxTremoloDepthLbl');
    if (lbl) lbl.textContent = Math.round(this.value * 100) + '%';
  });

  // Chorus (P2)
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

  // Flanger (P2)
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
    import('./audio.js').then(m => m.exportSoundToWav(s));
  });

  // ── PHASE 3 LISTENERS ─────────────────────────────────────

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
    });
    // P3: Q-Regler pro Band
    document.getElementById('fxEq10Q_' + i)?.addEventListener('input', function() {
      const v = parseFloat(this.value);
      const lbl = document.getElementById('fxEq10QLbl_' + i);
      if (lbl) lbl.textContent = 'Q' + v.toFixed(1);
    });
  }
  document.getElementById('btnEq10Reset')?.addEventListener('click', () => {
    for (let i = 0; i < 10; i++) {
      const sl = document.getElementById('fxEq10_' + i); if (sl) sl.value = 0;
      const lb = document.getElementById('fxEq10Lbl_' + i); if (lb) lb.textContent = '+0';
      // P3: Q-Werte auf Standard (1.4) zurücksetzen
      const qsl = document.getElementById('fxEq10Q_' + i); if (qsl) qsl.value = 1.4;
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
  document.getElementById('fxAnalyzerEnabled')?.addEventListener('change', () => {
    updateEffectSectionVisibility();
    const on = !!(document.getElementById('fxAnalyzerEnabled')?.checked);
    if (!on) stopAnalyzer();
  });

  // Full export (with audio)
  document.getElementById('btnExportFull')?.addEventListener('click', () => {
    import('./storage.js').then(m => m.exportDataWithAudio());
  });

  // ── PHASE 4 LISTENERS ─────────────────────────────────────

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
  document.getElementById('btnUndo')?.addEventListener('click', () => import('./history.js').then(m => m.undo()));
  document.getElementById('btnRedo')?.addEventListener('click', () => import('./history.js').then(m => m.redo()));

  // Sound Modal: MP3 Export button
  document.getElementById('btnExportMp3')?.addEventListener('click', async () => {
    const id = APP.editId; if (!id) return;
    const s  = CItems().find(x => x.id === id); if (!s) return;
    s.effects = readEffectsFromUI();
    const { exportSoundMp3 } = await import('./export.js');
    await exportSoundMp3(s);
  });

  // ── SOUND MODAL SAVE ───────────────────────────────────────

  document.getElementById('btnSaveSound')?.addEventListener('click', () => {
    if (_fxEditContext.kind === 'ambient') {
      const g = id => document.getElementById(id);
      const t = findAmbientTrack(_fxEditContext.id);
      if (!t) { bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide(); return; }

      const name = g('eName').value.trim() || 'Ambient';
      const vol  = parseFloat(g('eVol').value);
      renameAmbientTrack(_fxEditContext.id, name);
      if (!isNaN(vol)) setAmbientTrackVolume(_fxEditContext.id, vol);
      setAmbientTrackEffects(_fxEditContext.id, readEffectsFromUI());

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
      t.variantMode = _ambVariantMode;

      persistAmbientNow();
      renderAmbientPanel();
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
    const items    = CItems();

    // Strip internal-only fields from slots before persisting
    const cleanSlots = APP.editSlots.map(sl => {
      if (!sl) return sl;
      const { _tempId, ...rest } = sl; // remove temporary ID field
      return rest;
    });

    if (APP.editId) {
      const s = items.find(x => x.id === APP.editId);
      if (!s) { toast('Sound nicht gefunden', 'err'); return; }
      Object.assign(s, { name, vol, pitch, loop, fade, random, hotkey, category, icon, color, tileColor, tileW, tileH, slots: cleanSlots, curSlot: 0, effects });
      // Invalidate only slots that were actually modified in this session
      cleanSlots.forEach((sl, i) => {
        const edBuf = APP.audioBuffers[`_ed_${i}`];
        if (edBuf) {
          // New audio was loaded for this slot → update cache
          APP.audioBuffers[bk(s.id, i)] = edBuf;
        } else {
          // No new audio loaded → keep existing cache entry (do NOT invalidate)
        }
      });
    } else {
      // Use the pre-generated stable ID (so IDB audio keys already match)
      const id    = APP._pendingSoundId || uid();
      APP._pendingSoundId = null;
      const phId  = APP._phReplacingId;
      const phIdx = phId ? items.findIndex(x => x.id === phId) : -1;
      const newS  = { type: 'sound', id, order: phIdx >= 0 ? items[phIdx].order : 99999, name, vol, pitch, loop, fade, random, hotkey, category, icon, color, tileColor, tileW, tileH, slots: cleanSlots, curSlot: 0, locked: false, effects };
      if (phIdx >= 0) items.splice(phIdx, 1, newS);
      else {
        const firstPH = items.findIndex(x => x.type === 'placeholder');
        if (firstPH >= 0) { newS.order = items[firstPH].order; items.splice(firstPH, 1, newS); }
        else              { newS.order = items.length; items.push(newS); }
      }
      // Copy edit-modal buffers into the main cache for immediate playback
      cleanSlots.forEach((sl, i) => {
        const edBuf = APP.audioBuffers[`_ed_${i}`];
        if (edBuf) APP.audioBuffers[bk(id, i)] = edBuf;
      });
    }
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gespeichert ✓', 'ok');
  });

  document.getElementById('btnDelSound')?.addEventListener('click', () => {
    if (!APP.editId) return;
    if (!confirm('Diesen Sound wirklich löschen?')) return;
    stopItem(APP.editId);
    const items = CItems(); const idx = items.findIndex(x => x.id === APP.editId);
    if (idx >= 0) { const order = items[idx].order; items.splice(idx, 1, { type: 'placeholder', id: uid(), order, locked: false }); }
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gelöscht');
  });
  document.getElementById('btnExportSound')?.addEventListener('click', () => {
    if (APP.editId) exportSoundItem(APP.editId);
  });

  document.getElementById('btnPreviewSound')?.addEventListener('click', async () => {
    if (_fxEditContext.kind === 'ambient') { toggleAmbientPlay(_fxEditContext.id); return; }
    const slots = APP.editSlots;
    const hasData = slots.some(sl => sl && sl.data);
    if (!hasData) { toast('Keine Audio-Dateien geladen', 'err'); return; }

    // Build a temporary sound object from the current modal state
    // so preview uses the FULL effect chain (same engine as playback)
    const vol   = parseFloat(document.getElementById('eVol')?.value)   || 1;
    const pitch = APP.editId ? (CItems().find(x => x.id === APP.editId)?.pitch || 1) : 1;
    const effects = readEffectsFromUI();

    const tempSound = {
      id:      APP.editId || ('_preview_' + Date.now()),
      name:    document.getElementById('eName')?.value || 'Preview',
      slots:   APP.editSlots,
      vol, pitch, loop: false, fade: false, random: false, curSlot: 0, effects
    };

    // Map _ed_N buffers into the audioBuffers cache under the temp ID
    APP.editSlots.forEach((sl, i) => {
      const edBuf = APP.audioBuffers[`_ed_${i}`];
      if (edBuf) APP.audioBuffers[bk(tempSound.id, i)] = edBuf;
    });

    toast('▶ Vorschau mit Effekten…');
    try {
      await previewSound(tempSound, 0);
      toast('Vorschau läuft ✓', 'ok');
    } catch(e) {
      console.error('Preview error:', e);
      toast('Vorschau-Fehler: ' + e.message, 'err');
    }
  });

  // ── TRIM MODAL ─────────────────────────────────────────────
  // NOTE: canvas mousedown/mousemove/wheel handled by _initTrimCanvasDrag() in ui.js,
  // which is called from openTrimModal on 'shown.bs.modal'.

  document.getElementById('trimStart')?.addEventListener('input', () => { updateTrimDurLabel(); drawTrimWaveform(); });
  document.getElementById('trimEnd')?.addEventListener('input',   () => { updateTrimDurLabel(); drawTrimWaveform(); });
  // P3: Fade-Felder lösen ebenfalls updateTrimDurLabel() aus, damit der
  // Clamp-Hinweis (s. ui.js) sofort auf Eingaben reagiert.
  document.getElementById('trimFadeIn')?.addEventListener('input',  updateTrimDurLabel);
  document.getElementById('trimFadeOut')?.addEventListener('input', updateTrimDurLabel);
  // Aufräumen beim Schließen: laufende Vorschau + Meter-Loop nicht über
  // das offene Modal hinaus weiterlaufen lassen (sonst Audio- bzw.
  // rAF-Leak, wenn der Nutzer während der Vorschau auf "Schließen" klickt).
  document.getElementById('trimModal')?.addEventListener('hidden.bs.modal', () => {
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
    stopPeakRmsMeter();
  });

  // P3 Statisches Spektrogramm
  document.getElementById('trimSpectrogramToggle')?.addEventListener('change', function() {
    const cv = document.getElementById('trimSpectrogramCanvas');
    if (!cv) return;
    cv.style.display = this.checked ? 'block' : 'none';
    if (this.checked) drawTrimSpectrogram();
  });

  document.getElementById('btnTrimReset')?.addEventListener('click', () => {
    if (!APP.trim.buf) return;
    document.getElementById('trimStart').value   = '0';
    document.getElementById('trimEnd').value     = APP.trim.buf.duration.toFixed(3);
    document.getElementById('trimFadeIn').value  = '0';
    document.getElementById('trimFadeOut').value = '0';
    document.getElementById('trimZoom').value    = '1';
    APP.trim.zoom         = 1;
    APP.trim.scrollOffset = 0;
    const lbl = document.getElementById('trimZoomLbl'); if (lbl) lbl.textContent = '1×';
    updateTrimDurLabel(); drawTrimWaveform();
  });
  document.getElementById('btnTrimPreview')?.addEventListener('click', () => {
    if (!APP.trim.buf) return;
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
    const ts  = parseFloat(document.getElementById('trimStart').value) || 0;
    const te  = parseFloat(document.getElementById('trimEnd').value)   || APP.trim.buf.duration;
    const ctx = actx(); const gain = ctx.createGain(); gain.gain.value = 0.8;
    // P2 Peak/RMS-Meter: AnalyserNode zwischen Gain und Destination
    // eingeschleift, damit der gemessene Pegel den tatsächlich hörbaren
    // (bereits gain-skalierten) Signalpfad widerspiegelt.
    const meterAnalyser = ctx.createAnalyser();
    meterAnalyser.fftSize = 1024;
    gain.connect(meterAnalyser); meterAnalyser.connect(ctx.destination);
    const src = ctx.createBufferSource(); src.buffer = APP.trim.buf; src.connect(gain);
    src.start(0, ts, te - ts); APP.trim.previewSrc = src;
    startPeakRmsMeter(meterAnalyser);
    src.onended = () => { APP.trim.previewSrc = null; stopPeakRmsMeter(); };
    toast('Vorschau läuft…');
  });
  document.getElementById('btnTrimStop')?.addEventListener('click', () => {
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
    stopPeakRmsMeter();
  });
  document.getElementById('btnTrimSave')?.addEventListener('click', () => {
    if (APP.trim.slotIdx === null || !APP.trim.buf) return;
    const ts = parseFloat(document.getElementById('trimStart').value) || 0;
    const te = parseFloat(document.getElementById('trimEnd').value)   || APP.trim.buf.duration;
    const fi = Math.max(0, parseFloat(document.getElementById('trimFadeIn').value)  || 0);
    const fo = Math.max(0, parseFloat(document.getElementById('trimFadeOut').value) || 0);
    APP.editSlots[APP.trim.slotIdx].trimStart = Math.max(0, ts);
    APP.editSlots[APP.trim.slotIdx].trimEnd   = Math.min(APP.trim.buf.duration, te);
    APP.editSlots[APP.trim.slotIdx].fadeIn    = fi;
    APP.editSlots[APP.trim.slotIdx].fadeOut   = fo;
    // P3 Fade-Kurven
    APP.editSlots[APP.trim.slotIdx].fadeInCurve  = document.getElementById('trimFadeInCurve')?.value  || 'linear';
    APP.editSlots[APP.trim.slotIdx].fadeOutCurve = document.getElementById('trimFadeOutCurve')?.value || 'linear';
    bootstrap.Modal.getInstance(document.getElementById('trimModal')).hide();
    renderSlotList(); toast('Trim übernommen ✓', 'ok');
  });

  // ── DESTRUKTIVE SLOT-BEARBEITUNG (Editor.js-Anschluss, P0) ──
  // Verdrahtet die eigene Dialogbox #slotDestructiveModal (aus dem kompakten
  // Slot-Edit-Modal heraus geöffnet, Progressive Disclosure — siehe
  // index.html) mit den (bisher toten) Funktionen aus editor.js.
  //
  // Wichtiger Kontext: der Slot-Editor arbeitet mit einer Arbeitskopie
  // (APP.editSlots), die erst beim Speichern des GESAMTEN Sounds in das
  // persistierte Item übernommen wird. editor.js-Funktionen schreiben aber
  // direkt in die persistierte Sound-Struktur + IndexedDB. Deshalb:
  //  1) Destruktive Aktionen sind nur für bereits gespeicherte Slots mit
  //     persistierter Audiodatei erlaubt (sonst gäbe es nichts, worauf die
  //     Funktion dauerhaft schreiben könnte) — der Öffnen-Button prüft das
  //     bereits VOR dem Öffnen der Dialogbox.
  //  2) "Trim anwenden" nutzt explizit die aktuell im Draft sichtbaren
  //     Trim-Werte (nicht die zuletzt gespeicherten), siehe editTrimApply().
  //  3) Nach jeder Aktion werden Cache (_ed_N + bk()-Cache), Trim-Wellenform
  //     und Slot-Edit-Felder aktualisiert, damit UI und Audiodaten wieder
  //     konsistent sind.

  /** Sucht einen Sound anhand der ID über alle Profile hinweg (nicht nur das aktive). */
  function _findSoundAnyProfile(soundId) {
    for (const prof of APP.profiles) {
      const s = (prof.items || []).find(x => x.id === soundId && x.type === 'sound');
      if (s) return s;
    }
    return null;
  }

  function _persistedSlotHasAudio(soundId, slotIdx) {
    if (!soundId || slotIdx == null) return false;
    const s = _findSoundAnyProfile(soundId);
    return !!(s && s.slots && s.slots[slotIdx] && s.slots[slotIdx].data);
  }

  function _refreshEditorActionsAvailability() {
    const soundId = APP.editId;
    const slotIdx = getSlotEditIndex();
    const available = _persistedSlotHasAudio(soundId, slotIdx);
    const body = document.getElementById('editorActionsBody');
    const unavailable = document.getElementById('editorActionsUnavailable');
    if (body)        body.style.display        = available ? '' : 'none';
    if (unavailable) unavailable.style.display = available ? 'none' : '';
    const nrBtn = document.querySelector('#slotDestructiveModal [data-editor-action="noiseReduce"]');
    if (nrBtn) nrBtn.title = APP.noiseProfile ? '' : 'Zuerst „Rauschprofil lernen“ ausführen';
  }

  /** Nach einer destruktiven Editor-Aktion: Caches und UI-Anzeige neu synchronisieren. */
  async function _refreshSlotAfterDestructiveEdit(soundId, slotIdx) {
    invalidateBuffer(soundId, slotIdx);
    delete APP.audioBuffers[`_ed_${slotIdx}`];

    const s = _findSoundAnyProfile(soundId);
    const persistedSlot = s?.slots?.[slotIdx];
    const draftSlot = APP.editSlots?.[slotIdx];

    // Trim wird von manchen Aktionen (v.a. Trim selbst) auf der persistierten
    // Seite zurückgesetzt — Arbeitskopie im offenen Modal muss das spiegeln,
    // sonst zeigt der Trim-Dialog weiter die alten (jetzt ungültigen) Werte.
    if (draftSlot && persistedSlot) {
      draftSlot.trimStart = persistedSlot.trimStart || 0;
      draftSlot.trimEnd   = persistedSlot.trimEnd ?? null;
    }

    let buf = null;
    if (s && persistedSlot?.data) {
      try { buf = await getOrDecodeBuffer(soundId, slotIdx, persistedSlot.data, actx()); }
      catch (e) { console.error('[editor] Buffer-Refresh fehlgeschlagen', e); }
    }
    if (buf) APP.audioBuffers[`_ed_${slotIdx}`] = buf;

    if (getSlotEditIndex() === slotIdx) {
      const durEl = document.getElementById('slotEditDuration');
      if (durEl) durEl.textContent = buf ? buf.duration.toFixed(1) + 's' : '–';
    }

    // Falls der Trim-Dialog gerade für genau diesen Slot offen ist: Wellenform neu zeichnen.
    if (APP.trim.slotIdx === slotIdx && buf) {
      APP.trim.buf = buf;
      drawTrimWaveform();
    }

    renderSlotList();
  }

  async function _onEditorActionClick(action, btn) {
    const soundId = APP.editId;
    const slotIdx = getSlotEditIndex();
    if (!soundId || slotIdx == null) { toast('Kein Slot ausgewählt', 'err'); return; }
    if (!_persistedSlotHasAudio(soundId, slotIdx)) {
      toast('Erst speichern, dann dauerhaft bearbeiten', 'err');
      return;
    }

    const num = (id, def) => {
      const v = parseFloat(document.getElementById(id)?.value);
      return Number.isFinite(v) ? v : def;
    };

    if (action === 'noiseReduce' && !APP.noiseProfile) {
      toast('Zuerst „Rauschprofil lernen“ ausführen', 'err');
      return;
    }

    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    try {
      switch (action) {
        case 'trim': {
          const sl = APP.editSlots?.[slotIdx];
          await editTrimApply(soundId, slotIdx, sl?.trimStart, sl?.trimEnd);
          break;
        }
        case 'normalize':     await editNormalize(soundId, slotIdx, num('editorNormalizeDb', 0)); break;
        case 'loudness':      await editLoudnessNormalize(soundId, slotIdx, { targetRmsDb: num('editorLoudnessDb', -18) }); break;
        case 'reverse':       await editReverse(soundId, slotIdx); break;
        case 'fadeIn':        await editFadeIn(soundId, slotIdx, num('editorFadeInSec', 0.5), document.getElementById('editorFadeInCurve')?.value || 'linear'); break;
        case 'fadeOut':       await editFadeOut(soundId, slotIdx, num('editorFadeOutSec', 0.5), document.getElementById('editorFadeOutCurve')?.value || 'linear'); break;
        case 'gain':          await editGainApply(soundId, slotIdx, num('editorGainDb', 0)); break;
        case 'removeSilence': await editRemoveSilence(soundId, slotIdx, num('editorSilenceDb', -60)); break;
        case 'truncateSilence': await editTruncateSilence(soundId, slotIdx, { thresholdDb: num('editorSilenceDb', -60), targetSilenceDurationSec: num('editorTruncateSec', 0.3) }); break;
        case 'noiseGate':     await editNoiseGate(soundId, slotIdx, num('editorNoiseGateDb', -40)); break;
        case 'learnNoise':    await learnNoiseProfile(soundId, slotIdx); break;
        case 'noiseReduce':   await editNoiseReduce(soundId, slotIdx, num('editorNoiseReduceAmount', 0.6)); break;
        default: return;
      }
      await _refreshSlotAfterDestructiveEdit(soundId, slotIdx);
    } catch (err) {
      console.error(`[editor] Aktion "${action}" fehlgeschlagen:`, err);
      toast(`Fehler bei "${action}": ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
      _refreshEditorActionsAvailability();
    }
  }

  document.getElementById('slotDestructiveModal')?.addEventListener('shown.bs.modal', _refreshEditorActionsAvailability);

  document.getElementById('btnOpenSlotDestructiveModal')?.addEventListener('click', () => {
    if (!_persistedSlotHasAudio(APP.editId, getSlotEditIndex())) {
      toast('Erst diesen Sound speichern, dann dauerhaft bearbeiten', 'err');
      return;
    }
    new bootstrap.Modal(document.getElementById('slotDestructiveModal')).show();
  });

  document.querySelectorAll('#slotDestructiveModal [data-editor-action]').forEach(b => {
    b.addEventListener('click', () => _onEditorActionClick(b.dataset.editorAction, b));
  });

  const _nrAmount = document.getElementById('editorNoiseReduceAmount');
  const _nrLbl    = document.getElementById('editorNoiseReduceAmountLbl');
  _nrAmount?.addEventListener('input', () => {
    if (_nrLbl) _nrLbl.textContent = Math.round(parseFloat(_nrAmount.value) * 100) + '%';
  });

  /** Berechnet eine sinnvolle Startzeit für den nächsten Schritt (Ende des letzten Schritts) */
  function _macroNextStart() {
    if (!APP.macroSteps.length) return 0;
    return +APP.macroSteps.reduce((max, s) => {
      const st  = s.startTime || 0;
      const dur = s.action === 'fadeout' ? (s.fadeDuration || 1000) / 1000 : 0.25;
      return Math.max(max, st + dur);
    }, 0).toFixed(3);
  }

  // ── MACRO MODAL ────────────────────────────────────────────

  /** Helper: re-render macro timeline canvas after any step change */
  function _syncMacroTimeline() {
    import('./macroTimeline.js').then(m => m.setMacroTimelineSteps(APP.macroSteps));
  }

  // Sound/Makro → öffnet Picker-Modal (Problem 3 Fix)
  document.getElementById('btnAddStep')?.addEventListener('click', _openMacroItemPicker);
  document.getElementById('btnTestMacro')?.addEventListener('click', () => {
    runMacro({
      id: '_test',
      steps:       [...APP.macroSteps],
      repeat:      parseInt(document.getElementById('mRepeat').value) || 1,
      repeatDelay: parseInt(document.getElementById('mRepDelay').value) || 500,
      playMode:    document.getElementById('mPlayMode').value
    });
  });
  document.getElementById('mPlayMode')?.addEventListener('change', () => _syncMacroAdvancedIndicator());
  document.getElementById('btnSaveMacro')?.addEventListener('click', async () => {
    // Convert startTime positions to legacy delay (keeps backward compat)
    let _finalSteps;
    try {
      const _mtMod = await import('./macroTimeline.js');
      _finalSteps  = _mtMod.stepsToLegacy([...APP.macroSteps]);
    } catch (e) {
      // Fallback: use steps as-is if macroTimeline unavailable
      _finalSteps = [...APP.macroSteps];
    }
    const g  = id => document.getElementById(id);
    const name        = g('mName').value.trim()  || 'MAKRO';
    const repeat      = parseInt(g('mRepeat').value)    || 1;
    const repeatDelay = parseInt(g('mRepDelay').value)  || 500;
    const hotkey      = g('mHotkey').value.trim();
    const icon        = g('mIcon').value.trim()  || '🪄';
    const tileW       = parseInt(g('mTileW').value)     || null;
    const tileH       = parseInt(g('mTileH').value)     || null;
    const playMode    = g('mPlayMode').value;
    const mTcSel  = document.querySelector('#mTileClrOpts .color-swatch.is-selected');
    const tileColor   = (mTcSel && mTcSel.dataset.color !== 'none') ? mTcSel.dataset.color : '';
    const sel         = document.querySelector('#mClrOpts .color-swatch.is-selected');
    const color       = sel ? sel.dataset.color : 'none';
    const items       = CItems();
    if (APP.editMacroId) {
      const m = items.find(x => x.id === APP.editMacroId);
      Object.assign(m, { name, repeat, repeatDelay, hotkey, icon, color, tileColor, tileW, tileH, playMode, steps: _finalSteps });
    } else {
      const nm = mkMacro({ name, repeat, repeatDelay, hotkey, icon, color, tileColor, tileW, tileH, playMode, steps: _finalSteps });
      // Add in the exact tile the user clicked "+" on (see ui.js
      // _openTileAddChoice), falling back to the first free slot.
      const phId  = APP._macroPhReplacingId;
      const phIdx = phId ? items.findIndex(x => x.id === phId) : -1;
      if (phIdx >= 0) { nm.order = items[phIdx].order; items.splice(phIdx, 1, nm); }
      else {
        const firstPH = items.findIndex(x => x.type === 'placeholder');
        if (firstPH >= 0) { nm.order = items[firstPH].order; items.splice(firstPH, 1, nm); }
        else              { nm.order = items.length; items.push(nm); }
      }
    }
    bootstrap.Modal.getInstance(document.getElementById('macroModal')).hide();
    renderGrid(); toast('Makro gespeichert ✓', 'ok');
  });
  document.getElementById('btnDelMacro')?.addEventListener('click', () => {
    if (!APP.editMacroId) return;
    if (!confirm('Dieses Makro wirklich löschen?')) return;
    const items = CItems(); const idx = items.findIndex(x => x.id === APP.editMacroId);
    if (idx >= 0) { const order = items[idx].order; items.splice(idx, 1, { type: 'placeholder', id: uid(), order, locked: false }); }
    bootstrap.Modal.getInstance(document.getElementById('macroModal')).hide();
    renderGrid(); toast('Makro gelöscht');
  });

  // Hotkey fields
  ['eHotkey', 'mHotkey'].forEach(id => {
    const f = document.getElementById(id);
    if (!f) return;
    f.addEventListener('click', () => { APP.hkTarget = id; f.classList.add('is-recording'); f.value = 'Taste drücken…'; });
  });

  // Global keyboard
  document.addEventListener('keydown', e => {
    if (APP.hkTarget) { handleHotkeyRecord(e); return; }
    const tag = e.target.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const match = CItems().find(x => x.hotkey && hotkeyMatch(x.hotkey, e));
    if (match) { e.preventDefault(); import('./audio.js').then(m => m.playItem(match.id)); }
  });

  // Wake AudioContext on first interaction
  document.body.addEventListener('click', () => actx(), { once: true });

  // ── PHASE 5: Accordion ─────────────────────────────────────
  document.addEventListener('click', e => {
    const btn = e.target.closest('.sm-section-toggle');
    if (!btn) return;
    const targetId = btn.dataset.target;
    if (!targetId) return;
    const body = document.getElementById(targetId);
    if (!body) return;
    const isOpen = btn.classList.contains('is-open');
    btn.classList.toggle('is-open', !isOpen);
    body.style.display = isOpen ? 'none' : '';
  });

  // ── PHASE 5: Macro Timeline ────────────────────────────────
  document.getElementById('macroTlSnap')?.addEventListener('change', function() {
    import('./macroTimeline.js').then(m => m.setSnapMs(parseInt(this.value) || 0));
  });
  document.getElementById('macroTlZoom')?.addEventListener('input', function() {
    import('./macroTimeline.js').then(m => m.setZoom(parseFloat(this.value)));
  });
  document.getElementById('btnMacroTlPreview')?.addEventListener('click', () => {
    import('./macroTimeline.js').then(m => m.previewPlay(actx()));
  });
  document.getElementById('btnMacroTlStop')?.addEventListener('click', () => {
    import('./macroTimeline.js').then(m => m.previewStop(actx()));
  });

  // ── MACRO ITEM PICKER (Problem 3 Fix) ─────────────────────
  let _macroPickerSelected = null; // { id, type }

  /** Alle Sounds und Makros des aktiven Profils im Picker rendern */
  function _renderMacroItemList(filter) {
    const list = document.getElementById('macroItemPickerList');
    if (!list) return;
    const q     = (filter || '').toLowerCase();
    const items = CItems().filter(x =>
      (x.type === 'sound' || x.type === 'macro') &&
      (!q || x.name.toLowerCase().includes(q))
    );
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<p class="u-text-muted" style="padding:8px;font-size:var(--text-badge)">Keine Sounds oder Makros gefunden.</p>';
      return;
    }
    // Group: sounds first, then macros
    const sounds = items.filter(x => x.type === 'sound');
    const macros = items.filter(x => x.type === 'macro');
    const renderGroup = (title, group) => {
      if (!group.length) return;
      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-size:0.68rem;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);padding:6px 4px 2px;font-weight:600';
      hdr.textContent = title;
      list.appendChild(hdr);
      group.forEach(s => {
        const el = document.createElement('button');
        el.className = 'tl-picker-item btn btn--ghost';
        el.setAttribute('role', 'option');
        el.innerHTML = `<span style="font-size:1.1em;margin-right:6px">${iconHtmlOr(s.icon, s.type === 'macro' ? '🪄' : '🔊')}</span>
          <span style="flex:1;text-align:left">${s.name}</span>`;
        el.addEventListener('click', () => {
          list.querySelectorAll('.tl-picker-item').forEach(b => b.classList.remove('is-selected'));
          el.classList.add('is-selected');
          _macroPickerSelected = { id: s.id, type: s.type };
          const insertBtn = document.getElementById('btnMacroItemInsert');
          if (insertBtn) insertBtn.disabled = false;
        });
        list.appendChild(el);
      });
    };
    renderGroup('Sounds', sounds);
    renderGroup('Makros', macros);
  }

  /** Öffnet den Makro-Item-Picker */
  function _openMacroItemPicker() {
    _macroPickerSelected = null;
    const insertBtn = document.getElementById('btnMacroItemInsert');
    if (insertBtn) insertBtn.disabled = true;
    const searchEl = document.getElementById('macroItemSearch');
    if (searchEl) searchEl.value = '';
    _renderMacroItemList('');
    new bootstrap.Modal(document.getElementById('macroItemPickerModal')).show();
  }

  document.getElementById('macroItemSearch')?.addEventListener('input', function() {
    _renderMacroItemList(this.value);
  });

  document.getElementById('btnMacroItemInsert')?.addEventListener('click', () => {
    if (!_macroPickerSelected) return;
    // Startzeit = Ende des letzten Schritts
    const lastEnd = APP.macroSteps.reduce((max, s) => {
      const st = s.startTime || 0;
      const dur = s.action === 'fadeout' ? (s.fadeDuration || 1000) / 1000
                : s.action === 'stop' || s.action === 'stop_all' ? 0.25
                : s.action === 'volume' ? 0.25
                : 0.5; // unbekannte Sound-Dauer, Fallback
      return Math.max(max, st + dur);
    }, 0);
    APP.macroSteps.push({
      action:    'play',
      targetId:  _macroPickerSelected.id,
      startTime: +lastEnd.toFixed(3),
      delay:     0
    });
    bootstrap.Modal.getInstance(document.getElementById('macroItemPickerModal'))?.hide();
    import('./macroTimeline.js').then(m => m.setMacroTimelineSteps(APP.macroSteps));
  });

  // ── PHASE 5: Autosave ──────────────────────────────────────
  _startAutosave();
}

// ─── AUTOSAVE ────────────────────────────────────────────────

let _autosaveTimer = null;

function _startAutosave() {
  const INTERVAL = 60_000; // 60 seconds
  setInterval(() => {
    import('./storage.js').then(m => {
      if (m._saveRaw) m._saveRaw();
      else if (m.save) m.save();
      const dot = document.getElementById('autosaveDot');
      if (dot) { dot.classList.add('is-saving'); setTimeout(() => dot.classList.remove('is-saving'), 1200); }
    }).catch(() => {});
  }, INTERVAL);
}

// ─── ENVELOPE CURVE PREVIEW ──────────────────────────────────

function _updateEnvelopeCurve() {
  const cv = document.getElementById('envCanvas');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = cv.offsetWidth; const H = cv.offsetHeight;
  if (W === 0 || H === 0) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);

  const att = parseFloat(document.getElementById('fxEnvAttack')?.value)  || 0.01;
  const dec = parseFloat(document.getElementById('fxEnvDecay')?.value)   || 0.15;
  const sus = parseFloat(document.getElementById('fxEnvSustain')?.value) || 0.8;
  const rel = parseFloat(document.getElementById('fxEnvRelease')?.value) || 0.25;
  const totalT = att + dec + Math.max(dec * 2, 0.3) + rel;

  const cs     = getComputedStyle(document.documentElement);
  const accent = cs.getPropertyValue('--color-accent').trim() || '#0075de';
  const bg     = cs.getPropertyValue('--bg-warm').trim()      || '#1a1a1a';

  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();

  const t2x = t => (t / totalT) * W;
  const v2y = v => H - v * (H - 4) - 2;

  ctx.moveTo(0, v2y(0));
  ctx.lineTo(t2x(att), v2y(1));
  ctx.lineTo(t2x(att + dec), v2y(sus));
  const susEnd = att + dec + Math.max(dec * 2, 0.3);
  ctx.lineTo(t2x(susEnd), v2y(sus));
  ctx.lineTo(t2x(totalT), v2y(0));
  ctx.stroke();

  // Labels
  ctx.fillStyle = accent; ctx.font = `9px monospace`;
  ctx.fillText('A', t2x(att / 2) - 3, H - 2);
  ctx.fillText('D', t2x(att + dec / 2) - 3, H - 2);
  ctx.fillText('S', t2x(att + dec + Math.max(dec, 0.15)) - 3, H - 2);
  ctx.fillText('R', t2x(susEnd + rel / 2) - 3, H - 2);
}
