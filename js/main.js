/**
 * main.js — App Entry Point
 *
 * AudioContext is never created on load.
 * startMasterMeter() (ui/meters.js) is deferred until first user interaction.
 */
import { load }                        from './storage/persistence.js';
import { registerEvents }              from './events/index.js';
import { renderGrid, initTileAddChoice } from './ui/grid.js';
import { renderProfileTabs, applyProfileSettings } from './ui/tabs.js';
import { syncThemeIcon } from './ui/icon-picker.js';
import { initSlotEditModal } from './ui/slot-editor.js';
import { ensurePitchWorklet, actx } from './audio/context.js';
import { openDB }                      from './db.js';
import { undo, redo }                  from './history.js';
import { APP }                         from './core/state.js';
import { registerAmbientEvents }       from './ambient/ambient-events.js';
import { registerMusicEvents }         from './music/music-events.js';
import { initDisclosure }              from './ui/disclosure.js';
import { hydrateIconSlots }            from './ui/icons.js';
import { initModalStack }              from './ui/modal-stack.js';
import { loadFragments }               from './fragmentLoader.js';
import { toast }                       from './notifications.js';
import { startMasterMeter }            from './ui/meters.js';

// Modal-Fragmente: alle beim Start laden und abwarten
const FRAGMENT_URLS = [
  'fragments/modals/sound-core.html',
  'fragments/modals/sound-fx.html',
  'fragments/modals/sound-fx-pipeline.html',
  'fragments/modals/slot-editing.html',
  'fragments/modals/ambient.html',
  'fragments/modals/music.html',
  'fragments/modals/shared.html',
  'fragments/modals/transfer.html',
];

async function init() {
  await openDB();
  await load();  // No AudioContext created here

  // Fragmente vollständig laden, BEVOR irgendein Code auf Modal-Markup zugreift.
  const { failed } = await loadFragments(FRAGMENT_URLS, '#fragment-root');
  // Ladefenster beendet: Modal-öffnende Toolbar-Buttons (in index.html per
  // [data-await-fragments] vorläufig gesperrt) wieder freigeben.
  document.querySelectorAll('[data-await-fragments]').forEach(b => {
    b.disabled = false;
    b.removeAttribute('data-await-fragments');
  });
  document.body.removeAttribute('aria-busy');
  if (failed.length) {
    // Details (Name, Pfad, Ursache) hat der Loader bereits in die Konsole geloggt.
    toast(`Teile der Oberfläche konnten nicht geladen werden (${failed.map(u => u.split('/').pop()).join(', ')})`, 'err');
  }

  renderProfileTabs();
  applyProfileSettings();
  renderGrid();
  syncThemeIcon();
  // Icon-Platzhalter der HTML-Fragmente (data-icon-slot) durch das zentrale Icon-System ersetzen.
  hydrateIconSlots();
  // Mehrere gleichzeitig offene Modals (z. B. Audio-Effekte → Preset speichern): z-index, Backdrop,
  // Fokus, Escape, Scroll-Lock — s. ui/modal-stack.js.
  initModalStack();
  registerEvents();
  registerAmbientEvents();
  registerMusicEvents();

  // Progressive-disclosure popovers (Einstellungen / Wiedergabe …).
  // Purely presentational — wraps existing controls, no state logic here.
  initDisclosure();
  // "+"-Kachel: gemeinsames Sound/Makro-Auswahl-Popover
  initTileAddChoice();
  initSlotEditModal();

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

  // AudioContext + master meter only after first user gesture
  const _onFirstInteraction = async () => {
    const ctx = actx(); // safe to create now
    await ensurePitchWorklet();
    startMasterMeter(ctx);   // Phase 6: Pegel des Master-Busses (B-08)
  };
  document.body.addEventListener('click',       _onFirstInteraction, { once: true });
  document.body.addEventListener('keydown',     _onFirstInteraction, { once: true });
  document.body.addEventListener('touchstart',  _onFirstInteraction, { once: true });

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

init();
