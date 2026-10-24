/** GET /api/health — stato dei tre servizi (backend, ChromaDB, data agent) e della knowledge base. */
import { Router } from "express";
import { dataAgentHealth } from "../clients/dataAgentClient.js";
import { config } from "../config.js";
import { chromaHeartbeat, getCollection } from "../rag/vectorStore.js";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  const [chroma, dataAgent] = await Promise.all([chromaHeartbeat(), dataAgentHealth()]);
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
    // controllo di colonne e tipi del CSV fatto dal data agent all'avvio
    dataValidation: dataAgent?.validation ?? null,
  });
});
