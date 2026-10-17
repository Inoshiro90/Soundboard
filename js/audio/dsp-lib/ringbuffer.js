/**
 * audio/dsp-lib/ringbuffer.js — Ringpuffer für Float32-Samples (Grundlage für Delay-Line/Time-Buffer, ab P12/P20).
 * Der Speicher wird einmal im Konstruktor angelegt; `push`/`read` allokieren nicht.
 */
export class RingBuffer {
  /** @param {number} length Kapazität in Samples (≥ 1) */
  constructor(length) {
    this.length = Math.max(1, length | 0);
    this.data = new Float32Array(this.length);
    this.writeIndex = 0;
  }

  clear() { this.data.fill(0); this.writeIndex = 0; }

  push(x) {
    this.data[this.writeIndex] = x;
    this.writeIndex = this.writeIndex + 1 === this.length ? 0 : this.writeIndex + 1;
  }

  /** Sample, das `delay` Samples vor dem zuletzt geschriebenen liegt (delay 0 = zuletzt geschrieben). */
  read(delay) {
    let i = this.writeIndex - 1 - (delay | 0);
    i %= this.length; if (i < 0) i += this.length;
    return this.data[i];
  }
}
