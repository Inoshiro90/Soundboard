/**
 * events.js — Event Listeners, Modal Controllers, Grid Operations
 * Phase 1: Effects UI (Preset-Dropdown, Lowpass, Highpass, Pan, Reverb, Delay)
 */

import { APP, CP, CItems, CSettings } from './state.js';
import { uid, hotkeyStr, hotkeyMatch, bk } from './utils.js';
import { toast }          from './notifications.js';
import { actx, stopAll, stopItem, runMacro, previewSound, EFFECT_PRESETS, defaultEffects, exportSoundToWav, startAnalyzerLoop, stopAnalyzer } from './audio.js';
import { invalidateBuffer } from './audioCache.js';
import {
  renderGrid, renderProfileTabs, applyProfileSettings, updateStatus,
  buildIconGrid, buildColorOpts, renderSlotList, renderMacroSteps,
  openTrimModal, drawTrimWaveform, updateTrimDurLabel, normaliseOrders,
  updateMoveBarSelects, exitArrangeMode, enterArrangeMode, syncThemeIcon
} from './ui.js';
import {
  save, exportDataWithAudio, importData, resetAll,
  mkProfile, mkSound, mkMacro, mkPH, saveSlotAudio
} from './storage.js';
import { IDB_SENTINEL } from './db.js';

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
      amount:    num('fxDistAmount', 40),
      oversample: sel('fxDistOversample') || '4x'
    },
    // Phase 3
    pitchShift: {
      enabled:  chk('fxPitchEnabled'),
      semitones: num('fxPitchSemitones', 0)
    },
    eq10: {
      enabled: chk('fxEq10Enabled'),
      bands: Array.from({ length: 10 }, (_, i) => num('fxEq10_' + i, 0))
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
  set('fxDistAmount',  fx.distortion?.amount ?? 40); lbl('fxDistAmountLbl', Math.round(fx.distortion?.amount ?? 40));
  set('fxDistOversample', fx.distortion?.oversample ?? '4x');

  // Phase 3
  chk('fxPitchEnabled', fx.pitchShift?.enabled);
  set('fxPitchSemitones', fx.pitchShift?.semitones ?? 0);
  lbl('fxPitchSemitonesLbl', (fx.pitchShift?.semitones ?? 0) >= 0 ? '+' + (fx.pitchShift?.semitones ?? 0) : (fx.pitchShift?.semitones ?? 0));

  chk('fxEq10Enabled', fx.eq10?.enabled);
  const bands = fx.eq10?.bands || new Array(10).fill(0);
  bands.forEach((v, i) => {
    const sid = 'fxEq10_' + i; const lid = 'fxEq10Lbl_' + i;
    set(sid, v); lbl(lid, (v >= 0 ? '+' : '') + v.toFixed(0));
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

  updateEffectSectionVisibility();
  _markActiveAccordionSections(fx);
}

/**
 * Mark accordion section headers with 'has-active-fx' if they contain active effects.
 * Improves visual hierarchy: users can see at a glance which sections are active.
 */
function _markActiveAccordionSections(fx) {
  if (!fx) return;
  const sections = {
    'smFxBasic':    fx.enabled,
    'smFxFilters':  fx.lowpass?.enabled || fx.highpass?.enabled || fx.pan !== 0,
    'smFxEQ':       fx.eq?.enabled || fx.eq10?.enabled,
    'smFxDyn':      fx.compressor?.enabled || fx.limiter?.enabled,
    'smFxDist':     fx.distortion?.enabled,
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
    ['fxRevEnabled',  'fxRevControls'],
    ['fxDelEnabled',  'fxDelControls'],
    ['fxEqEnabled',   'fxEqControls'],
    ['fxCompEnabled', 'fxCompControls'],
    ['fxLimEnabled',  'fxLimControls'],
    ['fxDistEnabled', 'fxDistControls'],
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
}

// ─── SOUND MODAL ─────────────────────────────────────────────

export function openSoundModal(id, placeholderId = null) {
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

  document.getElementById('sMTitle').textContent = id ? 'SOUND BEARBEITEN' : 'NEUER SOUND';
  const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val; };
  const chk = (elId, val) => { const el = document.getElementById(elId); if (el) el.checked = val; };

  set('eName',    s ? s.name     : '');
  set('eVol',     s ? s.vol      : 1);
  set('ePitch',   s ? s.pitch    : 1);
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

  const pitchLbl = document.getElementById('pitchLbl');
  if (pitchLbl) pitchLbl.textContent = ((s ? s.pitch : 1) || 1).toFixed(2) + '×';

  const delBtn = document.getElementById('btnDelSound');
  if (delBtn) delBtn.style.display = id ? '' : 'none';

  APP.editSlots = s ? (s.slots || []).map(sl => ({ ...sl })) : [{ data: null, name: 'Leer', trimStart: 0, trimEnd: null }];
  renderSlotList();
  buildIconGrid('iconGrid',  s ? s.icon  : '');
  buildColorOpts('clrOpts',  s ? s.color : 'none');
  buildColorOpts('eTileClrOpts', s && s.tileColor ? s.tileColor : 'none');

  // ── Effects UI ────────────────────────────────────────────
  writeEffectsToUI(s?.effects || defaultEffects());
  // ─────────────────────────────────────────────────────────

  document.getElementById('soundModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#soundModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });

  new bootstrap.Modal(document.getElementById('soundModal')).show();
}

// ─── MACRO MODAL ─────────────────────────────────────────────

export function openMacroModal(id) {
  APP.editMacroId = id;
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

  buildIconGrid('profIconGrid', p ? p.icon : '🎵');
  document.getElementById('profModal').addEventListener('shown.bs.modal', () => {
    const bar = document.querySelector('#profModal .icon-picker__cats');
    if (bar && typeof lucide !== 'undefined') lucide.createIcons({ nodes: [...bar.querySelectorAll('[data-lucide]')] });
  }, { once: true });
  new bootstrap.Modal(document.getElementById('profModal')).show();
}

// ─── PROFILE SWITCH ───────────────────────────────────────────

function switchProfile(id) {
  stopAll();
  APP.activeProfileId = id;
  APP.activeCategory  = 'all';
  exitArrangeMode();
  const moveBar = document.getElementById('moveBar');
  if (moveBar) moveBar.classList.add('is-hidden');
  APP.moveMode = false;
  document.getElementById('btnMoveMode')?.classList.remove('btn--active');
  renderProfileTabs();
  applyProfileSettings();
  renderGrid();
}

// ─── ARRANGE HELPERS ─────────────────────────────────────────

function snapshotArrange() {
  APP.arrangeHistory.push(CItems().map(x => ({ id: x.id, order: x.order })));
  if (APP.arrangeHistory.length > 20) APP.arrangeHistory.shift();
}

function arrangeRowLeft() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders();
  const items = CItems();
  for (let r = 0; r < rows; r++) {
    const base     = r * cols;
    const rowItems = items.filter(x => x.order >= base && x.order < base + cols).sort((a, b) => a.order - b.order);
    const reals    = rowItems.filter(x => !x.locked && x.type !== 'placeholder');
    let col = 0;
    rowItems.forEach(x => { if (!x.locked && x.type !== 'placeholder') { x.order = base + col; col++; } });
    const usedCols = reals.map(x => x.order - base);
    const freeCols = Array.from({ length: cols }, (_, i) => i).filter(c => !usedCols.includes(c) && !rowItems.some(x => x.locked && x.order - base === c));
    rowItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeCols[i] !== undefined) ph.order = base + freeCols[i]; });
  }
  normaliseOrders(); renderGrid(); toast('Links ausgerichtet', 'ok');
}

function arrangeRowRight() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let r = 0; r < rows; r++) {
    const base     = r * cols;
    const rowItems = items.filter(x => x.order >= base && x.order < base + cols).sort((a, b) => a.order - b.order);
    const reals    = rowItems.filter(x => !x.locked && x.type !== 'placeholder');
    let col = cols - 1;
    for (let i = reals.length - 1; i >= 0; i--) { reals[i].order = base + col; col--; }
    const usedCols = reals.map(x => x.order - base);
    const freeCols = Array.from({ length: cols }, (_, i) => i).filter(c => !usedCols.includes(c) && !rowItems.some(x => x.locked && x.order - base === c));
    rowItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeCols[i] !== undefined) ph.order = base + freeCols[i]; });
  }
  normaliseOrders(); renderGrid(); toast('Rechts ausgerichtet', 'ok');
}

function arrangeRowCenter() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let r = 0; r < rows; r++) {
    const base     = r * cols;
    const rowItems = items.filter(x => x.order >= base && x.order < base + cols).sort((a, b) => a.order - b.order);
    const reals    = rowItems.filter(x => !x.locked && x.type !== 'placeholder');
    const start    = Math.floor((cols - reals.length) / 2);
    reals.forEach((x, i) => { x.order = base + start + i; });
    const usedCols = reals.map(x => x.order - base);
    const freeCols = Array.from({ length: cols }, (_, i) => i).filter(c => !usedCols.includes(c) && !rowItems.some(x => x.locked && x.order - base === c));
    rowItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeCols[i] !== undefined) ph.order = base + freeCols[i]; });
  }
  normaliseOrders(); renderGrid(); toast('Mittig ausgerichtet', 'ok');
}

function arrangeRowJustify() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let r = 0; r < rows; r++) {
    const base     = r * cols;
    const rowItems = items.filter(x => x.order >= base && x.order < base + cols).sort((a, b) => a.order - b.order);
    const reals    = rowItems.filter(x => !x.locked && x.type !== 'placeholder');
    if (reals.length <= 1) { reals.forEach((x, i) => { x.order = base + i; }); continue; }
    const step     = (cols - 1) / (reals.length - 1);
    reals.forEach((x, i) => { x.order = base + Math.round(i * step); });
    const usedCols = reals.map(x => x.order - base);
    const freeCols = Array.from({ length: cols }, (_, i) => i).filter(c => !usedCols.includes(c) && !rowItems.some(x => x.locked && x.order - base === c));
    rowItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeCols[i] !== undefined) ph.order = base + freeCols[i]; });
  }
  normaliseOrders(); renderGrid(); toast('Verteilt', 'ok');
}

function arrangeColTop() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let c = 0; c < cols; c++) {
    const colItems = items.filter(x => x.order % cols === c && x.order < cols * rows).sort((a, b) => a.order - b.order);
    const reals    = colItems.filter(x => !x.locked && x.type !== 'placeholder');
    let row = 0;
    reals.forEach(x => { x.order = row * cols + c; row++; });
    const usedRows = reals.map(x => Math.floor(x.order / cols));
    const freeRows = Array.from({ length: rows }, (_, i) => i).filter(r => !usedRows.includes(r) && !colItems.some(x => x.locked && Math.floor(x.order / cols) === r));
    colItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeRows[i] !== undefined) ph.order = freeRows[i] * cols + c; });
  }
  normaliseOrders(); renderGrid(); toast('Spalten nach oben', 'ok');
}

function arrangeColBottom() {
  snapshotArrange();
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  normaliseOrders(); const items = CItems();
  for (let c = 0; c < cols; c++) {
    const colItems = items.filter(x => x.order % cols === c && x.order < cols * rows).sort((a, b) => a.order - b.order);
    const reals    = colItems.filter(x => !x.locked && x.type !== 'placeholder');
    let row = rows - 1;
    for (let i = reals.length - 1; i >= 0; i--) { reals[i].order = row * cols + c; row--; }
    const usedRows = reals.map(x => Math.floor(x.order / cols));
    const freeRows = Array.from({ length: rows }, (_, i) => i).filter(r => !usedRows.includes(r) && !colItems.some(x => x.locked && Math.floor(x.order / cols) === r));
    colItems.filter(x => !x.locked && x.type === 'placeholder').forEach((ph, i) => { if (freeRows[i] !== undefined) ph.order = freeRows[i] * cols + c; });
  }
  normaliseOrders(); renderGrid(); toast('Spalten nach unten', 'ok');
}

function arrangeCompact() {
  snapshotArrange(); normaliseOrders();
  const items    = CItems();
  const locked   = items.filter(x => x.locked);
  const lockedOrders = new Set(locked.map(x => x.order));
  const reals    = items.filter(x => !x.locked && x.type !== 'placeholder').sort((a, b) => a.order - b.order);
  const phs      = items.filter(x => !x.locked && x.type === 'placeholder');
  let slot = 0;
  reals.forEach(x => { while (lockedOrders.has(slot)) slot++; x.order = slot; slot++; });
  const usedOrders = new Set([...locked.map(x => x.order), ...reals.map(x => x.order)]);
  let phSlot = 0;
  phs.forEach(x => { while (usedOrders.has(phSlot)) phSlot++; x.order = phSlot; usedOrders.add(phSlot); phSlot++; });
  normaliseOrders(); renderGrid(); toast('Alle Lücken geschlossen', 'ok');
}

function undoArrange() {
  if (!APP.arrangeHistory.length) { toast('Nichts zum Rückgängig'); return; }
  const snap = APP.arrangeHistory.pop();
  snap.forEach(s => { const item = CItems().find(x => x.id === s.id); if (item) item.order = s.order; });
  renderGrid(); toast('Rückgängig ✓', 'ok');
}

// ─── GRID MANAGEMENT ─────────────────────────────────────────

function addCol() {
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  cs.maxCols = Math.min(32, cols + 1);
  normaliseOrders();
  const items = CItems();
  for (let r = 0; r < rows; r++) {
    items.forEach(x => { if (x.order >= r * (cols + 1) + cols) x.order++; });
    items.push(mkPH(r * (cols + 1) + cols));
  }
  normaliseOrders();
  const el = document.getElementById('maxCols'); if (el) el.value = cs.maxCols;
  renderGrid();
}
function removeCol() {
  const cs = CSettings(); const cols = cs.maxCols; const rows = cs.maxRows;
  if (cols <= 1) return;
  cs.maxCols = cols - 1;
  normaliseOrders();
  const items = CItems();
  for (let r = 0; r < rows; r++) {
    const lastOrder = r * cols + (cols - 1);
    const idx = items.findIndex(x => x.order === lastOrder && x.type === 'placeholder');
    if (idx >= 0) items.splice(idx, 1);
  }
  normaliseOrders();
  const el = document.getElementById('maxCols'); if (el) el.value = cs.maxCols;
  renderGrid();
}
function addRow() {
  const cs = CSettings(); const cols = cs.maxCols;
  cs.maxRows = Math.min(32, cs.maxRows + 1);
  const items = CItems(); const base = cols * (cs.maxRows - 1);
  for (let c = 0; c < cols; c++) items.push(mkPH(base + c));
  normaliseOrders();
  const el = document.getElementById('maxRows'); if (el) el.value = cs.maxRows;
  renderGrid();
}
function removeRow() {
  const cs = CSettings(); if (cs.maxRows <= 1) return;
  const cols = cs.maxCols; const lastRowBase = cols * (cs.maxRows - 1);
  const items = CItems();
  const toRemove = items.filter(x => x.order >= lastRowBase && x.type === 'placeholder').map(x => x.id);
  CP().items = items.filter(x => !toRemove.includes(x.id));
  cs.maxRows--;
  normaliseOrders();
  const el = document.getElementById('maxRows'); if (el) el.value = cs.maxRows;
  renderGrid();
}

function swapRows() {
  const ra = parseInt(document.getElementById('mvRowA').value);
  const rb = parseInt(document.getElementById('mvRowB').value);
  if (!ra || !rb || ra === rb) { toast('Zwei verschiedene Reihen wählen'); return; }
  const cols = CSettings().maxCols;
  snapshotArrange(); normaliseOrders();
  const baseA = (ra - 1) * cols; const baseB = (rb - 1) * cols;
  CItems().forEach(x => {
    if      (x.order >= baseA && x.order < baseA + cols) x.order = baseB + (x.order - baseA);
    else if (x.order >= baseB && x.order < baseB + cols) x.order = baseA + (x.order - baseB);
  });
  normaliseOrders(); renderGrid(); toast(`Reihe ${ra} ↔ ${rb} getauscht`, 'ok');
}

function swapCols() {
  const ca = parseInt(document.getElementById('mvColA').value);
  const cb = parseInt(document.getElementById('mvColB').value);
  if (!ca || !cb || ca === cb) { toast('Zwei verschiedene Spalten wählen'); return; }
  const cols = CSettings().maxCols;
  snapshotArrange(); normaliseOrders();
  CItems().forEach(x => {
    const col = (x.order % cols) + 1;
    if      (col === ca) x.order = x.order - (ca - 1) + (cb - 1);
    else if (col === cb) x.order = x.order - (cb - 1) + (ca - 1);
  });
  normaliseOrders(); renderGrid(); toast(`Spalte ${ca} ↔ ${cb} getauscht`, 'ok');
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
      np.settings = { ...CSettings() };
      const total = np.settings.maxCols * np.settings.maxRows;
      for (let i = 0; i < total; i++) np.items.push(mkPH(i));
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

  // Toolbar — grid controls
  document.getElementById('btnColPlus')?.addEventListener('click',  addCol);
  document.getElementById('btnColMinus')?.addEventListener('click', removeCol);
  document.getElementById('btnRowPlus')?.addEventListener('click',  addRow);
  document.getElementById('btnRowMinus')?.addEventListener('click', removeRow);
  document.getElementById('maxCols')?.addEventListener('change', function() {
    const cs = CSettings(); cs.maxCols = Math.max(1, Math.min(32, parseInt(this.value) || 10)); this.value = cs.maxCols; renderGrid();
  });
  document.getElementById('maxRows')?.addEventListener('change', function() {
    const cs = CSettings(); cs.maxRows = Math.max(1, Math.min(32, parseInt(this.value) || 10)); this.value = cs.maxRows; renderGrid();
  });

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
  document.getElementById('btnNewMacro')?.addEventListener('click', () => openMacroModal(null));

  // Options bar
  document.getElementById('btnOptsToggle')?.addEventListener('click', function() {
    const bar  = document.getElementById('optsBar');
    const open = bar.classList.toggle('is-open');
    this.classList.toggle('is-active', open);
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
    bar.setAttribute('aria-hidden', open ? 'false' : 'true');
  });
  document.getElementById('setOverlap')?.addEventListener('change',    e => { APP.globalSettings.overlap    = e.target.checked; });
  document.getElementById('setStopReplay')?.addEventListener('change', e => { APP.globalSettings.stopReplay = e.target.checked; });
  document.getElementById('setMultiClick')?.addEventListener('change', e => { APP.globalSettings.multiClick = e.target.checked; });

  // Data
  document.getElementById('btnExport')?.addEventListener('click', () => {
    import('./storage.js').then(m => m.exportData());
  });
  document.getElementById('btnImportTrigger')?.addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f) return;
    importData(f, {
      onSuccess: () => {
        applyProfileSettings(); renderProfileTabs(); renderGrid(); toast('Import ✓', 'ok');
      }
    });
  });
  document.getElementById('btnReset')?.addEventListener('click', () => {
    resetAll({
      onDone: () => { applyProfileSettings(); renderProfileTabs(); renderGrid(); }
    });
  });

  // Arrange mode
  document.getElementById('btnArrange')?.addEventListener('click', () => {
    if (APP.arrangeMode) exitArrangeMode(); else enterArrangeMode();
  });
  document.getElementById('btnCloseArrange')?.addEventListener('click', exitArrangeMode);
  document.getElementById('btnLockToggle')?.addEventListener('click', function() {
    APP.lockMode = !APP.lockMode;
    this.classList.toggle('btn--active', APP.lockMode);
    toast(APP.lockMode ? 'Sperr-Modus aktiv: Kacheln klicken zum Sperren/Entsperren' : 'Sperr-Modus deaktiviert');
  });
  document.getElementById('arrRowLeft')?.addEventListener('click',    arrangeRowLeft);
  document.getElementById('arrRowCenter')?.addEventListener('click',  arrangeRowCenter);
  document.getElementById('arrRowRight')?.addEventListener('click',   arrangeRowRight);
  document.getElementById('arrRowJustify')?.addEventListener('click', arrangeRowJustify);
  document.getElementById('arrColTop')?.addEventListener('click',     arrangeColTop);
  document.getElementById('arrColBottom')?.addEventListener('click',  arrangeColBottom);
  document.getElementById('arrCompact')?.addEventListener('click',    arrangeCompact);
  document.getElementById('btnUndoArrange')?.addEventListener('click', undoArrange);

  // Move mode
  document.getElementById('btnMoveMode')?.addEventListener('click', function() {
    APP.moveMode = !APP.moveMode;
    document.getElementById('moveBar')?.classList.toggle('is-hidden', !APP.moveMode);
    this.classList.toggle('is-active', APP.moveMode);
    if (APP.moveMode) updateMoveBarSelects();
  });
  document.getElementById('btnCloseMoveMode')?.addEventListener('click', () => {
    APP.moveMode = false;
    document.getElementById('moveBar')?.classList.add('is-hidden');
    document.getElementById('btnMoveMode')?.classList.remove('is-active');
  });
  document.getElementById('btnSwapRows')?.addEventListener('click', swapRows);
  document.getElementById('btnSwapCols')?.addEventListener('click', swapCols);

  // Sound modal — slot management
  document.getElementById('btnAddSlot')?.addEventListener('click', () => {
    APP.editSlots.push({ data: null, name: 'Leer', trimStart: 0, trimEnd: null });
    renderSlotList();
  });
  document.getElementById('slotFile')?.addEventListener('change', function() {
    const f = this.files[0]; if (!f || APP.loadingSlotIdx === null) return;
    const r = new FileReader();
    r.onload = async e => {
      const b64 = e.target.result.split(',')[1];
      const idx = APP.loadingSlotIdx;
      // Use the pre-generated stable ID so IDB key matches the eventual sound ID.
      const stableId = APP.editId || APP._pendingSoundId || uid();
      if (!APP._pendingSoundId && !APP.editId) APP._pendingSoundId = stableId;
      await saveSlotAudio(stableId, idx, b64, null);
      APP.editSlots[idx] = { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null };
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
  document.getElementById('bulkFile')?.addEventListener('change', function() {
    const files = [...this.files]; if (!files.length) return;
    let pending = files.length;
    files.forEach(f => {
      const r = new FileReader();
      r.onload = async e => {
        const b64      = e.target.result.split(',')[1];
        const emptyIdx = APP.editSlots.findIndex(sl => !sl.data);
        const slotIdx  = emptyIdx >= 0 ? emptyIdx : APP.editSlots.length;
        const stableId = APP.editId || APP._pendingSoundId || uid();
        if (!APP._pendingSoundId && !APP.editId) APP._pendingSoundId = stableId;
        await saveSlotAudio(stableId, slotIdx, b64, null);
        const slotObj = { data: IDB_SENTINEL, name: f.name, trimStart: 0, trimEnd: null };
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
  document.getElementById('ePitch')?.addEventListener('input', function() {
    const lbl = document.getElementById('pitchLbl');
    if (lbl) lbl.textContent = parseFloat(this.value).toFixed(2) + '×';
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

  // Preset dropdown
  document.getElementById('fxPreset')?.addEventListener('change', function() {
    const val = this.value;
    if (!val) {
      // "Kein Preset" gewählt — Effekte auf Standardwerte zurücksetzen
      writeEffectsToUI(defaultEffects());
      return;
    }
    const preset = EFFECT_PRESETS[val];
    if (!preset) return;
    const def = defaultEffects();
    const merged = {
      enabled:    true,
      preset:     val,
      lowpass:    { ...def.lowpass,    ...preset.lowpass },
      highpass:   { ...def.highpass,   ...preset.highpass },
      pan:        preset.pan ?? 0,
      reverb:     { ...def.reverb,     ...preset.reverb },
      delay:      { ...def.delay,      ...preset.delay },
      eq:         { ...def.eq,         ...(preset.eq         || {}) },
      compressor: { ...def.compressor, ...(preset.compressor || {}) },
      limiter:    { ...def.limiter,    ...(preset.limiter    || {}) },
      distortion: { ...def.distortion, ...(preset.distortion || {}) }
    };
    writeEffectsToUI(merged);
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
  document.getElementById('fxDistAmount')?.addEventListener('input', function() {
    const lbl = document.getElementById('fxDistAmountLbl');
    if (lbl) lbl.textContent = Math.round(this.value);
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
  }
  document.getElementById('btnEq10Reset')?.addEventListener('click', () => {
    for (let i = 0; i < 10; i++) {
      const sl = document.getElementById('fxEq10_' + i); if (sl) sl.value = 0;
      const lb = document.getElementById('fxEq10Lbl_' + i); if (lb) lb.textContent = '+0';
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
    const g = id => document.getElementById(id);
    const name     = g('eName').value.trim()      || 'SOUND';
    const vol      = parseFloat(g('eVol').value);
    const pitch    = parseFloat(g('ePitch').value);
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
    stopItem(APP.editId);
    const items = CItems(); const idx = items.findIndex(x => x.id === APP.editId);
    if (idx >= 0) { const order = items[idx].order; items.splice(idx, 1, { type: 'placeholder', id: uid(), order, locked: false }); }
    bootstrap.Modal.getInstance(document.getElementById('soundModal')).hide();
    renderGrid(); toast('Gelöscht');
  });

  document.getElementById('btnPreviewSound')?.addEventListener('click', async () => {
    const slots = APP.editSlots;
    const hasData = slots.some(sl => sl && sl.data);
    if (!hasData) { toast('Keine Audio-Dateien geladen', 'err'); return; }

    // Build a temporary sound object from the current modal state
    // so preview uses the FULL effect chain (same engine as playback)
    const vol   = parseFloat(document.getElementById('eVol')?.value)   || 1;
    const pitch = parseFloat(document.getElementById('ePitch')?.value) || 1;
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
    const ctx = actx(); const gain = ctx.createGain(); gain.gain.value = 0.8; gain.connect(ctx.destination);
    const src = ctx.createBufferSource(); src.buffer = APP.trim.buf; src.connect(gain);
    src.start(0, ts, te - ts); APP.trim.previewSrc = src;
    src.onended = () => { APP.trim.previewSrc = null; };
    toast('Vorschau läuft…');
  });
  document.getElementById('btnTrimStop')?.addEventListener('click', () => {
    if (APP.trim.previewSrc) { try { APP.trim.previewSrc.stop(); } catch (e) {} APP.trim.previewSrc = null; }
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
    bootstrap.Modal.getInstance(document.getElementById('trimModal')).hide();
    renderSlotList(); toast('Trim übernommen ✓', 'ok');
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
      const firstPH = items.findIndex(x => x.type === 'placeholder');
      if (firstPH >= 0) { nm.order = items[firstPH].order; items.splice(firstPH, 1, nm); }
      else              { nm.order = items.length; items.push(nm); }
    }
    bootstrap.Modal.getInstance(document.getElementById('macroModal')).hide();
    renderGrid(); toast('Makro gespeichert ✓', 'ok');
  });
  document.getElementById('btnDelMacro')?.addEventListener('click', () => {
    if (!APP.editMacroId) return;
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
        el.innerHTML = `<span style="font-size:1.1em;margin-right:6px">${s.icon || (s.type === 'macro' ? '🪄' : '🔊')}</span>
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
