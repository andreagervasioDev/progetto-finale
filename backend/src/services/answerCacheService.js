/**
 * Cache delle risposte già date: se la stessa domanda viene fatta di nuovo, la risposta torna subito,
 * senza chiamare OpenAI né il data agent.
 *
 * Quando si usa: solo per il primo messaggio di una conversazione. Dopo, la risposta dipende anche
 * dalla cronologia ("E solo per i difensori?") e non si può riusare.
 *
 * La chiave combina:
 *   - la domanda normalizzata (maiuscole, spazi e punteggiatura finale non contano);
 *   - il documento o file di dati aperto, se c'è;
 *   - la "versione" dell'archivio visibile all'utente: un'impronta di documenti e dataset. Se un
 *     documento viene caricato, modificato o eliminato, l'impronta cambia e le vecchie risposte
 *     non vengono più trovate;
 *   - il modello: cambiando OPENAI_MODEL le risposte si rigenerano.
 *
 * Le voci scadono dopo QUERY_CACHE_TTL_HOURS ore (0 = cache disattivata) e ne restano al massimo
 * QUERY_CACHE_MAX_ENTRIES: oltre il limite si eliminano quelle usate meno di recente.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { allEntries, deleteEntries, getEntry, setEntry } from "../repositories/answerCacheRepository.js";

const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const cacheEnabled = () => config.answerCache.ttlHours > 0;

/** "  Quali sono le FASI del return-to-play?? " → "quali sono le fasi del return-to-play" */
export function normalizeQuestion(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s?!.…]+$/u, "")
    .trim();
}

/** Impronta dell'archivio: cambia se un documento o dataset viene aggiunto, modificato, rielaborato o rimosso. */
export function archiveVersion(docs) {
  return sha(
    docs
      .map((d) => [d.id, d.title, d.category, d.size, d.seedHash ?? null, d.chunks ?? 0, d.rows ?? null, d.facts ?? null])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

export function cacheKey({ question, docId, docs, model = config.chatModel }) {
  return sha({ q: normalizeQuestion(question), docId: docId ?? null, archive: archiveVersion(docs), model });
}

const ttlMs = () => config.answerCache.ttlHours * 60 * 60 * 1000;

/** Risposta salvata per la chiave, oppure null (assente o scaduta). */
export async function getCachedAnswer(key, now = Date.now()) {
  if (!cacheEnabled()) return null;
  const entry = await getEntry(key);
  if (!entry) return null;
  if (now - entry.createdAt > ttlMs()) {
    await deleteEntries([key]);
    return null;
  }
  await setEntry(key, { ...entry, lastHitAt: now, hits: (entry.hits ?? 0) + 1 });
  return entry.answer;
}

/** Si salvano solo le risposte complete: testo presente e nessuno strumento fallito. */
export function isCacheable(result) {
  return Boolean(result.reply?.trim()) && (result.trace ?? []).every((t) => t.ok !== false);
}

export async function storeAnswer(key, result, now = Date.now()) {
  if (!cacheEnabled() || !isCacheable(result)) return false;
  const { reply, charts, tables, sources, trace } = result;
  await setEntry(key, { answer: { reply, charts, tables, sources, trace }, createdAt: now, lastHitAt: now, hits: 0 });
  await prune(now);
  return true;
}

/** Elimina le voci scadute e, oltre il limite, quelle usate meno di recente. */
async function prune(now) {
  const entries = await allEntries();
  const expired = entries.filter(([, e]) => now - e.createdAt > ttlMs()).map(([k]) => k);
  const alive = entries
    .filter(([k]) => !expired.includes(k))
    .sort((a, b) => (b[1].lastHitAt ?? b[1].createdAt) - (a[1].lastHitAt ?? a[1].createdAt));
  const excess = alive.slice(config.answerCache.maxEntries).map(([k]) => k);
  if (expired.length || excess.length) await deleteEntries([...expired, ...excess]);
}
