/**
 * API della chat:
 *   POST /api/chat         risposta JSON unica
 *   POST /api/chat/stream  stessa logica, con eventi Server-Sent Events durante il ragionamento
 *                          (quale strumento sta usando l'agente) e l'evento "final" con la risposta completa
 * body: { message: string, sessionId?: string, docId?: string }
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { logError } from "../logger.js";
import { isValidId } from "../repositories/conversationRepository.js";
import { handleTurn } from "../services/chatService.js";

export const MAX_MESSAGE_LENGTH = 4000;

/** Valida il corpo della richiesta; in caso di errore risponde 400 e restituisce null. */
function validateChatBody(req, res) {
  const { message, sessionId, docId } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Il campo 'message' è obbligatorio." });
    return null;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `Messaggio troppo lungo (max ${MAX_MESSAGE_LENGTH} caratteri).` });
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

function friendlyError(err) {
  logError("[chat] errore:", err);
  if (err?.status === 402) return err.message; // tetto di spesa raggiunto: il messaggio è già chiaro
  if (err?.status === 401) return "Chiave OpenAI non valida: controlla OPENAI_API_KEY nel file .env.";
  if (err?.status === 429) return "Limite di richieste OpenAI raggiunto, riprova tra poco.";
  return "Si è verificato un errore durante l'elaborazione della richiesta.";
}

export const chatRouter = Router();

chatRouter.post("/", async (req, res) => {
  const body = validateChatBody(req, res);
  if (!body) return;
  try {
    res.json(await handleTurn(req.user, body));
  } catch (err) {
    // il tetto di spesa (402) e altri errori con status noto lo propagano; gli altri sono 500
    res.status(err?.status === 402 ? 402 : 500).json({ error: friendlyError(err) });
  }
});

chatRouter.post("/stream", async (req, res) => {
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
