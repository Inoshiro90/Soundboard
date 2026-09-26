/**
 * audio/playback.js — Wiedergabe-Steuerung (zustandsbehaftet)
 * Ausgelagert aus audio.js (Phase 3 der Refaktorierung). Enthält Start/Stop
 * von Sounds/Makros (inkl. Auto-Duck, Crossfade, Rotation), Legacy-Decode,
 * den Makro-Runner, WAV-Export sowie die zugehörige Tile-UI-Synchronisation.
 */

import { APP, CItems } from '../core/state.js';
import { bk, sleep }   from '../utils.js';
import { toast }       from '../notifications.js';
import { idbGet, audioKey, IDB_SENTINEL, isIdbRef, openDB } from '../db.js';
import { getOrDecodeBuffer, invalidateBuffer } from '../audioCache.js';
import { renderSoundGraph, scheduleFadeCurve } from '../renderPipeline.js';
// P2 Auto Duck: zirkulärer Import (ambient.js importiert umgekehrt actx/
// hasAudioContext aus audio/context.js und buildEffectChain aus
// audio/effect-graph.js) — funktioniert für reine Funktionsreferenzen, die
// erst zur Laufzeit (nicht beim Modul-Ladevorgang) aufgerufen werden.
import { duckAmbient } from '../ambient.js';
import { actx, hasAudioContext } from './context.js';
// Analyzer-Steuerung lebt in audio/preview.js (Effekt-Vorschau + Analyzer);
// playSelectedSlot() startet/stoppt den Analyzer aber auch bei normaler
// Live-Wiedergabe (nicht nur bei der Effekt-Vorschau), daher hier importiert.
import { startAnalyzerLoop, stopAnalyzer } from './preview.js';

// ─── DECODE (legacy compat) ───────────────────────────────────

/** @deprecated Use getOrDecodeBuffer from audioCache.js instead. */
export function decodeAudio(key, b64) {
  // Phase-3-Anpassung (Datei-Split): `_ctx` ist jetzt modul-privat in
  // audio/context.js. hasAudioContext()===(_ctx!==null), also identische
  // Bedingung; actx() liefert denselben, bereits existierenden Context
  // (löst hier nur zusätzlich das ohnehin übliche resume() aus, falls
  // suspendiert — keine Verhaltensänderung). BUGFIX bleibt bestehen:
  // niemals einen neuen Context erzeugen, wenn noch keiner existiert.
  if (!hasAudioContext()) return;
  const ctx = actx();
  try {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    ctx.decodeAudioData(arr.buffer.slice(0), buf => { APP.audioBuffers[key] = buf; }, err => { console.error('[audio] decodeAudio error:', err); });
  } catch(e) { console.error('[audio] decodeAudio setup error:', e); }
}

/** Promise-based decode, uses central cache. */
export async function decodeAudioSmart(soundId, slotIdx, slotData) {
  if (!slotData || !hasAudioContext()) return null;
  return getOrDecodeBuffer(soundId, slotIdx, slotData, actx());
}

// ─── AUTO DUCK (P2) ──────────────────────────────────────────
// Senkt die Ambient-Ebene automatisch ab, sobald ein Soundboard-Sound
// aktiv ist. Wirkungsbereich bewusst GLOBAL (ein "mindestens ein Sound
// läuft"-Zustand), NICHT pro Sound/Szene — siehe Plan-Begründung:
// Pro-Sound-Ducking würde bei vielen kurzen, häufig getriggerten Sounds
// zu unruhigem Auf-und-Ab-Pumpen führen.

/** Bei Start eines Sounds: Ambient duckt Richtung (1-amount). */
export function notifyDuckTrigger() {
  const duckSettings = APP.globalSettings?.autoDuck;
  if (!duckSettings?.enabled) return;
  const amount = Math.min(1, Math.max(0, duckSettings.amount ?? 0.7));
  const targetFactor = 1 - amount;
  // Zeitkonstante so gewählt, dass ~95% des Zielwerts nach `attack`ms erreicht sind (≈3τ).
  const timeConstant = Math.max(0.001, (duckSettings.attack ?? 150) / 1000 / 3);
  duckAmbient(targetFactor, timeConstant);
}

/** Bei Ende eines Sounds, NUR wenn wirklich kein anderer Sound mehr aktiv ist: Ambient released auf 1.0. */
export function notifyDuckRelease() {
  if (Object.keys(APP.activeAudio).length > 0) return; // noch andere Sounds aktiv → nicht releasen
  const duckSettings = APP.globalSettings?.autoDuck;
  if (!duckSettings?.enabled) return;
  const timeConstant = Math.max(0.001, (duckSettings.release ?? 500) / 1000 / 3);
  duckAmbient(1.0, timeConstant);
}

// ─── PLAYBACK ────────────────────────────────────────────────

export function playItem(id, callStack = []) {
  const item = CItems().find(x => x.id === id);
  if (!item || item.type === 'placeholder') return;
  if (item.type === 'sound') playSound(item);
  else runMacro(item, callStack);
}

export async function playSound(s, opts = {}) {
  const slots = s.slots || [];
  // Abschnitt 11: ein Sound kann jetzt gültig ganz ohne Audioslot existieren
  // (letzter Slot im Editor entfernt) — ohne diese Prüfung würde `% slots.length`
  // hier zu `% 0` (NaN) führen, statt der bereits an anderer Stelle etablierten
  // "Keine Audio-Dateien geladen"-Meldung (siehe btnPreviewSound).
  if (!slots.length) { toast('Keine Audio-Dateien geladen', 'err'); return; }
  let idx = s.random ? Math.floor(Math.random() * slots.length) : (s.curSlot || 0) % slots.length;
  if (!s.random) s.curSlot = (idx + 1) % slots.length;
  return playSelectedSlot(s, idx, opts);
}

/**
 * Bugfix (Ursache 3 / Testfälle C, D, J): Spielt EXPLIZIT den übergebenen
 * Slot-Index ab, unabhängig davon, was `s.curSlot` inzwischen ist.
 *
 * Vorher rief playSound() bei einem Cache-Miss nach dem Lazy-Decode
 * erneut `playSound(s, opts)` auf — das wählt den Slot aber NEU (über
 * s.curSlot/Zufall), der zuvor bereits für nicht-Zufall-Wiedergabe auf
 * idx+1 weitergeschaltet worden war. Der lazy-geladene Slot idx wurde
 * dadurch nie tatsächlich abgespielt, sondern ein anderer (evtl. wieder
 * ungeladener) Slot — sichtbar als endloses "Audio lädt…" oder als
 * Wiedergabe des falschen Slots. playSelectedSlot() behält die
 * Slot-Identität über den kompletten Lazy-Load hinweg bei, indem der
 * Retry nach dem Decode erneut GENAU denselben `idx` anfordert.
 */
export async function playSelectedSlot(s, idx, opts = {}) {
  const slots = s.slots || [];
  const slot  = slots[idx];
  if (!slot || !slot.data) { toast('Slot ' + (idx + 1) + ' leer'); return; }

  let buf = APP.audioBuffers[bk(s.id, idx)];
  if (!buf) {
    // Lazy-load, dann GENAU diesen Slot (idx) weiterverwenden — nie
    // erneut über playSound()/curSlot neu bestimmen lassen.
    toast('Audio lädt…');
    actx(); // stellt sicher, dass der AudioContext existiert (User-Gesture)
    buf = await decodeAudioSmart(s.id, idx, slot.data);
    if (!buf) { toast('Audio konnte nicht geladen werden', 'err'); return; }
  }

  const gs       = APP.globalSettings;
  const ctx      = actx();

  // "Wiedergabe & Verhalten" — Crossfade: nur sinnvoll bei einem
  // tatsächlichen Übergang zwischen zwei GLEICHZEITIG laufenden Instanzen
  // DESSELBEN Sounds — das setzt Overlap voraus (sonst hat stopAll() unten
  // ohnehin bereits alles beendet) und mindestens eine bereits aktive
  // Instanz dieses Sounds (ein Retrigger, kein Erststart). Preview nimmt
  // bewusst nicht teil (isolierter Lifecycle, s. APP.audioPreview-Doku).
  const cf = s.playback?.crossfade;
  const existingInstances = APP.activeAudio[s.id] || [];
  const doCrossfade = !!(cf?.enabled) && cf.duration > 0 && !!gs.overlap && !opts.isPreview && existingInstances.length > 0;

  if (!gs.overlap && !opts.isPreview) stopAll();

  if (doCrossfade) {
    // Alte Instanz(en) desselben Sounds über die Crossfade-Dauer ausblenden
    // und danach stoppen — identische Technik wie der bestehende Makro-
    // "fadeout"-Action-Handler (cancelScheduledValues + Rampe + verzögertes
    // stop()), hier nur mit wählbarer Kurvenform statt fest linear.
    existingInstances.forEach(a => {
      try {
        a.gain.gain.cancelScheduledValues(ctx.currentTime);
        a.gain.gain.setValueAtTime(a.gain.gain.value, ctx.currentTime);
        scheduleFadeCurve(a.gain, cf.curve || 'linear', a.gain.gain.value, 0, ctx.currentTime, cf.duration);
        setTimeout(() => { try { a.src.stop(); } catch (e) {} }, cf.duration * 1000 + 50);
      } catch (e) {}
    });
  }

  // P1 Render-Pipeline (renderPipeline.js): identischer Graph-Aufbau wie
  // Export — behebt strukturell die im P0-Audit beschriebenen Divergenzen
  // (Pitch/Noise-Gate) und eine bei der Vereinheitlichung zusätzlich
  // entdeckte: Fades/Envelope fehlten bisher komplett im Export-Pfad.
  const graph = await renderSoundGraph(ctx, buf, slot, s, {
    mode: opts.isPreview ? 'preview' : 'live',
    destination: ctx.destination,
    masterVol: gs.masterVol ?? 1,
    crossfadeIn: doCrossfade ? { duration: cf.duration, curve: cf.curve || 'linear' } : null
  });
  const { src, masterGain, analyser, dur } = graph;

  if (!APP.activeAudio[s.id]) APP.activeAudio[s.id] = [];
  APP.activeAudio[s.id].push({ src, gain: masterGain, dur });
  notifyDuckTrigger(); // P2 Auto Duck

  graph.start(0);
  src.onended = () => {
    if (APP.activeAudio[s.id]) {
      APP.activeAudio[s.id] = APP.activeAudio[s.id].filter(x => x.src !== src);
      if (!APP.activeAudio[s.id].length) { delete APP.activeAudio[s.id]; _setPlaying(s.id, false); }
    }
    _updateSoundLiveIndicator(); refreshRotBadge(s.id);
    if (analyser && !APP.activeAudio[s.id]?.length) stopAnalyzer();
    notifyDuckRelease(); // P2 Auto Duck — no-op, falls noch andere Sounds aktiv sind
  };

  _setPlaying(s.id, true); _updateSoundLiveIndicator();
  animProg(s.id, dur); refreshRotBadge(s.id);

  if (analyser) {
    const cv = document.getElementById('analyzerCanvas');
    if (cv) startAnalyzerLoop(analyser, cv, s.effects?.analyzer?.mode || 'bars');
  }
}

export function playSoundAndWait(s) {
  return new Promise(async resolve => {
    const slots = s.slots || [];
    // Wie playSound() oben: ein Sound ganz ohne Audioslot ist seit Abschnitt 11
    // ein gültiger Zustand — hier einfach überspringen (gleiches Verhalten wie
    // ein leerer Einzel-Slot weiter unten: resolve() ohne Wiedergabe).
    if (!slots.length) { resolve(); return; }
    let idx = s.random ? Math.floor(Math.random() * slots.length) : (s.curSlot || 0) % slots.length;
    if (!s.random) s.curSlot = (idx + 1) % slots.length;
    const slot = slots[idx]; if (!slot?.data) { resolve(); return; }
    // Bugfix (Konsistenz aller Playback-Wege, Abschnitt 6): auch die
    // sequenzielle Makro-Wiedergabe muss denselben Lazy-Load-Pfad wie
    // normales Playback nutzen, statt bei einem Cache-Miss den Slot
    // stillschweigend zu überspringen (führte zu "fehlenden" Sounds in
    // Makros direkt nach einem Bulk-Import, bevor der Cache warmgelaufen war).
    actx();
    let buf = APP.audioBuffers[bk(s.id, idx)];
    if (!buf) buf = await decodeAudioSmart(s.id, idx, slot.data);
    if (!buf) { resolve(); return; }
    const gs = APP.globalSettings; const ctx = actx();

    // allowLoop:false — Bestandsverhalten bewusst beibehalten: sequenzielle
    // Makro-Wiedergabe darf NIE loopen, sonst würde `onended` nie feuern
    // und die await-Kette der Makro-Sequenz für immer hängen bleiben.
    const graph = await renderSoundGraph(ctx, buf, slot, s, {
      mode: 'live',
      destination: ctx.destination,
      masterVol: gs.masterVol ?? 1,
      allowLoop: false
    });
    const { src, masterGain, dur } = graph;

    if (!APP.activeAudio[s.id]) APP.activeAudio[s.id] = [];
    APP.activeAudio[s.id].push({ src, gain: masterGain, dur });
    notifyDuckTrigger(); // P2 Auto Duck
    graph.start(0);
    src.onended = () => {
      if (APP.activeAudio[s.id]) {
        APP.activeAudio[s.id] = APP.activeAudio[s.id].filter(x => x.src !== src);
        if (!APP.activeAudio[s.id].length) { delete APP.activeAudio[s.id]; _setPlaying(s.id, false); }
      }
      _updateSoundLiveIndicator(); refreshRotBadge(s.id);
      notifyDuckRelease(); // P2 Auto Duck
      resolve();
    };
    _setPlaying(s.id, true); _updateSoundLiveIndicator(); animProg(s.id, dur); refreshRotBadge(s.id);
  });
}

export function stopItem(id) {
  (APP.activeAudio[id] || []).forEach(a => { try { a.src.stop(); } catch(e) {} });
  delete APP.activeAudio[id]; _setPlaying(id, false); _updateSoundLiveIndicator();
}

export function stopAll() { Object.keys(APP.activeAudio).forEach(stopItem); }

/**
 * Plays an AudioBuffer directly (used for slot preview in the edit modal).
 * Respects trimStart/trimEnd from the slot object.
 * Does NOT use the effect chain — raw buffer playback only.
 * Returns the BufferSourceNode so the caller can stop it if needed.
 *
 * @param {AudioBuffer} buf
 * @param {object}      slot   — { trimStart, trimEnd }
 * @param {number}      vol    — gain (0..1+)
 * @param {number}      pitch  — playbackRate multiplier
 * @returns {AudioBufferSourceNode}
 */
export function playBufferPreview(buf, slot, vol, pitch) {
  if (!buf) { console.warn('[audio] playBufferPreview: no buffer'); return null; }
  const ctx      = actx();
  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0, vol ?? 1);
  gainNode.connect(ctx.destination);

  const src = ctx.createBufferSource();
  src.buffer              = buf;
  src.playbackRate.value  = Math.max(0.1, pitch ?? 1);

  const ts  = slot?.trimStart || 0;
  let   te  = slot?.trimEnd ?? buf.duration;
  if (te <= ts) te = buf.duration;
  const dur = Math.max(0.01, te - ts);

  src.connect(gainNode);
  src.start(0, ts, dur);
  return src;
}

// ─── MACRO RUNNER ────────────────────────────────────────────

const MAX_DEPTH = 8;

export async function runMacro(m, callStack = []) {
  if (callStack.length >= MAX_DEPTH) { toast('Makro-Tiefe erreicht', 'err'); return; }
  if (callStack.includes(m.id))      { toast('Zirkulärer Makro!',    'err'); return; }
  const stack = [...callStack, m.id]; _setPlaying(m.id, true);
  const mode  = m.playMode || 'parallel';

  for (let r = 0; r < (m.repeat || 1); r++) {
    let steps = [...(m.steps || [])];
    if (mode === 'random') steps = steps.sort(() => Math.random() - 0.5);

    // ── startTime-based scheduling (Timeline-Makros) ──────────
    // If any step carries a startTime, use absolute setTimeout scheduling so
    // the playback matches exactly what the macro timeline canvas previews.
    const hasStartTimes = steps.some(s => s.startTime != null && s.startTime > 0);
    if (hasStartTimes) {
      const sorted = [...steps].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
      const t0 = performance.now();
      await new Promise(resolve => {
        let pending = sorted.length;
        if (!pending) { resolve(); return; }
        sorted.forEach(step => {
          const delayMs = Math.max(0, Math.round((step.startTime || 0) * 1000));
          setTimeout(async () => {
            const action = step.action || 'play';
            if (action === 'stop_all') {
              stopAll();
            } else if (action === 'stop') {
              const t = CItems().find(x => x.id === step.targetId);
              if (t) stopItem(t.id);
            } else if (action === 'play' || !action) {
              const t = CItems().find(x => x.id === step.targetId);
              if (t) {
                if (t.type === 'sound') {
                  if (mode === 'sequential') await playSoundAndWait(t);
                  else playSound(t);
                } else if (t.type === 'macro') {
                  await runMacro(t, stack);
                }
              }
            } else if (action === 'volume') {
              APP.globalSettings.masterVol = Math.max(0, Math.min(1, step.volumeVal ?? APP.globalSettings.masterVol));
              const el = document.getElementById('masterVol'); if (el) el.value = APP.globalSettings.masterVol;
            } else if (action === 'fadeout') {
              const t = CItems().find(x => x.id === step.targetId);
              if (t) {
                const fadeDur = (step.fadeDuration || 1000) / 1000;
                (APP.activeAudio[t.id] || []).forEach(a => {
                  try { const ctx = actx(); a.gain.gain.cancelScheduledValues(ctx.currentTime); a.gain.gain.setValueAtTime(a.gain.gain.value, ctx.currentTime); a.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDur); setTimeout(() => { try { a.src.stop(); } catch(e) {} }, fadeDur * 1000 + 50); } catch(e) {}
                });
              }
            }
            if (--pending === 0) resolve();
          }, delayMs);
        });
      });

    // ── Legacy delay-based scheduling (alte Makros ohne startTime) ──
    } else {
      for (const step of steps) {
        const action = step.action || 'play';
        if (action === 'stop_all') { stopAll(); }
        else if (action === 'stop')    { const t = CItems().find(x => x.id === step.targetId); if (t) stopItem(t.id); }
        else if (action === 'play' || !action) {
          const t = CItems().find(x => x.id === step.targetId);
          if (t) {
            if (t.type === 'sound')  { if (mode === 'sequential') await playSoundAndWait(t); else playSound(t); }
            else if (t.type === 'macro') await runMacro(t, stack);
          }
        } else if (action === 'volume') {
          APP.globalSettings.masterVol = Math.max(0, Math.min(1, step.volumeVal ?? APP.globalSettings.masterVol));
          const el = document.getElementById('masterVol'); if (el) el.value = APP.globalSettings.masterVol;
        } else if (action === 'fadeout') {
          const t = CItems().find(x => x.id === step.targetId);
          if (t) {
            const fadeDur = (step.fadeDuration || 1000) / 1000;
            (APP.activeAudio[t.id] || []).forEach(a => {
              try { const ctx = actx(); a.gain.gain.cancelScheduledValues(ctx.currentTime); a.gain.gain.setValueAtTime(a.gain.gain.value, ctx.currentTime); a.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeDur); setTimeout(() => { try { a.src.stop(); } catch(e) {} }, fadeDur * 1000 + 50); } catch(e) {}
            });
          }
        }
        if (step.delay > 0) await sleep(step.delay);
      }
    }

    if (r < (m.repeat || 1) - 1) await sleep(m.repeatDelay || 500);
  }
  _setPlaying(m.id, false); _updateSoundLiveIndicator();
}

// ─── WAV EXPORT ──────────────────────────────────────────────

function _bufToWav(buffer) {
  const numCh = buffer.numberOfChannels; const sr = buffer.sampleRate; const len = buffer.length;
  const bps = 16; const block = numCh * bps / 8; const dataSize = len * block;
  const ab = new ArrayBuffer(44 + dataSize); const v = new DataView(ab);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wr(0,'RIFF'); v.setUint32(4, 36 + dataSize, true); wr(8,'WAVE'); wr(12,'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * block, true);
  v.setUint16(32, block, true); v.setUint16(34, bps, true);
  wr(36,'data'); v.setUint32(40, dataSize, true);
  let off = 44;
  for (let f = 0; f < len; f++) for (let ch = 0; ch < numCh; ch++) { const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[f])); v.setInt16(off, s < 0 ? s * 32768 : s * 32767, true); off += 2; }
  return ab;
}

export async function exportSoundToWav(s) {
  const slotIdx = (s.curSlot || 0) % Math.max(1, (s.slots || []).length);
  const slot    = (s.slots || [])[slotIdx]; if (!slot?.data) { toast('Kein Audio', 'err'); return; }
  let liveBuf   = APP.audioBuffers[bk(s.id, slotIdx)];
  // Phase-3-Anpassung (Datei-Split): _ctx direkt → hasAudioContext()+actx(),
  // s. Kommentar bei decodeAudio() oben. Keine Verhaltensänderung.
  if (!liveBuf && hasAudioContext()) liveBuf = await getOrDecodeBuffer(s.id, slotIdx, slot.data, actx());
  if (!liveBuf) { toast('Audio nicht geladen', 'err'); return; }
  const ts = slot.trimStart || 0; let te = slot.trimEnd ?? liveBuf.duration; if (te <= ts) te = liveBuf.duration;
  const dur = te - ts; if (dur <= 0) { toast('Ungültige Trim-Punkte', 'err'); return; }
  toast('Exportiere WAV…');
  try {
    const hasFx = s.effects?.enabled;
    const numCh = liveBuf.numberOfChannels; const sr = liveBuf.sampleRate;
    // Tail-Puffer für Reverb/Delay-Ausklang (Bestandsverhalten unverändert).
    const offCtx = new OfflineAudioContext(numCh, Math.ceil((dur + (hasFx ? 3.5 : 0)) * sr), sr);

    // P1 Render-Pipeline (renderPipeline.js): derselbe Graph-Aufbau wie
    // Live-Playback/Preview. Trim geschieht per start(when, offset, duration)
    // direkt auf dem UNGETRIMMTEN liveBuf — die manuelle Trim-Buffer-Kopie
    // entfällt dadurch (AudioBufferSourceNode.start() mit offset/duration
    // funktioniert für OfflineAudioContext identisch wie live). Als
    // Nebeneffekt der Vereinheitlichung werden jetzt AUCH Fades/Envelope
    // korrekt mitgerendert, die im alten Export-Code komplett fehlten.
    const graph = await renderSoundGraph(offCtx, liveBuf, slot, s, {
      mode: 'export',
      destination: offCtx.destination
    });
    graph.start(0);
    const rendered = await offCtx.startRendering();

    const blob = new Blob([_bufToWav(rendered)], { type: 'audio/wav' });
    const url  = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;
    a.download = (s.name || 'sound').replace(/[^a-zA-Z0-9äöüÄÖÜß _-]/g, '') + '.wav'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000); toast('WAV exportiert ✓', 'ok');
  } catch(err) { console.error('[audio] WAV Export:', err); toast('Export fehlgeschlagen: ' + err.message, 'err'); }
}

// ─── UI SYNC ─────────────────────────────────────────────────

function _setPlaying(id, on) {
  const wrap = document.querySelector(`.tile-wrap[data-id="${id}"]`);
  if (wrap) wrap.querySelector('.tile')?.classList.toggle('is-playing', on);
}

// Prompt 5: früher hieß diese Funktion nach der (jetzt entfernten) unteren
// Statusleiste; sie pflegte zusätzlich deren Elemente (#sdot/#stxt) — die
// Zählung (APP.activeAudio) und der Navbar-Indikator (Prompt 4) bleiben
// davon unberührt, nur die statusleisten-spezifischen Zeilen entfallen.
function _updateSoundLiveIndicator() {
  const n = Object.keys(APP.activeAudio).length;
  // Prompt 4: Navbar-Indikator an #btnModeSound — sichtbar/aktuell aus
  // jeder Ansicht heraus, da hier direkt am tatsächlichen Wiedergabestatus
  // der Audio-Engine (APP.activeAudio, nicht am zuletzt geklickten Button)
  // hängend, analog zum bestehenden Musik-Indikator (has-live-indicator,
  // s. music.css). Zusätzlich zur rein farblichen ::after-Markierung wird
  // eine per aria-describedby verknüpfte, visuell verborgene Beschreibung
  // gepflegt, damit die Information nicht ausschließlich über Farbe
  // vermittelt wird.
  document.getElementById('btnModeSound')?.classList.toggle('has-live-indicator', n > 0);
  const liveDesc = document.getElementById('btnModeSoundLiveDesc');
  if (liveDesc) liveDesc.textContent = n > 0 ? `Wiedergabe aktiv (${n})` : '';
}

export function animProg(id, dur) {
  const bar = document.querySelector(`.tile-wrap[data-id="${id}"] .tile__progress`);
  if (!bar || !dur) return;
  const t0 = performance.now();
  function step(t) { const p = Math.min(100, ((t - t0) / (dur * 1000)) * 100); bar.style.width = p + '%'; if (p < 100 && APP.activeAudio[id]) requestAnimationFrame(step); else bar.style.width = '0%'; }
  requestAnimationFrame(step);
}

export function refreshRotBadge(id) {
  const s = CItems().find(x => x.id === id && x.type === 'sound'); if (!s) return;
  const wrap = document.querySelector(`.tile-wrap[data-id="${id}"]`); if (!wrap) return;
  const badge = wrap.querySelector('.tile__slot-badge'); const tile = wrap.querySelector('.tile');
  if (!badge || !tile) return;
  const total = (s.slots || []).length;
  if (total > 1) { badge.textContent = `${((s.curSlot || 0) % total) + 1}/${total}`; tile.classList.add('has-multi-slots'); }
  else { badge.textContent = ''; tile.classList.remove('has-multi-slots'); }
}
