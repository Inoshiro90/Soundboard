/**
 * modalGuards.js — Zentraler Unsaved-Changes-Schutz für Editier-Dialoge.
 *
 * Zweck: verhindert, dass Benutzer:innen ungespeicherte Änderungen in einem
 * Editier-Modal versehentlich verlieren, weil der Dialog über Abbrechen, den
 * X-Button, einen Klick außerhalb (Backdrop) oder Escape geschlossen wurde.
 *
 * Zentrales Prinzip: alle vier Schließwege lösen in Bootstrap 5 intern
 * dasselbe `hide.bs.modal`-Event aus — auch ein programmgesteuerter
 * `.hide()`-Aufruf. Dieses eine Event wird hier EINMAL pro Modal abgefangen,
 * statt vier separate Click-/Keydown-Handler zu bauen. Das schließt strukturell
 * aus, dass z.B. ein eigener Abbrechen-Click-Handler UND `hide.bs.modal`
 * unabhängig voneinander je eine eigene Rückfrage auslösen (doppeltes
 * confirm() für ein- und dieselbe Aktion).
 *
 * `hide.bs.modal` ist in Bootstrap 5 abbrechbar: `event.preventDefault()`
 * verhindert, dass das Modal tatsächlich schließt. Wird das Verwerfen vom
 * Benutzer bestätigt, wird zuerst `onDiscard()` abgewartet (z.B. um zuvor
 * bereits nach IndexedDB geschriebene, aber verworfene Audiodaten
 * zurückzurollen) und danach `.hide()` erneut aufgerufen — diesmal ohne
 * Rückfrage, weil die Sitzung zu diesem Zeitpunkt bereits als "nicht mehr
 * aktiv" markiert ist (siehe `active`-Flag unten).
 *
 * Ein Guard unterscheidet außerdem sauber zwischen "Benutzer versucht zu
 * schließen" und "Anwendung hat erfolgreich gespeichert und schließt jetzt
 * absichtlich": Der Aufrufer ruft dafür vor einem programmgesteuerten
 * `.hide()` nach erfolgreichem Speichern `disarm()` auf — dadurch ignoriert
 * der Guard das dadurch ausgelöste `hide.bs.modal` vollständig, unabhängig
 * vom Dirty-Zustand.
 */
export function createModalDraftGuard({ modalId, isDirty, message, onDiscard }) {
  const el = document.getElementById(modalId);
  // "active": eine Editiersitzung läuft gerade (seit dem letzten arm()) und
  // wurde noch nicht durch disarm()/ein bestätigtes Verwerfen beendet. Ohne
  // dieses Flag würde ein Guard schon VOR dem ersten Öffnen bzw. nach einem
  // sauberen Schließen auf verwaiste DOM-Werte reagieren.
  let active = false;

  if (el) {
    el.addEventListener('hide.bs.modal', (e) => {
      if (!active) return;                 // keine Editiersitzung aktiv (oder bereits freigegeben, s. disarm())
      if (typeof isDirty !== 'function' || !isDirty()) return; // keine echten Änderungen -> normal schließen lassen

      // Es gibt ungespeicherte Änderungen: Schließen zunächst verhindern und
      // Rückfrage anzeigen. Entscheidet sich der Benutzer gegen das
      // Schließen, bleibt der Dialog exakt so offen, wie er war.
      e.preventDefault();
      if (!confirm(message)) return;

      // Verwerfen bestätigt: Sitzung sofort als beendet markieren, damit das
      // gleich folgende erneute .hide() (egal ob synchron oder nach einem
      // asynchronen onDiscard()) NICHT nochmal denselben Guard auslöst.
      active = false;
      Promise.resolve()
        .then(() => onDiscard?.())
        .catch(err => console.error(`[modalGuards] onDiscard für #${modalId} fehlgeschlagen:`, err))
        .finally(() => {
          bootstrap.Modal.getInstance(el)?.hide();
        });
    });
  }

  return {
    /** Startet/erneuert eine Editiersitzung — vor jedem "Öffnen" des Dialogs aufrufen. */
    arm() { active = true; },
    /**
     * Beendet die Editiersitzung, OHNE die Rückfrage auszulösen — vor jedem
     * absichtlichen, nicht rückfragepflichtigen `.hide()` aufrufen (z.B.
     * nach erfolgreichem Speichern oder beim Löschen des bearbeiteten
     * Objekts, wo bereits eine eigene Bestätigung stattgefunden hat).
     */
    disarm() { active = false; },
  };
}
