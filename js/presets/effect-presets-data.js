/**
 * presets/effect-presets-data.js — Fest eingebaute Effekt-Presets (EFFECT_PRESETS)
 * Ausgelagert aus audio.js (Phase 1 der Refaktorierung). Reine Datentabelle,
 * keine Audio-Engine-Logik. Getrennt von benutzerdefinierten Presets (siehe
 * js/presets.js / APP.userPresets), damit Built-ins nie überschrieben werden.
 */

export const EFFECT_PRESETS = {
  cave:        { lowpass: { enabled: true, frequency: 4000, Q: 0.8 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.55, duration: 3.5, decay: 1.8 }, delay: { enabled: true, time: 0.08, feedback: 0.35, wet: 0.25 }, eq: { enabled: false, low: 0, mid: 0, high: 0 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'cave', wet: 0.60 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  behind_wall: { lowpass: { enabled: true, frequency: 350, Q: 1.2 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.25, duration: 0.4, decay: 3.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: false, low: 0, mid: 0, high: 0 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  tunnel:      { lowpass: { enabled: true, frequency: 6000, Q: 0.5 }, highpass: { enabled: true, frequency: 120, Q: 1.2 }, pan: 0, reverb: { enabled: true, amount: 0.45, duration: 1.8, decay: 2.2 }, delay: { enabled: true, time: 0.15, feedback: 0.50, wet: 0.35 }, eq: { enabled: false, low: 0, mid: 0, high: 0 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'tunnel', wet: 0.50 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  bathroom:    { lowpass: { enabled: false, frequency: 20000, Q: 0.7 }, highpass: { enabled: true, frequency: 200, Q: 0.5 }, pan: 0, reverb: { enabled: true, amount: 0.60, duration: 0.8, decay: 3.5 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: false, low: 0, mid: 0, high: 0 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'bathroom', wet: 0.55 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  metal_room:  { lowpass: { enabled: false, frequency: 20000, Q: 0.7 }, highpass: { enabled: true, frequency: 400, Q: 1.5 }, pan: 0, reverb: { enabled: true, amount: 0.50, duration: 1.0, decay: 4.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -3, mid: 4, high: 6 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  phone:       { lowpass: { enabled: true, frequency: 3400, Q: 1.5 }, highpass: { enabled: true, frequency: 300, Q: 0.9 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -6, mid: 3, high: -4 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -18, knee: 20, ratio: 8, attack: 0.002, release: 0.15 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 15, oversample: '2x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  underwater:  { lowpass: { enabled: true, frequency: 220, Q: 2.0 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.40, duration: 1.2, decay: 1.5 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: 6, mid: -8, high: -12 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  radio:       { lowpass: { enabled: true, frequency: 3200, Q: 1.2 }, highpass: { enabled: true, frequency: 250, Q: 0.9 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -8, mid: 5, high: -6 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -20, knee: 15, ratio: 10, attack: 0.002, release: 0.12 }, limiter: { enabled: true, threshold: -2, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 25, oversample: '2x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  lofi:        { lowpass: { enabled: true, frequency: 4500, Q: 0.8 }, highpass: { enabled: true, frequency: 80, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.15, duration: 0.6, decay: 2.5 }, delay: { enabled: true, time: 0.12, feedback: 0.20, wet: 0.15 }, eq: { enabled: true, low: 4, mid: -2, high: -8 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -22, knee: 25, ratio: 6, attack: 0.010, release: 0.40 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 20, oversample: 'none' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  megaphone:   { lowpass: { enabled: true, frequency: 4000, Q: 1.8 }, highpass: { enabled: true, frequency: 500, Q: 1.5 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -10, mid: 8, high: -5 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -12, knee: 5, ratio: 15, attack: 0.001, release: 0.10 }, limiter: { enabled: true, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 45, oversample: '2x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  monster:     { lowpass: { enabled: true, frequency: 8000, Q: 0.6 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.40, duration: 2.0, decay: 1.5 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: 12, mid: -4, high: -6 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -16, knee: 20, ratio: 8, attack: 0.005, release: 0.30 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 55, oversample: '4x' }, pitchShift: { enabled: true, semitones: -5 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  dark_cave:   { lowpass: { enabled: true, frequency: 2500, Q: 0.7 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.75, duration: 5.0, decay: 1.2 }, delay: { enabled: true, time: 0.12, feedback: 0.50, wet: 0.30 }, eq: { enabled: true, low: 3, mid: -5, high: -10 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'cave', wet: 0.75 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  huge_hall:   { lowpass: { enabled: false, frequency: 20000, Q: 0.7 }, highpass: { enabled: true, frequency: 60, Q: 0.5 }, pan: 0, reverb: { enabled: true, amount: 0.85, duration: 4.5, decay: 1.0 }, delay: { enabled: true, time: 0.20, feedback: 0.45, wet: 0.35 }, eq: { enabled: true, low: -2, mid: 0, high: 3 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -28, knee: 40, ratio: 4, attack: 0.010, release: 0.50 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'huge_hall', wet: 0.80 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  vintage_tape:{ lowpass: { enabled: true, frequency: 8000, Q: 0.6 }, highpass: { enabled: true, frequency: 60, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.12, duration: 0.5, decay: 3.0 }, delay: { enabled: true, time: 0.08, feedback: 0.15, wet: 0.10 }, eq: { enabled: true, low: 3, mid: -1, high: -5 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -18, knee: 30, ratio: 5, attack: 0.012, release: 0.45 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 12, oversample: 'none' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'plate', wet: 0.15 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  tight_room:  { lowpass: { enabled: false, frequency: 20000, Q: 0.7 }, highpass: { enabled: true, frequency: 100, Q: 0.8 }, pan: 0, reverb: { enabled: true, amount: 0.25, duration: 0.35, decay: 4.5 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -2, mid: 2, high: 1 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -20, knee: 20, ratio: 6, attack: 0.004, release: 0.20 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'tight_room', wet: 0.30 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  dreamy_echo: { lowpass: { enabled: true, frequency: 9000, Q: 0.5 }, highpass: { enabled: false, frequency: 20, Q: 0.7 }, pan: 0, reverb: { enabled: true, amount: 0.55, duration: 2.8, decay: 1.8 }, delay: { enabled: true, time: 0.33, feedback: 0.55, wet: 0.45 }, eq: { enabled: true, low: 2, mid: -3, high: 4 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 }, limiter: { enabled: false, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: false, amount: 0, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: true, impulse: 'hallway', wet: 0.40 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },
  broken_speaker:{ lowpass: { enabled: true, frequency: 6000, Q: 2.5 }, highpass: { enabled: true, frequency: 150, Q: 2.0 }, pan: 0, reverb: { enabled: false, amount: 0.10, duration: 0.3, decay: 2.0 }, delay: { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 }, eq: { enabled: true, low: -5, mid: 10, high: -8 }, eq10: { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] }, compressor: { enabled: true, threshold: -10, knee: 5, ratio: 20, attack: 0.001, release: 0.05 }, limiter: { enabled: true, threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.08 }, distortion: { enabled: true, amount: 80, oversample: '4x' }, pitchShift: { enabled: false, semitones: 0 }, irReverb: { enabled: false, impulse: null, wet: 0.35 }, envelope: { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 }, spatial: { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }, noiseGate: { enabled: false, threshold: -50 } },

  // ── Erweiterung (Preset-Bibliothek Kap. 22): akustisch eigenständige,
  // nicht-redundante Transformationen, die zugleich bislang von keinem
  // Preset genutzte Effektmodule sinnvoll einsetzen (ringmod, notch,
  // wahwah, chorus, flanger, tremolo, envelope, spatial). Nur die hier
  // gesetzten Felder weichen vom Default ab — fehlende Module werden von
  // der generischen Preset-Anwendung (presets.js applyPresetEffects())
  // automatisch mit defaultEffects() aufgefüllt, exakt wie bei den 17
  // bestehenden Presets oben. Metadaten (Name/Kategorie/Beschreibung)
  // stehen in presets.js (BUILTIN_PRESET_META), nicht hier — reine
  // Effektparameter bleiben, wie bei den bestehenden Presets, hier in
  // audio.js (Audio-Engine-Zuständigkeit).
  possessed: {
    lowpass:    { enabled: true,  frequency: 7000, Q: 0.8 },
    notch:      { enabled: true,  frequency: 1000, Q: 8 },
    ringmod:    { enabled: true,  frequency: 55,   mix: 0.35 },
    distortion: { enabled: true,  mode: 'hardClip', amount: 20, oversample: '2x' },
    pitchShift: { enabled: true,  semitones: -3 },
    reverb:     { enabled: true,  amount: 0.30, duration: 1.2, decay: 2.0 }
  },
  portal_warp: {
    wahwah:     { enabled: true, frequency: 600, depth: 0.8, rate: 3.5, resonance: 8 },
    flanger:    { enabled: true, baseDelay: 2, depth: 2, rate: 0.4, feedback: 0.6, mix: 0.6 },
    pitchShift: { enabled: true, semitones: 2 },
    reverb:     { enabled: true, amount: 0.40, duration: 1.5, decay: 2.0 }
  },
  phantom_choir: {
    chorus:     { enabled: true, baseDelay: 20, depth: 10, rate: 0.6, mix: 0.45 },
    highpass:   { enabled: true, frequency: 300, Q: 0.7 },
    pitchShift: { enabled: true, semitones: 1 },
    irReverb:   { enabled: true, impulse: 'cathedral', wet: 0.55 }
  },
  signal_dropout: {
    highpass:   { enabled: true, frequency: 400,  Q: 0.9 },
    lowpass:    { enabled: true, frequency: 3000, Q: 0.7 },
    tremolo:    { enabled: true, rate: 7, depth: 0.8, waveform: 'square' },
    distortion: { enabled: true, mode: 'bitcrush', amount: 45, oversample: 'none' },
    noiseGate:  { enabled: true, threshold: -35 }
  },
  distant: {
    lowpass: { enabled: true, frequency: 1800, Q: 0.6 },
    eq:      { enabled: true, low: -2, mid: -3, high: -6 },
    reverb:  { enabled: true, amount: 0.20, duration: 1.0, decay: 1.5 },
    spatial: { enabled: true, x: 0, y: 0, z: -6, rolloff: 2, maxDistance: 60, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }
  },
  dying_breath: {
    envelope:   { enabled: true, attack: 0.25, decay: 0.4, sustain: 0.6, release: 1.2 },
    pitchShift: { enabled: true, semitones: -2 },
    lowpass:    { enabled: true, frequency: 3500, Q: 0.7 },
    reverb:     { enabled: true, amount: 0.45, duration: 3.0, decay: 1.5 }
  },

  // ── Erweiterung Runde 2 (Nutzer-Vorlage, Kap. 22): 17 weitere Presets.
  // WICHTIG: Die Vorlage beschreibt teils Effekte, die es in dieser
  // Audio-Engine nicht gibt (echte Bandpass-/Peaking-/Highshelf-Filter,
  // Oszillatoren/Rauschgeneratoren, Stereo-Haas-Delay mit getrennten L/R-
  // Zeiten, Multi-Tap-Delay, Auto-Pan-LFO, Phaser, parallele Pitch-Kopien,
  // benutzerdefinierte AudioWorklets). Diese wurden NICHT nachgebaut,
  // sondern mit den tatsächlich vorhandenen Modulen klanglich angenähert:
  // Bandpass  -> highpass+lowpass eng gestapelt
  // Peaking/Highshelf -> eq10-Band möglichst nah an der Zielfrequenz
  // Phaser    -> wahwah (LFO-modulierter Filter) mit sehr langsamer Rate
  // Haas/Stereo-Delay -> chorus (kurze modulierte Verzögerung = Breite)
  // Multi-Tap/parallele Pitch-Kopien -> chorus (mehrstimmiger Eindruck)
  // Oszillator/Rauschen/Worklets -> ringmod (Ring-Artefakt) bzw. weggelassen
  // Gain-Boost/-Reduction -> eq/eq10 (kein separater Ausgangsgain im Preset)
  // Siehe presets.js BUILTIN_PRESET_META für Namen/Kategorie/Beschreibung.
  cathedral_sanctum: {
    lowpass:  { enabled: true, frequency: 12000, Q: 0.7 },
    highpass: { enabled: true, frequency: 80, Q: 0.7 },
    reverb:   { enabled: true, amount: 0.60, duration: 6.0, decay: 0.9 },
    irReverb: { enabled: true, impulse: 'cathedral', wet: 0.55 }
  },
  narrow_vent: {
    highpass: { enabled: true, frequency: 700, Q: 2.0 },
    lowpass:  { enabled: true, frequency: 1400, Q: 2.0 },
    reverb:   { enabled: true, amount: 0.30, duration: 0.3, decay: 3.0 },
    flanger:  { enabled: true, baseDelay: 2, depth: 1.5, rate: 8, feedback: 0.5, mix: 0.4 },
    eq10:     { enabled: true, bands: [0, 0, 0, 0, 0, 4, 0, 0, 0, 0] }
  },
  endless_abyss: {
    lowpass:  { enabled: true, frequency: 3000, Q: 0.6 },
    highpass: { enabled: true, frequency: 120, Q: 0.7 },
    reverb:   { enabled: true, amount: 0.70, duration: 8.0, decay: 0.8 },
    delay:    { enabled: true, time: 0.45, feedback: 0.65, wet: 0.40 },
    eq:       { enabled: true, low: 2, mid: -4, high: -8 }
  },
  heavy_barricade: {
    lowpass:    { enabled: true, frequency: 250, Q: 1.0 },
    distortion: { enabled: true, mode: 'softClip', amount: 15, oversample: '2x' }
  },
  dense_canopy: {
    lowpass:    { enabled: true, frequency: 2000, Q: 0.7 },
    highpass:   { enabled: true, frequency: 120, Q: 0.7 },
    reverb:     { enabled: true, amount: 0.08, duration: 0.4, decay: 3.0 },
    compressor: { enabled: true, threshold: -24, knee: 10, ratio: 4, attack: 0.01, release: 0.3 }
  },
  distant_horizon: {
    lowpass: { enabled: true, frequency: 4000, Q: 0.8 },
    delay:   { enabled: true, time: 0.6, feedback: 0.30, wet: 0.25 },
    eq:      { enabled: true, low: 0, mid: -2, high: -6 },
    spatial: { enabled: true, x: 0, y: 0, z: -8, rolloff: 2.5, maxDistance: 80, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 }
  },
  intercom_bunker: {
    lowpass:    { enabled: true, frequency: 3500, Q: 1.2 },
    highpass:   { enabled: true, frequency: 400, Q: 0.9 },
    delay:      { enabled: true, time: 0.045, feedback: 0.15, wet: 0.30 },
    distortion: { enabled: true, mode: 'hardClip', amount: 35, oversample: '2x' },
    compressor: { enabled: true, threshold: -16, knee: 10, ratio: 10, attack: 0.002, release: 0.15 }
  },
  surveillance_bug: {
    highpass:   { enabled: true, frequency: 1000, Q: 2.0 },
    lowpass:    { enabled: true, frequency: 6000, Q: 0.7 },
    compressor: { enabled: true, threshold: -30, knee: 5, ratio: 15, attack: 0.001, release: 0.1 },
    limiter:    { enabled: true, threshold: -6, knee: 0, ratio: 20, attack: 0.001, release: 0.05 },
    noiseGate:  { enabled: true, threshold: -45 }
  },
  phonograph_horn: {
    highpass:   { enabled: true, frequency: 500, Q: 1.5 },
    lowpass:    { enabled: true, frequency: 2800, Q: 1.8 },
    distortion: { enabled: true, mode: 'bitcrush', amount: 35, oversample: 'none' },
    tremolo:    { enabled: true, rate: 0.5, depth: 0.25, waveform: 'sine' },
    eq:         { enabled: true, low: -6, mid: 6, high: -10 }
  },
  ear_ringing: {
    lowpass:   { enabled: true, frequency: 150, Q: 0.7 },
    ringmod:   { enabled: true, frequency: 3800, mix: 0.15 },
    noiseGate: { enabled: true, threshold: -40 }
  },
  drunk_dizzy: {
    reverb: { enabled: true, amount: 0.30, duration: 2.5, decay: 1.8 },
    wahwah: { enabled: true, frequency: 800, depth: 0.5, rate: 0.2, resonance: 4 }
  },
  asphyxiation: {
    highpass: { enabled: true, frequency: 200, Q: 0.7 },
    eq10:     { enabled: true, bands: [0, 0, 0, 0, 6, 0, 0, 0, 0, 0] },
    reverb:   { enabled: true, amount: 0.45, duration: 0.2, decay: 5.0 }
  },
  mind_control: {
    chorus:     { enabled: true, baseDelay: 15, depth: 8, rate: 0.3, mix: 0.6 },
    compressor: { enabled: true, threshold: -10, knee: 3, ratio: 12, attack: 0.001, release: 0.08 }
  },
  shadow_realm: {
    eq:         { enabled: true, low: 2, mid: -2, high: -6 },
    reverb:     { enabled: true, amount: 0.45, duration: 5.0, decay: 1.1 },
    chorus:     { enabled: true, baseDelay: 18, depth: 12, rate: 1.5, mix: 0.35 },
    pitchShift: { enabled: true, semitones: -2 }
  },
  fairy_pixie: {
    highpass:   { enabled: true, frequency: 300, Q: 0.7 },
    eq10:       { enabled: true, bands: [0, 0, 0, 0, 0, 0, 0, 0, 5, 0] },
    reverb:     { enabled: true, amount: 0.20, duration: 1.2, decay: 2.0 },
    pitchShift: { enabled: true, semitones: 7 }
  },
  hive_mind: {
    eq:      { enabled: true, low: -3, mid: 4, high: 3 },
    flanger: { enabled: true, baseDelay: 1, depth: 1.5, rate: 14, feedback: 0.4, mix: 0.5 },
    chorus:  { enabled: true, baseDelay: 10, depth: 6, rate: 2, mix: 0.4 },
    delay:   { enabled: true, time: 0.045, feedback: 0.25, wet: 0.30 }
  },
  stone_statue: {
    eq10:       { enabled: true, bands: [0, 0, 8, 0, 0, 0, 0, 0, 0, 0] },
    compressor: { enabled: true, threshold: -14, knee: 4, ratio: 10, attack: 0.001, release: 0.12 },
    reverb:     { enabled: true, amount: 0.35, duration: 0.6, decay: 2.5 },
    delay:      { enabled: true, time: 0.035, feedback: 0.30, wet: 0.25 },
    pitchShift: { enabled: true, semitones: -4 }
  }
};
