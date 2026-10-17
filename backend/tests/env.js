/**
 * Ambiente isolato per i test: va importato per primo, prima di qualunque modulo che legga config.js.
 * Profilo, documenti e conversazioni finiscono in una cartella temporanea (mai in backend/storage/),
 * e nessun test chiama OpenAI, ChromaDB o il data agent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "management-ai-test-"));
process.env.STORAGE_DIR = TEST_STORAGE;
process.env.OPENAI_API_KEY ||= "sk-test-non-usata";

process.on("exit", () => fs.rmSync(TEST_STORAGE, { recursive: true, force: true }));
