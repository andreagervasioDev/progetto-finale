/**
 * Registro delle attività degli utenti, consultabile dall'amministratore:
 *   login, login_failed, logout, chat (domanda scritta), search (ricerca nell'archivio),
 *   upload, edit, delete (documenti)
 */
import { activityLog } from "../repositories/eventLogRepository.js";
import { currentUserId } from "./requestContext.js";

export const ACTIVITY_TYPES = ["login", "login_failed", "logout", "chat", "search", "upload", "edit", "delete"];

export function logActivity(type, details = {}, userId) {
  return activityLog.append({ userId: userId ?? currentUserId(), type, ...details });
}

/** Attività filtrate (più recenti prima). */
export async function listActivity({ userId, type, limit = 200 } = {}) {
  const events = await activityLog.readAll();
  return events
    .filter((e) => (!userId || e.userId === userId) && (!type || e.type === type))
    .reverse()
    .slice(0, limit);
}

export const readActivity = () => activityLog.readAll();
