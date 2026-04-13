/**
 * audio.js — Audio Engine
 * Pitch fix: playbackRate applied consistently in all playback paths.
 */

import { APP, CP, CItems } from './state.js';
import { bk, sleep }       from './utils.js';
import { toast }           from './notifications.js';

let _audioCtx = null;

export function actx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

export function decodeAudio(key, b64) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    actx().decodeAudioData(arr.buffer.slice(0), buf => { APP.audioBuffers[key] = buf; }, () => {});
  } catch (e) {}
}

export function playItem(id, callStack = []) {
  const item = CItems().find(x => x.id === id);
  if (!item || item.type === 'placeholder') return;
  if (item.type === 'sound') playSound(item);
  else runMacro(item, callStack);
}

export function playSound(s) {
  const slots = s.slots || [];
  let idx = s.random
    ? Math.floor(Math.random() * slots.length)
    : (s.curSlot || 0) % slots.length;
  if (!s.random) s.curSlot = (idx + 1) % slots.length;

  const slot = slots[idx];
  if (!slot || !slot.data) { toast('Slot ' + (idx + 1) + ' leer'); return; }

  const buf = APP.audioBuffers[bk(s.id, idx)];
  if (!buf) { toast('Audio lädt…'); return; }

  const gs  = APP.globalSettings;
  const ctx = actx();

  if (!gs.overlap) stopAll();

  const gain = ctx.createGain();
  gain.gain.value = s.vol * gs.masterVol;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = s.pitch || 1;   // ← pitch applied
  src.loop = !!s.loop;

  const ts = slot.trimStart || 0;
  let   te = slot.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  const dur = te - ts;

  src.connect(gain);
  gain.connect(ctx.destination);

  if (s.fade && !s.loop) {
    const fs = Math.max(0, dur - 0.8);
    gain.gain.setValueAtTime(s.vol * gs.masterVol, ctx.currentTime + fs);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
  }
  const fadeIn  = slot.fadeIn  || 0;
  const fadeOut = slot.fadeOut || 0;
  if (fadeIn > 0 && !s.loop) {
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(s.vol * gs.masterVol, ctx.currentTime + Math.min(fadeIn, dur * 0.5));
  }
  if (fadeOut > 0 && !s.loop && !s.fade) {
    const foStart = Math.max(ctx.currentTime, ctx.currentTime + dur - fadeOut);
    gain.gain.setValueAtTime(s.vol * gs.masterVol, foStart);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur);
  }

  if (!APP.activeAudio[s.id]) APP.activeAudio[s.id] = [];
  APP.activeAudio[s.id].push({ src, gain, dur });

  src.start(0, ts, s.loop ? undefined : dur);
  src.onended = () => {
    if (APP.activeAudio[s.id]) {
      APP.activeAudio[s.id] = APP.activeAudio[s.id].filter(x => x.src !== src);
      if (!APP.activeAudio[s.id].length) { delete APP.activeAudio[s.id]; setPlaying(s.id, false); }
    }
    updateStatusDot();
    refreshRotBadge(s.id);
  };

  setPlaying(s.id, true);
  updateStatusDot();
  animProg(s.id, dur);
  refreshRotBadge(s.id);
}

export function playSoundAndWait(s) {
  return new Promise(resolve => {
    const slots = s.slots || [];
    let idx = s.random
      ? Math.floor(Math.random() * slots.length)
      : (s.curSlot || 0) % slots.length;
    if (!s.random) s.curSlot = (idx + 1) % slots.length;

    const slot = slots[idx];
    if (!slot || !slot.data) { resolve(); return; }

    const buf = APP.audioBuffers[bk(s.id, idx)];
    if (!buf) { resolve(); return; }

    const gs  = APP.globalSettings;
    const ctx = actx();
    const gain = ctx.createGain();
    gain.gain.value = s.vol * gs.masterVol;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = s.pitch || 1;   // ← pitch applied

    const ts = slot.trimStart || 0;
    let   te = slot.trimEnd ?? buf.duration;
    if (te <= ts) te = buf.duration;
    const dur = te - ts;

    src.connect(gain);
    gain.connect(ctx.destination);
    if (!APP.activeAudio[s.id]) APP.activeAudio[s.id] = [];
    APP.activeAudio[s.id].push({ src, gain, dur });
    src.start(0, ts, dur);
    src.onended = () => {
      if (APP.activeAudio[s.id]) {
        APP.activeAudio[s.id] = APP.activeAudio[s.id].filter(x => x.src !== src);
        if (!APP.activeAudio[s.id].length) { delete APP.activeAudio[s.id]; setPlaying(s.id, false); }
      }
      updateStatusDot();
      refreshRotBadge(s.id);
      resolve();
    };
    setPlaying(s.id, true);
    updateStatusDot();
    animProg(s.id, dur);
    refreshRotBadge(s.id);
  });
}

/**
 * Plays a single audio buffer directly (used for modal preview).
 * Applies volume and pitch from the passed parameters.
 */
export function playBufferPreview(buf, slot, vol, pitch) {
  if (!buf) return null;
  const ctx  = actx();
  const gain = ctx.createGain();
  gain.gain.value = vol;
  gain.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = pitch || 1;   // ← pitch applied in preview

  const ts = slot?.trimStart || 0;
  let   te = slot?.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;

  src.connect(gain);
  src.start(0, ts, te - ts);
  return src;
}

export function stopItem(id) {
  (APP.activeAudio[id] || []).forEach(a => { try { a.src.stop(); } catch (e) {} });
  delete APP.activeAudio[id];
  setPlaying(id, false);
  updateStatusDot();
}

export function stopAll() {
  Object.keys(APP.activeAudio).forEach(stopItem);
}

const MAX_DEPTH = 8;

export async function runMacro(m, callStack = []) {
  if (callStack.length >= MAX_DEPTH) { toast('Makro-Tiefe erreicht', 'err'); return; }
  if (callStack.includes(m.id))      { toast('Zirkulärer Makro!',    'err'); return; }
  const stack = [...callStack, m.id];
  setPlaying(m.id, true);
  const mode = m.playMode || 'parallel';

  for (let r = 0; r < (m.repeat || 1); r++) {
    let execSteps = [...(m.steps || [])];
    if (mode === 'random') execSteps = execSteps.sort(() => Math.random() - 0.5);

    for (const step of execSteps) {
      const action = step.action || 'play';

      if (action === 'stop_all') {
        stopAll();
      } else if (action === 'stop') {
        if (step.targetId) { const t = CItems().find(x => x.id === step.targetId); if (t) stopItem(t.id); }
      } else if (action === 'play' || !action) {
        if (step.targetId) {
          const t = CItems().find(x => x.id === step.targetId);
          if (t) {
            if (t.type === 'sound') {
              if (mode === 'sequential') await playSoundAndWait(t);
              else playSound(t);
            } else if (t.type === 'macro') {
              await runMacro(t, stack);
            }
          }
        }
      } else if (action === 'volume') {
        const vol = step.volumeVal != null ? step.volumeVal : APP.globalSettings.masterVol;
        APP.globalSettings.masterVol = Math.max(0, Math.min(1, vol));
        const el = document.getElementById('masterVol');
        if (el) el.value = APP.globalSettings.masterVol;
      } else if (action === 'fadeout') {
        if (step.targetId) {
          const t = CItems().find(x => x.id === step.targetId);
          if (t) {
            const active  = APP.activeAudio[t.id] || [];
            const fadeDur = (step.fadeDuration || 1000) / 1000;
            active.forEach(a => {
              try {
                const ctx = actx();
                a.gain.gain.cancelScheduledValues(ctx.currentTime);
                a.gain.gain.setValueAtTime(a.gain.gain.value, ctx.currentTime);
                a.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDur);
                setTimeout(() => { try { a.src.stop(); } catch (e) {} }, fadeDur * 1000 + 50);
              } catch (e) {}
            });
          }
        }
      }

      if (step.delay > 0) await sleep(step.delay);
    }
    if (r < (m.repeat || 1) - 1) await sleep(m.repeatDelay || 500);
  }
  setPlaying(m.id, false);
  updateStatusDot();
}

// ─── UI SYNC ─────────────────────────────────────────────────

function setPlaying(id, on) {
  const wrap = document.querySelector(`.tile-wrap[data-id="${id}"]`);
  if (wrap) wrap.querySelector('.tile')?.classList.toggle('is-playing', on);
}

function updateStatusDot() {
  const n    = Object.keys(APP.activeAudio).length;
  const dot  = document.getElementById('sdot');
  const stxt = document.getElementById('stxt');
  if (dot)  dot.classList.toggle('is-active', n > 0);
  if (stxt) stxt.textContent = n > 0 ? `${n} AKTIV` : 'BEREIT';
}

export function animProg(id, dur) {
  const bar = document.querySelector(`.tile-wrap[data-id="${id}"] .tile__progress`);
  if (!bar || !dur) return;
  const t0 = performance.now();
  function step(t) {
    const p = Math.min(100, ((t - t0) / (dur * 1000)) * 100);
    bar.style.width = p + '%';
    if (p < 100 && APP.activeAudio[id]) requestAnimationFrame(step);
    else bar.style.width = '0%';
  }
  requestAnimationFrame(step);
}

export function refreshRotBadge(id) {
  const s = CItems().find(x => x.id === id && x.type === 'sound');
  if (!s) return;
  const wrap = document.querySelector(`.tile-wrap[data-id="${id}"]`);
  if (!wrap) return;
  const badge = wrap.querySelector('.tile__slot-badge');
  const tile  = wrap.querySelector('.tile');
  if (!badge || !tile) return;
  const total = (s.slots || []).length;
  if (total > 1) {
    badge.textContent = `${((s.curSlot || 0) % total) + 1}/${total}`;
    tile.classList.add('has-multi-slots');
  } else {
    badge.textContent = '';
    tile.classList.remove('has-multi-slots');
  }
}
