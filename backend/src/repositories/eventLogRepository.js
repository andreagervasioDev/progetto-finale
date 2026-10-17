/**
 * Registri "solo aggiunta" in formato JSON Lines (una riga JSON per evento), in backend/storage/:
 *   - activity.jsonl  → cosa fanno gli utenti (accessi, domande, ricerche, caricamenti)
 *   - usage.jsonl     → token consumati da ogni chiamata a OpenAI
 * Aggiungere una riga è veloce e non riscrive mai il file; i totali si calcolano in lettura.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

await fs.mkdir(config.storageDir, { recursive: true });

function createLog(fileName) {
  const file = path.join(config.storageDir, fileName);
  let queue = Promise.resolve(); // scritture in fila: le righe non si mescolano

  return {
    append(event) {
      const line = JSON.stringify({ ts: Date.now(), ...event }) + "\n";
      queue = queue.then(() => fs.appendFile(file, line)).catch((err) => console.error(`[${fileName}]`, err.message));
      return queue;
    },
    async readAll() {
      await queue;
      let text = "";
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        return [];
      }
      return text
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return []; // riga incompleta (es. arresto durante la scrittura)
          }
        });
    },
  };
}

export const activityLog = createLog("activity.jsonl");
export const usageLog = createLog("usage.jsonl");
