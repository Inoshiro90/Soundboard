/**
 * audio/preview.js — Effekt-Editor-Vorschau
 */

import { makeAdmit, stagger } from './engine/budget.js';   // Phase 3a
import { setIcon } from '../ui/icons.js';
import { APP } from '../core/state.js';
import { toast } from '../notifications.js';
import { bk } from '../utils.js';
import { getOrDecodeBuffer } from '../audioCache.js';
import { renderSoundGraph } from '../renderPipeline.js';
import { actx } from './context.js';
import { outputFor, connectToOutput } from './engine/output.js';   // Phase 4: einziger Ausgang
import { startPreviewMeter, stopPreviewMeter } from '../ui/meters.js';   // Phase 7: Peak-Anzeige der Vorschau
import { resolvePlan, connectPipeline, TARGET_CAPS } from './fx-pipeline.js';
import { asPipelineEffects } from '../fx-model.js';
import { buildNoiseGenerator } from '../generators.js';

/*
 * Effekt-Editor-Preview (isolierter Lifecycle)
 * Läuft komplett NEBEN der normalen Soundboard-Wiedergabe: eigener State
 * (APP.audioPreview statt APP.activeAudio), kein _setPlaying()/kein
 * Tile-Highlight, kein Auto-Duck, keine Rotation-/Fortschrittsanzeige,
 * kein stopAll()/stopItem() auf echte Sounds. Nutzt aber dieselbe
 * renderSoundGraph()-Pipeline wie Live-Playback/Export —
 * dieselben Effekte, keine zweite Engine.
 *
 * previewSound() ist der öffentliche Einstiegspunkt und togglet intern zwischen
 * startEffectPreview()/stopEffectPreview().
 */

function _stopPreviewSourceOnly() {
  const p = APP.audioPreview;
  if (p.src) {
    // Mehrfaches/zu spätes .stop() (Quelle bereits von selbst
    // beendet) darf nie zu einem sichtbaren Fehler führen.
    try { p.src.onended = null; } catch (e) { /* ignorieren */ }
    // Rauschgenerator-Preview: AudioWorkletNode kennt kein .stop() — nur trennen.
    // Ein unbedingtes stop() würfe hier und ließe den Node dauerhaft weiterlaufen.
    try { if (p.kind === 'noise') p.src.disconnect(); else p.src.stop(); } catch (e) { /* bereits beendet — ignorieren */ }
    // Zusätzlich die Gain-Kette trennen, damit nach dem Stopp garantiert nichts mehr
    // hörbar am Ausgang hängt (z. B. Effekt-Nachhall-Reste) und der Graph freigegeben wird.
    try { p.masterGain?.disconnect(); } catch (e) { /* ignorieren */ }
  }
}

/**
 * Zentrale, einzige Cleanup-Stelle für die Effekt-Editor-Preview (PreviewSession, Phase 7).
 * Wird aufgerufen bei: Stop-Klick, Ende des Nachklangs, Start einer neuen Preview (ersetzt die alte),
 * Modal-Schließen, Speichern und Abbrechen. Sofort und ohne Auslauf — der Nachklang nach dem natürlichen
 * Ende (siehe `_onSourceEnded`) wird dabei bewusst abgebrochen.
 *
 * Phase 7 (B-06 strukturell): Die Quelle wird als Buffer-Referenz übergeben, es gibt keine Alias-Einträge
 * (`_fxpreview_*`/`_ambpreview_*`) mehr in `APP.audioBuffers`.
 */
export function stopEffectPreview() {
  const p = APP.audioPreview;
  p.token++; // entwertet jede noch wartende startEffectPreview()-Anfrage (Decode/Graph-Aufbau)
  if (p.endTimer) { clearTimeout(p.endTimer); p.endTimer = null; }
  stopPreviewMeter();
  _stopPreviewSourceOnly();
  p.playing = false; p.loading = false; p.ending = false; p.bypass = false;
  if (p.dispose) { try { p.dispose(); } catch (e) {} p.dispose = null; }   // LFOs/Träger/Worklets der Effektkette freigeben
  p.src = null; p.masterGain = null; p.runtime = null;
  p.soundId = null; p.slotIdx = null; p.kind = null;
  _updatePreviewButton();
}

/**
 * Live-Update der laufenden Vorschau (Phase 7, B-05): `effects` = aktueller Dialogzustand (readEffectsFromUI()).
 * Parameter wirken sofort (setTargetAtTime), eine Strukturänderung (Modul an/aus, Layer) wird per swapTo überblendet.
 * Rückgabe: Promise (resolved, wenn angewendet) oder null, wenn keine live-fähige Vorschau läuft.
 * Kosten der Voice werden bei Updates nicht nachgemeldet (wie bei der Musik).
 */
export function updatePreviewEffects(effects) {
  const p = APP.audioPreview;
  const rt = p.runtime;
  if (!p.playing || !rt || !rt.live || rt.disposed) return null;
  let plan;
  try { plan = resolvePlan(asPipelineEffects(effects)); } catch (e) { console.warn('[preview] Plan ungültig:', e); return null; }
  return Promise.resolve(rt.update(plan)).catch(e => console.warn('[preview] Live-Update fehlgeschlagen:', e));
}

let _rafPending = false, _getFx = null;
/**
 * Fasst Änderungsereignisse (z. B. Regler-`input`, 60+/s) pro Animationsframe zusammen und wendet dann EINEN Live-Update an.
 * `getEffects` liefert den aktuellen Effektstand erst beim Anwenden (immer der neueste). Ohne laufende Vorschau: nichts zu tun.
 */
export function schedulePreviewUpdate(getEffects) {
  if (!APP.audioPreview.playing) return;
  _getFx = getEffects;
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    const f = _getFx; _getFx = null;
    if (f && APP.audioPreview.playing) updatePreviewEffects(f());
  });
}

/** Loop-Schalter der Vorschau (gilt ab dem nächsten Start; im Dialog als Hinweis am Button). */
export function setPreviewLoop(on) {
  APP.audioPreview.loop = !!on;
  _updatePreviewButton();
}

/** A/B: Effekte klickfrei umgehen (true) bzw. wieder einschalten (false). Nur bei laufender Vorschau; Rückgabe = Erfolg. */
export function setPreviewBypass(on) {
  const p = APP.audioPreview;
  if (!p.playing || !p.runtime || !p.runtime.live) return false;
  if (!p.runtime.setPipelineBypass(!!on)) return false;
  p.bypass = !!on;
  _updatePreviewButton();
  return true;
}

/**
 * Natürliches Ende der Quelle: Die Session bleibt für den Nachklang (`runtime.tailSeconds()`) bestehen und
 * räumt danach auf. Ohne nennenswerten Nachklang sofort (wie bisher). Ein Stop-Klick beendet sie jederzeit sofort.
 */
function _onSourceEnded(src) {
  const p = APP.audioPreview;
  // onended kann auch von einer bereits ERSETZTEN Quelle nachträglich feuern — nur reagieren, wenn es noch DIESE ist.
  if (p.src !== src) return;
  let tail = 0;
  try { tail = p.runtime?.tailSeconds?.() ?? 0; } catch (e) { tail = 0; }
  if (!(tail > 0.05)) { stopEffectPreview(); return; }
  const myToken = p.token;
  p.ending = true;
  p.endTimer = setTimeout(() => { if (APP.audioPreview.token === myToken) stopEffectPreview(); }, Math.min(30, tail) * 1000 + 100);
  _updatePreviewButton();
}

/**
 * Hängt die Preview-Bereinigung an den Lebenszyklus eines Editor-Modals (#soundModal — Sound- UND
 * Ambient-Editor teilen es). Eine einzige, zentrale Stelle für ALLE Schließwege (X, Abbrechen,
 * Escape, Backdrop, programmatisches hide() nach Speichern/Löschen):
 *
 *  - hide.bs.modal:   Das Schließen beginnt → sofort stoppen. Bewusst ein EIGENER Listener und nicht
 *                     Teil des Draft-Guards (modalGuards.js): der Guard kann das Schließen per
 *                     preventDefault() zunächst abbrechen und eine Rückfrage zeigen — die Vorschau
 *                     soll aber so oder so enden, damit nie Audio über eine blockierende
 *                     Rückfrage hinweg weiterläuft.
 *  - hidden.bs.modal: Sicherheitsnetz. Während der Ausblend-Animation (~0,3 s) ist der Dialog noch
 *                     klickbar; startet dort jemand noch eine Vorschau, wäre sie nach hide.bs.modal
 *                     nicht mehr erfasst. Feuert nicht, wenn der Guard das Schließen abbricht.
 *
 * Idempotent pro Element.
 */
export function bindPreviewModalLifecycle(modalEl) {
  if (!modalEl || modalEl._previewLifecycleBound) return;
  modalEl._previewLifecycleBound = true;
  modalEl.addEventListener('hide.bs.modal',   () => stopEffectPreview());
  modalEl.addEventListener('hidden.bs.modal', () => stopEffectPreview());
}

async function startEffectPreview(s, slotIdx, opts = {}) {
  const p = APP.audioPreview;
  stopEffectPreview(); // Eine evtl. laufende/ladende Preview immer zuerst sauber beenden
  const myToken = p.token; // stopEffectPreview() hat token bereits erhöht — dieser Aufruf "besitzt" ihn jetzt

  const slot = s.slots?.[slotIdx];
  if (!slot?.data) { toast('Slot ' + (slotIdx + 1) + ' leer'); return; }

  p.loading = true; _updatePreviewButton();
  actx(); // stellt AudioContext innerhalb der User-Geste sicher
  const ctx = actx();

  // Quelle als Buffer-Referenz (Phase 7): der Aufrufer löst den Entwurfs-/Cache-Buffer auf (`opts.buffer`), es wird nichts
  // unter einer Preview-ID im Buffer-Cache abgelegt. Fallbacks: `opts.loadBuffer` (Entwurf: Audio liegt nur als IDB-Verweis
  // vor), sonst regulärer Decode. Läuft im selben Token-Schutz.
  let buf = opts.buffer || null;
  if (!buf) {
    try {
      buf = opts.loadBuffer
        ? await opts.loadBuffer(slotIdx)
        : await getOrDecodeBuffer(s.id, slotIdx, slot.data, ctx);
    } catch (e) {
      console.error('[audio] Preview-Decode-Fehler:', e);
      buf = null;
    }
  }
  if (myToken !== p.token) return; // zwischenzeitlich gestoppt/durch neue Preview ersetzt

  if (!buf) {
    toast('Audio konnte nicht geladen werden', 'err');
    p.loading = false; _updatePreviewButton();
    return;
  }

  let graph;
  try {
    // mode:'preview' — dieselbe Pipeline wie Live/Export. Phase 7: live:true (update/swapTo/A-B). Live-Runtime und geteilter Hall
    // schließen sich aus (runtime.js) → Hall pro Stimme (klanglich exakt); keine Degradation, damit Updates denselben Plan wie der Start nutzen.
    const voiceRef = {};
    graph = await renderSoundGraph(ctx, buf, slot, s, { mode: 'preview', destination: outputFor(ctx, 'preview'), live: true, loopPreview: !!p.loop,
      admit: makeAdmit({ kind: 'preview', id: s.id, loop: !!p.loop, ref: voiceRef, share: false, noDegrade: true }), stagger });   // Phase 3a: gezählt, nie entzogen
    voiceRef.graph = graph;
  } catch (e) {
    console.error('[audio] Preview-Graph-Fehler:', e);
    graph = null;
  }
  if (myToken !== p.token) {
    // Zwischenzeitlich gestoppt/durch neue Preview ersetzt, während der
    // Graph aufgebaut wurde — src wurde noch nie gestartet, daher
    // disconnect() statt stop() (stop() vor start() wirft InvalidStateError).
    try { graph?.src.disconnect(); graph?.dispose(); } catch (e) {}
    return;
  }

  if (!graph) {
    toast('Vorschau-Fehler', 'err');
    p.loading = false; _updatePreviewButton();
    return;
  }

  const { src, masterGain, dur } = graph;
  p.loading = false; p.playing = true;
  p.src = src; p.masterGain = masterGain; p.dispose = graph.dispose; p.runtime = graph.runtime;
  p.soundId = s.id; p.slotIdx = slotIdx; p.kind = 'buffer';

  src.onended = () => _onSourceEnded(src);

  try {
    graph.start(0);
  } catch (e) {
    // start() darf nie einen „spielt"-Zustand ohne Ton zurücklassen.
    console.error('[audio] Preview-Start-Fehler:', e);
    stopEffectPreview();
    toast('Vorschau-Fehler', 'err');
    return;
  }
  _updatePreviewButton();
  startPreviewMeter(ctx);

  void dur; // (aktuell ungenutzt — Preview braucht keine Fortschrittsanzeige)
}

/**
 * Öffentlicher Einstiegspunkt: togglet die Effekt-Editor-Preview für Sound
 * `s`, Slot `slotIdx`. Läuft bereits eine Preview (spielend oder ladend),
 * wird sie gestoppt — Argumente werden dann ignoriert.
 * Sonst wird eine neue gestartet (ersetzt automatisch eine evtl. andere
 * laufende Preview).
 */
export async function previewSound(s, slotIdx, opts = {}) {
  if (APP.audioPreview.playing || APP.audioPreview.loading) { stopEffectPreview(); return; }
  await startEffectPreview(s, slotIdx ?? 0, opts);
}

/**
 * Ambient-Rauschgenerator-Vorschau — gleicher Lifecycle wie die Datei-Preview (APP.audioPreview,
 * Token, stopEffectPreview(), _updatePreviewButton()), nur mit einem Worklet-Node als Quelle statt
 * eines AudioBufferSource. Läuft endlos bis zum Stopp (wie der Generator selbst), vollständig
 * getrennt von der normalen Ambient-Wiedergabe (_active in ambient-playback.js).
 * Toggle wie previewSound(): läuft/lädt bereits eine Preview, wird sie gestoppt.
 *
 * @param {{ generatorType: string, vol: number, effects: object }} g
 */
export async function previewNoiseGenerator(g) {
  const p = APP.audioPreview;
  if (p.playing || p.loading) { stopEffectPreview(); return; }

  stopEffectPreview();            // defensiv, setzt auch den Token neu
  const myToken = p.token;
  p.loading = true; p.kind = 'noise'; _updatePreviewButton();
  actx();
  const ctx = actx();

  let node = null;
  try { node = await buildNoiseGenerator(ctx, g.generatorType || 'pink'); }
  catch (e) { console.error('[audio] Rauschgenerator-Preview-Fehler:', e); node = null; }

  if (myToken !== p.token) { try { node?.disconnect(); } catch (e) {} return; } // zwischenzeitlich gestoppt

  if (!node) {
    toast('Rauschgenerator konnte nicht geladen werden', 'err');
    p.loading = false; p.kind = null; _updatePreviewButton();
    return;
  }

  const masterGain = ctx.createGain();
  masterGain.gain.value = Number.isFinite(g.vol) ? g.vol : 0.7;
  // Gleiche Pipeline wie überall: Quelle → Medium → Umgebung → Hörer (Benutzerreihenfolge), dann masterGain.
  let conn = null;
  try { conn = await connectPipeline(ctx, node, resolvePlan(asPipelineEffects(g.effects)), masterGain, { caps: TARGET_CAPS.noise, numChannels: 2, live: true }); }
  catch (e) { console.error('[audio] Rauschgenerator-Pipeline-Fehler:', e); node.connect(masterGain); }
  if (myToken !== p.token) { try { conn?.dispose(); node.disconnect(); } catch (e) {} return; }
  connectToOutput(masterGain, 'preview');

  p.loading = false; p.playing = true; p.kind = 'noise';
  p.src = node; p.masterGain = masterGain; p.dispose = conn ? conn.dispose : null; p.runtime = conn?.graph?.runtime ?? null;
  p.soundId = '_noisepreview'; p.slotIdx = 0;
  _updatePreviewButton();
  startPreviewMeter(ctx);

}

/**
 * Einzige Stelle, die die Vorschau-Buttons beschriftet. Zustand kommt ausschließlich aus
 * APP.audioPreview (playing/loading) — jeder Pfad, der diese Flags ändert, ruft danach
 * _updatePreviewButton() auf (Start, Laden, Fehler, Stopp, natürliches Ende, Modal-Schließen).
 *
 * Zustände (beide Buttons identisch):
 *   Stopp    : Play-Icon,   Label „Vorschau abspielen", kein .is-active
 *   Laden    : Spinner,     Label „Vorschau stoppen" (Klick bricht ab!), .is-active, aria-busy
 *   Spielend : Square-Icon, Label „Vorschau stoppen", .is-active
 * Der Button wird NIE deaktiviert — auch während des Ladens/Dekodierens muss ein zweiter Klick
 * die Vorschau sofort stoppen können (stopEffectPreview() entwertet den laufenden Start per Token).
 */
function _updatePreviewButton() {
  const p = APP.audioPreview;
  const active = p.loading || p.playing;
  const label  = active ? 'Vorschau stoppen' : 'Vorschau abspielen';
  ['btnPreviewSound', 'btnPreviewFx', 'btnPreviewFxLayer'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const icon = btn.querySelector('.ui-icon');
    btn.disabled = false;
    if (p.loading)      setIcon(icon, 'loader-circle', 'ui-icon--spin');
    else if (p.playing) setIcon(icon, 'square', 'u-text-accent');
    else                setIcon(icon, 'play', 'u-text-accent');
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
    btn.toggleAttribute('aria-busy', p.loading);
    btn.setAttribute('aria-label', label);
    btn.title = label;
    // Sichtbarer Text (nur #btnPreviewSound hat ein .btn__label)
    const txt = btn.querySelector('.btn__label');
    if (txt) txt.textContent = active ? 'Stoppen' : 'Vorschau';
  });
  // Phase 7: Loop (gilt ab dem nächsten Start) und A/B (nur bei laufender Vorschau, Effekte klickfrei umgehen).
  for (const id of ['btnPreviewLoop', 'btnPreviewLoopLayer']) document.getElementById(id)?.setAttribute('aria-pressed', String(!!p.loop));
  for (const id of ['btnPreviewAB', 'btnPreviewABLayer']) {
    const abBtn = document.getElementById(id);
    if (!abBtn) continue;
    abBtn.disabled = !p.playing;
    abBtn.setAttribute('aria-pressed', String(!!p.bypass));
    abBtn.classList.toggle('is-active', !!p.bypass);
    abBtn.title = p.bypass ? 'A/B: Effekte sind umgangen (Original) – erneut klicken für Effekte' : 'A/B: Effekte kurz umgehen und das Original hören';
  }
}
