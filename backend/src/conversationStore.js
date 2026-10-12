/**
 * Archivio persistente delle conversazioni, separato per utente.
 *
 * Ogni conversazione è un file JSON in backend/storage/conversations/<userId>/<id>.json
 * con tutti i messaggi (testo, grafici, fonti e passi dell'agente). In questo modo:
 *   - la cronologia sopravvive al riavvio del backend;
 *   - ogni utente vede e riprende solo le proprie conversazioni.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const ROOT = path.join(config.storageDir, "conversations");
const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const cache = new Map(); // "userId/id" -> conversazione

await fs.mkdir(ROOT, { recursive: true });

export const isValidId = (id) => typeof id === "string" && ID_RE.test(id);

async function userDir(userId) {
  if (!isValidId(userId)) throw new Error("userId non valido");
  const dir = path.join(ROOT, userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeTitle(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? clean.slice(0, 57).trimEnd() + "…" : clean;
}

async function save(userId, conv) {
  cache.set(`${userId}/${conv.id}`, conv);
  const file = path.join(await userDir(userId), `${conv.id}.json`);
  // scrittura atomica: file temporaneo + rename, così un crash non corrompe la conversazione
  await fs.writeFile(file + ".tmp", JSON.stringify(conv, null, 2));
  await fs.rename(file + ".tmp", file);
}

export async function getConversation(userId, id) {
  if (!isValidId(id)) return null;
  const key = `${userId}/${id}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const conv = JSON.parse(await fs.readFile(path.join(await userDir(userId), `${id}.json`), "utf8"));
    cache.set(key, conv);
    return conv;
  } catch {
    return null;
  }
}

/** Cronologia da passare all'LLM: solo testo utente/assistente, ultimi N messaggi. */
export async function getHistory(userId, id) {
  const conv = await getConversation(userId, id);
  if (!conv) return [];
  return conv.messages.slice(-config.maxHistoryMessages).map(({ role, content }) => ({ role, content }));
}

/** Salva un turno completo (domanda + risposta) creando la conversazione se non esiste. */
export async function appendTurn(userId, id, userText, assistant, userExtra = {}) {
  const now = Date.now();
  const conv = (await getConversation(userId, id)) ?? { id, title: makeTitle(userText), createdAt: now, messages: [] };
  const userMsg = { id: randomUUID(), role: "user", content: userText, createdAt: now, ...userExtra };
  const assistantMsg = { id: randomUUID(), role: "assistant", createdAt: Date.now(), ...assistant };
  conv.messages.push(userMsg, assistantMsg);
  conv.updatedAt = Date.now();
  await save(userId, conv);
  return { conversation: conv, userMsg, assistantMsg };
}

export async function listConversations(userId) {
  const files = (await fs.readdir(await userDir(userId))).filter((f) => f.endsWith(".json"));
  const convs = await Promise.all(files.map((f) => getConversation(userId, f.replace(/\.json$/, ""))));
  return convs
    .filter(Boolean)
    .map(({ id, title, createdAt, updatedAt, messages }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      messageCount: messages.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function renameConversation(userId, id, title) {
  const conv = await getConversation(userId, id);
  if (!conv) return null;
  conv.title = makeTitle(title);
  await save(userId, conv);
  return conv;
}

export async function deleteConversation(userId, id) {
  if (!isValidId(id)) return false;
  cache.delete(`${userId}/${id}`);
  try {
    await fs.unlink(path.join(await userDir(userId), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Conversazioni salvate senza utente (versioni precedenti, file nella radice): passano al profilo. */
export async function claimOrphanConversations(userId) {
  const dir = await userDir(userId);
  const orphans = (await fs.readdir(ROOT)).filter((f) => f.endsWith(".json"));
  for (const f of orphans) await fs.rename(path.join(ROOT, f), path.join(dir, f));
  if (orphans.length) console.log(`Assegnate ${orphans.length} conversazioni esistenti al primo utente registrato.`);
}
