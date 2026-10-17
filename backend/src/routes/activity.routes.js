/** POST /api/activity/search — registra una ricerca fatta nell'archivio (per lo storico dell'amministratore). */
import { Router } from "express";
import { logActivity } from "../services/activityService.js";

export const activityRouter = Router();

activityRouter.post("/search", (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim().slice(0, 200) : "";
  if (query.length < 2) return res.status(400).json({ error: "Ricerca troppo corta." });
  const source = req.body?.source === "home" ? "home" : "documenti";
  logActivity("search", { query, source });
  res.status(204).end();
});
