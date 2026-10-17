/**
 * audio/engine/reverb-hub.js — Geteilter Reverb-Send (Phase 3b, AE-17)
 *
 * Statt je Voice einen eigenen ConvolverNode zu bauen, speisen sendfähige Voices ihr Signal über einen Send-Gain in
 * EINEN gemeinsamen Convolver je Impulsantwort („Hub“). Grundlage: Faltung ist linear und zeitinvariant,
 *   Σᵢ wᵢ·(h ∗ xᵢ) = h ∗ (Σᵢ wᵢ·xᵢ).
 *
 * SENDFÄHIG (describeSend/fx-pipeline.sendEligibility): das klingende Hall-Modul gehört zum letzten klingenden Schritt
 * des Plans, und im selben Layer folgt nach ihm kein klingendes Modul (Delay, Tremolo, Noise-Gate, Spatial).
 *
 * VERDRAHTUNG (eine Voice), alle Abgriffe HINTER dem Master-Gain (Fades und Lautstärke wirken auf Dry und Send):
 *   masterGain → dryG (1−wet) ──────────────┐
 *   masterGain → Stand-in-Convolver → ×ε ──┴→ Summe → terminaler Panner → Ausgang
 *   masterGain → sendG (wet) → Hub.input → Convolver(IR) → Panner → Ausgang
 * Der Stand-in-Convolver (1-Sample-Einheits-IR, Gain 0) bildet die KANALFORM des bisherigen Hall-Bausteins nach: der
 * Ausgang eines Convolvers ist je Engine mono oder stereo (M-3); die Summe mit dem Trockenanteil hängt davon ab. So
 * ist der Pegel (Mono 0 oder −3,01 dB) je Engine exakt der bisherige — ohne Annahme über den Browser.
 *
 * BEWUSSTE KLANGÄNDERUNG (D1): der Hall sitzt jetzt NACH Fade und Lautstärke. Ein Fade-Out oder Crossfade kappt den
 * Nachhall nicht mehr; er klingt aus. Bei statischer Lautstärke ohne Fades ist das Ergebnis mathematisch gleich.
 *
 * LEBENSZYKLUS: Referenzzähler. Live: nach der letzten Abmeldung wird der Hub nach IR-Länge + 0,5 s freigegeben
 * (`buffer = null` gegen das Chrome-Leck L-02, trennen, verwerfen); eine neue Anmeldung bricht das ab. Offline-Context
 * und Scope 'preview': sofort bei der letzten Abmeldung (die Vorschau klang bisher bei Stopp ebenfalls sofort ab).
 * Die Vorschau hat einen EIGENEN Hub (Scope), damit sie nie den Hub der Live-Wiedergabe berührt (Invariante 5).
 */

import { getIRBuffer, getGenericIR } from '../ir-data.js';
import { buildTerminalPanner } from '../effect-graph.js';
import { outputFor } from './output.js';

const clamp01 = v => Math.max(0, Math.min(1, v));

/** Beschreibung des Sends für ein Hall-Modul (rein, ohne Context). null für andere Module. */
export function describeSend(key, p) {
  if (key === 'irReverb') {
    return { key, wet: clamp01(p.wet ?? 0.35), irKey: 'ir:' + (p.impulse || 'default') + (p.irMax ? '@' + p.irMax : ''), getIR: ctx => getIRBuffer(ctx, p.impulse, p.irMax) };
  }
  if (key === 'reverb') {
    return { key, wet: clamp01(p.amount ?? 0.35), irKey: `g:${p.duration ?? 2.2}|${p.decay ?? 2.0}|${p.pre ?? 0.005}`, getIR: ctx => getGenericIR(ctx, p) };
  }
  return null;
}

const _registry = new WeakMap();   // ctx → Map<hubKey, Hub>
const _ids = new WeakMap(); let _idN = 0;
const _idOf = node => { let i = _ids.get(node); if (!i) { i = ++_idN; _ids.set(node, i); } return i; };
const _unitIR = new Map();         // Abtastrate → 2-kanalige 1-Sample-Einheits-IR (Stand-in)
function _standInIR(ctx) {
  let b = _unitIR.get(ctx.sampleRate);
  if (!b) { b = ctx.createBuffer(2, 1, ctx.sampleRate); b.getChannelData(0)[0] = 1; b.getChannelData(1)[0] = 1; _unitIR.set(ctx.sampleRate, b); }
  return b;
}
const _isOffline = ctx => typeof ctx.startRendering === 'function';

class Hub {
  constructor(ctx, map, key, destination, ir, scope) {
    this.ctx = ctx; this.map = map; this.key = key;
    this.refs = 0; this.dead = false; this.timer = null;
    this.irSeconds = ir.duration;
    this.immediate = _isOffline(ctx) || scope === 'preview';
    this.input = ctx.createGain();
    this.conv = ctx.createConvolver();
    this.conv.buffer = ir;
    this.input.connect(this.conv);
    this.pan = buildTerminalPanner(ctx, 0);
    if (this.pan) { this.conv.connect(this.pan.input); this.pan.output.connect(destination); }
    else this.conv.connect(destination);
  }
  attach() { this.refs++; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  detach() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0 || this.dead) return;
    if (this.immediate) this.dispose();
    else this.timer = setTimeout(() => { this.timer = null; if (this.refs === 0) this.dispose(); }, Math.ceil((this.irSeconds + 0.5) * 1000));
  }
  dispose() {
    if (this.dead) return;
    this.dead = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.map.get(this.key) === this) this.map.delete(this.key);
    try { this.input.disconnect(); } catch (e) { /* ignorieren */ }
    try { this.conv.buffer = null; } catch (e) { /* Engine ohne Unterstützung */ }   // L-02: native Faltungs-Engine freigeben
    try { this.conv.disconnect(); } catch (e) { /* ignorieren */ }
    try { this.pan?.input.disconnect(); } catch (e) { /* ignorieren */ }
  }
}

/** Anzahl lebender Hubs eines Contexts (Tests/Diagnose). */
export function hubCount(ctx) { return _registry.get(ctx)?.size || 0; }

/**
 * Hängt eine Voice an den Hub: Abgriffe von `from` (= Master-Gain der Voice) zu Dry-Pfad und Send.
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} from      Master-Gain der Voice
 * @param {{send:object, channels?:number, destination?:AudioNode, scope?:'main'|'preview'}} o
 * @returns {{dispose:()=>void, hub:Hub}}
 */
export function attachSend(ctx, from, { send, channels = 2, destination, scope = 'main' } = {}) {
  destination = destination || outputFor(ctx, 'hub');
  const ir = send.getIR(ctx);
  let map = _registry.get(ctx); if (!map) { map = new Map(); _registry.set(ctx, map); }
  const key = [ctx.sampleRate, scope, _idOf(destination), Math.min(2, channels), send.irKey].join('|');
  let hub = map.get(key);
  if (!hub || hub.dead) { hub = new Hub(ctx, map, key, destination, ir, scope); map.set(key, hub); }
  hub.attach();

  // Kanalform-Stand-in: der bisherige Hall-Baustein ließ die Summe (Dry + Hall) bei Anteil > 0 stereo werden. Engines entscheiden das
  // dynamisch: ein Zweig mit (fast) Gain 0 gilt als Stille und zählt nicht mit (gemessen in Node: Schwelle zwischen 1e-7 und 1e-5).
  // Deshalb trägt der Stand-in ε = 1e-4 (Einheits-IR ohne Normalisierung = exakt +ε·x) und der Dry-Gain gleicht es aus (1−wet−ε):
  // die Summe bleibt rechnerisch (1−wet)·x. Bei Anteil 0 war der Zweig auch früher still → ε = 0.
  const EPS = send.wet > 0 ? 1e-4 : 0;
  const dryG = ctx.createGain(); dryG.gain.value = 1 - send.wet - EPS;
  const sum = ctx.createGain();
  const probe = ctx.createConvolver(); probe.normalize = false; probe.buffer = _standInIR(ctx);
  const probeG = ctx.createGain(); probeG.gain.value = EPS;
  const sendG = ctx.createGain(); sendG.gain.value = send.wet;
  from.connect(dryG); dryG.connect(sum);
  from.connect(probe); probe.connect(probeG); probeG.connect(sum);
  from.connect(sendG); sendG.connect(hub.input);
  const pan = buildTerminalPanner(ctx, 0);
  if (pan) { sum.connect(pan.input); pan.output.connect(destination); } else sum.connect(destination);

  let done = false;
  const dispose = () => {
    if (done) return; done = true;
    for (const n of [dryG, sum, probe, probeG, sendG, pan?.input]) { try { n?.disconnect(); } catch (e) { /* ignorieren */ } }
    for (const n of [dryG, probe, sendG]) { try { from.disconnect(n); } catch (e) { /* ignorieren */ } }
    try { probe.buffer = null; } catch (e) { /* ignorieren */ }
    hub.detach();
  };
  return { dispose, hub };
}
