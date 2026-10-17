/**
 * Autenticazione delle API: il cookie di sessione identifica l'utente (req.user).
 * Ogni richiesta autenticata gira nel "contesto" del suo utente, così token consumati e attività
 * vengono attribuiti a lui (vedi services/requestContext.js).
 */
import { SESSION_COOKIE, userFromToken } from "../services/authService.js";
import { runWithUser } from "../services/requestContext.js";

/** Legge un cookie dall'header Cookie (senza dipendenze esterne). */
export function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function requireUser(req, res, next) {
  const user = await userFromToken(readCookie(req, SESSION_COOKIE));
  if (!user) return res.status(401).json({ error: "Accesso richiesto." });
  req.user = user;
  runWithUser(user, next);
}

export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "Area riservata agli amministratori." });
  next();
}
