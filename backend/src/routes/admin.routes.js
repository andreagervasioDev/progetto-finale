/**
 * Dashboard di amministrazione (solo utenti admin):
 *   GET /api/admin/overview                       KPI: spesa e token OpenAI, attività, utenti, archivio
 *   GET /api/admin/users                          utenti con i loro numeri (domande, caricamenti, spesa)
 *   GET /api/admin/activity?userId&type&limit     storico di accessi, domande, ricerche e caricamenti
 *   GET /api/admin/conversations?userId           conversazioni di tutti gli utenti
 *   GET /api/admin/conversations/:userId/:id      una conversazione completa (sola lettura)
 */
import { Router } from "express";
import { config } from "../config.js";
import { getConversation, isValidId, listConversations } from "../repositories/conversationRepository.js";
import { listAll } from "../repositories/documentRepository.js";
import { listUsers, publicUser } from "../repositories/userRepository.js";
import { ACTIVITY_TYPES, listActivity, readActivity } from "../services/activityService.js";
import { PRICES_PER_MILLION, readUsage, summarizeUsage } from "../services/usageService.js";

export const adminRouter = Router();

const DAY_MS = 86400000;
const SPECIAL_USERS = { system: "Sistema (indicizzazione)", anonimo: "Non autenticato" };

async function userNames() {
  const names = new Map((await listUsers()).map((u) => [u.id, u.name]));
  return (id) => names.get(id) ?? SPECIAL_USERS[id] ?? "Utente eliminato";
}

adminRouter.get("/overview", async (_req, res) => {
  const [usageEvents, activity, users, docs, nameOf] = await Promise.all([
    readUsage(),
    readActivity(),
    listUsers(),
    listAll(),
    userNames(),
  ]);
  const usage = summarizeUsage(usageEvents);
  usage.byUser = usage.byUser.map((g) => ({ ...g, name: nameOf(g.key) }));
  const since = Date.now() - 30 * DAY_MS;
  const count = (type, recent = false) => activity.filter((e) => e.type === type && (!recent || e.ts >= since)).length;
  const questions = count("chat");
  res.json({
    usage,
    model: config.chatModel,
    embeddingModel: config.embeddingModel,
    prices: PRICES_PER_MILLION,
    activity: {
      questions,
      questionsLast30Days: count("chat", true),
      searches: count("search"),
      uploads: count("upload"),
      logins: count("login"),
      failedLogins: count("login_failed", true),
    },
    costPerQuestionUsd: questions ? usage.total.costUsd / questions : null,
    users: users.length,
    documents: docs.length,
  });
});

adminRouter.get("/users", async (_req, res) => {
  const [users, usage, activity] = await Promise.all([listUsers(), readUsage(), readActivity()]);
  const rows = await Promise.all(
    users.map(async (u) => {
      const mine = activity.filter((e) => e.userId === u.id);
      const spent = usage.filter((e) => e.userId === u.id);
      return {
        ...publicUser(u),
        conversations: (await listConversations(u.id)).length,
        questions: mine.filter((e) => e.type === "chat").length,
        searches: mine.filter((e) => e.type === "search").length,
        uploads: mine.filter((e) => e.type === "upload").length,
        tokens: spent.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0),
        costUsd: spent.reduce((s, e) => s + (e.costUsd ?? 0), 0),
        lastActivityAt: mine.at(-1)?.ts ?? null,
      };
    }),
  );
  res.json(rows);
});

adminRouter.get("/activity", async (req, res) => {
  const type = ACTIVITY_TYPES.includes(req.query.type) ? req.query.type : undefined;
  const userId = typeof req.query.userId === "string" && req.query.userId ? req.query.userId : undefined;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const nameOf = await userNames();
  const events = await listActivity({ userId, type, limit });
  res.json(events.map((e) => ({ ...e, userName: nameOf(e.userId) })));
});

adminRouter.get("/conversations", async (req, res) => {
  const users = (await listUsers()).filter((u) => !req.query.userId || u.id === req.query.userId);
  const all = await Promise.all(
    users.map(async (u) => (await listConversations(u.id)).map((c) => ({ ...c, userId: u.id, userName: u.name }))),
  );
  res.json(all.flat().sort((a, b) => b.updatedAt - a.updatedAt));
});

adminRouter.get("/conversations/:userId/:id", async (req, res) => {
  if (!isValidId(req.params.userId)) return res.status(404).json({ error: "Conversazione non trovata." });
  const conv = await getConversation(req.params.userId, req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversazione non trovata." });
  const nameOf = await userNames();
  res.json({ ...conv, userId: req.params.userId, userName: nameOf(req.params.userId) });
});
