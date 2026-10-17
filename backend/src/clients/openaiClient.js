import OpenAI from "openai";
import { config } from "../config.js";

let client;

// Istanza condivisa creata al primo utilizzo: la chiave arriva solo dalle variabili d'ambiente
export function getOpenAI() {
  if (!client) client = new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}
