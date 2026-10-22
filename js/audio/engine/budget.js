/**
 * audio/engine/budget.js — Voice-Budget in der App (Phase 3a): der EINE VoiceManager, Anmeldung für die Wiedergabe,
 * Einstellung „Stimmenlimit“, Kalibrierung im Leerlauf, Überlast-Wächter, Hinweis und Diagnose (`?debug=audio`).
 * Die Logik selbst (voices.js, cost.js, calibrate.js, monitor.js) ist rein und getestet; hier steckt nur die Verdrahtung.
 *
 * Einstellung `globalSettings.voiceLimit`: 'auto' (Standard) | 'off' | Zahl als Text ('4'…'16', feste Höchstzahl gleichzeitiger Sounds).
 * Wirkt nur auf Live und Vorschau; der Export läuft nie degradiert. Ambient und Musik (nur gezählt, `noDegrade`) melden sich über `_connectWithFx` bzw. `_reconnectSlotFx` an.
 */
import { APP } from '../../core/state.js';
import { toast } from '../../notifications.js';
import { VoiceManager, createStagger } from './voices.js';
import { planCost } from './cost.js';
import { applyDegrade } from './degrade.js';
import { sendEligibility } from '../fx-pipeline.js';
import { loadCalibration, saveCalibration, runCalibration } from './calibrate.js';
import { startMonitor } from './monitor.js';

export const stagger = createStagger({ threshold: 4, perFrame: 2 });
const CALIB_RETRY_MS = 3000, CALIB_MAX_TRIES = 40;
let _vm = null, _ctxMonitored = null, _stopMonitor = null, _calibrating = false, _noticeShown = false;

/** Einstellung → Modus. */
export function parseVoiceLimit(v) {
  if (v === 'off') return { mode: 'off' };
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n > 0) return { mode: 'count', maxVoices: n };
  return { mode: 'auto' };
}

export function getVoiceManager() {
  if (!_vm) {
    _vm = new VoiceManager({ onEvent: _onEvent });
    if (typeof window !== 'undefined') window.__voices = _vm;   // Diagnose (?debug=audio, Konsole)
  }
  const m = parseVoiceLimit(APP.globalSettings?.voiceLimit);
  _vm.setMode(m.mode, m.maxVoices);
  return _vm;
}

function _onEvent(e) {
  if (e.type === 'evicted' && e.first && !_noticeShown) {
    _noticeShown = true;
    toast('Älteste Stimme ausgeblendet — zu viele aufwendige Sounds gleichzeitig (Einstellung „Stimmenlimit“)');
  }
}

/**
 * Erzeugt die `admit`-Funktion für renderSoundGraph. `ref` (veränderlich) bekommt später { graph }, damit ein Entzug die
 * Voice klickfrei ausblenden kann.
 */
export function makeAdmit({ kind = 'sound', id = null, loop = false, ref = {}, share: shareOpt = null, noDegrade = false } = {}) {
  return plan => {
    const vm = getVoiceManager();
    // share: Ambient/Musik bauen den Hall bisher immer pro Stimme (kein Hub) → Kosten ohne Send zählen.
    const share = shareOpt === null ? APP.globalSettings?.reverbShare !== false : !!shareOpt;
    const costFor = level => {
      const p = level ? applyDegrade(plan, level) : plan;
      return planCost(p, { send: share ? sendEligibility(p) : null });
    };
    const r = vm.requestVoice({ kind, id, loop, costFor, noDegrade, fadeOut: ms => fadeOutVoice(ref, ms) });
    const finalPlan = r.degrade ? applyDegrade(plan, r.degrade) : plan;
    const points = vm.voices.get(r.voiceId)?.cost.points ?? 0;
    return { plan: finalPlan, release: r.release, degraded: !!r.degrade, overBudget: r.overBudget, points, heavy: points > 40 || !!plan.hasPitch };
  };
}

/** Klickfreies Ausblenden einer entzogenen Voice (Rampe auf Master-Gain, danach stop; onended räumt wie gewohnt auf). */
export function fadeOutVoice(ref, ms) {
  const g = ref?.graph;
  if (!g) return;
  try {
    const ctx = g.masterGain.context, t = ctx.currentTime;
    g.masterGain.gain.cancelScheduledValues(t);
    g.masterGain.gain.setValueAtTime(g.masterGain.gain.value, t);
    g.masterGain.gain.linearRampToValueAtTime(0, t + ms / 1000);
  } catch (e) { /* Knoten bereits entsorgt */ }
  setTimeout(() => { try { g.src.stop(); } catch (e) { /* schon gestoppt */ } }, ms + 30);
}

/**
 * Einmalig nach der ersten Nutzeraktion: gespeicherte Kapazität laden oder im Leerlauf kalibrieren; Wächter starten.
 * Idempotent. `ctx` ist der Live-AudioContext.
 */
export function initVoiceBudget(ctx) {
  const vm = getVoiceManager();
  mountAudioDebug();
  if (ctx && _ctxMonitored !== ctx) {
    _stopMonitor?.();
    _ctxMonitored = ctx;
    _stopMonitor = startMonitor(ctx, info => vm.reportOverload(info));
  }
  if (_calibrating || vm.calibrated) return;
  let saved = null;
  try { saved = loadCalibration(localStorage); } catch (e) { /* Speicher gesperrt */ }
  if (saved) { vm.setCapacity(saved.capacity); vm.calibrated = true; return; }
  _calibrating = true;
  // „Leerlauf“ = keine Sound-/Vorschau-Stimme. Musik und Ambient dürfen laufen (der Offline-Render läuft auf eigenem Thread; würde sonst bei
  // Dauerbeschallung nie kalibriert). Läuft gerade ein Sound, wird alle 3 s erneut geprüft (höchstens 40×, danach beim nächsten Abspielen wieder).
  const attempt = async n => {
    if (vm.count('sound') + vm.count('preview') > 0) {
      if (n >= CALIB_MAX_TRIES) { _calibrating = false; return; }
      setTimeout(() => attempt(n + 1).catch(() => { _calibrating = false; }), CALIB_RETRY_MS);
      return;
    }
    const r = await runCalibration({ OfflineAudioContext: window.OfflineAudioContext || window.webkitOfflineAudioContext, sampleRate: ctx?.sampleRate || 48000 });
    _calibrating = false;
    if (r && !vm.calibrated) { vm.setCapacity(r.capacity); vm.calibrated = true; try { saveCalibration(localStorage, r.capacity); } catch (e) { /* Quota */ } }
  };
  (window.requestIdleCallback || (cb => setTimeout(cb, 1500)))(() => { attempt(0).catch(() => { _calibrating = false; }); }, { timeout: 5000 });
}

/** Hinweis (P10c): Hüllkurven-Steuerung ohne geladenes Worklet → Ersatz durch den LFO; einmal pro Sitzung. */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  let _fallbackNoted = false;
  window.addEventListener('sb:fx-fallback', e => {
    if (_fallbackNoted) return; _fallbackNoted = true;
    toast(`${e.detail?.module || 'Effekt'}: Hüllkurven-Steuerung nicht verfügbar (AudioWorklet) — es läuft der LFO.`);
  });
}

/** Diagnose-Overlay (?debug=audio): Voices, Punkte, Kapazität, Uhr-Verhältnis. */
export function mountAudioDebug() {
  if (typeof location === 'undefined' || !/[?&]debug=audio\b/.test(location.search) || document.getElementById('audioDebug')) return;
  const el = document.createElement('pre');
  el.id = 'audioDebug';
  el.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;margin:0;padding:8px 10px;background:rgba(0,0,0,.8);color:#9f9;font:11px/1.4 ui-monospace,monospace;max-width:46ch;pointer-events:none';
  document.body.appendChild(el);
  setInterval(() => {
    const st = getVoiceManager().getState();
    el.textContent = `Stimmen ${st.voices.length} · ${st.used}/${st.budget} Punkte (Kapazität ${st.capacity}, ${st.mode})\n` +
      `entzogen ${st.stats.evicted} · degradiert ${st.stats.degraded} · über Budget ${st.stats.overBudget} · Überlast ${st.stats.overloads}\n` +
      (typeof window !== 'undefined' && window.__swapStats ? `Austausch ${window.__swapStats.swaps}× · Aufbau ${Math.round(window.__swapStats.buildMs)} ms · gesamt ${Math.round(window.__swapStats.totalMs)} ms (max ${Math.round(window.__swapStats.maxTotalMs)}) · zusammengefasst ${window.__swapStats.coalesced}\n` : '') +
      st.voices.slice(0, 8).map(v => `${v.kind}${v.loop ? '∞' : ''} ${v.id ?? ''} ${v.points}${v.hub ? ' Hub ' + v.hub : ''}${v.degraded ? ' ↓' : ''}`).join('\n');
  }, 1000);
}
