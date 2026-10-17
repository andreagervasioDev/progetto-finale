/** GET /api/charts/:file — proxy verso le immagini dei grafici generate dal data agent. */
import { Readable } from "node:stream";
import { Router } from "express";
import { fetchChart } from "../clients/dataAgentClient.js";

export const CHART_FILE = /^chart_[a-f0-9]+\.png$/;

export const chartsRouter = Router();

chartsRouter.get("/:file", async (req, res) => {
  const file = req.params.file;
  if (!CHART_FILE.test(file)) return res.status(400).end();
  try {
    const upstream = await fetchChart(file);
    if (!upstream.ok) return res.status(upstream.status).end();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    res.status(502).end();
  }
});
