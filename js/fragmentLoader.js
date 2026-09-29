/**
 * fragmentLoader.js — HTML-Fragment-Loader
 *
 * Lädt HTML-Fragmente per fetch() und hängt sie an einen Root-Container an.
 * Ausschließlich Infrastruktur: keine Fachlogik, kein State, keine
 * Event-Registrierung, keine Modal-Logik.
 *
 * Alle Requests laufen parallel; die Funktion kehrt erst zurück, wenn ALLE
 * abgeschlossen sind (erfolgreich oder fehlgeschlagen). Eingefügt wird in der
 * Reihenfolge der übergebenen Liste (deterministisch, unabhängig von der
 * Antwortgeschwindigkeit der einzelnen Requests).
 *
 * Voraussetzung: Auslieferung über HTTP(S) — unter file:// scheitert fetch().
 */

/** Anzahl Top-Level-Elemente eines Fragments (für die Plausibilitätsprüfung). */
function countTopLevelElements(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.children.length;
}

/**
 * @param {string[]} fragmentUrls  Pfade der Fragment-Dateien
 * @param {string}   rootSelector  CSS-Selektor des Ziel-Containers
 * @returns {Promise<{loaded: string[], failed: string[]}>}
 */
export async function loadFragments(fragmentUrls, rootSelector) {
  const result = { loaded: [], failed: [] };
  if (!Array.isArray(fragmentUrls) || fragmentUrls.length === 0) return result;

  const root = document.querySelector(rootSelector);
  if (!root) {
    console.error(`[fragmentLoader] Root-Container "${rootSelector}" nicht gefunden.`);
    result.failed.push(...fragmentUrls);
    return result;
  }

  // Alle Requests starten, jeder mit eigenem try/catch (ein Fehler bricht die anderen nicht ab).
  const settled = await Promise.all(fragmentUrls.map(async (url) => {
    const name = url.split('/').pop();
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[fragmentLoader] "${name}" (${url}): HTTP ${res.status} ${res.statusText}`);
        return { url, ok: false };
      }
      const html = await res.text();
      if (!html.trim()) {
        console.error(`[fragmentLoader] "${name}" (${url}): Fragment ist leer.`);
        return { url, ok: false };
      }
      if (countTopLevelElements(html) === 0) {
        console.warn(`[fragmentLoader] "${name}" (${url}): enthält keine Top-Level-Elemente.`);
      }
      return { url, ok: true, html };
    } catch (err) {
      console.error(`[fragmentLoader] "${name}" (${url}): Netzwerkfehler –`, err?.message || err);
      return { url, ok: false };
    }
  }));

  // Erst jetzt, nachdem ALLE Requests zurück sind, in Listenreihenfolge einfügen.
  for (const r of settled) {
    if (r.ok) {
      root.insertAdjacentHTML('beforeend', r.html);
      result.loaded.push(r.url);
    } else {
      result.failed.push(r.url);
    }
  }
  return result;
}
