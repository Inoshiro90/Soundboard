/**
 * events/register-toolbar-events.js — Profil-Wechsel, Hotkey-Aufnahme,
 * Sammlungs-Preset-Anwendung (Profil-/Szenen-/Playlist-Modal), Audio-Effekt-
 * View-Toolbar-Buttons
 */

import { APP, CP, CAP, CMP } from '../core/state.js';
import { hotkeyStr } from '../utils.js';
import { toast } from '../notifications.js';
import { iconSvg } from '../ui/icons.js';
import { stopAll } from '../audio/playback.js';
import { applyPresetToCollection } from '../presets.js';
import { _saveRaw } from '../storage/persistence.js';
import { renderGrid } from '../ui/grid.js';
import { renderProfileTabs, applyProfileSettings, renderPresetOptions } from '../ui/tabs.js';
import { persistAmbientNow } from '../ambient/ambient-model.js';
import { renderAmbientPanel } from '../ambient/ambient-render.js';
import { persistMusicNow } from '../music/music-model.js';
import { renderMusicPanel } from '../music/music-render.js';

// ─── PROFILE SWITCH ───────────────────────────────────────────

export function switchProfile(id) {
  stopAll();
  APP.activeProfileId = id;
  APP.activeCategory  = 'all';
  renderProfileTabs();
  applyProfileSettings();
  renderGrid();
}


// ─── HOTKEY RECORDING ─────────────────────────────────────────

export function handleHotkeyRecord(e) {
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


// ─── AUDIO-EFFEKT-PRESET AUF SAMMLUNG ANWENDEN ─────────────
// Eine einzige, gemeinsame UI-Verdrahtung für den "Audio-Effekte"-Bereich in
// #profModal/#ambProfModal/#musicProfileModal (Preset-Dropdown +
// Alle/Gleiche/Keine-Modusauswahl + "Anwenden"-Button), statt die Logik dreimal zu
// duplizieren. Die eigentliche Anwendungslogik steckt zentral in
// applyPresetToCollection() (presets.js); diese Funktion kümmert sich nur um die
// DOM-Verdrahtung.
// ─── MODUS-ERKLÄRUNG (Alle / Gleiche / Keine) ──────────────────
// Einzige Quelle für Beschriftung und Erklärung der drei Modi — Sound-, Ambient- und Musik-Toolbar
// rendern sie über _wireAudioEffectPresetSection() aus DIESER Tabelle (nur das Nomen unterscheidet
// sich). Die Semantik selbst liegt unverändert in applyPresetToCollection() (presets.js).
export const FX_APPLY_MODES = [
  { mode: 'all',  label: 'Alle',
    text: n => `Preset auf alle ${n} anwenden – bereits vorhandene Presets werden überschrieben.` },
  { mode: 'same', label: 'Gleiche',
    text: n => `${n} ohne Preset erhalten es; ${n} mit genau diesem Preset werden neu abgeglichen. Andere Presets bleiben unverändert.` },
  { mode: 'none', label: 'Keine',
    text: n => `Nur ${n} ändern, die noch kein Preset haben. Vorhandene Presets bleiben unverändert.` }
];
export const FX_APPLY_MODES_GROUP_LABEL = 'Umgang mit bereits vorhandenen Presets';

/**
 * Ergänzt die (in den Fragmenten statisch vorhandene) Modus-Buttongruppe um die Erklärung:
 *  - sichtbare Legende mit je einer Zeile pro Modus (Name + Satz), aktiver Modus mit Haken + fett
 *    (nicht nur Farbe) und aria-current,
 *  - Haken-Symbol im aktiven Button (zusätzlich zu .is-active/aria-pressed),
 *  - Tooltip (title) und aria-describedby auf jedem Button, Gruppenbeschriftung.
 * Idempotent pro Gruppe. Gibt eine Funktion zurück, die die Legende zum aktiven Modus synchronisiert.
 */
function _renderModeExplanation(group, nounPlural) {
  if (!group) return () => {};
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', FX_APPLY_MODES_GROUP_LABEL);
  let legend = group.nextElementSibling;
  if (!legend || !legend.classList.contains('fx-mode-legend')) {
    legend = document.createElement('ul');
    legend.className = 'fx-mode-legend';
    legend.id = `${group.id}Legend`;
    legend.innerHTML = FX_APPLY_MODES.map(m => `
      <li class="fx-mode-legend__item" data-mode="${m.mode}" id="${group.id}Desc-${m.mode}">
        <span class="fx-mode-legend__mark" aria-hidden="true">${iconSvg('check')}</span>
        <span class="fx-mode-legend__name">${m.label}</span>
        <span class="fx-mode-legend__text"></span>
      </li>`).join('');
    group.insertAdjacentElement('afterend', legend);
  }
  FX_APPLY_MODES.forEach(m => {
    const text = m.text(nounPlural);
    const li = legend.querySelector(`[data-mode="${m.mode}"]`);
    if (li) li.querySelector('.fx-mode-legend__text').textContent = text;
    const btn = group.querySelector(`button[data-mode="${m.mode}"]`);
    if (btn) {
      btn.title = `${m.label}: ${text}`;
      btn.setAttribute('aria-describedby', `${group.id}Desc-${m.mode}`);
      if (!btn.querySelector('.fx-mode-check')) btn.insertAdjacentHTML('beforeend', `<span class="fx-mode-check" aria-hidden="true">${iconSvg('check')}</span>`);
    }
  });
  return activeMode => legend.querySelectorAll('.fx-mode-legend__item').forEach(li => {
    const on = li.dataset.mode === activeMode;
    li.classList.toggle('is-active', on);
    if (on) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
  });
}

export function _wireAudioEffectPresetSection({ selectId, groupId, applyBtnId, getItems, persist, itemLabel }) {
  const sel      = document.getElementById(selectId);
  const group    = document.getElementById(groupId);
  const applyBtn = document.getElementById(applyBtnId);
  let mode = 'none'; // Default ist immer "Keine"

  const syncLegend = _renderModeExplanation(group, itemLabel);
  const setMode = (m) => {
    mode = m;
    group?.querySelectorAll('button[data-mode]').forEach(b => {
      const active = b.dataset.mode === m;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    syncLegend(m);
  };
  setMode(mode);

  group?.querySelectorAll('button[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Das "übergeordnete" Preset dieses Profils/dieser Szene/Playlist wird live bei jeder
  // Auswahländerung gesichert (persist() liest den aktuellen sel.value und schreibt ihn auf
  // das AKTIVE Profil, s. die drei Instanzen unten). Der Dialog hat bewusst nur einen
  // "Fertig"-Button, analog zu den Lautstärke-Dialogen.
  sel?.addEventListener('change', () => persist());

  applyBtn?.addEventListener('click', () => {
    const presetId = sel?.value || null;
    if (!presetId) { toast('Bitte zuerst ein Preset auswählen', 'err'); return; }
    const items = getItems();
    const { changed, total } = applyPresetToCollection({ items, presetId, overwriteMode: mode });
    persist();
    const modeLbl = FX_APPLY_MODES.find(x => x.mode === mode)?.label || 'Keine';
    toast(`Preset auf ${changed} von ${total} ${itemLabel} angewendet (Modus „${modeLbl}“)`, 'ok');
  });

  return {
    // Bei JEDEM Öffnen des Anwenden-Bereichs zurückgesetzt — sowohl die Preset-Auswahl
    // (auf das gespeicherte audioEffectPreset; fällt bei einem gelöschten Preset automatisch
    // auf "Kein Preset" zurück) als auch der Modus (immer "Keine").
    reset(currentPresetId) {
      renderPresetOptions(sel, currentPresetId || '');
      setMode('none');
    }
  };
}

// Modulweite Instanzen — als `let`-Live-Bindings deklariert und erst in
// registerToolbarEvents() befüllt: die referenzierten Elemente (#profFxPreset,
// #ambProfFxPreset, #musicProfFxPreset, *ModeGroup, *ApplyBtn) liegen in
// fragments/modals/*.html und existieren beim Auswerten dieses Moduls (Import-Zeit,
// vor loadFragments()) noch NICHT. openSoundFxToolbar()/openAmbientFxToolbar()/
// openMusicFxToolbar() (s.u.) greifen erst nach der Registrierung darauf zu.
//
// getItems() liest das AKTIVE Profil/Szene/Playlist (via CP()/CAP()/CMP()).
export let _profFxSection = null;
export let _ambProfFxSection = null;
export let _musicProfFxSection = null;

export function registerToolbarEvents() {
  _profFxSection = _wireAudioEffectPresetSection({
    selectId: 'profFxPreset', groupId: 'profFxModeGroup', applyBtnId: 'profFxApplyBtn',
    // Nur `type === 'sound'` — Placeholder/Makros sind kein Audio.
    getItems: () => {
      const p = CP();
      return p ? p.items.filter(it => it.type === 'sound') : [];
    },
    persist: () => {
      const p = CP();
      if (p) p.audioEffectPreset = document.getElementById('profFxPreset')?.value || null;
      _saveRaw(); renderGrid();
    },
    itemLabel: 'Sounds'
  });

  _ambProfFxSection = _wireAudioEffectPresetSection({
    selectId: 'ambProfFxPreset', groupId: 'ambProfFxModeGroup', applyBtnId: 'ambProfFxApplyBtn',
    // Alle enthaltenen Ambient-Tracks, unabhängig von der Anzahl
    // ihrer Audiodateien (t.effects ist unabhängig von t.files).
    getItems: () => {
      const p = CAP();
      return p ? (p.tracks || []) : [];
    },
    persist: () => {
      const p = CAP();
      if (p) p.audioEffectPreset = document.getElementById('ambProfFxPreset')?.value || null;
      persistAmbientNow(); renderAmbientPanel();
    },
    itemLabel: 'Ambient-Tracks'
  });

  _musicProfFxSection = _wireAudioEffectPresetSection({
    selectId: 'musicProfFxPreset', groupId: 'musicProfFxModeGroup', applyBtnId: 'musicProfFxApplyBtn',
    // Nur effects wird geändert — Name/Artist/Album/Icon/Farbe/
    // Lautstärke/Trim/Order der Tracks bleiben unangetastet.
    getItems: () => {
      const p = CMP();
      return p ? (p.tracks || []) : [];
    },
    persist: () => {
      const p = CMP();
      if (p) p.audioEffectPreset = document.getElementById('musicProfFxPreset')?.value || null;
      persistMusicNow(); renderMusicPanel();
    },
    itemLabel: 'Musik-Tracks'
  });
}


// ─── AUDIO-EFFEKTE: VIEW-TOOLBAR-BUTTONS ────────────
// Öffnen die Audio-Effekte-Dialoge für den jeweils AKTIVEN Kontext.
// CP()/CAP()/CMP() fallen bei fehlender/ungültiger activeProfileId bereits
// auf profiles[0] zurück (core/state.js) — ein "kein aktives Profil"-Fall kann
// daher nur eintreten, wenn eine Sammlung komplett leer ist (sollte durch
// ensureAmbientState()/ensureMusicState() nicht vorkommen, wird hier aber
// dennoch defensiv abgefangen statt einen Fehler zu werfen).
export function openSoundFxToolbar() {
  const p = CP();
  if (!p) { toast('Kein Soundeffekt-Profil vorhanden', 'err'); return; }
  const label = document.getElementById('soundFxToolbarActiveLabel');
  if (label) label.textContent = `Profil: ${p.icon || ''} ${p.name}`.trim();
  _profFxSection.reset(p.audioEffectPreset);
  new bootstrap.Modal(document.getElementById('soundFxToolbarModal')).show();
}

export function openAmbientFxToolbar() {
  const p = CAP();
  if (!p) { toast('Keine Ambient-Szene vorhanden', 'err'); return; }
  const label = document.getElementById('ambientFxToolbarActiveLabel');
  if (label) label.textContent = `Szene: ${p.icon || ''} ${p.name}`.trim();
  _ambProfFxSection.reset(p.audioEffectPreset);
  new bootstrap.Modal(document.getElementById('ambientFxToolbarModal')).show();
}

export function openMusicFxToolbar() {
  const p = CMP();
  if (!p) { toast('Keine Musik-Playlist vorhanden', 'err'); return; }
  const label = document.getElementById('musicFxToolbarActiveLabel');
  if (label) label.textContent = `Playlist: ${p.icon || ''} ${p.name}`.trim();
  _musicProfFxSection.reset(p.audioEffectPreset);
  new bootstrap.Modal(document.getElementById('musicFxToolbarModal')).show();
}

