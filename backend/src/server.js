import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import cors from "cors";
import express from "express";
import { runAgent } from "./agent/orchestrator.js";
import { attachUser, publicUser } from "./auth/userStore.js";
import { config } from "./config.js";
import { getCategory } from "./documents/categories.js";
import { canRead, getDocument, listVisible } from "./documents/documentStore.js";
import { isTabular } from "./documents/extract.js";
import { syncKnowledgeBase } from "./documents/indexer.js";
import { availableDatasets, datasetsRouter, documentsRouter } from "./documents/routes.js";
import { chromaHeartbeat, getCollection } from "./rag/vectorStore.js";
import {
  appendTurn,
  deleteConversation,
  getConversation,
  getHistory,
  isValidId,
  listConversations,
  renameConversation,
} from "./conversationStore.js";

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "1mb" }));

// nessun login: tutte le API lavorano con il profilo unico della piattaforma
app.use(["/api/me", "/api/chat", "/api/conversations", "/api/charts", "/api/documents", "/api/datasets", "/api/data"], attachUser);
app.get("/api/me", (req, res) => res.json(publicUser(req.user)));
app.use("/api/documents", documentsRouter);
app.use("/api/datasets", datasetsRouter);

function validateChatBody(req, res) {
  const { message, sessionId, docId } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Il campo 'message' è obbligatorio." });
    return null;
  }
  if (message.length > 4000) {
    res.status(400).json({ error: "Messaggio troppo lungo (max 4000 caratteri)." });
    return null;
  }
  if (sessionId != null && !isValidId(sessionId)) {
    res.status(400).json({ error: "sessionId non valido." });
    return null;
  }
  if (docId != null && typeof docId !== "string") {
    res.status(400).json({ error: "docId non valido." });
    return null;
  }
  return { message: message.trim(), sessionId: sessionId ?? randomUUID(), docId };
}

async function handleTurn(user, { sessionId, message, docId }, onEvent) {
  const userId = user.id;
  // elemento aperto: un documento (la ricerca può limitarsi a quello) o un file di dati (dataset predefinito)
  const opened = docId ? await getDocument(docId) : null;
  const readable = opened && canRead(opened, user) ? { id: opened.id, title: opened.title } : null;
  const document = readable && !isTabular(opened.ext) ? readable : null;
  const dataset = readable && isTabular(opened.ext) ? readable : null;

  // archivio (titoli per categoria e dati chiave) e dataset disponibili, passati all'agente
  const documents = (await listVisible(user))
    .filter((d) => !isTabular(d.ext))
    .map((d) => ({ title: d.title, categoryLabel: getCategory(d.category).label, facts: d.facts ?? null }));
  const datasets = await availableDatasets(user).catch(() => []);

  const history = await getHistory(userId, sessionId);
  const result = await runAgent(history, message, onEvent, { userId, user, document, dataset, documents, datasets });
  // la conversazione viene salvata su disco con testo, grafici, fonti e passi dell'agente
  const { conversation, assistantMsg } = await appendTurn(userId, sessionId, message, {
    content: result.reply,
    charts: result.charts,
    sources: result.sources,
    trace: result.trace,
  }, readable ? { document: readable } : {});
  return { sessionId, title: conversation.title, message: assistantMsg, ...result };
}

function friendlyError(err) {
  console.error("[chat] errore:", err);
  if (err?.status === 401) return "Chiave OpenAI non valida: controlla OPENAI_API_KEY nel file .env.";
  if (err?.status === 429) return "Limite di richieste OpenAI raggiunto, riprova tra poco.";
  return "Si è verificato un errore durante l'elaborazione della richiesta.";
}

/**
 * POST /api/chat — risposta JSON unica.
 * body: { message: string, sessionId?: string }
 */
app.post("/api/chat", async (req, res) => {
  const body = validateChatBody(req, res);
  if (!body) return;
  try {
    res.json(await handleTurn(req.user, body));
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

/**
 * POST /api/chat/stream — stessa logica, ma invia eventi Server-Sent Events durante il ragionamento
 * (quale strumento sta usando l'agente) e infine l'evento "final" con la risposta completa.
 */
app.post("/api/chat/stream", async (req, res) => {
  const body = validateChatBody(req, res);
  if (!body) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("session", { sessionId: body.sessionId });

  try {
    const result = await handleTurn(req.user, body, (e) => send(e.type, e));
    send("final", result);
  } catch (err) {
    send("error", { error: friendlyError(err) });
  } finally {
    res.end();
  }
});

/** Cronologia: elenco delle conversazioni salvate (più recenti prima). */
app.get("/api/conversations", async (req, res) => {
  res.json(await listConversations(req.user.id));
});

/** Conversazione completa, per riaprirla e continuarla. */
app.get("/api/conversations/:id", async (req, res) => {
  const conv = await getConversation(req.user.id, req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversazione non trovata." });
  res.json(conv);
});

app.patch("/api/conversations/:id", async (req, res) => {
  const title = req.body?.title;
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "Titolo obbligatorio." });
  const conv = await renameConversation(req.user.id, req.params.id, title);
  if (!conv) return res.status(404).json({ error: "Conversazione non trovata." });
  res.json({ id: conv.id, title: conv.title });
});

app.delete("/api/conversations/:id", async (req, res) => {
  res.json({ deleted: await deleteConversation(req.user.id, req.params.id) });
});

/** Proxy verso le immagini dei grafici servite dal data agent. */
app.get("/api/charts/:file", async (req, res) => {
  const file = req.params.file;
  if (!/^chart_[a-f0-9]+\.png$/.test(file)) return res.status(400).end();
  try {
    const upstream = await fetch(`${config.dataAgentUrl}/charts/${file}`);
    if (!upstream.ok) return res.status(upstream.status).end();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    res.status(502).end();
  }
});

/** Compatibilità con la prima versione: panoramica del dataset partite (ora /api/datasets/partite/overview). */
app.get("/api/data/overview", (req, res) => res.redirect(307, `/api/datasets/partite/overview${req.query.rows ? `?rows=${req.query.rows}` : ""}`));

app.get("/api/health", async (_req, res) => {
  const [chroma, dataAgent] = await Promise.all([
    chromaHeartbeat(),
    fetch(`${config.dataAgentUrl}/health`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .catch(() => null),
  ]);
  let kbChunks = null;
  if (chroma) kbChunks = await getCollection().then((c) => c.count()).catch(() => null);
  res.json({
    backend: "ok",
    model: config.chatModel,
    openaiKeyConfigured: Boolean(config.openaiApiKey),
    chroma: chroma ? "ok" : "offline",
    knowledgeBaseChunks: kbChunks,
    dataAgent: dataAgent ? "ok" : "offline",
    datasetRows: dataAgent?.dataset_rows ?? null,
  });
});

/** All'avvio: sincronizza ChromaDB con l'archivio documenti. */
async function ensureKnowledgeBase() {
  if (!config.openaiApiKey) {
    console.warn("ATTENZIONE: OPENAI_API_KEY non impostata: la chat non funzionerà finché non configuri il file .env");
    return;
  }
  // Chroma potrebbe essere ancora in avvio (es. con "npm run dev" dalla root): riprovo per ~30 secondi
  for (let attempt = 1; !(await chromaHeartbeat()); attempt++) {
    if (attempt === 15) {
      console.warn(`ATTENZIONE: ChromaDB non raggiungibile su ${config.chroma.host}:${config.chroma.port}. Avvialo con: npm run chroma`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  // allinea l'indice all'archivio documenti (documenti ufficiali, nuovi caricamenti, chunk orfani)
  await syncKnowledgeBase();
}

app.listen(config.port, async (err) => {
  if (err) {
    console.error(`Impossibile avviare il backend sulla porta ${config.port}: ${err.message}`);
    console.error("Imposta un'altra porta con BACKEND_PORT nel file .env (e aggiorna VITE_BACKEND_URL se serve).");
    process.exit(1);
  }
  console.log(`Backend Management AI in ascolto su http://localhost:${config.port} (modello: ${config.chatModel})`);
  try {
    await ensureKnowledgeBase();
  } catch (err) {
    console.error("Impossibile preparare la knowledge base:", err.message);
  }
});
