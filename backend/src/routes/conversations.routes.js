/**
 * Cronologia delle conversazioni (memoria persistente):
 *   GET    /api/conversations      elenco (più recenti prima)
 *   GET    /api/conversations/:id  conversazione completa, per riaprirla e continuarla
 *   PATCH  /api/conversations/:id  rinomina
 *   DELETE /api/conversations/:id  elimina
 */
import { Router } from "express";
import {
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
} from "../repositories/conversationRepository.js";

export const conversationsRouter = Router();

conversationsRouter.get("/", async (req, res) => {
  res.json(await listConversations(req.user.id));
});

conversationsRouter.get("/:id", async (req, res) => {
  const conv = await getConversation(req.user.id, req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversazione non trovata." });
  res.json(conv);
});

conversationsRouter.patch("/:id", async (req, res) => {
  const title = req.body?.title;
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "Titolo obbligatorio." });
  const conv = await renameConversation(req.user.id, req.params.id, title);
  if (!conv) return res.status(404).json({ error: "Conversazione non trovata." });
  res.json({ id: conv.id, title: conv.title });
});

conversationsRouter.delete("/:id", async (req, res) => {
  res.json({ deleted: await deleteConversation(req.user.id, req.params.id) });
});
