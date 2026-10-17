/**
 * Archivio documenti: metadati in storage/documents.json, file originali in storage/files/.
 *
 * Visibilità:
 *   - "club"    → visibile a tutti gli utenti (es. regolamenti e protocolli ufficiali)
 *   - "private" → visibile solo a chi l'ha caricato
 * I documenti "di sistema" (la knowledge base iniziale del progetto) sono del club e non eliminabili.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

const META_FILE = path.join(config.storageDir, "documents.json");
export const FILES_DIR = path.join(config.storageDir, "files");
export const SYSTEM_OWNER = "system";

await fs.mkdir(FILES_DIR, { recursive: true });

let docs = null;

async function load() {
  if (docs) return docs;
  try {
    docs = JSON.parse(await fs.readFile(META_FILE, "utf8"));
  } catch {
    docs = [];
  }
  return docs;
}

async function persist() {
  await fs.writeFile(META_FILE + ".tmp", JSON.stringify(docs, null, 2));
  await fs.rename(META_FILE + ".tmp", META_FILE);
}

export const filePathOf = (doc) => path.join(FILES_DIR, `${doc.id}${doc.ext}`);

export const canRead = (doc, user) => doc.visibility === "club" || doc.ownerId === user.id;
// i documenti ufficiali non si eliminano dall'app; quelli caricati li elimina chi li ha caricati o un amministratore
export const canDelete = (doc, user) => doc.ownerId !== SYSTEM_OWNER && (doc.ownerId === user.id || Boolean(user.isAdmin));

/** Documenti visibili all'utente: quelli del club + i suoi privati, più recenti prima. */
export async function listVisible(user) {
  return (await load()).filter((d) => canRead(d, user)).sort((a, b) => b.createdAt - a.createdAt);
}

export async function listAll() {
  return [...(await load())];
}

export async function getDocument(id) {
  return (await load()).find((d) => d.id === id) ?? null;
}

export async function findBySeed(seedFile) {
  return (await load()).find((d) => d.seedFile === seedFile) ?? null;
}

export async function addDocument(fields) {
  await load();
  const doc = { id: randomUUID(), createdAt: Date.now(), chunks: 0, ...fields };
  docs.push(doc);
  await persist();
  return doc;
}

export async function updateDocument(id, patch) {
  await load();
  const doc = docs.find((d) => d.id === id);
  if (!doc) return null;
  Object.assign(doc, patch);
  await persist();
  return doc;
}

export async function removeDocument(id) {
  await load();
  const doc = docs.find((d) => d.id === id);
  if (!doc) return false;
  docs = docs.filter((d) => d.id !== id);
  await persist();
  await fs.unlink(filePathOf(doc)).catch(() => {});
  return true;
}
