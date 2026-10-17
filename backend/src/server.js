/**
 * Avvio del backend: apre la porta e, in background, allinea ChromaDB all'archivio documenti.
 *
 * Struttura del backend (a livelli):
 *   routes/        endpoint HTTP: validano l'input e chiamano i servizi
 *   services/      logica: turno di chat, agente ReAct, elaborazione documenti, dataset, scadenze
 *   prompts/       system prompt dell'orchestratore
 *   tools/         strumenti del function calling (RAG e data agent)
 *   rag/           ChromaDB: embedding, ricerca, suddivisione in chunk
 *   repositories/  dati salvati su disco: conversazioni, documenti, profilo
 *   clients/       servizi esterni: OpenAI e data agent Python
 *   documents/     categorie dell'archivio ed estrazione del testo dai file
 */
import { createApp } from "./app.js";
import { config } from "./config.js";
import { chromaHeartbeat } from "./rag/vectorStore.js";
import { syncKnowledgeBase } from "./services/documentService.js";

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

createApp().listen(config.port, async (err) => {
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
