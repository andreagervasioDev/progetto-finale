/**
 * Login e sessioni.
 *
 * La sessione è un token firmato con HMAC-SHA256 ("userId.scadenza.firma") salvato in un cookie
 * HttpOnly: il JavaScript della pagina non può leggerlo, e il browser lo invia anche per immagini,
 * PDF e download (che non passano da fetch). La chiave di firma viene da AUTH_SECRET nel .env
 * oppure è generata al primo avvio e salvata in storage/.auth_secret (mai nel codice).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { findByUsername, getUserById, recordLogin } from "../repositories/userRepository.js";
import { verifyPassword } from "./passwordService.js";

export const SESSION_COOKIE = "mai_session";
const SESSION_MS = config.auth.sessionDays * 86400000;

function loadSecret() {
  if (config.auth.secret) return config.auth.secret;
  const file = path.join(config.storageDir, ".auth_secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    const secret = randomBytes(32).toString("hex");
    fs.mkdirSync(config.storageDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

const SECRET = loadSecret();
const sign = (payload) => createHmac("sha256", SECRET).update(payload).digest("base64url");

export function createSessionToken(userId, now = Date.now()) {
  const payload = `${userId}.${now + SESSION_MS}`;
  return `${payload}.${sign(payload)}`;
}

/** @returns l'id utente se il token è valido e non scaduto, altrimenti null */
export function verifySessionToken(token, now = Date.now()) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, signature] = parts;
  const expected = Buffer.from(sign(`${userId}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!(Number(expires) > now)) return null;
  return userId;
}

export const sessionMaxAgeSeconds = () => Math.floor(SESSION_MS / 1000);

/* ---------- protezione dai tentativi ripetuti ---------- */
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;
const failures = new Map(); // "ip|username" -> { count, until }

export function isLocked(key, now = Date.now()) {
  const f = failures.get(key);
  return Boolean(f && f.count >= MAX_FAILURES && f.until > now);
}

function registerFailure(key, now = Date.now()) {
  const f = failures.get(key);
  const count = f && f.until > now ? f.count + 1 : 1;
  failures.set(key, { count, until: now + LOCK_MS });
}

/**
 * Verifica le credenziali.
 * @returns {{ user } | { error: string, status: number }}
 */
export async function login(username, password, ip = "") {
  const key = `${ip}|${String(username).toLowerCase()}`;
  if (isLocked(key)) return { status: 429, error: "Troppi tentativi non riusciti: riprova tra qualche minuto." };
  const user = await findByUsername(username);
  // la password viene verificata anche se l'utente non esiste, così i tempi di risposta non rivelano i nomi validi
  const ok = await verifyPassword(password, user?.passwordHash ?? "00:00");
  if (!user || !ok) {
    registerFailure(key);
    return { status: 401, error: "Nome utente o password non corretti." };
  }
  failures.delete(key);
  await recordLogin(user.id);
  return { user };
}

export async function userFromToken(token) {
  const id = verifySessionToken(token);
  return id ? getUserById(id) : null;
}
