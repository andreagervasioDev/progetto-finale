/**
 * API dei dataset (file di dati analizzabili dal data agent):
 *   GET /api/datasets               dataset disponibili (dati partite + file CSV/Excel caricati)
 *   GET /api/datasets/:id/overview  schema, pulizia, valori mancanti e anteprima righe
 */
import { Router } from "express";
import { datasetOverview } from "../clients/dataAgentClient.js";
import { isTabular } from "../documents/extract.js";
import { canRead, getDocument } from "../repositories/documentRepository.js";
import { BUILTIN_DATASET, availableDatasets } from "../services/datasetService.js";

export const datasetsRouter = Router();

datasetsRouter.get("/", async (req, res) => {
  try {
    res.json(await availableDatasets(req.user));
  } catch {
    res.status(502).json({ error: "Data agent non raggiungibile." });
  }
});

datasetsRouter.get("/:id/overview", async (req, res) => {
  const { id } = req.params;
  if (id !== BUILTIN_DATASET) {
    const doc = await getDocument(id);
    if (!doc || !canRead(doc, req.user) || !isTabular(doc.ext)) return res.status(404).json({ error: "Dataset non trovato." });
  }
  try {
    const rows = Math.min(Number(req.query.rows) || 50, 200);
    res.json(await datasetOverview(id, rows));
  } catch (err) {
    res.status(err.status === 404 ? 404 : 502).json({ error: err.status === 404 ? "Dataset non trovato." : "Data agent non raggiungibile." });
  }
});
