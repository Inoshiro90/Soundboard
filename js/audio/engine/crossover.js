/**
 * engine/crossover.js — LR4-Frequenzweiche (Linkwitz-Riley 4. Ordnung, 24 dB/Okt.), wiederverwendbarer Baustein (Phase 11e;
 * wird von Multiband Delay P14 und dem Frequenz-Splitter P22 mitbenutzt).
 *
 * Aufbau: Jede Weiche besteht aus zwei kaskadierten Butterworth-Biquads (Q = 1/√2) je Seite. In der Web Audio API ist Q bei
 * `lowpass`/`highpass` in dB angegeben (−3,01 dB), bei `allpass` linear (0,7071).
 *
 *   Dreiband (Grenzen f1 < f2):
 *     Tief  = LP(f1) · AP(f2)            ← Allpass 2. Ordnung bei f2, damit die Phase zu Mitte/Hoch passt
 *     Mitte = HP(f1) · LP(f2)
 *     Hoch  = HP(f1) · HP(f2)
 *   Die Summe der drei Bänder hat einen ebenen Betragsfrequenzgang (LP+HP einer LR4-Weiche = Allpass 2. Ordnung mit Q = 1/√2),
 *   also AP(f1)·AP(f2): nur die Phase dreht sich, der Pegel bleibt.
 *
 * Keine Latenz (IIR). Frequenzen laufen über AudioParams und sind live (geglättet) änderbar.
 */

/** Q einer Butterworth-Stufe 2. Ordnung, linear. */
export const LR4_Q = Math.SQRT1_2;
/** Dasselbe in dB (für `lowpass`/`highpass`). */
export const LR4_Q_DB = 20 * Math.log10(LR4_Q);

function _pair(ctx, type) {
  const a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter();
  a.type = type; b.type = type; a.Q.value = LR4_Q_DB; b.Q.value = LR4_Q_DB;
  a.connect(b);
  return { input: a, output: b, nodes: [a, b] };
}

/**
 * Zweiband-Weiche: `low` = LP4, `high` = HP4 bei `frequency`.
 * @returns {{input:AudioNode, low:AudioNode, high:AudioNode, nodes:AudioNode[], setFrequency:(f:number, set?:(param:AudioParam, v:number)=>void)=>void}}
 */
export function buildCrossover2(ctx, frequency = 1000) {
  const lp = _pair(ctx, 'lowpass'), hp = _pair(ctx, 'highpass');
  const input = ctx.createGain();
  input.connect(lp.input); input.connect(hp.input);
  const nodes = [...lp.nodes, ...hp.nodes];
  const setFrequency = (f, set = (param, v) => { param.value = v; }) => { for (const n of nodes) set(n.frequency, f); };
  setFrequency(frequency);
  return { input, low: lp.output, high: hp.output, nodes: [input, ...nodes], setFrequency };
}

/**
 * Dreiband-Weiche (siehe Kopfkommentar). `outputs` = [Tief, Mitte, Hoch] in dieser Reihenfolge.
 * @returns {{input:AudioNode, outputs:AudioNode[], nodes:AudioNode[], setFrequencies:(f1:number, f2:number, set?:(param:AudioParam, v:number)=>void)=>void}}
 */
export function buildCrossover3(ctx, f1 = 200, f2 = 2500) {
  const input = ctx.createGain();
  const lp1 = _pair(ctx, 'lowpass'), hp1 = _pair(ctx, 'highpass');
  const lp2 = _pair(ctx, 'lowpass'), hp2 = _pair(ctx, 'highpass');
  const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.Q.value = LR4_Q;
  input.connect(lp1.input); input.connect(hp1.input);
  lp1.output.connect(ap);
  hp1.output.connect(lp2.input); hp1.output.connect(hp2.input);
  const low1 = [...lp1.nodes, ...hp1.nodes], at2 = [...lp2.nodes, ...hp2.nodes, ap];
  const setFrequencies = (a, b, set = (param, v) => { param.value = v; }) => {
    for (const n of low1) set(n.frequency, a);
    for (const n of at2) set(n.frequency, b);
  };
  setFrequencies(f1, f2);
  return { input, outputs: [ap, lp2.output, hp2.output], nodes: [input, ...low1, ...at2], setFrequencies };
}
