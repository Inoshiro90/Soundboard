/**
 * core/state.js — Zentraler Anwendungszustand (APP) + Ableitungsfunktionen
 * Ausgelagert aus dem ursprünglichen state.js (Phase 1 der Refaktorierung).
 * Statische Referenzdaten (Emoji-/Farbtabellen) liegen jetzt in js/data/.
 */

export const APP = {
  profiles: [],
  activeProfileId: null,
  globalSettings: {
    overlap: true, stopReplay: false, multiClick: true, masterVol: 1.0,
    // P2 Auto Duck: globale (nicht pro-Sound/-Szene) Absenkung der
    // Ambient-Ebene, solange mindestens ein Soundboard-Sound aktiv ist.
    // Siehe audio.js notifyDuckTrigger()/notifyDuckRelease() + ambient.js duckAmbient().
    autoDuck: { enabled: false, amount: 0.7, attack: 150, release: 500 }
  },
  audioBuffers: {},
  activeAudio:  {},
  editId: null, editSlots: [], loadingSlotIdx: null, _phReplacingId: null,
  editMacroId: null, macroSteps: [],
  editProfileId: null,
  hkTarget: null,
  activeCategory: 'all',
  trim: { slotIdx: null, buf: null, previewSrc: null, dragging: null,
           zoom: 1, scrollOffset: 0, playheadPos: null, _playRaf: null,
           clippingRegions: [] },
  // Phase 3
  analyzer:     { node: null, canvas: null, rafId: null, mode: 'bars', active: false },
  // Effekt-Editor-Preview (Audio-Effekt-Dialog): eigener, von der normalen
  // Soundboard-Wiedergabe (activeAudio/_setPlaying/Ducking/Rotation)
  // vollständig isolierter Lifecycle-State. `token` schützt gegen Race
  // Conditions zwischen einem laufenden async Decode/Graph-Aufbau und
  // einem zwischenzeitlichen Stop/Neustart (s. audio.js startEffectPreview()).
  audioPreview: {
    playing: false, loading: false,
    soundId: null, slotIdx: null,
    src: null, masterGain: null, analyser: null,
    token: 0
  },
  irCache:      {},
  idbReady:     false,
  pitchWorkletReady: false,
  // Phase 4
  history:      { stack: [], pointer: -1, maxSize: 50 },
  timeline:     {
    tracks:     [],          // [{ id, name, clips[], vol, pan, mute, solo }]
    playing:    false,
    playheadSec: 0,
    loopEnabled: false,
    loopStart:  0,
    loopEnd:    8,
    pixelsPerSec: 80,
    rafId:      null,
    startWallClock: null,
    startPlayhead:  0
  },
  appMode:      'soundboard',  // 'soundboard' | 'timeline' | 'lab'
  labSound:     null,          // sound currently in Audio Lab
  masterBus:    { limiterEnabled: true, threshold: -1, peakL: 0, peakR: 0, rafId: null },
  noiseProfile: null,          // Float32Array spectral floor for noise reduction
  // Sound-Effekte vs. Ambient-Szenen vs. Musikspuren — drei Ansichten,
  // per Mode-Toggle umschaltbar (siehe ambient.js: setViewMode()).
  viewMode: 'sound',           // 'sound' | 'ambient' | 'music'
  // Ambient: separate, independently looping background layer.
  // Organised into scene-profiles (Marktplatz, Höhle, …) — same tab pattern
  // as the sound-effect profiles. Several tracks within the active scene can
  // run in parallel; playback keeps going even when switching back to 'sound'.
  ambient: {
    profiles:        [],   // [{ id, name, icon, tracks: [{ id, name, icon, color, data, fileName, vol, loop, fadeIn, fadeOut }] }]
    activeProfileId: null,
    masterVol:       1.0
  },
  // Musikspuren: dritte, eigenständige Ansicht — im Unterschied zu Ambient
  // (mehrere parallele Loops) läuft hier normalerweise genau EIN Track
  // gleichzeitig, mit Playlist-Logik (Next/Previous/Shuffle/Repeat/
  // Crossfade/Seek), siehe js/music.js. Playback läuft unabhängig von der
  // sichtbaren Ansicht weiter (wie Ambient).
  music: {
    profiles:        [],   // [{ id, name, icon, tracks: [{ id, name, artist, album, icon, color, data, fileName, duration, vol, order }] }]
    activeProfileId: null,
    masterVol:       1.0,
    activeTrackId:   null, // zuletzt ausgewählter/laufender Track (für Reload-Restore)
    repeatMode:      'off', // 'off' | 'all' | 'one'
    shuffle:         false,
    crossfade:       2,     // Sekunden, 0 = harter Wechsel
    autoplay:        true   // automatischer Wechsel zum nächsten Track bei Ende
  },
  // Benutzerdefinierte Audio-Effekt-Presets (siehe js/presets.js). Getrennt
  // von den eingebauten Presets (presets/effect-presets-data.js EFFECT_PRESETS), damit Built-ins
  // nie versehentlich überschrieben/gelöscht werden können. Jeder Eintrag:
  // { id, name, category, description, effects, version, createdAt, updatedAt }.
  userPresets: []
};

export function CAP()      { return APP.ambient.profiles.find(p => p.id === APP.ambient.activeProfileId) || APP.ambient.profiles[0]; }
export function CATracks() { return CAP()?.tracks || []; }

export function CMP()      { return APP.music.profiles.find(p => p.id === APP.music.activeProfileId) || APP.music.profiles[0]; }
export function CMTracks() { return CMP()?.tracks || []; }

export function CP()       { return APP.profiles.find(p => p.id === APP.activeProfileId) || APP.profiles[0]; }
export function CItems()   { return CP()?.items || []; }
