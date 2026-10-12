/**
 * Profilo utente unico della piattaforma (backend/storage/users.json).
 *
 * L'app non ha login: tutte le richieste usano lo stesso profilo. Se esiste già un utente
 * (es. registrato quando c'era il login) si usa quello, così conversazioni e documenti restano;
 * altrimenti ne viene creato uno predefinito.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { claimOrphanConversations } from "../conversationStore.js";

const FILE = path.join(config.storageDir, "users.json");

await fs.mkdir(path.dirname(FILE), { recursive: true });

let currentUser = null; // cache in memoria

/** Dati dell'utente da inviare al frontend. */
export const publicUser = ({ id, username, name, role, createdAt }) => ({ id, username, name, role, createdAt });

export async function getCurrentUser() {
  if (currentUser) return currentUser;
  let users = [];
  try {
    users = JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    /* primo avvio: nessun utente */
  }
  if (!users.length) {
    users = [{ id: randomUUID(), username: "staff", name: "Staff del club", role: "Staff", createdAt: Date.now() }];
    await fs.writeFile(FILE, JSON.stringify(users, null, 2));
    // conversazioni di versioni precedenti salvate senza utente
    await claimOrphanConversations(users[0].id);
  }
  currentUser = users[0];
  return currentUser;
}

/** Middleware: ogni richiesta API lavora con il profilo unico. */
export async function attachUser(req, _res, next) {
  req.user = await getCurrentUser();
  next();
}
