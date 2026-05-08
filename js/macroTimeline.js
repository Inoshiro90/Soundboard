/**
 * macroTimeline.js — Visual Macro Timeline Editor (Phase 5)
 *
 * Replaces the old "step list with ms delay" UI with a drag-and-drop
 * canvas-based timeline. Each macro step is a coloured block on a
 * horizontal time axis. Steps can be dragged to set startTime.
 *
 * Data model change (backward-compatible):
 *   OLD step: { action, targetId, delay }           ← ms after PREVIOUS step
 *   NEW step: { action, targetId, startTime, delay } ← seconds from t=0 (preferred)
 *
 * Migration: on load, if step has no startTime, derive it from cumulative delay sum.
 */

import { APP }    from './state.js';
import { CItems } from './state.js';
import { toast }  from './notifications.js';
import { uid, bk } from './utils.js';

// ─── CONSTANTS ────────────────────────────────────────────────
const TRACK_H    = 36;   // px per row
const HEADER_W   = 90;   // left label area
const RULER_H    = 22;   // ruler strip
const MIN_BLOCK_W = 28;  // minimum block width in px

// ─── MIGRATION ────────────────────────────────────────────────

/**
 * Convert old ms-delay steps to startTime-based steps.
 * Steps that already have startTime are left unchanged.
 */
export function migrateStepsToStartTime(steps) {
  if (!steps || !steps.length) return steps;
  let cursor = 0;
  return steps.map(step => {
    if (step.startTime != null) { cursor = step.startTime + 0.5; return step; }
    const s = { ...step, startTime: cursor / 1000 + (step.delay || 0) / 1000 };
    cursor += (step.delay || 0);
    return s;
  });
}

/** Convert startTime-based steps back to legacy delay for saving (keeps compat). */
export function stepsToLegacy(steps) {
  if (!steps || !steps.length) return steps;
  const sorted = [...steps].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  let prev = 0;
  return sorted.map(step => ({
    ...step,
    delay: Math.round(((step.startTime || 0) - prev) * 1000),
    // Keep startTime for timeline
  }));
}

// ─── STATE ────────────────────────────────────────────────────

let _pps        = 120;   // pixels per second
let _dragging   = null;  // { stepIdx, offsetSec }
let _canvas     = null;
let _steps      = [];    // reference to APP.macroSteps
let _playing    = false;
let _playhead   = 0;
let _playRaf    = null;
let _playStart  = null;
let _scheduledSrcs = [];
let _snapMs     = 50;    // snap grid in ms (0 = no snap)

// ─── PUBLIC API ───────────────────────────────────────────────

export function initMacroTimeline(canvasEl, steps) {
  _canvas  = canvasEl;
  _steps   = steps;
  _playhead = 0;
  _pps     = 120;
  _dragging = null;

  if (!_canvas) return;

  const dpr = window.devicePixelRatio || 1;
  _canvas.width  = _canvas.offsetWidth  * dpr;
  _canvas.height = (_calcHeight())      * dpr;
  _canvas.style.height = _calcHeight() + 'px';

  _bindEvents();
  render();
}

export function setMacroTimelineSteps(steps) {
  _steps = steps;
  _resize();
  render();
}

export function getMacroTimelineSteps() {
  return _steps;
}

export function setSnapMs(ms) { _snapMs = ms; }
export function setZoom(pps)  { _pps = Math.max(40, Math.min(600, pps)); _resize(); render(); }

// ─── RENDERING ────────────────────────────────────────────────

export function render() {
  if (!_canvas) return;
  const dpr      = window.devicePixelRatio || 1;
  const totalSec = Math.max(4, _totalDuration() + 2);
  // Canvas is wider than the visible scroll container — enables horizontal scroll
  const W        = Math.max(_canvas.parentElement?.clientWidth || 600, totalSec * _pps + HEADER_W + 40);
  const H        = _calcHeight();
  _canvas.width  = W * dpr;
  _canvas.height = H * dpr;
  _canvas.style.width  = W + 'px';
  _canvas.style.height = H + 'px';
  const ctx = _canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cs      = getComputedStyle(document.documentElement);
  const accent  = cs.getPropertyValue('--color-accent').trim()  || '#0075de';
  const bg      = cs.getPropertyValue('--bg-warm').trim()       || '#1e1e1e';
  const surface = cs.getPropertyValue('--bg-surface').trim()    || '#252525';
  const border  = cs.getPropertyValue('--border-color').trim()  || '#333';
  const txt     = cs.getPropertyValue('--text-primary').trim()  || '#ddd';
  const muted   = cs.getPropertyValue('--text-muted').trim()    || '#888';

  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // Ruler
  ctx.fillStyle = '#00000022'; ctx.fillRect(HEADER_W, 0, W - HEADER_W, RULER_H);
  ctx.strokeStyle = border; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(HEADER_W, RULER_H); ctx.lineTo(W, RULER_H); ctx.stroke();

  const tickEvery = _pps >= 200 ? 0.25 : _pps >= 80 ? 0.5 : 1;
  ctx.fillStyle = muted; ctx.font = '9px monospace';
  for (let s = 0; s <= totalSec + tickEvery; s += tickEvery) {
    const x = HEADER_W + s * _pps;
    if (x > W) break;
    ctx.strokeStyle = s % 1 === 0 ? border : border + '66';
    ctx.lineWidth   = s % 1 === 0 ? 1 : 0.5;
    ctx.beginPath(); ctx.moveTo(x, RULER_H - (s % 1 === 0 ? 8 : 4)); ctx.lineTo(x, RULER_H); ctx.stroke();
    if (s % 1 === 0) ctx.fillText(s + 's', x + 2, RULER_H - 10);
  }

  // Step rows
  const unique = _uniqueRows();
  unique.forEach((row, ri) => {
    const y   = RULER_H + ri * TRACK_H;
    const label = row.label || row.action || '?';

    // Row header
    ctx.fillStyle = '#00000015';
    ctx.fillRect(0, y, HEADER_W, TRACK_H);
    ctx.fillStyle = txt; ctx.font = '10px sans-serif';
    ctx.fillText(_ellipsis(label, 10), 4, y + TRACK_H / 2 + 4);
    ctx.strokeStyle = border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + TRACK_H); ctx.lineTo(W, y + TRACK_H); ctx.stroke();

    // Vertical grid
    ctx.strokeStyle = border + '33'; ctx.lineWidth = 0.5;
    for (let s = 0; s <= totalSec + tickEvery; s += tickEvery) {
      const x = HEADER_W + s * _pps; if (x > W) break;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + TRACK_H); ctx.stroke();
    }
  });

  // Render blocks
  const sorted = [..._steps]
    .map((s, i) => ({ ...s, _origIdx: i }))
    .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

  sorted.forEach(step => {
    const ri  = unique.findIndex(r => r.key === _rowKey(step));
    if (ri < 0) return;
    const y   = RULER_H + ri * TRACK_H;
    const x   = HEADER_W + (step.startTime || 0) * _pps;
    const dur = _stepDuration(step);
    const bw  = Math.max(MIN_BLOCK_W, dur * _pps);
    const bh  = TRACK_H - 6;
    const by  = y + 3;
    const col = _stepColor(step, accent);
    const isDragging = _dragging && _dragging.stepIdx === step._origIdx;

    // Shadow when dragging
    if (isDragging) {
      ctx.shadowColor   = accent;
      ctx.shadowBlur    = 8;
    }
    _roundRect(ctx, x, by, bw, bh, 4);
    ctx.fillStyle = col + (isDragging ? 'ff' : 'cc');
    ctx.fill();
    ctx.shadowBlur = 0;

    // Block label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    const name = step.label || _stepLabel(step);
    ctx.fillText(_ellipsis(name, Math.floor(bw / 7)), x + 5, by + bh / 2 + 4);

    // Time badge
    ctx.fillStyle = '#fff8';
    ctx.font = '8px monospace';
    ctx.fillText((step.startTime || 0).toFixed(2) + 's', x + 5, by + bh - 3);
  });

  // Playhead
  if (_playing || _playhead > 0) {
    const phX = HEADER_W + _playhead * _pps;
    ctx.strokeStyle = '#e04040'; ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(phX, 0); ctx.lineTo(phX, H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e04040';
    ctx.beginPath(); ctx.moveTo(phX, RULER_H); ctx.lineTo(phX - 6, RULER_H - 10); ctx.lineTo(phX + 6, RULER_H - 10); ctx.closePath(); ctx.fill();
  }
}

// ─── PLAYBACK ────────────────────────────────────────────────

export function previewPlay(audioCtx) {
  if (_playing) previewStop(audioCtx);
  _playing   = true;
  _playhead  = 0;
  _playStart = audioCtx.currentTime;

  const sorted = [..._steps].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  sorted.forEach(step => {
    if (step.action !== 'play' && step.action) return;
    const targetId = step.targetId;
    if (!targetId) return;
    const sound = CItems().find(x => x.id === targetId);
    if (!sound) return;
    const slotIdx = sound.curSlot || 0;
    const buf   = APP.audioBuffers[bk(sound.id, slotIdx)] || APP.audioBuffers[bk(sound.id, 0)];
    if (!buf)   return;

    // Respect trim — same as playSound() in audio.js
    const slot = sound.slots?.[slotIdx] || sound.slots?.[0];
    const ts   = slot?.trimStart || 0;
    let   te   = slot?.trimEnd ?? buf.duration;
    if (te <= ts) te = buf.duration;
    const dur  = Math.max(0.01, te - ts);

    const src   = audioCtx.createBufferSource();
    src.buffer  = buf;
    src.playbackRate.value = sound.pitch || 1;
    const g     = audioCtx.createGain(); g.gain.value = sound.vol || 1;
    src.connect(g); g.connect(audioCtx.destination);
    src.start(audioCtx.currentTime + (step.startTime || 0), ts, dur);
    _scheduledSrcs.push(src);
  });

  function tick() {
    if (!_playing) return;
    _playhead = audioCtx.currentTime - _playStart;
    render();
    if (_playhead < _totalDuration() + 1) {
      _playRaf = requestAnimationFrame(tick);
    } else {
      previewStop(audioCtx);
    }
  }
  _playRaf = requestAnimationFrame(tick);
  render();
}

export function previewStop(audioCtx) {
  _playing = false;
  if (_playRaf) { cancelAnimationFrame(_playRaf); _playRaf = null; }
  _scheduledSrcs.forEach(s => { try { s.stop(); } catch(e) {} });
  _scheduledSrcs = [];
  _playhead = 0;
  render();
}

// ─── INTERACTION ─────────────────────────────────────────────

function _bindEvents() {
  if (!_canvas) return;
  const fresh = _canvas.cloneNode(true);
  _canvas.parentNode?.replaceChild(fresh, _canvas);
  _canvas = fresh;

  const scrollEl = _canvas.parentElement; // .macro-tl-scroll

  // ── Horizontal scroll via mouse wheel (Änderung 3) ───────────
  if (scrollEl) {
    // Remove and re-attach to avoid stacking listeners on modal re-open
    scrollEl._tlWheelHandler && scrollEl.removeEventListener('wheel', scrollEl._tlWheelHandler);
    scrollEl._tlWheelHandler = e => {
      // Only intercept horizontal or Shift+vertical scroll; let vertical pass through
      if (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
        // Pure vertical scroll — use for zoom like before, but only on the canvas
        if (e.target === _canvas) {
          e.preventDefault();
          setZoom(_pps + (e.deltaY < 0 ? 10 : -10));
        }
        return;
      }
      e.preventDefault();
      scrollEl.scrollLeft += e.shiftKey ? e.deltaY : e.deltaX;
    };
    scrollEl.addEventListener('wheel', scrollEl._tlWheelHandler, { passive: false });
  }

  // ── Drag-to-scroll on canvas background (Änderung 3) ────────
  let _panStart = null; // { clientX, scrollLeft }

  _canvas.addEventListener('pointerdown', e => {
    // Only start pan if we didn't hit a block
    const r  = _canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const si = _hitTest(cx, cy);
    if (si >= 0) {
      // Hit a block — delegate to drag logic below
      _canvas.setPointerCapture(e.pointerId);
      const step = _steps[si];
      const sec  = (cx - HEADER_W) / _pps;
      _dragging = { stepIdx: si, offsetSec: sec - (step.startTime || 0) };
      _canvas.style.cursor = 'grabbing';
      e.preventDefault();
    } else if (scrollEl && cx > HEADER_W) {
      // Empty area — start pan
      _canvas.setPointerCapture(e.pointerId);
      _panStart = { clientX: e.clientX, scrollLeft: scrollEl.scrollLeft };
      _canvas.style.cursor = 'grab';
      e.preventDefault();
    }
  });

  _canvas.addEventListener('pointermove', e => {
    if (_dragging) {
      const r      = _canvas.getBoundingClientRect();
      const cx     = e.clientX - r.left;
      let newStart = Math.max(0, (cx - HEADER_W) / _pps - _dragging.offsetSec);
      if (_snapMs > 0) {
        const snapSec = _snapMs / 1000;
        newStart = Math.round(newStart / snapSec) * snapSec;
      }
      _steps[_dragging.stepIdx].startTime = +Math.max(0, newStart).toFixed(3);
      render();
      e.preventDefault();
    } else if (_panStart) {
      const dx = e.clientX - _panStart.clientX;
      scrollEl.scrollLeft = _panStart.scrollLeft - dx;
      e.preventDefault();
    }
  });

  _canvas.addEventListener('pointerup', e => {
    if (_dragging) {
      _canvas.style.cursor = 'crosshair';
      _dragging = null;
      render();
    } else if (_panStart) {
      _panStart = null;
      _canvas.style.cursor = 'crosshair';
    }
    try { _canvas.releasePointerCapture(e.pointerId); } catch(_) {}
  });

  _canvas.addEventListener('pointercancel', e => {
    _dragging  = null;
    _panStart  = null;
    _canvas.style.cursor = 'crosshair';
    try { _canvas.releasePointerCapture(e.pointerId); } catch(_) {}
  });

  _canvas.addEventListener('contextmenu', e => { e.preventDefault(); _onRightClick(e); });
}


// ─── HIT TEST ────────────────────────────────────────────────

function _hitTest(cx, cy) {
  const unique = _uniqueRows();
  const sorted = [..._steps].map((s, i) => ({ ...s, _origIdx: i }));

  for (const step of sorted) {
    const ri = unique.findIndex(r => r.key === _rowKey(step));
    if (ri < 0) continue;
    const y  = RULER_H + ri * TRACK_H + 3;
    const x  = HEADER_W + (step.startTime || 0) * _pps;
    const bw = Math.max(MIN_BLOCK_W, _stepDuration(step) * _pps);
    const bh = TRACK_H - 6;
    if (cx >= x && cx <= x + bw && cy >= y && cy <= y + bh) return step._origIdx;
  }
  return -1;
}

// ─── HELPERS ─────────────────────────────────────────────────

function _totalDuration() {
  if (!_steps.length) return 4;
  return Math.max(4, ..._steps.map(s => (s.startTime || 0) + _stepDuration(s)));
}

function _stepDuration(step) {
  if (step.action === 'play' || !step.action) {
    const sound = CItems().find(x => x.id === step.targetId);
    if (sound) {
      const slotIdx = sound.curSlot || 0;
      const buf     = APP.audioBuffers[bk(sound.id, slotIdx)] || APP.audioBuffers[bk(sound.id, 0)];
      if (buf) {
        // Respect trimming — same logic as playSound() in audio.js
        const slot = sound.slots?.[slotIdx] || sound.slots?.[0];
        const ts   = slot?.trimStart || 0;
        const te   = (slot?.trimEnd != null && slot.trimEnd > ts) ? slot.trimEnd : buf.duration;
        return Math.max(0.01, te - ts);
      }
    }
    return 0.5;
  }
  if (step.action === 'fadeout') return (step.fadeDuration || 1000) / 1000;
  return 0.25;
}

function _rowKey(step) {
  if (step.action === 'volume')   return '_vol';
  if (step.action === 'stop_all') return '_stop';
  if (step.action === 'stop')     return '_stop_' + (step.targetId || '');
  return step.targetId || step.action || '_misc';
}

function _uniqueRows() {
  const seen = new Map();
  _steps.forEach(step => {
    const k = _rowKey(step);
    if (!seen.has(k)) {
      const label = step.action === 'volume' ? 'Volume' :
                    step.action === 'stop_all' ? 'Stop All' :
                    step.action === 'stop' ? 'Stop' :
                    (CItems().find(x => x.id === step.targetId)?.name || step.targetId || '?');
      seen.set(k, { key: k, label });
    }
  });
  return [...seen.values()];
}

function _calcHeight() {
  return RULER_H + Math.max(1, _uniqueRows().length) * TRACK_H + 4;
}

function _resize() {
  if (!_canvas) return;
  _canvas.style.height = _calcHeight() + 'px';
}

function _stepLabel(step) {
  if (step.action === 'volume')   return 'Vol';
  if (step.action === 'stop_all') return 'Stop All';
  if (step.action === 'stop')     return 'Stop';
  if (step.action === 'fadeout')  return 'Fade';
  const s = CItems().find(x => x.id === step.targetId);
  return s ? s.name : (step.action || '?');
}

function _stepColor(step, accent) {
  if (step.action === 'fadeout')  return '#e07b00';
  if (step.action === 'volume')   return '#2a9d99';
  if (step.action?.startsWith('stop')) return '#e04040';
  return accent;
}

function _ellipsis(str, maxChars) {
  return str.length <= maxChars ? str : str.slice(0, maxChars - 1) + '…';
}

function _roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2; if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
