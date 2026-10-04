/**
 * ui/modal-stack.js — Zentrales Stacking für gleichzeitig geöffnete Bootstrap-Modals
 * ------------------------------------------------------------------
 * Problem: Bootstrap 5 unterstützt nur EIN offenes Modal. Öffnet man ein zweites (z. B.
 * „Preset speichern" aus „Audio-Effekte"), haben beide denselben z-index (1055) — es entscheidet
 * die Reihenfolge im DOM. Die Fragmente werden in fester Reihenfolge geladen (js/main.js), das
 * Preset-Modal (sound-core.html) steht dadurch VOR #soundFxModal (sound-fx.html) und wird verdeckt.
 * Außerdem: alle Backdrops liegen unter ALLEN Modals, `modal-open` verschwindet beim Schließen
 * des oberen Modals, der Fokus landet danach auf <body>, und Escape trifft das Modal mit dem
 * Fokus statt das oberste.
 *
 * Lösung (kein globaler z-index-Hack, kein Eingriff in einzelne Modals): ein einziger Manager,
 * der über die bubbelnden Bootstrap-Events (`show.bs.modal`, `hide.bs.modal`, `hidden.bs.modal`)
 * die tatsächliche Öffnungsreihenfolge verfolgt und daraus pro Modal Folgendes ableitet:
 *   1. z-index: Das unterste Modal behält exakt Bootstraps Standard (kein Inline-Style). Jedes
 *      weitere erhält z-index = (z-index des aktuell obersten) + STEP, sein Backdrop liegt 5 darunter
 *      (gleicher Abstand wie bei Bootstrap: 1050/1055) — also ÜBER dem darunterliegenden Modal.
 *      Ein einzelnes Modal verhält sich dadurch exakt wie vorher.
 *   2. Scroll-Lock/Body-Klasse: Bootstraps ScrollBarHelper ist ein Merker, kein Zähler — ab der
 *      dritten Ebene stellt das Schließen der mittleren den Body wieder frei, obwohl das unterste
 *      Modal noch offen ist (overflow/padding-right weg, Seite scrollt hinter dem Dialog), und
 *      `modal-open` entfernt Bootstrap schon beim Schließen des oberen Modals. Beides wird hier
 *      zurückgesetzt, solange noch ein Modal offen ist (Snapshot des Lock-Zustands beim Öffnen
 *      der zweiten Ebene); das endgültige Freigeben nach dem letzten Modal bleibt Bootstrap.
 *   3. Fokus: Beim Schließen eines oberen Modals geht der Fokus an das Element zurück, das ihn
 *      beim Öffnen hatte (sonst auf das oberste verbleibende Modal). Bewusst KEIN eigener
 *      `focusin`-Wächter: Bootstraps Fokusfalle des unteren Modals ist bis zum `shown` des oberen
 *      noch aktiv — ein zweiter Wächter würde mit ihr ping-pongen (Endlosschleife / Stack Overflow).
 *      Stattdessen `inert` am verdeckten Modal: dessen Falle kann den Fokus dann nicht zurückholen,
 *      und der Fokus bleibt im obersten Modal.
 *   4. Escape: Schließt immer das OBERSTE Modal — auch wenn der Fokus noch im darunterliegenden
 *      oder auf <body> liegt (Capture-Phase, damit das untere Modal das Event nicht verarbeitet).
 *   5. Verdeckte Modals werden `inert` (nicht fokussier-/bedienbar, für Screenreader ausgeblendet),
 *      solange ein anderes darüber liegt — das ist zugleich der Fokus-Schutz aus Punkt 3.
 *
 * Reihenfolge-unabhängig: die DOM-Position eines Modals spielt keine Rolle mehr; schließt man ein
 * unteres vor einem oberen, bekommt ein später geöffnetes Modal trotzdem einen höheren z-index
 * als jedes noch offene.
 */

const STEP = 10;            // z-index-Abstand zwischen zwei gestapelten Modals
const BACKDROP_GAP = 5;     // Backdrop liegt so weit unter „seinem" Modal (Bootstrap: 1055 − 1050)
const STACKED_BACKDROP_OPACITY = '0.3'; // sonst dunkelt der 2. Backdrop die Seite doppelt ab

/** Offene Modals, unterstes zuerst. Nur Modals, deren Schließen nicht abgebrochen wurde. */
const stack = [];
/** modal → Element, das beim Öffnen den Fokus hatte (Rückgabeziel beim Schließen). */
const openers = new WeakMap();
/** Body-Lock-Zustand, wie ihn das UNTERSTE Modal gesetzt hat (s. Kopfkommentar, Punkt 2). */
let lockSnapshot = null;
const LOCK_STYLE = ['overflow', 'padding-right'];
const LOCK_DATA  = ['bs-overflow', 'bs-padding-right'];

function _captureLock() {
  const b = document.body;
  return {
    style: LOCK_STYLE.map(k => [k, b.style.getPropertyValue(k)]),
    data:  LOCK_DATA.map(k => [k, b.getAttribute('data-' + k)])
  };
}
function _restoreLock(snap) {
  const b = document.body;
  snap.style.forEach(([k, v]) => { if (v) b.style.setProperty(k, v); else b.style.removeProperty(k); });
  snap.data.forEach(([k, v]) => { if (v === null) b.removeAttribute('data-' + k); else b.setAttribute('data-' + k, v); });
}

const _isModal = el => el instanceof HTMLElement && el.classList.contains('modal');
const _top = () => stack[stack.length - 1] || null;

function _baseZ(el) {
  const v = parseInt(getComputedStyle(el).getPropertyValue('--bs-modal-zindex'), 10);
  return Number.isFinite(v) ? v : 1055;
}

function _zOf(el) {
  const v = parseInt(el.style.zIndex, 10);
  return Number.isFinite(v) ? v : _baseZ(el);
}

/** Verdeckt = es liegt ein anderes Modal darüber → inert; das oberste ist bedienbar. */
function _syncInert() {
  stack.forEach((el, i) => {
    const covered = i < stack.length - 1;
    if (covered) { el.setAttribute('inert', ''); } else { el.removeAttribute('inert'); }
  });
}

/**
 * Bootstrap hängt den Backdrop synchron in show() an — erst NACH dem show-Event, daher Microtask.
 * Zugeordnet wird der zuletzt angehängte Backdrop, der nicht einem anderen noch offenen Modal
 * gehört (ein noch ausblendender Backdrop eines gerade geschlossenen Modals bleibt dabei außen vor,
 * weil Bootstrap den neuen immer zuletzt anhängt). Eventuell von einer früheren Verwendung
 * übrig gebliebene Inline-Stile werden dabei immer zurückgesetzt.
 */
function _styleBackdrop(modal, modalZ, stacked) {
  const foreign = new Set(stack.filter(m => m !== modal).map(m => m.id));
  const bds = [...document.querySelectorAll('.modal-backdrop')].filter(b => !foreign.has(b.dataset.stackOwner));
  const bd = bds[bds.length - 1];
  if (!bd) return;                          // z. B. backdrop:false
  bd.dataset.stackOwner = modal.id || '';
  if (stacked) {
    bd.style.zIndex = String(modalZ - BACKDROP_GAP);
    bd.style.setProperty('--bs-backdrop-opacity', STACKED_BACKDROP_OPACITY);
  } else {
    bd.style.removeProperty('z-index');
    bd.style.removeProperty('--bs-backdrop-opacity');
  }
}

function _onShow(e) {
  const el = e.target;
  if (!_isModal(el) || e.defaultPrevented || stack.includes(el)) return;

  const above = _top();
  const stacked = !!above;
  // Zweite Ebene: Der Body ist jetzt vom untersten Modal gesperrt (Bootstrap sperrt erst NACH
  // diesem Event für das neue Modal) — diesen Zustand merken, um ihn später wiederherzustellen.
  if (stacked && !lockSnapshot) lockSnapshot = _captureLock();
  const z = stacked ? _zOf(above) + STEP : _baseZ(el);
  if (stacked) el.style.zIndex = String(z); else el.style.removeProperty('z-index');

  // Rückgabeziel nur merken, wenn es nicht schon im neuen Modal selbst liegt.
  const active = document.activeElement;
  if (active && active !== document.body && !el.contains(active)) openers.set(el, active);

  stack.push(el);
  _syncInert();
  queueMicrotask(() => _styleBackdrop(el, z, stacked));
}

function _onHide(e) {
  const el = e.target;
  if (!_isModal(el) || e.defaultPrevented) return;   // Draft-Guard hat das Schließen abgebrochen
  const i = stack.indexOf(el);
  if (i < 0) return;
  stack.splice(i, 1);
  _syncInert();
}

function _onHidden(e) {
  const el = e.target;
  if (!_isModal(el)) return;
  // Falls ein abgebrochenes/übersprungenes hide hier noch einen Eintrag hinterlassen hat.
  const i = stack.indexOf(el);
  if (i >= 0) { stack.splice(i, 1); _syncInert(); }
  el.style.removeProperty('z-index');
  el.removeAttribute('inert');

  const top = _top();
  if (!top) { lockSnapshot = null; return; }   // letztes Modal: Bootstrap hat den Body korrekt freigegeben

  // Bootstrap hat `modal-open` und ggf. den Scroll-Lock in seinem Hide-Callback aufgehoben, obwohl
  // noch ein Modal offen ist — wiederherstellen.
  document.body.classList.add('modal-open');
  if (lockSnapshot) _restoreLock(lockSnapshot);

  // Fokus zurück an den Auslöser (im jetzt obersten Modal), sonst auf das Modal selbst.
  const opener = openers.get(el);
  openers.delete(el);
  if (opener && opener.isConnected && top.contains(opener) && !opener.disabled) opener.focus({ preventScroll: true });
  else if (!top.contains(document.activeElement)) top.focus({ preventScroll: true });
}

/**
 * Nach dem Einblenden: Liegt der Fokus nicht im (nun obersten) Modal — z. B. weil Bootstraps Falle
 * des darunterliegenden Modals ihn beim Aktivieren der neuen Falle noch zurückgeholt hat —, wird er
 * einmalig ins Modal gesetzt. Kein Dauer-Listener, daher keine Wechselwirkung mit Bootstraps Falle.
 */
function _onShown(e) {
  const el = e.target;
  if (!_isModal(el) || _top() !== el) return;
  if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
}

function _onKeyDown(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = _top();
  if (!top) return;
  if (top.contains(e.target)) return;                     // Bootstraps eigener Handler am obersten Modal reicht
  if (top.getAttribute('data-bs-keyboard') === 'false') return;
  e.stopPropagation();                                    // das darunterliegende Modal darf Escape nicht auswerten
  e.preventDefault();
  window.bootstrap?.Modal.getInstance(top)?.hide();
}

let _wired = false;
/** Einmalig beim Start aufrufen (js/main.js). Mehrfachaufrufe sind harmlos. */
export function initModalStack() {
  if (_wired) return;
  _wired = true;
  document.addEventListener('show.bs.modal',   _onShow);
  document.addEventListener('hide.bs.modal',   _onHide);
  document.addEventListener('hidden.bs.modal', _onHidden);
  document.addEventListener('shown.bs.modal',  _onShown);
  document.addEventListener('keydown',         _onKeyDown, true);
}

/** Anzahl aktuell geöffneter (nicht im Schließen befindlicher) Modals — für Tests/Diagnose. */
export function modalStackDepth() { return stack.length; }
