/**
 * Applicazione Express: middleware e montaggio delle rotte. Non apre porte né contatta servizi esterni,
 * così può essere importata anche dai test (vedi tests/http.test.js). L'avvio è in server.js.
 */
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { logError } from "./logger.js";
import { requireAdmin, requireUser } from "./middleware/auth.js";
import { activityRouter } from "./routes/activity.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { chartsRouter } from "./routes/charts.routes.js";
import { chatRouter } from "./routes/chat.routes.js";
import { conversationsRouter } from "./routes/conversations.routes.js";
import { datasetsRouter } from "./routes/datasets.routes.js";
import { documentsRouter } from "./routes/documents.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { profileRouter } from "./routes/profile.routes.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", "loopback"); // dietro il proxy di Vite: req.ip è l'indirizzo reale
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // pubbliche: stato dei servizi e login
  app.use("/api/health", healthRouter);
  app.use("/api/auth", authRouter);

  // tutte le altre API richiedono la sessione
  app.use("/api", requireUser);
  app.use("/api/me", profileRouter);
  app.use("/api/activity", activityRouter);
  app.use("/api/admin", requireAdmin, adminRouter);
  app.use("/api/chat", chatRouter);
  app.use("/api/conversations", conversationsRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/datasets", datasetsRouter);
  app.use("/api/charts", chartsRouter);

  // compatibilità con la prima versione: panoramica del dataset partite
  app.get("/api/data/overview", (req, res) =>
    res.redirect(307, `/api/datasets/partite/overview${req.query.rows ? `?rows=${req.query.rows}` : ""}`),
  );

  app.use("/api", (_req, res) => res.status(404).json({ error: "Endpoint non trovato." }));

  // gestore finale degli errori: senza, Express risponderebbe con la traccia completa dell'errore
  // (percorsi dei file sul server compresi). Al client va solo un messaggio generico, il dettaglio nei log.
  app.use((err, req, res, _next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Il corpo della richiesta non è un JSON valido." });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Richiesta troppo grande." });
    logError(`[${req.method} ${req.originalUrl}]`, err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: "Si è verificato un errore interno." });
  });
  return app;
}
