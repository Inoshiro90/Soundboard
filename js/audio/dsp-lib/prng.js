/**
 * audio/dsp-lib/prng.js — Geseedeter Zufallsgenerator (mulberry32). Gleicher Seed ⇒ gleiche Folge, damit
 * Live, Preview und Export identisch klingen (Plan P20/P19). Liefert Zahlen in [0, 1).
 */
export function createPrng(seed = 1) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
