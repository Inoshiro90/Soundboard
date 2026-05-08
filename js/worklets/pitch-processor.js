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
 */

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
    this._sr          = sampleRate; // AudioWorkletGlobalScope global
    this._grainSize   = 2048;       // samples per grain
    this._overlap     = 4;          // grains overlap
    this._hopSize     = this._grainSize / this._overlap;
    this._bufLen      = this._grainSize * 8;
    this._inBuf       = new Float32Array(this._bufLen);  // ring: input samples
    this._outBuf      = new Float32Array(this._bufLen);  // overlap-add accumulator
    this._inHead      = 0;   // write pointer in _inBuf
    this._outRead     = 0;   // read pointer in _outBuf
    this._outWrite    = 0;   // write pointer in _outBuf
    this._grainPhase  = 0.0; // fractional read position in _inBuf (input grain head)
    this._window      = this._hannWindow(this._grainSize);
    this._outHop      = this._hopSize;   // fixed output hop
  }

  _hannWindow(n) {
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

  process(inputs, outputs, parameters) {
    const input  = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const pitchFactor = parameters.pitchFactor[0];
    const gs   = this._grainSize;
    const hop  = this._hopSize;
    const bufL = this._bufLen;

    // 1. Write input samples into ring buffer
    for (let i = 0; i < input.length; i++) {
      this._inBuf[this._inHead % bufL] = input[i];
      this._inHead++;
    }

    // 2. For each output sample, read from _outBuf accumulator
    for (let i = 0; i < output.length; i++) {
      output[i] = this._outBuf[this._outRead % bufL] * 0.25; // gain correction
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

    return true;
  }
}

registerProcessor('pitch-shifter-processor', PitchShifterProcessor);
