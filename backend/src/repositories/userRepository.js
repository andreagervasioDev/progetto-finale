/**
 * Utenti della piattaforma (backend/storage/users.json), con password salvate come hash scrypt.
 *
 * Al primo avvio vengono creati due utenti:
 *   - admin / admin → amministratore: vede anche la dashboard di amministrazione
 *   - test  / test  → utente normale
 * Se esiste già un profilo (versioni precedenti dell'app) diventa l'utente "admin",
 * così le sue conversazioni restano accessibili.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { hashPassword } from "../services/passwordService.js";
import { claimOrphanConversations } from "./conversationRepository.js";

const FILE = path.join(config.storageDir, "users.json");

await fs.mkdir(path.dirname(FILE), { recursive: true });

let users = null; // cache in memoria

/** Dati dell'utente da inviare al frontend (mai l'hash della password). */
export const publicUser = ({ id, username, name, role, isAdmin, createdAt, lastLoginAt }) => ({
  id,
  username,
  name,
  role,
  isAdmin: Boolean(isAdmin),
  createdAt,
  lastLoginAt: lastLoginAt ?? null,
});

async function save() {
  await fs.writeFile(FILE + ".tmp", JSON.stringify(users, null, 2));
  await fs.rename(FILE + ".tmp", FILE);
}

async function load() {
  if (users) return users;
  try {
    users = JSON.parse(await fs.readFile(FILE, "utf8"));
  } catch {
    users = [];
  }
  if (await ensureDefaultUsers()) await save();
  return users;
}

/** Crea gli utenti predefiniti mancanti. @returns true se qualcosa è cambiato */
async function ensureDefaultUsers() {
  let changed = false;
  if (!users.some((u) => u.username === "admin")) {
    // un profilo esistente senza login diventa l'amministratore (mantiene conversazioni e documenti)
    const legacy = users.find((u) => !u.isAdmin && u.username !== "test");
    if (legacy) {
      Object.assign(legacy, { username: "admin", isAdmin: true, passwordHash: await hashPassword(config.auth.defaultAdminPassword) });
    } else {
      users.push({
        id: randomUUID(),
        username: "admin",
        name: "Amministratore",
        role: "Amministratore",
        isAdmin: true,
        passwordHash: await hashPassword(config.auth.defaultAdminPassword),
        createdAt: Date.now(),
      });
    }
    // conversazioni di versioni precedenti salvate senza utente
    await claimOrphanConversations(users.find((u) => u.username === "admin").id);
    changed = true;
  }
  if (!users.some((u) => u.username === "test")) {
    users.push({
      id: randomUUID(),
      username: "test",
      name: "Utente Test",
      role: "Staff",
      isAdmin: false,
      passwordHash: await hashPassword(config.auth.defaultTestPassword),
      createdAt: Date.now(),
    });
    changed = true;
  }
  return changed;
}

export async function listUsers() {
  return [...(await load())];
}

export async function getUserById(id) {
  return (await load()).find((u) => u.id === id) ?? null;
}

export async function findByUsername(username) {
  const name = String(username ?? "").trim().toLowerCase();
  return (await load()).find((u) => u.username.toLowerCase() === name) ?? null;
}

export async function recordLogin(id) {
  const user = (await load()).find((u) => u.id === id);
  if (!user) return;
  user.lastLoginAt = Date.now();
  await save();
}
