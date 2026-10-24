/**
 * Turno di conversazione: prepara il contesto (archivio, dataset, elemento aperto), carica la cronologia,
 * esegue l'agente ReAct (o riusa una risposta già data, vedi answerCacheService.js) e salva domanda
 * e risposta nella conversazione.
 */
import { getCategory } from "../documents/categories.js";
import { isTabular } from "../documents/extract.js";
import { appendTurn, getHistory } from "../repositories/conversationRepository.js";
import { canRead, getDocument, listVisible } from "../repositories/documentRepository.js";
import { logActivity } from "./activityService.js";
import { runAgent } from "./agentService.js";
import { cacheKey, getCachedAnswer, storeAnswer } from "./answerCacheService.js";
import { availableDatasets } from "./datasetService.js";
import { assertWithinBudget } from "./usageService.js";

/**
 * @param {object} user  profilo che fa la domanda
 * @param {{sessionId: string, message: string, docId?: string}} turn
 * @param {(event: object) => void} [onEvent]  aggiornamenti di stato per lo streaming
 */
export async function handleTurn(user, { sessionId, message, docId }, onEvent) {
  const userId = user.id;
  // elemento aperto: un documento (la ricerca può limitarsi a quello) o un file di dati (dataset predefinito)
  const opened = docId ? await getDocument(docId) : null;
  const readable = opened && canRead(opened, user) ? { id: opened.id, title: opened.title } : null;
  const document = readable && !isTabular(opened.ext) ? readable : null;
  const dataset = readable && isTabular(opened.ext) ? readable : null;
  logActivity("chat", { text: message.slice(0, 500), conversationId: sessionId, ...(readable && { document: readable.title }) }, userId);

  const visible = await listVisible(user);
  const history = await getHistory(userId, sessionId);

  // primo messaggio della conversazione: se la stessa domanda ha già una risposta valida, la riuso
  const key = history.length === 0 ? cacheKey({ question: message, docId: readable?.id, docs: visible }) : null;
  let result = key ? await getCachedAnswer(key) : null;
  const cached = Boolean(result);
  if (cached) {
    onEvent?.({ type: "status", stage: "cache", label: "Domanda già fatta: recupero la risposta" });
  } else {
    // rete di sicurezza: se la spesa stimata di oggi ha raggiunto il tetto, non si avvia il turno
    // (le risposte dalla cache non costano nulla, quindi passano anche oltre il tetto)
    await assertWithinBudget();
    // archivio (titoli per categoria e dati chiave) e dataset disponibili, passati all'agente
    const documents = visible
      .filter((d) => !isTabular(d.ext))
      .map((d) => ({ title: d.title, categoryLabel: getCategory(d.category).label, facts: d.facts ?? null }));
    const datasets = await availableDatasets(user).catch(() => []);
    result = await runAgent(history, message, onEvent, { userId, user, document, dataset, documents, datasets });
    if (key) await storeAnswer(key, result);
  }

  // la conversazione viene salvata su disco con testo, grafici, fonti e passi dell'agente
  const { conversation, assistantMsg } = await appendTurn(
    userId,
    sessionId,
    message,
    {
      content: result.reply,
      charts: result.charts,
      tables: result.tables,
      sources: result.sources,
      trace: result.trace,
      ...(cached && { cached: true }),
    },
    readable ? { document: readable } : {},
  );
  return { sessionId, title: conversation.title, message: assistantMsg, ...result, cached };
}
