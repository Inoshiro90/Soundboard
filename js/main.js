/**
 * main.js — App Entry Point (Stable Edition)
 *
 * BUGFIX: AudioContext is NEVER created on load.
 * _startMasterMeter() is deferred until first user interaction.
 */
import { load }                        from './storage.js';
import { registerEvents }              from './events.js';
import { renderGrid, renderProfileTabs, applyProfileSettings, syncThemeIcon } from './ui.js';
import { ensurePitchWorklet, actx, hasAudioContext } from './audio.js';
import { openDB }                      from './db.js';
import { undo, redo }                  from './history.js';
import { APP }                         from './state.js';

async function init() {
  await openDB();
  await load();  // No AudioContext created here

  renderProfileTabs();
  applyProfileSettings();
  renderGrid();
  syncThemeIcon();
  registerEvents();

  // Ctrl+Z / Ctrl+Y
  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  });

  // App mode switching
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      APP.appMode = mode;
      document.querySelectorAll('[data-mode]').forEach(b =>
        b.classList.toggle('btn--active', b.dataset.mode === mode));
      document.querySelectorAll('[data-view]').forEach(v => {
        v.style.display = v.dataset.view === mode ? '' : 'none';
      });
      if (mode === 'timeline') {
        import('./timeline.js').then(m => { m.renderTimeline(); m.initTimelineInteraction(); });
      }
    });
  });

  // BUGFIX: AudioContext + master meter only after first user gesture
  const _onFirstInteraction = async () => {
    const ctx = actx(); // safe to create now
    await ensurePitchWorklet();
    _startMasterMeter(ctx);
  };
  document.body.addEventListener('click',       _onFirstInteraction, { once: true });
  document.body.addEventListener('keydown',     _onFirstInteraction, { once: true });
  document.body.addEventListener('touchstart',  _onFirstInteraction, { once: true });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function _startMasterMeter(ctx) {
  // Connect a silent analyser to the destination — does NOT affect audio routing
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  // Do NOT connect analyser.connect(ctx.destination) — that would double the signal.
  // Instead we listen passively by creating a gain node that taps into destination.
  // Since we cannot tap destination in WebAudio, we approximate with a separate analyser
  // on a zero-gain node connected to destination (for meter visual only).
  const tap  = ctx.createGain(); tap.gain.value = 0; // silent
  tap.connect(ctx.destination);
  analyser.connect(tap);
  APP.masterBus._analyser = analyser;

  const data = new Uint8Array(analyser.fftSize);
  let _lastRaf = 0;
  function tick(ts) {
    // Throttle to ~30fps for performance
    if (ts - _lastRaf < 33) { requestAnimationFrame(tick); return; }
    _lastRaf = ts;
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const v = Math.abs((data[i] / 128) - 1); if (v > peak) peak = v; }
    APP.masterBus.peakL = peak; APP.masterBus.peakR = peak;
    const pct = (peak * 100).toFixed(1);
    const hue = 120 - peak * 120;
    const mL  = document.getElementById('meterBarL');
    const mR  = document.getElementById('meterBarR');
    if (mL) { mL.style.height = pct + '%'; mL.style.background = `hsl(${hue},80%,45%)`; }
    if (mR) { mR.style.height = pct + '%'; mR.style.background = `hsl(${hue},80%,45%)`; }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

init();
