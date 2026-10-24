/**
 * Cache delle risposte (backend/storage/answer_cache.json): chiave → risposta già data, con data di
 * creazione, ultimo utilizzo e numero di utilizzi. Le regole (chiave, scadenza, limite) sono in
 * services/answerCacheService.js.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const FILE = path.join(config.storageDir, "answer_cache.json");

await fs.mkdir(path.dirname(FILE), { recursive: true });

let entries = null; // cache in memoria: { [key]: { answer, createdAt, lastHitAt, hits } }

async function load() {
  if (entries) return entries;
  try {
    entries = JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    entries = {};
  }
  return entries;
}

async function save() {
  await fs.writeFile(FILE + ".tmp", JSON.stringify(entries));
  await fs.rename(FILE + ".tmp", FILE);
}

export async function getEntry(key) {
  return (await load())[key] ?? null;
}

export async function setEntry(key, entry) {
  (await load())[key] = entry;
  await save();
}

export async function deleteEntries(keys) {
  await load();
  for (const k of keys) delete entries[k];
  await save();
}

export async function allEntries() {
  return Object.entries(await load());
}
