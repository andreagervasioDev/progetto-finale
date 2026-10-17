/**
 * Accesso:
 *   POST /api/auth/login   { username, password } → imposta il cookie di sessione, restituisce il profilo
 *   POST /api/auth/logout  cancella il cookie
 */
import { Router } from "express";
import { readCookie } from "../middleware/auth.js";
import { publicUser } from "../repositories/userRepository.js";
import { logActivity } from "../services/activityService.js";
import { SESSION_COOKIE, createSessionToken, login, sessionMaxAgeSeconds, verifySessionToken } from "../services/authService.js";

const cookie = (value, maxAge) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
    return res.status(400).json({ error: "Inserisci nome utente e password." });
  }
  const result = await login(username, password, req.ip);
  if (result.error) {
    logActivity("login_failed", { username: username.trim().slice(0, 60) }, "anonimo");
    return res.status(result.status).json({ error: result.error });
  }
  logActivity("login", {}, result.user.id);
  res.setHeader("Set-Cookie", cookie(createSessionToken(result.user.id), sessionMaxAgeSeconds()));
  res.json(publicUser(result.user));
});

authRouter.post("/logout", (req, res) => {
  const userId = verifySessionToken(readCookie(req, SESSION_COOKIE));
  if (userId) logActivity("logout", {}, userId);
  res.setHeader("Set-Cookie", cookie("", 0));
  res.json({ ok: true });
});
