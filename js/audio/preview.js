/**
 * audio/preview.js — Effekt-Editor-Vorschau
 */

import { setIcon } from '../ui/icons.js';
import { APP } from '../core/state.js';
import { toast } from '../notifications.js';
import { bk } from '../utils.js';
import { getOrDecodeBuffer } from '../audioCache.js';
import { renderSoundGraph } from '../renderPipeline.js';
import { actx } from './context.js';
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
 * Zentrale, einzige Cleanup-Stelle für die Effekt-Editor-Preview
 *. Wird aufgerufen bei: Stop-Klick, natürlichem Ende,
 * Start einer neuen Preview (ersetzt die alte), Modal-Schließen,
 * Speichern und Abbrechen.
 */
export function stopEffectPreview() {
  const p = APP.audioPreview;
  p.token++; // entwertet jede noch wartende startEffectPreview()-Anfrage (Decode/Graph-Aufbau)
  _stopPreviewSourceOnly();
  p.playing = false; p.loading = false;
  if (p.dispose) { try { p.dispose(); } catch (e) {} p.dispose = null; }   // LFOs/Träger/Worklets der Effektkette freigeben
  p.src = null; p.masterGain = null;
  p.soundId = null; p.slotIdx = null; p.kind = null;
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

  // Bestehenden Cache verwenden, nicht unnötig neu dekodieren.
  let buf = APP.audioBuffers[bk(s.id, slotIdx)];
  if (!buf) {
    try {
      // opts.loadBuffer: Aufrufer-spezifischer Lader (Editor-Entwurf: Buffer unter `_ed_N`, Audio
      // liegt nur als IDB-Verweis vor). Ohne ihn fände getOrDecodeBuffer() unter der Preview-ID
      // keinen IDB-Eintrag. Läuft im selben Token-Schutz wie der reguläre Decode.
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
    // mode:'preview' — dieselbe Pipeline wie Live/Export.
    graph = await renderSoundGraph(ctx, buf, slot, s, { mode: 'preview', destination: ctx.destination });
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
  p.src = src; p.masterGain = masterGain; p.dispose = graph.dispose;
  p.soundId = s.id; p.slotIdx = slotIdx; p.kind = 'buffer';

  src.onended = () => {
    // onended kann auch von einer bereits ERSETZTEN
    // Quelle nachträglich feuern — nur reagieren, wenn es noch DIESE ist.
    if (APP.audioPreview.src !== src) return;
    stopEffectPreview();
  };

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
  try { conn = await connectPipeline(ctx, node, resolvePlan(asPipelineEffects(g.effects)), masterGain, { caps: TARGET_CAPS.noise, numChannels: 2 }); }
  catch (e) { console.error('[audio] Rauschgenerator-Pipeline-Fehler:', e); node.connect(masterGain); }
  if (myToken !== p.token) { try { conn?.dispose(); node.disconnect(); } catch (e) {} return; }
  masterGain.connect(ctx.destination);

  p.loading = false; p.playing = true; p.kind = 'noise';
  p.src = node; p.masterGain = masterGain; p.dispose = conn ? conn.dispose : null;
  p.soundId = '_noisepreview'; p.slotIdx = 0;
  _updatePreviewButton();

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
  ['btnPreviewSound', 'btnPreviewFx'].forEach(id => {
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
}

