/**
 * audio/effect-graph.js — Effekt-Graph-Konstruktion (zustandslos)
 * Enthält die reinen Knoten-Builder (_build*), buildEffectChain/buildPitchNode sowie die
 * Default-Datenmodelle für Effekte/Wiedergabeparameter.
 */

import { _pitchWorkletReadyContexts } from './context.js';
import { getGenericIR, getIRBuffer } from './ir-data.js';
import { defaultModules } from './engine/registry.js';

// ─── DEFAULT EFFECTS ─────────────────────────────────────────

export function defaultEffects() {
  // Einzige Quelle der Modul-Defaults ist die Registry (audio/engine/registry.js, AE-01′). Das Ergebnis ist
  // byte-identisch zur früheren handgeschriebenen Liste (Test: tests/suites/09-registry.js gegen den Phase-1-Stand).
  return defaultModules();
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
//
// Jedes Modul ist eine INSTANZ (Phase 3, AE-04′): { key, input, output, update(p) → boolean, … }.
//   • Die Parameter→Knoten-Abbildung (inkl. aller Klemmwerte) steht je Modul EINMAL in `apply(p, smooth)`. Beim Bau läuft
//     sie mit smooth=false (direkte Zuweisung — exakt das bisherige Verhalten), beim Live-Update mit smooth=true
//     (`setTargetAtTime`, klickfrei). Dadurch gibt es keine zweite Formel, die vom Bau abweichen könnte.
//   • `update(p)` liefert true, wenn alle Änderungen live angewendet wurden, und false, wenn sich ein NICHT glättbarer Wert
//     geändert hat (IR, Verzerrungskurve, LFO-Form …). Dann muss der Aufrufer neu bauen/überblenden (runtime.js).

export const EQ10_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Zeitkonstante der Parameterglättung (s): ≈ 95 % nach 3·τ = 45 ms. */
export const SMOOTH_TC = 0.015;

const _cl = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const _setter = (ctx, smooth) => (param, v) => {
  if (!smooth) param.value = v;
  else param.setTargetAtTime(v, ctx.currentTime, SMOOTH_TC);
};

/** Versieht ein Segment {input, output} mit Schlüssel und update(); `sig(p)` = Signatur der nicht glättbaren Werte. */
function _inst(key, seg, p, { apply, sig = null }) {
  const s0 = sig ? sig(p) : '';
  seg.key = key;
  seg.update = np => {
    if (sig && sig(np) !== s0) return false;
    apply(np, true);
    return true;
  };
  return seg;
}

/**
 * bands[i] kann sowohl das alte Format (reine Zahl = Gain, fester Q=1.4) als auch das
 * neue Format ({freq, gain, Q}) sein — Rückwärtskompatibilität mit älteren Presets/gespeicherten
 * Sounds im Flat-Array-Format (u.a. alle mitgelieferten FX-Presets).
 */
function _buildEQ10(ctx, p) {
  const nodes = EQ10_FREQS.map((_, i) => {
    const n = ctx.createBiquadFilter();
    n.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking';
    return n;
  });
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const bands = q.bands || new Array(10).fill(0);
    nodes.forEach((n, i) => {
      const b = bands[i];
      const isObj = typeof b === 'object' && b !== null;
      const gain = isObj ? (b.gain ?? 0) : (b ?? 0);
      const freq = isObj && b.freq ? b.freq : EQ10_FREQS[i];
      const qq   = isObj && b.Q    ? b.Q    : 1.4;
      set(n.frequency, freq);
      set(n.Q, Math.max(0.3, Math.min(10, qq)));
      set(n.gain, Math.max(-18, Math.min(18, gain)));
    });
  };
  apply(p, false);
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return _inst('eq10', { input: nodes[0], output: nodes[nodes.length - 1] }, p, { apply });
}

function _buildEQ3(ctx, p) {
  const ls = ctx.createBiquadFilter(); ls.type = 'lowshelf';  ls.frequency.value = 200;
  const mp = ctx.createBiquadFilter(); mp.type = 'peaking';   mp.frequency.value = 1000; mp.Q.value = 1.0;
  const hs = ctx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 4000;
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(ls.gain, Math.max(-18, Math.min(18, q.low  ?? 0)));
    set(mp.gain, Math.max(-18, Math.min(18, q.mid  ?? 0)));
    set(hs.gain, Math.max(-18, Math.min(18, q.high ?? 0)));
  };
  apply(p, false);
  ls.connect(mp); mp.connect(hs);
  return _inst('eq', { input: ls, output: hs }, p, { apply });
}

/** Kompressor (auch Limiter-Näherung bis P11): `key` = 'compressor' | 'limiter'. */
function _buildCompressor(ctx, p, key = 'compressor') {
  const n = ctx.createDynamicsCompressor();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(n.threshold, q.threshold ?? -24);
    set(n.knee,      q.knee      ?? 30);
    set(n.ratio,     Math.min(20, q.ratio ?? 12));
    set(n.attack,    q.attack    ?? 0.003);
    set(n.release,   q.release   ?? 0.25);
  };
  apply(p, false);
  return _inst(key, { input: n, output: n }, p, { apply });
}

/**
 * Mehrere Verzerrungs-Kurvenformen (softClip, hardClip, bitcrush).
 * WICHTIG: der 'softClip'/default-Zweig verwendet BEWUSST die exakte Math.PI-basierte Formel
 * (nicht eine vereinfachte (1+k)-Variante) — alle mitgelieferten FX-Presets sind auf genau diese
 * Kurve abgestimmt; ein Formelwechsel würde deren Klang unbeabsichtigt verändern.
 */
function _buildDistortionCurve(mode, amount) {
  // Ungerade Länge (513): der Eingang 0 liegt EXAKT auf einer Stützstelle (Index 256). Bei gerader Länge (512)
  // interpolierte der WaveShaper bei Stille zwischen zwei Punkten und erzeugte einen Gleichanteil (N-01, ≈ −34 dBFS).
  const n = 513; const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1; // -1..1, x(256) = 0 exakt
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

/** Verzerrung: Kurve und Oversampling sind nicht glättbar → jede Änderung verlangt Neubau/Überblendung. */
function _buildDistortion(ctx, p) {
  const s = ctx.createWaveShaper();
  s.curve = _buildDistortionCurve(p.mode, p.amount ?? 40);
  s.oversample = ['none', '2x', '4x'].includes(p.oversample) ? p.oversample : '4x';
  return _inst('distortion', { input: s, output: s }, p, { apply: () => {}, sig: q => `${q.mode}|${q.amount ?? 40}|${q.oversample}` });
}

function _buildBiquadModule(ctx, p, key, type, { fMin, fMax, fDef, qMin, qMax, qDef }) {
  const n = ctx.createBiquadFilter(); n.type = type;
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(n.frequency, Math.max(fMin, Math.min(fMax, q.frequency ?? fDef)));
    set(n.Q, Math.max(qMin, Math.min(qMax, q.Q ?? qDef)));
  };
  apply(p, false);
  return _inst(key, { input: n, output: n }, p, { apply });
}

/** Schmalbandige Frequenzunterdrückung, primär gegen Netzbrummen (50/60Hz). */
function _buildNotch(ctx, p) {
  return _buildBiquadModule(ctx, p, 'notch', 'notch', { fMin: 20, fMax: 20000, fDef: 50, qMin: 0.5, qMax: 30, qDef: 10 });
}

/**
 * Klassische Lautstärke-Modulation. Gain = dcOffset + LFO*lfoGain,
 * pendelt zwischen [1-depth, 1] (depth=0 → konstant 1, kein Effekt;
 * depth=1 → pendelt zwischen 0 und 1). Die LFO-Form ist nicht glättbar (Signatur).
 */
function _buildTremolo(ctx, p, tr) {
  const lfo = ctx.createOscillator();
  lfo.type = ['sine', 'triangle', 'square'].includes(p.waveform) ? p.waveform : 'sine';
  const lfoGain = ctx.createGain();
  const dcOffset = ctx.createConstantSource();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const lg = Math.max(0, Math.min(1, q.depth ?? 0.5)) * 0.5;   // auf ±0.5 skaliert
    set(lfo.frequency, Math.max(0.1, Math.min(20, q.rate ?? 5)));
    set(lfoGain.gain, lg);
    set(dcOffset.offset, 1 - (sm ? lg : lfoGain.gain.value));    // Basispegel, damit Gain nie negativ wird
  };
  apply(p, false);

  const outGain = ctx.createGain();
  outGain.gain.value = 0; // wird ausschließlich per LFO+DC moduliert
  lfo.connect(lfoGain).connect(outGain.gain);
  dcOffset.connect(outGain.gain);
  lfo.start(); dcOffset.start();
  if (tr) tr.push(lfo, dcOffset);

  return _inst('tremolo', { input: outGain, output: outGain }, p, { apply, sig: q => String(q.waveform) });
}

/**
 * Modulierte Delay-Line, gemeinsame Basis für Chorus (lang, kein
 * Feedback) und Flanger (kurz, mit Feedback) — siehe _buildChorus/
 * _buildFlanger. `maxDelay` (Sekunden) begrenzt den DelayNode-Puffer und
 * muss baseDelay+depth mit Sicherheitsabstand abdecken, sonst würde die
 * LFO-Modulation bei hohen depth-Werten den erlaubten Bereich verlassen.
 */
function _buildModulatedDelay(ctx, p, { key, withFeedback, maxDelay = 0.05 }, tr) {
  const input = ctx.createGain();
  const delay = ctx.createDelay(maxDelay);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  const lfoGain = ctx.createGain();
  const wetGain = ctx.createGain();
  const dryGain = ctx.createGain();
  const fb = withFeedback ? ctx.createGain() : null;
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(delay.delayTime, Math.max(0, (q.baseDelay ?? 15) / 1000));
    set(lfo.frequency, Math.max(0.01, Math.min(10, q.rate ?? 0.8)));
    set(lfoGain.gain, Math.max(0, (q.depth ?? 8) / 1000));       // ms -> s
    const w = Math.max(0, Math.min(1, q.mix ?? 0.3));
    set(wetGain.gain, w);
    set(dryGain.gain, 1 - (sm ? w : wetGain.gain.value));
    if (fb) set(fb.gain, Math.max(0, Math.min(0.95, q.feedback ?? 0.5)));
  };
  apply(p, false);
  lfo.connect(lfoGain).connect(delay.delayTime);
  lfo.start();
  if (tr) tr.push(lfo);

  const output = ctx.createGain();
  input.connect(dryGain).connect(output);
  input.connect(delay);
  if (fb) delay.connect(fb).connect(delay);
  delay.connect(wetGain).connect(output);

  return _inst(key, { input, output }, p, { apply });
}

// Chorus: lange Basis-Delay-Zeit (10-30ms), kein Feedback — "mehrere
// leicht verstimmte Stimmen". Flanger: sehr kurze Basis-Delay-Zeit
// (0.5-5ms) MIT Feedback — Kammfilter-/"Jet"-Effekt.
// maxDelay-Puffer bewusst mit Sicherheitsabstand über dem theoretischen
// Maximum von baseDelay+depth (Chorus: 40+20=60ms, Flanger: 5+20=25ms aus
// den jeweiligen Parametertabellen) gewählt — DelayNode moduliert additiv
// (delayTime-AudioParam + LFO-Signal), ein zu knapper Puffer würde die
// LFO-Modulation bei hohen depth-Werten stillschweigend kappen.
function _buildChorus(ctx, p, tr)  { return _buildModulatedDelay(ctx, p, { key: 'chorus',  withFeedback: false, maxDelay: 0.08 }, tr); }
function _buildFlanger(ctx, p, tr) { return _buildModulatedDelay(ctx, p, { key: 'flanger', withFeedback: true,  maxDelay: 0.04 }, tr); }

/**
 * Wahwah — LFO-modulierter Bandpass, klassischer "Wah"-Sweep-Klang.
 * depthHz wird proportional zur Basisfrequenz skaliert, damit "depth" bei jeder
 * Basisfrequenz einen vergleichbar hörbaren Sweep-Bereich ergibt (ein fixer Hz-Wert
 * würde bei niedrigem baseFreq unverhältnismäßig groß wirken).
 */
function _buildWahwah(ctx, p, tr) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  const lfo = ctx.createOscillator(); lfo.type = 'sine';
  const lfoGain = ctx.createGain();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const baseFreq = Math.max(100, Math.min(5000, q.frequency ?? 800));
    const depthHz  = Math.max(0, Math.min(1, q.depth ?? 0.7)) * baseFreq * 3;
    set(filter.frequency, baseFreq);
    set(filter.Q, Math.max(1, Math.min(20, q.resonance ?? 5)));
    set(lfo.frequency, Math.max(0.1, Math.min(10, q.rate ?? 2)));
    set(lfoGain.gain, depthHz);
  };
  apply(p, false);
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start();
  if (tr) tr.push(lfo);

  return _inst('wahwah', { input: filter, output: filter }, p, { apply });
}

/**
 * Ring Modulation — Träger-Oszillator moduliert direkt den Gain des Eingangssignals
 * (Web-Audio-Parameter-Modulation: bei Oszillator-Amplitude ±1 und Gain-Basiswert 0 entspricht das einer
 * echten Multiplikation Input×Träger; nur Sinusform, 20–5000 Hz).
 */
function _buildRingMod(ctx, p, tr) {
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  const ringGain = ctx.createGain(); ringGain.gain.value = 0; // Träger moduliert direkt den Gain
  const wet = ctx.createGain();
  const dry = ctx.createGain();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(carrier.frequency, Math.max(20, Math.min(5000, q.frequency ?? 440)));
    const w = Math.max(0, Math.min(1, q.mix ?? 1));
    set(wet.gain, w);
    set(dry.gain, 1 - (sm ? w : wet.gain.value));
  };
  apply(p, false);
  carrier.connect(ringGain.gain);
  carrier.start();
  if (tr) tr.push(carrier);

  const input = ctx.createGain(); const output = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(ringGain).connect(wet).connect(output);

  return _inst('ringmod', { input, output }, p, { apply });
}

/**
 * Gibt den Faltungspuffer eines ConvolverNodes bei dispose() frei. Chrome hält pro `conv.buffer = …` eine native
 * Faltungs-Engine (FFT-Partitionen ≈ Vielfaches der IR-Größe), die nur über den GC freigegeben wird — dessen Druck
 * sieht diesen Speicher nicht. Gemessen (Phase 0, Chrome 154): Absturz nach ≈ 275 Bau-/Entsorgungszyklen bei 3,5-s-IR,
 * ≈ 200 bei 5-s-IR, unabhängig vom Abstand der Zyklen (L-02). `buffer = null` gibt die Engine sofort frei.
 * `tr` ist die dispose()-Liste der Pipeline (Einträge mit stop()).
 */
function _trackConvolver(conv, tr) {
  if (tr) tr.push({ stop() { try { conv.buffer = null; } catch (e) { /* Knoten bereits verworfen */ } } });
}

/** Gemeinsame Hall-Hülle: Dry/Wet um einen Convolver. `wetOf(p)` liefert den Anteil; die IR ist nicht glättbar (Signatur). */
function _buildConvolverModule(ctx, p, tr, { key, wetOf, irOf, sig }) {
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const conv = ctx.createConvolver();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const wet = wetOf(q);
    set(dry.gain, 1 - wet); set(wetG.gain, wet);
  };
  apply(p, false);
  conv.buffer = irOf(ctx, p);
  _trackConvolver(conv, tr);
  inp.connect(dry); inp.connect(conv); conv.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return _inst(key, { input: inp, output: out }, p, { apply, sig });
}

function _buildReverb(ctx, p, tr) {
  return _buildConvolverModule(ctx, p, tr, {
    key: 'reverb', wetOf: q => Math.max(0, Math.min(1, q.amount ?? 0.35)), irOf: getGenericIR,
    sig: q => `${q.duration ?? 2.2}|${q.decay ?? 2.0}|${q.pre ?? 0.005}`
  });
}

function _buildIRReverb(ctx, p, tr) {
  return _buildConvolverModule(ctx, p, tr, {
    key: 'irReverb', wetOf: q => Math.max(0, Math.min(1, q.wet ?? 0.35)), irOf: (c, q) => getIRBuffer(c, q.impulse),
    sig: q => String(q.impulse)
  });
}

function _buildDelay(ctx, p) {
  const inp  = ctx.createGain(); const dry = ctx.createGain();
  const wetG = ctx.createGain(); const out = ctx.createGain();
  const del  = ctx.createDelay(5.0); const fbG = ctx.createGain();
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    const time = Math.max(0.01, Math.min(2.0, q.time ?? 0.22));
    const fb   = Math.max(0, Math.min(0.95, q.feedback ?? 0.35));
    const wet  = Math.max(0, Math.min(0.95, q.wet ?? 0.35));
    set(del.delayTime, time); set(fbG.gain, fb);
    set(dry.gain, 1 - wet); set(wetG.gain, wet);
  };
  apply(p, false);
  del.connect(fbG); fbG.connect(del);
  inp.connect(dry); inp.connect(del); del.connect(wetG);
  dry.connect(out); wetG.connect(out);
  return _inst('delay', { input: inp, output: out }, p, { apply });
}

/**
 * Noise-Gate: Compressor-Approximation. Das ist AUSDRÜCKLICH kein echtes Gate (ein DynamicsCompressorNode dämpft
 * oberhalb, nicht unterhalb des Thresholds) — nur eine hörbare Näherung (B-03, wird in P11 ersetzt).
 */
function _buildNoiseGate(ctx, p) {
  const g = ctx.createDynamicsCompressor();
  g.ratio.value = 20;        // maximal mögliches Ratio der Web Audio API
  g.knee.value = 0;          // harte Kennlinie, Annäherung an Gate-Verhalten
  const apply = (q, sm) => {
    const set = _setter(ctx, sm);
    set(g.threshold, Math.max(-100, Math.min(0, q.threshold ?? -45)));
    set(g.attack, Math.max(0.001, (q.attack ?? 5) / 1000));
    set(g.release, Math.max(0.01, (q.release ?? 150) / 1000));
  };
  apply(p, false);
  return _inst('noiseGate', { input: g, output: g }, p, { apply });
}

/**
 * Baut einen Pitch-Shift-Node für GENAU den übergebenen Context.
 * Prüft die Context-spezifische Worklet-Readiness (`_pitchWorkletReadyContexts`) statt des
 * globalen, nur für den Live-Context gültigen `APP.pitchWorkletReady`-Flags. Damit liefert
 * dieselbe Funktion für Live-AudioContext UND OfflineAudioContext (Export) ein konsistentes
 * Ergebnis, sofern der Aufrufer zuvor `ensurePitchWorkletFor(ctx)` ausgeführt hat.
 * Exportiert, damit export.js denselben Baustein wiederverwenden kann.
 *
 * @param {number} [numChannels=2] Kanalzahl der Quelle (buffer.numberOfChannels).
 *   Stereo-fähiger Worklet: `channelCountMode:'explicit'` +
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
      const pf = n.parameters.get('pitchFactor');
      pf.setValueAtTime(Math.pow(2, semitones / 12), ctx.currentTime);
      // Live-Update: nur die Tonhöhe selbst ist glättbar. Ob der Knoten überhaupt existiert (Halbtöne ≠ 0), entscheidet
      // die Runtime (Strukturvergleich) — deshalb liefert update() bei Halbtönen = 0 false (Neubau/Überblendung nötig).
      const seg = { input: n, output: n, key: 'pitchShift' };
      seg.update = np => {
        const st = np?.semitones ?? 0;
        if (!st) return false;
        pf.setTargetAtTime(Math.pow(2, st / 12), ctx.currentTime, SMOOTH_TC);
        return true;
      };
      return seg;
    } catch (e) { console.warn('[audio] PitchWorklet node failed:', e.message); }
  }
  return null; // caller uses src.detune as fallback
}

/** HRTF-Panner (spatial). null, wenn deaktiviert oder nicht erzeugbar. */
function _buildSpatialPanner(ctx, spatial) {
  if (!spatial?.enabled) return null;
  try {
    const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    if (p.positionX) { p.positionX.value = spatial.x ?? 0; p.positionY.value = spatial.y ?? 0; p.positionZ.value = spatial.z ?? -1; }
    else p.setPosition(spatial.x ?? 0, spatial.y ?? 0, spatial.z ?? -1);
    const props = s => {
      p.rolloffFactor = s.rolloff ?? 1; p.maxDistance = s.maxDistance ?? 10000; p.refDistance = s.refDistance ?? 1;
      p.coneInnerAngle = s.coneInnerAngle ?? 360; p.coneOuterAngle = s.coneOuterAngle ?? 360; p.coneOuterGain = s.coneOuterGain ?? 0;
    };
    props(spatial);
    const seg = { input: p, output: p, key: 'spatial' };
    // Live-Update: Position über AudioParams (geglättet); die übrigen Eigenschaften sind einfache Zuweisungen. Ohne
    // AudioParam-Positionen (ältere Browser) ist nur Neubau möglich.
    seg.update = np => {
      if (!p.positionX) return false;
      const t = ctx.currentTime;
      p.positionX.setTargetAtTime(np.x ?? 0, t, SMOOTH_TC); p.positionY.setTargetAtTime(np.y ?? 0, t, SMOOTH_TC); p.positionZ.setTargetAtTime(np.z ?? -1, t, SMOOTH_TC);
      props(np);
      return true;
    };
    return seg;
  } catch(e) { return null; }
}

function _buildPanner(ctx, effects) {
  const sp = _buildSpatialPanner(ctx, effects.spatial);
  if (sp) return sp;
  return buildTerminalPanner(ctx, 0);
}

/**
 * Terminaler Stereo-Panner am Ende der Pipeline (genau einer pro Pipeline, s. audio/fx-pipeline.js).
 * Bei Stereo-Eingang und pan=0 ist er die Identität; bei Mono-Eingang erzeugt er (wie bisher) Stereo mit −3 dB je Kanal.
 */
export function buildTerminalPanner(ctx, pan) {
  try {
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan ?? 0)); return { input: p, output: p };
  } catch(e) { return null; }
}

/**
 * Die Modulkette EINES Effekt-Objekts in fester Modulreihenfolge (ohne Panner). `tr` (optional) sammelt alle
 * gestarteten Quellen (LFOs, Träger, ConstantSources), damit der Aufrufer sie über dispose() wieder stoppen kann.
 * Jedes Element ist eine Modul-Instanz mit `key` und `update()` (s. NODE BUILDERS).
 */
function _collectSegments(ctx, effects, tr) {
  const segs = [];

  if (effects.highpass?.enabled)
    segs.push(_buildBiquadModule(ctx, effects.highpass, 'highpass', 'highpass', { fMin: 20, fMax: 5000, fDef: 20, qMin: 0.1, qMax: 10, qDef: 0.7 }));
  if (effects.lowpass?.enabled)
    segs.push(_buildBiquadModule(ctx, effects.lowpass, 'lowpass', 'lowpass', { fMin: 100, fMax: 20000, fDef: 20000, qMin: 0.1, qMax: 10, qDef: 0.7 }));
  if (effects.notch?.enabled)      segs.push(_buildNotch(ctx, effects.notch));
  if (effects.wahwah?.enabled)     segs.push(_buildWahwah(ctx, effects.wahwah, tr));
  if (effects.eq10?.enabled)       segs.push(_buildEQ10(ctx, effects.eq10));
  else if (effects.eq?.enabled)    segs.push(_buildEQ3(ctx, effects.eq));

  if (effects.limiter?.enabled)    segs.push(_buildCompressor(ctx, effects.limiter, 'limiter'));
  else if (effects.compressor?.enabled) segs.push(_buildCompressor(ctx, effects.compressor, 'compressor'));

  if (effects.distortion?.enabled) segs.push(_buildDistortion(ctx, effects.distortion));
  if (effects.ringmod?.enabled)    segs.push(_buildRingMod(ctx, effects.ringmod, tr));

  // Chorus/Flanger: Modulationseffekte, bewusst vor Reverb/Delay platziert
  // (typische Effektketten-Reihenfolge: Filter → Verzerrung → Modulation →
  // Zeitbasierte Effekte). Gegenseitig exklusiv wie EQ/EQ10 wäre unnötig
  // einschränkend (Chorus+Flanger gleichzeitig ist klanglich sinnvoll),
  // daher hier — anders als z.B. bei eq/eq10 — KEIN else-if.
  if (effects.chorus?.enabled)     segs.push(_buildChorus(ctx, effects.chorus, tr));
  if (effects.flanger?.enabled)    segs.push(_buildFlanger(ctx, effects.flanger, tr));

  if (effects.irReverb?.enabled)   segs.push(_buildIRReverb(ctx, effects.irReverb, tr));
  else if (effects.reverb?.enabled) segs.push(_buildReverb(ctx, effects.reverb, tr));

  if (effects.delay?.enabled)      segs.push(_buildDelay(ctx, effects.delay));

  // Tremolo: bewusst NACH dem Delay-Block platziert —
  // moduliert damit auch die Delay-Wiederholungen mit, nicht nur das
  // Trockensignal.
  if (effects.tremolo?.enabled)    segs.push(_buildTremolo(ctx, effects.tremolo, tr));

  // Noise-Gate: Compressor-Approximation (B-03), s. _buildNoiseGate().
  if (effects.noiseGate?.enabled)  segs.push(_buildNoiseGate(ctx, effects.noiseGate));
  return segs;
}

/**
 * Bypass-Hülle (AE-04′): input → [Modul] → Summe  ∥  input → Dry → Summe. `setBypass(true)` blendet auf Dry, `false` zurück
 * (Dry und Wet stammen aus derselben Quelle, sind also kohärent: Summe der Gains = 1, kein Pegelsprung). Nur auf Anforderung
 * (`bypassable`), weil sie zwei Summenknoten je Modul kostet und die Kanalform der Kette berührt (Mono-Dry gegen Stereo-Wet,
 * M-3): bestehende Konsumenten bauen ohne Hülle und bleiben damit bit-gleich.
 */
function _wrapBypass(ctx, seg) {
  const inp = ctx.createGain(), out = ctx.createGain(), wet = ctx.createGain(), dry = ctx.createGain();
  wet.gain.value = 1; dry.gain.value = 0;
  inp.connect(seg.input); seg.output.connect(wet); wet.connect(out);
  inp.connect(dry); dry.connect(out);
  const w = { ...seg, input: inp, output: out, bypassed: false };
  w.inner = seg;
  w.update = np => seg.update(np);
  w.setBypass = (on, smooth = true) => {
    w.bypassed = !!on;
    const t = ctx.currentTime;
    if (smooth) { wet.gain.setTargetAtTime(on ? 0 : 1, t, 0.005); dry.gain.setTargetAtTime(on ? 1 : 0, t, 0.005); }
    else { wet.gain.value = on ? 0 : 1; dry.gain.value = on ? 1 : 0; }
  };
  return w;
}

function _chain(segs) {
  if (!segs.length) return null;
  for (let i = 0; i < segs.length - 1; i++) segs[i].output.connect(segs[i + 1].input);
  return { input: segs[0].input, output: segs[segs.length - 1].output, modules: segs };
}

/**
 * LEGACY-Kette (v1-Effektobjekt, flach): Modulkette + Panner am Ende. Wird von der Pipeline NICHT mehr benutzt
 * (dort: buildLayerChain pro Layer + ein terminaler Panner), bleibt aber als Referenz für die
 * Paritätstests gegen den bisherigen Klang erhalten.
 */
export function buildEffectChain(ctx, effects) {
  if (!effects || !effects.enabled) return null;
  const segs = _collectSegments(ctx, effects);
  const panner = _buildPanner(ctx, effects);
  if (panner) segs.push(panner);
  return _chain(segs);
}

/**
 * Baut die Kette EINES Layers aus seinen (vollständig aufgefüllten) Parametern: feste Modulreihenfolge,
 * der Spatial-Panner (falls aktiv) am Layer-Ende. Kein Master-Schalter, kein terminaler Panner, kein Pitch
 * (Pitch ist ein eigener Knoten am Layer-Kopf, s. fx-pipeline.js). Liefert null, wenn der Layer nichts tut
 * (reines Durchreichen). `opts.track` sammelt gestartete Quellen für dispose().
 * Ergebnis: { input, output, modules } — `modules` = Modul-Instanzen in Kettenreihenfolge (key, update, ggf. setBypass).
 * `opts.bypassable`: jedes Modul in eine Bypass-Hülle setzen (s. _wrapBypass).
 */
export function buildLayerChain(ctx, params, opts = {}) {
  if (!params) return null;
  let segs = _collectSegments(ctx, params, opts.track);
  const sp = _buildSpatialPanner(ctx, params.spatial);
  if (sp) segs.push(sp);
  if (opts.bypassable) segs = segs.map(s => _wrapBypass(ctx, s));
  return _chain(segs);
}

// Fade-Kurven werden zentral in renderPipeline.js (renderSoundGraph()) berechnet,
// auf getrennten, in Serie geschalteten Gain-Nodes.

