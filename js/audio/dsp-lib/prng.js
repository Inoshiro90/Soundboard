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

/**
 * Zustandsloser Zufallswert (Phase 20a) für Ereignis `k` mit Strom `salt`, Ergebnis in [0, 1).
 * Anders als createPrng hängt der Wert nur von (seed, k, salt) ab, nicht von der Vorgeschichte: Ereignis k klingt gleich,
 * egal ob die Wiedergabe von vorn läuft, nach einem Loop oder nach einem Seek (Export = Live, Ursprung über arm()).
 * Mischfunktion: lowbias32 (Wellons); k und salt gehen über Multiplikation mit ungeraden Konstanten ein.
 */
export function hashRand(seed, k, salt = 0) {
  let t = (seed >>> 0) ^ Math.imul(k >>> 0, 0x9E3779B1) ^ Math.imul((salt >>> 0) + 1, 0x85EBCA77);
  t ^= t >>> 16; t = Math.imul(t, 0x7FEB352D);
  t ^= t >>> 15; t = Math.imul(t, 0x846CA68B);
  t ^= t >>> 16;
  return (t >>> 0) / 4294967296;
}
