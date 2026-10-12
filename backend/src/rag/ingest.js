/**
 * Indicizzazione della knowledge base in ChromaDB da riga di comando.
 *
 *   npm run ingest         -> allinea l'indice all'archivio documenti (indicizza solo ciò che manca)
 *   npm run ingest:reset   -> re-indicizza da zero tutti i documenti
 *
 * Il server esegue la stessa sincronizzazione automaticamente all'avvio.
 */
import { pathToFileURL } from "node:url";
import { assertOpenAIKey } from "../config.js";
import { syncKnowledgeBase } from "../documents/indexer.js";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertOpenAIKey();
    await syncKnowledgeBase({ reset: process.argv.includes("--reset") });
  } catch (err) {
    console.error("Errore durante l'indicizzazione:", err.message);
    console.error("Verifica che Chroma sia in esecuzione (npm run chroma) e che OPENAI_API_KEY sia impostata.");
    process.exit(1);
  }
}
