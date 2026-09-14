/**
 * pitch-processor.js — AudioWorklet Processor
 * Granular overlap-add pitch shift.
 * Registered as: 'pitch-shifter-processor'
 *
 * Algorithm: Time-domain overlap-add with grain resampling.
 *   - Reads input into a ring buffer
 *   - On each grain output hop, resamples a grain from the ring buffer
 *     at a rate that corresponds to the desired pitch ratio
 *   - Cross-fades adjacent grains with a Hann window
 *   - This changes pitch while keeping output duration ≈ input duration
 *
 * Quality: Good for ±6 semitones, acceptable up to ±12.
 *
 * STEREO (P1): Die Overlap-Add-Logik ist in `PitchShiftEngine` gekapselt
 * und wird für Kanal L und Kanal R als ZWEI unabhängige Instanzen
 * betrieben (eigener Ringbuffer, eigene Grain-/Phasen-Zustände pro
 * Kanal). Kein Cross-Channel-Processing → unkorrelierte Stereo-Signale
 * werden nicht durch eine gemeinsame Phasenreferenz verfälscht, Panning/
 * Stereobreite bleiben erhalten. Bei Mono-Quellen wird nur die erste
 * Engine-Instanz verwendet (unverändertes Verhalten ggü. vorher).
 */

class PitchShiftEngine {
  constructor(sr, grainSize = 2048, overlap = 4) {
    this._sr          = sr;
    this._grainSize   = grainSize;
    this._overlap     = overlap;
    this._hopSize     = grainSize / overlap;
    this._bufLen      = grainSize * 8;
    this._inBuf        = new Float32Array(this._bufLen);  // ring: input samples
    this._outBuf        = new Float32Array(this._bufLen);  // overlap-add accumulator
    this._inHead       = 0;   // write pointer in _inBuf
    this._outRead      = 0;   // read pointer in _outBuf
    this._outWrite      = 0;   // write pointer in _outBuf
    this._window       = PitchShiftEngine._hannWindow(grainSize);
  }

  static _hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    return w;
  }

  /** Linear interpolation read from ring buffer at fractional index */
  _readRing(buf, pos) {
    const len  = buf.length;
    const i0   = Math.floor(pos) % len;
    const i1   = (i0 + 1) % len;
    const frac = pos - Math.floor(pos);
    return buf[(i0 + len) % len] * (1 - frac) + buf[(i1 + len) % len] * frac;
  }

  /**
   * Verarbeitet einen Audioblock für GENAU diesen Kanal. Eigenständige,
   * instanziierbare Kapselung der ursprünglichen Mono-process()-Logik
   * (siehe Klassendoku oben), damit L/R unabhängig voneinander laufen
   * können, ohne sich Ringbuffer/Phasenzustand zu teilen.
   */
  processBlock(inputChannel, outputChannel, pitchFactor) {
    const gs   = this._grainSize;
    const hop  = this._hopSize;
    const bufL = this._bufLen;

    // 1. Write input samples into ring buffer
    for (let i = 0; i < inputChannel.length; i++) {
      this._inBuf[this._inHead % bufL] = inputChannel[i];
      this._inHead++;
    }

    // 2. For each output sample, read from _outBuf accumulator
    for (let i = 0; i < outputChannel.length; i++) {
      outputChannel[i] = this._outBuf[this._outRead % bufL] * 0.25; // gain correction
      this._outBuf[this._outRead % bufL] = 0; // clear after read
      this._outRead++;

      // 3. Every _outHop samples, synthesize a new grain
      if ((this._outRead - (this._outWrite - gs)) % hop === 0) {
        // Input grain hop (adjusted by pitch factor for pitch shift)
        const inGrainStart = this._inHead - gs - hop;

        for (let j = 0; j < gs; j++) {
          // Read from input ring at pitch-adjusted position
          const inPos = inGrainStart + j * pitchFactor;
          const sample = this._readRing(this._inBuf, ((inPos % bufL) + bufL) % bufL);
          const outPos = (this._outWrite + j) % bufL;
          this._outBuf[outPos] += sample * this._window[j];
        }
        this._outWrite += hop;
      }
    }
  }
}

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name:         'pitchFactor',  // ratio: 2^(semitones/12), 1.0 = no shift
      defaultValue: 1.0,
      minValue:     0.25,
      maxValue:     4.0,
      automationRate: 'k-rate'
    }];
  }

  constructor() {
    super();
    // sampleRate ist ein Global im AudioWorkletGlobalScope.
    this._engines = [new PitchShiftEngine(sampleRate), new PitchShiftEngine(sampleRate)];
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;

    const pitchFactor = parameters.pitchFactor[0];

    // Bypass-Optimierung: bei pitchFactor===1 (kein Pitch-Shift) Signal
    // unverändert durchreichen statt durch die Grain-Engine zu schicken.
    // Spart CPU und vermeidet die prinzipbedingten minimalen Fensterungs-
    // Artefakte des Overlap-Add-Verfahrens (bit-identischer Durchlauf).
    if (pitchFactor === 1) {
      const chCount = Math.min(input.length, output.length);
      for (let ch = 0; ch < chCount; ch++) output[ch].set(input[ch]);
      return true;
    }

    // Jeder Kanal bekommt seine EIGENE Engine-Instanz — kein gemeinsamer
    // Zustand zwischen L und R.
    const chCount = Math.min(input.length, output.length, this._engines.length);
    for (let ch = 0; ch < chCount; ch++) {
      this._engines[ch].processBlock(input[ch], output[ch], pitchFactor);
    }
    return true;
  }
}

registerProcessor('pitch-shifter-processor', PitchShifterProcessor);
