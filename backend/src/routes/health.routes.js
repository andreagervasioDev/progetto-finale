/**
 * GET /api/health       stato dei tre servizi (backend, ChromaDB, data agent) e della knowledge base
 * GET /api/health/live  risponde subito, senza interrogare nessun servizio: è il controllo usato da Render.
 *   Render considera l'istanza pronta solo se il controllo risponde entro 5 secondi; /api/health dipende da
 *   ChromaDB e dal data agent, che all'avvio sul piano gratuito (0,1 CPU) sono occupati a indicizzare i
 *   documenti, e su un servizio già online troppi controlli lenti farebbero riavviare l'istanza.
 */
import { Router } from "express";
import { dataAgentHealth } from "../clients/dataAgentClient.js";
import { config } from "../config.js";
import { chromaHeartbeat, getCollection } from "../rag/vectorStore.js";

export const healthRouter = Router();

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/", async (_req, res) => {
  const [chroma, dataAgent] = await Promise.all([chromaHeartbeat(), dataAgentHealth()]);
  let kbChunks = null;
  // con un limite anche il conteggio: la risposta non resta mai appesa a ChromaDB
  if (chroma) kbChunks = await withTimeout(getCollection().then((c) => c.count()), 1500).catch(() => null);
  res.json({
    backend: "ok",
    model: config.chatModel,
    openaiKeyConfigured: Boolean(config.openaiApiKey),
    chroma: chroma ? "ok" : "offline",
    knowledgeBaseChunks: kbChunks,
    dataAgent: dataAgent ? "ok" : "offline",
    datasetRows: dataAgent?.dataset_rows ?? null,
    // controllo di colonne e tipi del CSV fatto dal data agent all'avvio
    dataValidation: dataAgent?.validation ?? null,
    // PNG dei grafici salvati e giorni dopo cui vengono eliminati
    charts: dataAgent?.charts ?? null,
    // cache delle analisi del data agent: voci salvate, riusi e analisi rifatte
    analysisCache: dataAgent?.analysis_cache ?? null,
  });
});
