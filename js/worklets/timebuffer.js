/**
 * timebuffer.js — AudioWorklet Processor (Phase 20a, AE-09): Time-Buffer-Engine, ein Prozessor für Stutter, Beat Repeat, Retrigger,
 * Reverse- und Granular-Delay. Registriert als: 'timebuffer-processor'
 *
 * Ein Eingang, ein Ausgang, beide fest stereo (der Knoten setzt channelCount 2 'explicit' und outputChannelCount [2]; Mono wird davor über
 * einen StereoPanner bei pan 0 hochgemischt, M-3: L = R mit −3,01 dB). Grund: Köpfe klingen nach dem Ende der Quelle weiter; ein dynamischer
 * Ausgang fiele dann auf einen Kanal zurück (Eingang ohne Kanäle). Rechenkern: audio/dsp-lib/timebuffer.js
 * (per `import`, wie crusher.js: Chrome/Firefox/Node [S], Safari/iOS offen [H]).
 * Parameter (k-rate): dry 0…1, wet 0…1.
 * processorOptions (beim Bau fest, Änderung = Neubau):
 *   maxSeconds  Pufferlänge (der Puffer wird im Konstruktor angelegt, also erst wenn das Modul aktiv gebaut wird)
 *   seed        Startwert der Zufallsentscheidungen (hashRand je Ereignis)
 *   mode        'thru' (20a: nur Puffer schreiben, Ausgang = dry · Eingang) | 'probe' (Lastprobe, nur M-1/Tests) | 'stutter' (20b)
 *               | 'beatRepeat' (20c) | 'retrigger' (20d) | 'reverseDelay' (20e, Delay-Modus `reverse`) | 'granularDelay' (20f, Delay-Modus `granular`)
 *   probeHeads  Anzahl gleichzeitiger Köpfe im Modus 'probe'
 *   params      Modus 'stutter' / 'beatRepeat' / 'retrigger': Startwerte der Regler (audio/dsp-lib/stutter.js stutterParams, beat-repeat.js beatRepeatParams
 *               bzw. retrigger.js retriggerParams)
 * Port (Modi 'stutter', 'beatRepeat' und 'retrigger', 20b–20d, gleiches Protokoll): { type: 'params', params } neue Regler (ab dem nächsten Ereignis), { type: 'arm', timing } Zeitbasis in
 * Context-Frames (originF, passStartF, passIndex, durF, loop, seed), { type: 'hold' } Musik-Pause. Der Planer bekommt je Block den
 * Context-Frame des ersten Samples (`currentFrame`), damit Ereignisse sample-genau zur Quelle liegen.
 * 'retrigger' (20d) erkennt Anschläge im Eingang selbst (Planer liest das geschriebene Sample aus dem Ring). Weitere Planer (20e ff.) kommen als Modi hinzu.
 * 'reverseDelay' (20e): gleiches Port-Protokoll; params = audio/dsp-lib/reverse-delay.js reverseDelayParams (time, feedback, wet), arm() erkennt
 * nur den Neustart (Seek leert den Ring), hold() wirkt nicht. Die Rückkopplung schreibt der Planer in den Ring (kein Haltepuffer).
 * 'granularDelay' (20f): wie 'reverseDelay'; params = audio/dsp-lib/granular-delay.js granularDelayParams. Der Zufall nutzt nur den festen
 * `seed` aus processorOptions (arm() bringt keinen neuen, Entscheidung E).
 * Ohne Eingang (Quelle beendet) wird Stille geschrieben; laufende Köpfe spielen weiter. 'dispose' über den Port beendet den Prozessor.
 */
import { TimeBuffer, TbProbe } from '../audio/dsp-lib/timebuffer.js';
import { StutterSched, STUTTER_HOLD_SECONDS } from '../audio/dsp-lib/stutter.js';
import { BeatRepeatSched, BEATREPEAT_HOLD_SECONDS } from '../audio/dsp-lib/beat-repeat.js';
import { RetriggerSched, RETRIGGER_HOLD_SECONDS } from '../audio/dsp-lib/retrigger.js';
import { ReverseDelaySched } from '../audio/dsp-lib/reverse-delay.js';
import { GranularDelaySched } from '../audio/dsp-lib/granular-delay.js';

const K = 'k-rate';
class TimeBufferProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'dry', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: K },
      { name: 'wet', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: K }
    ];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this._alive = true;
    const stutter = o.mode === 'stutter', beat = o.mode === 'beatRepeat', retrig = o.mode === 'retrigger', rev = o.mode === 'reverseDelay', gran = o.mode === 'granularDelay';
    const timed = stutter || beat || retrig || rev || gran;   // Planer mit Zeitbasis (Port params/arm/hold)
    this._k = new TimeBuffer(sampleRate, 2, Number.isFinite(o.maxSeconds) ? o.maxSeconds : 4, stutter ? STUTTER_HOLD_SECONDS : beat ? BEATREPEAT_HOLD_SECONDS : retrig ? RETRIGGER_HOLD_SECONDS : 0);
    if (timed) { this._sched = stutter ? new StutterSched(sampleRate) : beat ? new BeatRepeatSched(sampleRate) : retrig ? new RetriggerSched(sampleRate) : gran ? new GranularDelaySched(sampleRate) : new ReverseDelaySched(sampleRate); this._sched.seed = Number.isFinite(o.seed) ? o.seed >>> 0 : 1; this._sched.setParams(o.params || {}); }
    else this._sched = o.mode === 'probe' ? new TbProbe(sampleRate, Number.isFinite(o.probeHeads) ? o.probeHeads : 8, Number.isFinite(o.seed) ? o.seed : 1) : null;
    this.port.onmessage = e => {
      const d = e && e.data;
      if (d === 'dispose') { this._alive = false; return; }
      if (!timed || !d || typeof d !== 'object') return;
      if (d.type === 'params') this._sched.setParams(d.params || {});
      else if (d.type === 'arm' && d.timing) this._sched.arm(d.timing);
      else if (d.type === 'hold') this._sched.hold();
    };
    this._p = { dry: 1, wet: 1 };
  }

  process(inputs, outputs, params) {
    if (!this._alive) return false;
    const out = outputs[0];
    if (!out || !out.length) return true;
    const p = this._p;
    p.dry = params.dry[0]; p.wet = params.wet[0];
    if (this._sched && this._sched.block) this._sched.block(currentFrame, this._k.t);
    this._k.process(inputs[0], out, out[0].length, p, this._sched);
    return true;
  }
}

registerProcessor('timebuffer-processor', TimeBufferProcessor);
