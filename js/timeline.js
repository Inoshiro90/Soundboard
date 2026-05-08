/**
 * timeline.js — Multi-Track Timeline / Mixer (Phase 4)
 *
 * State lives in APP.timeline (state.js).
 * Canvas rendering for the timeline view.
 * Audio scheduling via Web Audio API (sample-accurate).
 *
 * Track structure:
 *   { id, name, vol, pan, mute, solo, clips: [{ id, soundId, slotIdx, startSec, gain }] }
 *
 * Clip: references a sound's slot audio buffer.
 */

import { APP, CItems }   from './state.js';
import { uid, bk }       from './utils.js';
import { toast }         from './notifications.js';
import { actx, stopAll } from './audio.js';
import { historyPush, snapshotTimeline } from './history.js';

// ─── TRACK MANAGEMENT ────────────────────────────────────────

export function addTrack(name) {
  const before = snapshotTimeline();
  const track  = { id: uid(), name: name || `Spur ${APP.timeline.tracks.length + 1}`,
                   vol: 1, pan: 0, mute: false, solo: false, clips: [] };
  APP.timeline.tracks.push(track);
  historyPush('Spur hinzugefügt', 'timeline', { before, after: snapshotTimeline() });
  renderTimeline();
  return track;
}

export function removeTrack(trackId) {
  const before = snapshotTimeline();
  APP.timeline.tracks = APP.timeline.tracks.filter(t => t.id !== trackId);
  historyPush('Spur entfernt', 'timeline', { before, after: snapshotTimeline() });
  renderTimeline();
}

export function addClipToTrack(trackId, soundId, slotIdx, startSec) {
  const track = APP.timeline.tracks.find(t => t.id === trackId);
  if (!track) return;
  const sound  = CItems().find(x => x.id === soundId);
  if (!sound) return;
  const before = snapshotTimeline();
  const clip   = { id: uid(), soundId, slotIdx: slotIdx || 0, startSec: startSec || 0, gain: sound.vol || 1, label: sound.name };
  track.clips.push(clip);
  historyPush(`Clip „${sound.name}" hinzugefügt`, 'timeline', { before, after: snapshotTimeline() });
  renderTimeline();
  return clip;
}

export function removeClip(trackId, clipId) {
  const track = APP.timeline.tracks.find(t => t.id === trackId);
  if (!track) return;
  const before = snapshotTimeline();
  track.clips = track.clips.filter(c => c.id !== clipId);
  historyPush('Clip entfernt', 'timeline', { before, after: snapshotTimeline() });
  renderTimeline();
}

// ─── PLAYBACK ────────────────────────────────────────────────

let _scheduledNodes = [];

export function timelinePlay() {
  if (APP.timeline.playing) timelineStop();
  APP.timeline.playing = true;
  APP.timeline.startWallClock  = actx().currentTime;
  APP.timeline.startPlayhead   = APP.timeline.playheadSec;

  const tracks  = APP.timeline.tracks;
  const hasSolo = tracks.some(t => t.solo);
  const ctx     = actx();

  // Master Bus Limiter
  const masterLimiter = ctx.createDynamicsCompressor();
  masterLimiter.threshold.value = -1;
  masterLimiter.knee.value      = 0;
  masterLimiter.ratio.value     = 20;
  masterLimiter.attack.value    = 0.001;
  masterLimiter.release.value   = 0.08;
  masterLimiter.connect(ctx.destination);

  tracks.forEach(track => {
    if (track.mute) return;
    if (hasSolo && !track.solo) return;

    const trackGain = ctx.createGain();
    trackGain.gain.value = track.vol;
    const panner = ctx.createStereoPanner();
    panner.pan.value = track.pan || 0;
    trackGain.connect(panner); panner.connect(masterLimiter);

    (track.clips || []).forEach(clip => {
      const buf = APP.audioBuffers[bk(clip.soundId, clip.slotIdx)];
      if (!buf) return;

      const clipOffset  = clip.startSec - APP.timeline.startPlayhead;
      if (clipOffset < -buf.duration) return; // already past

      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 1;

      const clipGain = ctx.createGain();
      clipGain.gain.value = clip.gain;
      src.connect(clipGain); clipGain.connect(trackGain);

      const startAt  = Math.max(0, ctx.currentTime + clipOffset);
      const offsetIn = clipOffset < 0 ? -clipOffset : 0;
      src.start(startAt, offsetIn);
      _scheduledNodes.push(src);
    });
  });

  _startPlayheadRAF();
  document.getElementById('btnTimelinePlay')?.classList.add('btn--active');
  document.getElementById('btnTimelineStop')?.classList.remove('btn--active');
}

export function timelineStop() {
  APP.timeline.playing = false;
  _scheduledNodes.forEach(n => { try { n.stop(); } catch(e) {} });
  _scheduledNodes = [];
  if (APP.timeline.rafId) { cancelAnimationFrame(APP.timeline.rafId); APP.timeline.rafId = null; }
  document.getElementById('btnTimelinePlay')?.classList.remove('btn--active');
  renderTimeline();
}

function _startPlayheadRAF() {
  if (APP.timeline.rafId) cancelAnimationFrame(APP.timeline.rafId);
  function tick() {
    if (!APP.timeline.playing) return;
    const elapsed = actx().currentTime - APP.timeline.startWallClock;
    APP.timeline.playheadSec = APP.timeline.startPlayhead + elapsed;

    // Loop
    if (APP.timeline.loopEnabled && APP.timeline.playheadSec >= APP.timeline.loopEnd) {
      timelineStop();
      APP.timeline.playheadSec = APP.timeline.loopStart;
      timelinePlay();
      return;
    }
    renderTimelinePlayhead();
    APP.timeline.rafId = requestAnimationFrame(tick);
  }
  APP.timeline.rafId = requestAnimationFrame(tick);
}

// ─── RENDERING ───────────────────────────────────────────────

const TRACK_H    = 52; // px per track
const HEADER_W   = 110; // px for track label area
const RULER_H    = 24; // px for time ruler

export function renderTimeline() {
  const container = document.getElementById('timelineCanvas');
  if (!container) return;

  const pps    = APP.timeline.pixelsPerSec;
  const tracks = APP.timeline.tracks;
  const totalW = Math.max(800, pps * 30);
  const totalH = RULER_H + tracks.length * TRACK_H + 4;

  container.style.height = totalH + 'px';
  const dpr = window.devicePixelRatio || 1;
  container.width  = totalW * dpr;
  container.height = totalH * dpr;
  container.style.width = totalW + 'px';
  const ctx = container.getContext('2d');
  ctx.scale(dpr, dpr);

  const cs     = getComputedStyle(document.documentElement);
  const bgClr  = cs.getPropertyValue('--bg-warm').trim()    || '#1e1e1e';
  const brdClr = cs.getPropertyValue('--border-color').trim() || '#333';
  const accent = cs.getPropertyValue('--color-accent').trim() || '#0075de';
  const txtClr = cs.getPropertyValue('--text-primary').trim() || '#ddd';

  ctx.fillStyle = bgClr;
  ctx.fillRect(0, 0, totalW, totalH);

  // Time ruler
  ctx.fillStyle = '#00000022';
  ctx.fillRect(HEADER_W, 0, totalW - HEADER_W, RULER_H);
  ctx.strokeStyle = brdClr; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(HEADER_W, RULER_H); ctx.lineTo(totalW, RULER_H); ctx.stroke();
  ctx.fillStyle = txtClr; ctx.font = `10px monospace`;
  for (let s = 0; s <= 120; s += (pps < 40 ? 10 : pps < 80 ? 5 : 1)) {
    const x = HEADER_W + s * pps;
    if (x > totalW) break;
    ctx.strokeStyle = brdClr; ctx.beginPath(); ctx.moveTo(x, RULER_H - 6); ctx.lineTo(x, RULER_H); ctx.stroke();
    ctx.fillText(s + 's', x + 2, RULER_H - 8);
  }

  // Tracks
  tracks.forEach((track, ti) => {
    const y = RULER_H + ti * TRACK_H;

    // Header bg
    ctx.fillStyle = track.mute ? '#00000044' : (track.solo ? accent + '22' : '#00000018');
    ctx.fillRect(0, y, HEADER_W, TRACK_H);
    ctx.strokeStyle = brdClr; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + TRACK_H); ctx.lineTo(totalW, y + TRACK_H); ctx.stroke();

    // Track name
    ctx.fillStyle = track.mute ? '#666' : txtClr;
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(track.name.slice(0, 12), 6, y + 15);

    // Track controls (M/S labels)
    ctx.font = '9px sans-serif';
    ctx.fillStyle = track.mute ? '#e05' : '#888';
    ctx.fillText('M', 6,  y + 30);
    ctx.fillStyle = track.solo ? accent : '#888';
    ctx.fillText('S', 20, y + 30);

    // Vol
    ctx.fillStyle = '#888'; ctx.fillText(`V:${Math.round(track.vol * 100)}%`, 32, y + 30);

    // Track area background
    ctx.fillStyle = '#00000010';
    ctx.fillRect(HEADER_W, y, totalW - HEADER_W, TRACK_H);

    // Clips
    (track.clips || []).forEach(clip => {
      const buf = APP.audioBuffers[bk(clip.soundId, clip.slotIdx)];
      const dur = buf ? buf.duration : 1;
      const cx  = HEADER_W + clip.startSec * pps;
      const cw  = Math.max(8, dur * pps);
      const cy  = y + 3; const ch = TRACK_H - 6;

      // Clip body
      ctx.fillStyle = track.mute ? '#555' : accent + 'bb';
      _roundRect(ctx, cx, cy, cw, ch, 3); ctx.fill();

      // Clip waveform thumbnail
      if (buf && cw > 20) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1; ctx.beginPath();
        const data = buf.getChannelData(0);
        const step = Math.ceil(data.length / cw);
        for (let px = 0; px < cw; px++) {
          let mn = 0, mx = 0;
          for (let j = 0; j < step && (px * step + j) < data.length; j++) {
            const v = data[px * step + j]; if (v < mn) mn = v; if (v > mx) mx = v;
          }
          const midY = cy + ch / 2;
          if (px === 0) ctx.moveTo(cx + px, midY + mn * (ch / 2) * 0.9);
          else { ctx.lineTo(cx + px, midY + mx * (ch / 2) * 0.9); ctx.lineTo(cx + px, midY + mn * (ch / 2) * 0.9); }
        }
        ctx.stroke();
      }

      // Clip label
      ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif';
      ctx.fillText(clip.label?.slice(0, Math.floor(cw / 6)) || '', cx + 4, cy + 12);
    });
  });

  renderTimelinePlayhead(ctx, totalH);
}

export function renderTimelinePlayhead(existingCtx, totalH) {
  const container = document.getElementById('timelineCanvas');
  if (!container) return;
  const ctx = existingCtx || (() => {
    const c = container.getContext('2d');
    c.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    return c;
  })();

  const pps = APP.timeline.pixelsPerSec;
  const ph  = APP.timeline.playheadSec;
  const x   = HEADER_W + ph * pps;
  const h   = totalH || container.offsetHeight;
  ctx.strokeStyle = '#e04040';
  ctx.lineWidth   = 2;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  // Diamond head
  ctx.fillStyle = '#e04040';
  ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x - 6, RULER_H - 10); ctx.lineTo(x + 6, RULER_H - 10); ctx.closePath(); ctx.fill();
}

function _roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2; if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ─── CANVAS INTERACTION ───────────────────────────────────────

export function initTimelineInteraction() {
  const canvas = document.getElementById('timelineCanvas');
  if (!canvas) return;

  canvas.addEventListener('click', e => {
    const r    = canvas.getBoundingClientRect();
    const x    = e.clientX - r.left;
    const y    = e.clientY - r.top;
    const pps  = APP.timeline.pixelsPerSec;
    const timeSec = (x - HEADER_W) / pps;

    // Click on ruler → seek
    if (y < RULER_H && x > HEADER_W) {
      APP.timeline.playheadSec = Math.max(0, timeSec);
      renderTimeline(); return;
    }

    // Click on header (M/S) for track controls
    if (x < HEADER_W) {
      const ti = Math.floor((y - RULER_H) / TRACK_H);
      const track = APP.timeline.tracks[ti];
      if (!track) return;
      const relY = y - RULER_H - ti * TRACK_H;
      if (relY > 20 && relY < 35) {
        if (e.clientX - r.left < 18)  { track.mute = !track.mute; renderTimeline(); }
        if (e.clientX - r.left < 32 && e.clientX - r.left >= 18) { track.solo = !track.solo; renderTimeline(); }
      }
    }
  });

  // Drag to position clips (simplified: drag sound from soundboard)
  canvas.addEventListener('dragover', e => e.preventDefault());
  canvas.addEventListener('drop', e => {
    e.preventDefault();
    const soundId = e.dataTransfer.getData('soundId');
    if (!soundId) return;
    const r   = canvas.getBoundingClientRect();
    const x   = e.clientX - r.left;
    const y   = e.clientY - r.top;
    const pps = APP.timeline.pixelsPerSec;
    const ti  = Math.floor((y - RULER_H) / TRACK_H);
    const sec = Math.max(0, (x - HEADER_W) / pps);
    let track = APP.timeline.tracks[ti];
    if (!track) { track = addTrack(); }
    addClipToTrack(track.id, soundId, 0, sec);
  });
}

// ─── OFFLINE MIXDOWN ──────────────────────────────────────────

/**
 * Render all timeline tracks to a single AudioBuffer (offline mixdown).
 */
export async function timelineMixdown() {
  const tracks = APP.timeline.tracks;
  if (!tracks.length) { toast('Keine Spuren', 'err'); return null; }

  // Find total duration
  let totalDur = 0;
  tracks.forEach(t => {
    (t.clips || []).forEach(c => {
      const buf = APP.audioBuffers[bk(c.soundId, c.slotIdx)];
      if (buf) totalDur = Math.max(totalDur, c.startSec + buf.duration);
    });
  });
  if (totalDur <= 0) { toast('Keine Audio-Daten', 'err'); return null; }

  toast('Mixdown läuft…');
  const sr     = actx().sampleRate;
  const offCtx = new OfflineAudioContext(2, Math.ceil(totalDur * sr) + sr, sr);

  // Master limiter
  const lim = offCtx.createDynamicsCompressor();
  lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20;
  lim.attack.value = 0.001; lim.release.value = 0.08;
  lim.connect(offCtx.destination);

  const hasSolo = tracks.some(t => t.solo);
  tracks.forEach(track => {
    if (track.mute || (hasSolo && !track.solo)) return;
    const tGain = offCtx.createGain(); tGain.gain.value = track.vol;
    const pan   = offCtx.createStereoPanner(); pan.pan.value = track.pan || 0;
    tGain.connect(pan); pan.connect(lim);

    (track.clips || []).forEach(clip => {
      const buf = APP.audioBuffers[bk(clip.soundId, clip.slotIdx)];
      if (!buf) return;
      const src = offCtx.createBufferSource(); src.buffer = buf;
      const cg  = offCtx.createGain(); cg.gain.value = clip.gain;
      src.connect(cg); cg.connect(tGain);
      src.start(clip.startSec);
    });
  });

  const rendered = await offCtx.startRendering();
  toast('Mixdown fertig ✓', 'ok');
  return rendered;
}

// ─── ZOOM ─────────────────────────────────────────────────────

export function setZoom(pps) {
  APP.timeline.pixelsPerSec = Math.max(10, Math.min(400, pps));
  renderTimeline();
}
