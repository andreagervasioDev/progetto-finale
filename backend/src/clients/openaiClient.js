import OpenAI from "openai";
import { config } from "../config.js";

let client;

// Istanza condivisa creata al primo utilizzo: la chiave arriva solo dalle variabili d'ambiente.
// Ogni chiamata ha un tempo massimo esplicito; quelle della chat ricevono anche il signal della richiesta.
export function getOpenAI() {
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey, timeout: config.openaiTimeoutMs, maxRetries: config.openaiMaxRetries });
  return client;
}
