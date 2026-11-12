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
 * Limiti (le voci stanno in memoria e su disco, in storage/answer_cache.json):
 *   - durata: le voci scadono dopo QUERY_CACHE_TTL_HOURS ore (0 = cache disattivata);
 *   - numero: ne restano al massimo QUERY_CACHE_MAX_ENTRIES;
 *   - dimensione di una voce: una risposta che da sola supera QUERY_CACHE_MAX_ENTRY_KB kilobyte (default 512)
 *     non si salva. Anche una sola risposta molto grande, con grafici e tabelle, occuperebbe molto spazio;
 *   - spazio totale: in tutto al massimo QUERY_CACHE_MAX_MB megabyte (default 20).
 * Per i limiti di spazio 0 = nessun limite. Oltre un limite si eliminano le voci usate meno di recente.
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
const MB = 1024 * 1024;
const maxBytes = () => (config.answerCache.maxMb > 0 ? config.answerCache.maxMb * MB : null);
/** Una voce non può superare il suo limite né lo spazio dell'intera cache. */
function maxEntryBytes() {
  const limits = [config.answerCache.maxEntryKb > 0 ? config.answerCache.maxEntryKb * 1024 : null, maxBytes()].filter(Boolean);
  return limits.length ? Math.min(...limits) : null;
}
/** Byte del JSON salvato, misurati al salvataggio (le voci salvate prima si misurano al momento). */
const entrySize = (entry) => entry.size ?? Buffer.byteLength(JSON.stringify(entry));
const roundMb = (bytes) => Math.round((bytes / MB) * 100) / 100;

let tooLarge = 0; // risposte non salvate perché troppo grandi, dall'avvio

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
  const entry = { answer: { reply, charts, tables, sources, trace }, createdAt: now, lastHitAt: now, hits: 0 };
  entry.size = entrySize(entry);
  const limit = maxEntryBytes();
  if (limit && entry.size > limit) {
    tooLarge++;
    console.warn(`[cache] risposta non salvata: ${Math.round(entry.size / 1024)} KB, oltre il limite di ${Math.round(limit / 1024)} KB per voce`);
    return false;
  }
  await setEntry(key, entry);
  await prune(now);
  return true;
}

/** Elimina le voci scadute e, oltre il numero di voci o lo spazio, quelle usate meno di recente. */
async function prune(now) {
  const entries = await allEntries();
  const expired = entries.filter(([, e]) => now - e.createdAt > ttlMs()).map(([k]) => k);
  const alive = entries
    .filter(([k]) => !expired.includes(k))
    .sort((a, b) => (b[1].lastHitAt ?? b[1].createdAt) - (a[1].lastHitAt ?? a[1].createdAt));
  const kept = alive.slice(0, config.answerCache.maxEntries);
  const excess = alive.slice(config.answerCache.maxEntries).map(([k]) => k);
  // spazio: dalla meno usata di recente, finché il totale rientra nel limite
  let total = kept.reduce((sum, [, e]) => sum + entrySize(e), 0);
  const limit = maxBytes();
  for (let i = kept.length - 1; limit && i >= 0 && total > limit; i--) {
    total -= entrySize(kept[i][1]);
    excess.push(kept[i][0]);
  }
  if (expired.length || excess.length) await deleteEntries([...expired, ...excess]);
}

/** Stato per /api/health: voci valide, spazio occupato e limiti. */
export async function answerCacheStatus(now = Date.now()) {
  const alive = (await allEntries()).filter(([, e]) => now - e.createdAt <= ttlMs());
  return {
    entries: alive.length,
    sizeMb: roundMb(alive.reduce((sum, [, e]) => sum + entrySize(e), 0)),
    maxMb: config.answerCache.maxMb,
    maxEntryKb: config.answerCache.maxEntryKb,
    tooLarge,
    ttlHours: config.answerCache.ttlHours,
  };
}
