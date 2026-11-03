/**
 * Cache delle risposte (backend/storage/answer_cache.json): chiave → risposta già data, con data di
 * creazione, ultimo utilizzo e numero di utilizzi. Le regole (chiave, scadenza, limite) sono in
 * services/answerCacheService.js.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { withLock, writeJsonAtomic } from "./jsonFile.js";

const FILE = path.join(config.storageDir, "answer_cache.json");

await fs.mkdir(path.dirname(FILE), { recursive: true });

let entries = null; // cache in memoria: { [key]: { answer, createdAt, lastHitAt, hits } }
let loading = null; // primo caricamento condiviso dalle richieste contemporanee

function load() {
  if (entries) return Promise.resolve(entries);
  loading ??= fs
    .readFile(FILE, "utf8")
    .then(JSON.parse)
    .catch(() => ({}))
    .then((loaded) => (entries = loaded))
    .finally(() => {
      loading = null;
    });
  return loading;
}

// scritture in fila: ognuna salva lo stato più recente, nessuna si sovrappone a un'altra
const save = () => withLock(FILE, () => writeJsonAtomic(FILE, entries));

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
