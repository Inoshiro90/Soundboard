/**
 * audio/effect-graph.js — Effekt-Graph-Konstruktion (zustandslos)
 * Ausgelagert aus audio.js (Phase 3 der Refaktorierung). Enthält die reinen
 * Knoten-Builder (_build*), buildEffectChain/buildPitchNode sowie die
 * Default-Datenmodelle für Effekte/Wiedergabeparameter.
 */

import { _pitchWorkletReadyContexts } from './context.js';
import { _buildIR, getIRBuffer } from './ir-data.js';

// ─── DEFAULT EFFECTS ─────────────────────────────────────────

export function defaultEffects() {
  return {
    enabled: false, preset: null,
    lowpass:  { enabled: false, frequency: 20000, Q: 0.7 },
    highpass: { enabled: false, frequency: 20,    Q: 0.7 },
    notch:    { enabled: false, frequency: 50, Q: 10 },
    wahwah:   { enabled: false, frequency: 800, depth: 0.7, rate: 2, resonance: 5 },
    pan: 0,
    reverb:   { enabled: false, amount: 0.35, duration: 2.2, decay: 2.0 },
    delay:    { enabled: false, time: 0.22, feedback: 0.35, wet: 0.35 },
    chorus:   { enabled: false, baseDelay: 15, depth: 8,   rate: 0.8, mix: 0.3 },
    flanger:  { enabled: false, baseDelay: 2,  depth: 1.5, rate: 0.2, feedback: 0.5, mix: 0.5 },
    tremolo:  { enabled: false, rate: 5, depth: 0.5, waveform: 'sine' },
    eq:       { enabled: false, low: 0, mid: 0, high: 0 },
    eq10:     { enabled: false, bands: [0,0,0,0,0,0,0,0,0,0] },
    compressor: { enabled: false, threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
    limiter:    { enabled: false, threshold: -1,  knee: 0,  ratio: 20, attack: 0.001, release: 0.08 },
    // mode: P2-Erweiterung (softClip = bisheriges, unverändertes Verhalten;
    // hardClip/bitcrush neu). Presets ohne "mode"-Feld fallen über den
    // switch-default in _buildDistortionCurve() weiterhin auf softClip
    // zurück — kein Migrationsschritt für bestehende Presets nötig.
    distortion: { enabled: false, mode: 'softClip', amount: 40, oversample: '4x' },
    ringmod:    { enabled: false, frequency: 440, mix: 1 },
    pitchShift: { enabled: false, semitones: 0 },
    irReverb:   { enabled: false, impulse: null, wet: 0.35 },
    envelope:   { enabled: false, attack: 0.01, decay: 0.15, sustain: 0.8, release: 0.25 },
    analyzer:   { enabled: false },
    spatial:    { enabled: false, x: 0, y: 0, z: -1, rolloff: 1, maxDistance: 10000, refDistance: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0 },
    // attack/release: Stufe-A-Compressor-Approximation (siehe buildEffectChain).
    // Bestehende Presets ohne diese Felder funktionieren unverändert weiter,
    // da buildEffectChain() sie mit `?? 5`/`?? 150` defaultet.
    noiseGate:  { enabled: false, threshold: -50, attack: 5, release: 150 }
  };
}

/**
 * "Wiedergabe & Verhalten": nicht-destruktive Wiedergabeparameter eines
 * Sounds — im Gegensatz zu slot.fadeIn/slot.fadeOut (dauerhafte, im Editor
 * gebrannte Bearbeitung, s. editor.js editFadeIn()/editFadeOut()) verändern
 * diese Werte nie die gespeicherte Audiodatei, sondern werden erst beim
 * Abspielen angewendet (renderPipeline.js). Eigener Namensraum (`playback`)
 * bewusst getrennt von den bestehenden Legacy-Feldern `s.loop`/`s.fade`/
 * `s.random`, um Namenskonflikte mit den Slot-Fades zu vermeiden.
 */
export function defaultPlayback() {
  return {
    fadeIn:    { enabled: false, duration: 0.5, curve: 'linear' },
    fadeOut:   { enabled: false, duration: 0.5, curve: 'linear' },
    crossfade: { enabled: false, duration: 1,   curve: 'linear' }
  };
}

// ─── NODE BUILDERS ───────────────────────────────────────────

export const EQ10_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/**
 * P3: bands[i] kann sowohl das alte Format (reine Zahl = Gain, fester
 * Q=1.4) als auch das neue Format ({freq, gain, Q}) sein — volle
 * Rückwärtskompatibilität mit alten Presets/gespeicherten Sounds, die
 * noch das Flat-Array-Format nutzen (u.a. alle 17 mitgelieferten
 * FX-Presets).
 */
function _buildEQ10(ctx, p) {
  const bands = p.bands || new Array(10).fill(0);
  const nodes = EQ10_FREQS.map((defaultFreq, i) => {
    const n = ctx.createBiquadFilter();
    n.type  = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
    const b = bands[i];
    const isObj = typeof b === 'object' && b !== null;
    const gain = isObj ? (b.gain ?? 0) : (b ?? 0);
    const freq = isObj && b.freq ? b.freq : defaultFreq;
    const q    = isObj && b.Q    ? b.Q    : 1.4;
    n.frequency.value = freq;
    n.Q.value = Math.max(0.3, Math.min(10, q));
    n.gain.value = Math.max(-18, Math.min(18, gain));
    return n;
  });
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return { input: nodes[0], output: nodes[nodes.length - 1] };
}

function _buildEQ3(ctx, p) {
  const ls = ctx.createBiquadFilter(); ls.type = 'lowshelf';  ls.frequency.value = 200;  ls.gain.value = Math.max(-18, Math.min(18, p.low  ?? 0));
  const mp = ctx.createBiquadFilter(); mp.type = 'peaking';   mp.frequency.value = 1000; mp.Q.value = 1.0; mp.gain.value = Math.max(-18, Math.min(18, p.mid ?? 0));
  const hs = ctx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 4000; hs.gain.value = Math.max(-18, Math.min(18, p.high ?? 0));
  ls.connect(mp); mp.connect(hs);
  return { input: ls, output: hs };
}

function _buildCompressor(ctx, p) {
  const n = ctx.createDynamicsCompressor();
  n.threshold.value = p.threshold ?? -24;
  n.knee.value      = p.knee      ?? 30;
  n.ratio.value     = Math.min(20, p.ratio ?? 12);
  n.attack.value    = p.attack    ?? 0.003;
  n.release.value   = p.release   ?? 0.25;
  return n;
}

/**
 * P2-Erweiterung: mehrere Verzerrungs-Kurvenformen statt nur der einen
 * bisherigen weichen Sättigungskurve.
 * WICHTIG: der 'softClip'/default-Zweig verwendet BEWUSST die exakte,
 * bereits bestehende Formel (Math.PI-basiert, nicht die im Plan
 * vorgeschlagene vereinfachte (1+k)-Variante) — alle 17 FX-Presets sind
 * auf genau diese Kurve abgestimmt; ein Formelwechsel hätte deren Klang
 * unbeabsichtigt verändert.
 */
function _buildDistortionCurve(mode, amount) {
  const n = 512; const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1; // -1..1
    switch (mode) {
      case 'hardClip': {
        const threshold = Math.max(0.05, Math.min(1, amount / 100)); // amount 0-100 -> threshold 1-0.05
        curve[i] = Math.max(-threshold, Math.min(threshold, x)) / threshold; // normalisiert
        break;
      }
      case 'bitcrush': {
        const bitDepth = Math.max(1, Math.min(16, Math.round(16 - (amount / 100) * 14))); // amount -> 1..16 bit
        const steps = Math.pow(2, bitDepth);
        curve[i] = Math.round(x * steps) / steps;
        break;
      }
      case 'softClip':
      default: {
        const k = Math.max(0.1, amount);
        curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
      }
    }
  }
  return curve;
}

/** P2: schmalbandige Frequenzunterdrückung, primär gegen Netzbrummen (50/60Hz). */
function _buildNotch(ctx, p) {
  const n = ctx.createBiquadFilter();
  n.type = 'notch';
  n.frequency.value = Math.max(20, Math.min(20000, p.frequency ?? 50));
  n.Q.value = Math.max(0.5, Math.min(30, p.Q ?? 10));
  return { input: n, output: n };
}

/**
 * P2: klassische Lautstärke-Modulation. Gain = dcOffset + LFO*lfoGain,
 * pendelt zwischen [1-depth, 1] (depth=0 → konstant 1, kein Effekt;
 * depth=1 → pendelt zwischen 0 und 1). Siehe Plan-Funktionsbeispiel.
 */
function _buildTremolo(ctx, p) {
  const lfo = ctx.createOscillator();
  lfo.type = ['sine', 'triangle', 'square'].includes(p.waveform) ? p.waveform : 'sine';
  lfo.frequency.value = Math.max(0.1, Math.min(20, p.rate ?? 5));

  const lfoGain = ctx.createGain();
  lfoGain.gain.value = Math.max(0, Math.min(1, p.depth ?? 0.5)) * 0.5; // auf ±0.5 skaliert

  const dcOffset = ctx.createConstantSource();
  dcOffset.offset.value = 1 - lfoGain.gain.value; // Basispegel, damit Gain nie negativ wird

  const outGain = ctx.createGain();
  outGain.gain.value = 0; // wird ausschließlich per LFO+DC moduliert
  lfo.connect(lfoGain).connect(outGain.gain);
  dcOffset.connect(outGain.gain);
  lfo.start(); dcOffset.start();

  return { input: outGain, output: outGain };
}

/**
 * P2: modulierte Delay-Line, gemeinsame Basis für Chorus (lang, kein
 * Feedback) und Flanger (kurz, mit Feedback) — siehe _buildChorus/
 * _buildFlanger. `maxDelay` (Sekunden) begrenzt den DelayNode-Puffer und
 * muss baseDelay+depth mit Sicherheitsabstand abdecken, sonst würde die
 * LFO-Modulation bei hohen depth-Werten den erlaubten Bereich verlassen.
 */
function _buildModulatedDelay(ctx, p, { withFeedback, maxDelay = 0.05 }) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(maxDelay);
  delay.delayTime.value = Math.max(0, (p.baseDelay ?? 15) / 1000);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = Math.max(0.01, Math.min(10, p.rate ?? 0.8));
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = Math.max(0, (p.depth ?? 8) / 1000); // ms -> s
  lfo.connect(lfoGain).connect(delay.delayTime);
  lfo.start();

  const wetGain = ctx.createGain(); wetGain.gain.value = Math.max(0, Math.min(1, p.mix ?? 0.3));
  const dryGain = ctx.createGain(); dryGain.gain.value = 1 - wetGain.gain.value;
  const output = ctx.createGain();

  input.connect(dryGain).connect(output);
  input.connect(delay);
  if (withFeedback) {
    const fb = ctx.createGain(); fb.gain.value = Math.max(0, Math.min(0.95, p.feedback ?? 0.5));
    delay.connect(fb).connect(delay);
  }
  delay.connect(wetGain).connect(output);

  return { input, output };
}

// Chorus: lange Basis-Delay-Zeit (10-30ms), kein Feedback — "mehrere
// leicht verstimmte Stimmen". Flanger: sehr kurze Basis-Delay-Zeit
// (0.5-5ms) MIT Feedback — Kammfilter-/"Jet"-Effekt.
// maxDelay-Puffer bewusst mit Sicherheitsabstand über dem theoretischen
// Maximum von baseDelay+depth (Chorus: 40+20=60ms, Flanger: 5+20=25ms aus
// den jeweiligen Parametertabellen) gewählt — DelayNode moduliert additiv
// (delayTime-AudioParam + LFO-Signal), ein zu knapper Puffer würde die
// LFO-Modulation bei hohen depth-Werten stillschweigend kappen.
function _buildChorus(ctx, p)  { return _buildModulatedDelay(ctx, p, { withFeedback: false, maxDelay: 0.08 }); }
function _buildFlanger(ctx, p) { return _buildModulatedDelay(ctx, p, { withFeedback: true,  maxDelay: 0.04 }); }

/**
 * P3: Wahwah — LFO-modulierter Bandpass, klassischer "Wah"-Sweep-Klang.
 * depthHz proportional zur Basisfrequenz skaliert (siehe Plan-Formel),
 * damit "depth" bei jeder Basisfrequenz einen vergleichbar hörbaren
 * Sweep-Bereich ergibt (ein fixer Hz-Wert würde bei niedrigem baseFreq
 * unverhältnismäßig groß wirken).
 */
function _buildWahwah(ctx, p) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  const baseFreq = Math.max(100, Math.min(5000, p.frequency ?? 800));
  const depthHz  = Math.max(0, Math.min(1, p.depth ?? 0.7)) * baseFreq * 3;
  filter.frequency.value = baseFreq;
  filter.Q.value = Math.max(1, Math.min(20, p.resonance ?? 5));

  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  lfo.frequency.value = Math.max(0.1, Math.min(10, p.rate ?? 2));
  const lfoGain = ctx.createGain(); lfoGain.gain.value = depthHz;
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start();

  return { input: filter, output: filter };
}

/**
 * P3: Ring Modulation — Träger-Oszillator moduliert direkt den Gain
 * des Eingangssignals (Web-Audio-Parameter-Modulation als pragmatische
 * Näherung an echte Signal-Multiplikation, siehe Plan-Hinweis: bei
 * Oszillator-Amplitude ±1 und Gain-Basiswert 0 entspricht das einer
 * Multiplikation Input×Träger — technisch keine exakte Ring-Modulation
 * wie mit einem dedizierten AudioWorklet, klanglich aber der
 * charakteristische metallische/oktavierte Effekt).
 */
function _buildRingMod(ctx, p) {
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = Math.max(20, Math.min(5000, p.frequency ?? 440));
  const ringGain = ctx.createGain(); ringGain.gain.value = 0; // Träger moduliert direkt den Gain
  carrier.connect(ringGain.gain);
  carrier.start();

  const wet = ctx.createGain(); wet.gain.value = Math.max(0, Math.min(1, p.mix ?? 1));
  const dry = ctx.createGain(); dry.gain.value = 1 - wet.gain.value;
  const input = ctx.createGain(); const output = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(ringGain).connect(wet).connect(output);

  return { input, output };
}

function _buildReverb(ctx, p) {
  const wet = Math.max(0, Math.min(1, p.amount ?? 0.35));
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const conv = ctx.createConvolver();
  dry.gain.value = 1 - wet; wetG.gain.value = wet;
  conv.buffer = _buildIR(ctx, p);
  inp.connect(dry); inp.connect(conv); conv.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return { input: inp, output: out };
}

function _buildIRReverb(ctx, p) {
  const wet = Math.max(0, Math.min(1, p.wet ?? 0.35));
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const conv = ctx.createConvolver();
  dry.gain.value = 1 - wet; wetG.gain.value = wet;
  conv.buffer = getIRBuffer(ctx, p.impulse);
  inp.connect(dry); inp.connect(conv); conv.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return { input: inp, output: out };
}

function _buildDelay(ctx, p) {
  const time = Math.max(0.01, Math.min(2.0, p.time ?? 0.22));
  const fb   = Math.max(0, Math.min(0.95, p.feedback ?? 0.35));
  const wet  = Math.max(0, Math.min(0.95, p.wet ?? 0.35));
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const del  = ctx.createDelay(5.0); const fbG = ctx.createGain();
  del.delayTime.value = time; fbG.gain.value = fb;
  dry.gain.value = 1 - wet; wetG.gain.value = wet;
  del.connect(fbG); fbG.connect(del);
  inp.connect(dry); inp.connect(del); del.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return { input: inp, output: out };
}

/**
 * Baut einen Pitch-Shift-Node für GENAU den übergebenen Context.
 * BUGFIX (Pitch-Export-Konsistenz): prüft die Context-spezifische
 * Worklet-Readiness (`_pitchWorkletReadyContexts`) statt des globalen,
 * nur für den Live-Context gültigen `APP.pitchWorkletReady`-Flags. Damit
 * liefert dieselbe Funktion für Live-AudioContext UND OfflineAudioContext
 * (Export) ein konsistentes Ergebnis, sofern der Aufrufer zuvor
 * `ensurePitchWorkletFor(ctx)` ausgeführt hat.
 * Exportiert, damit export.js denselben Baustein wiederverwenden kann
 * (keine zweite, abweichende Pitch-Node-Implementierung für den Export).
 *
 * @param {number} [numChannels=2] Kanalzahl der Quelle (buffer.numberOfChannels).
 *   Stereo-fähiger Worklet (P1): `channelCountMode:'explicit'` +
 *   `channelInterpretation:'discrete'` verhindert, dass der Browser bei
 *   Mono-Quellen automatisch hoch- bzw. bei Multi-Channel-Quellen
 *   heruntermischt, BEVOR der Worklet die Kanäle sieht — jeder Kanal
 *   bekommt im Prozessor eine eigene, unabhängige Overlap-Add-Instanz.
 */
export function buildPitchNode(ctx, p, numChannels = 2) {
  const semitones = p.semitones ?? 0;
  if (semitones === 0) return null;
  if (_pitchWorkletReadyContexts.has(ctx)) {
    try {
      const ch = Math.max(1, Math.min(2, numChannels || 2));
      const n = new AudioWorkletNode(ctx, 'pitch-shifter-processor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        channelCount: ch,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        outputChannelCount: [ch]
      });
      n.parameters.get('pitchFactor').setValueAtTime(Math.pow(2, semitones / 12), ctx.currentTime);
      return { input: n, output: n };
    } catch (e) { console.warn('[audio] PitchWorklet node failed:', e.message); }
  }
  return null; // caller uses src.detune as fallback
}

function _buildPanner(ctx, effects) {
  if (effects.spatial?.enabled) {
    try {
      const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
      if (p.positionX) { p.positionX.value = effects.spatial.x ?? 0; p.positionY.value = effects.spatial.y ?? 0; p.positionZ.value = effects.spatial.z ?? -1; }
      else p.setPosition(effects.spatial.x ?? 0, effects.spatial.y ?? 0, effects.spatial.z ?? -1);
      p.rolloffFactor = effects.spatial.rolloff ?? 1; p.maxDistance = effects.spatial.maxDistance ?? 10000; p.refDistance = effects.spatial.refDistance ?? 1;
      p.coneInnerAngle = effects.spatial.coneInnerAngle ?? 360; p.coneOuterAngle = effects.spatial.coneOuterAngle ?? 360; p.coneOuterGain = effects.spatial.coneOuterGain ?? 0;
      return { input: p, output: p };
    } catch(e) { /* fall through to stereo */ }
  }
  try {
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, effects.pan ?? 0)); return { input: p, output: p };
  } catch(e) { return null; }
}

/**
 * Build the full effect chain for a given context.
 * Returns { input, output } or null.
 * BUGFIX: used in both playback AND preview — same engine for both.
 */
export function buildEffectChain(ctx, effects) {
  if (!effects || !effects.enabled) return null;
  const segs = [];

  if (effects.highpass?.enabled) {
    const n = ctx.createBiquadFilter(); n.type = 'highpass';
    n.frequency.value = Math.max(20, Math.min(5000, effects.highpass.frequency ?? 20));
    n.Q.value = Math.max(0.1, Math.min(10, effects.highpass.Q ?? 0.7));
    segs.push({ input: n, output: n });
  }
  if (effects.lowpass?.enabled) {
    const n = ctx.createBiquadFilter(); n.type = 'lowpass';
    n.frequency.value = Math.max(100, Math.min(20000, effects.lowpass.frequency ?? 20000));
    n.Q.value = Math.max(0.1, Math.min(10, effects.lowpass.Q ?? 0.7));
    segs.push({ input: n, output: n });
  }
  if (effects.notch?.enabled)      segs.push(_buildNotch(ctx, effects.notch));
  if (effects.wahwah?.enabled)     segs.push(_buildWahwah(ctx, effects.wahwah));
  if (effects.eq10?.enabled)       segs.push(_buildEQ10(ctx, effects.eq10));
  else if (effects.eq?.enabled)    segs.push(_buildEQ3(ctx, effects.eq));

  if (effects.limiter?.enabled)    { const n = _buildCompressor(ctx, effects.limiter);    segs.push({ input: n, output: n }); }
  else if (effects.compressor?.enabled) { const n = _buildCompressor(ctx, effects.compressor); segs.push({ input: n, output: n }); }

  if (effects.distortion?.enabled) {
    const s = ctx.createWaveShaper();
    s.curve = _buildDistortionCurve(effects.distortion.mode, effects.distortion.amount ?? 40);
    s.oversample = ['none','2x','4x'].includes(effects.distortion.oversample) ? effects.distortion.oversample : '4x';
    segs.push({ input: s, output: s });
  }
  if (effects.ringmod?.enabled)    segs.push(_buildRingMod(ctx, effects.ringmod));

  // Chorus/Flanger: Modulationseffekte, bewusst vor Reverb/Delay platziert
  // (typische Effektketten-Reihenfolge: Filter → Verzerrung → Modulation →
  // Zeitbasierte Effekte). Gegenseitig exklusiv wie EQ/EQ10 wäre unnötig
  // einschränkend (Chorus+Flanger gleichzeitig ist klanglich sinnvoll),
  // daher hier — anders als z.B. bei eq/eq10 — KEIN else-if.
  if (effects.chorus?.enabled)     segs.push(_buildChorus(ctx, effects.chorus));
  if (effects.flanger?.enabled)    segs.push(_buildFlanger(ctx, effects.flanger));

  if (effects.irReverb?.enabled)   segs.push(_buildIRReverb(ctx, effects.irReverb));
  else if (effects.reverb?.enabled) segs.push(_buildReverb(ctx, effects.reverb));

  if (effects.delay?.enabled)      segs.push(_buildDelay(ctx, effects.delay));

  // Tremolo: bewusst NACH dem Delay-Block platziert (Plan-Vorgabe) —
  // moduliert damit auch die Delay-Wiederholungen mit, nicht nur das
  // Trockensignal.
  if (effects.tremolo?.enabled)    segs.push(_buildTremolo(ctx, effects.tremolo));

  // BUGFIX (Noise-Gate P0, Stufe A): `effects.noiseGate` wurde bisher an
  // keiner Stelle in buildEffectChain() ausgelesen — der UI-Regler
  // (fxNoiseGateEnabled/-Threshold) hatte dadurch NULL Audiowirkung.
  // Sofortmaßnahme: Compressor-Approximation. Das ist AUSDRÜCKLICH kein
  // echtes Gate (ein DynamicsCompressorNode dämpft oberhalb, nicht
  // unterhalb des Thresholds) — nur "irgendeine hörbare Wirkung", damit
  // der Regler nicht mehr wirkungslos ist. Zielarchitektur (P1): echter
  // Envelope-Follower-Gate als AudioWorkletNode (analog pitch-processor.js).
  if (effects.noiseGate?.enabled) {
    const g = ctx.createDynamicsCompressor();
    g.threshold.value = Math.max(-100, Math.min(0, effects.noiseGate.threshold ?? -45));
    g.ratio.value = 20;        // maximal mögliches Ratio der Web Audio API
    g.knee.value = 0;          // harte Kennlinie, Annäherung an Gate-Verhalten
    g.attack.value = Math.max(0.001, (effects.noiseGate.attack ?? 5) / 1000);
    g.release.value = Math.max(0.01, (effects.noiseGate.release ?? 150) / 1000);
    segs.push({ input: g, output: g });
  }

  const panner = _buildPanner(ctx, effects);
  if (panner) segs.push(panner);

  if (!segs.length) return null;
  for (let i = 0; i < segs.length - 1; i++) segs[i].output.connect(segs[i + 1].input);
  return { input: segs[0].input, output: segs[segs.length - 1].output };
}

// ─── ENVELOPE ────────────────────────────────────────────────
// BUGFIX (P1 Render-Pipeline): Envelope-/Fade-Kurvenberechnung lebt jetzt
// zentral in renderPipeline.js (renderSoundGraph()), auf getrennten,
// in Serie geschalteten Gain-Nodes statt konkurrierend auf demselben Node
// (siehe Plan Abschnitt 1.5). Die frühere _applyEnvelope()/_applyFades()/
// _wire() hier in audio.js sind damit überflüssig geworden und entfallen
// — playSound()/playSoundAndWait() rufen jetzt renderSoundGraph() auf.

