/** GET /api/me — profilo dell'utente collegato (401 se la sessione manca o è scaduta). */
import { Router } from "express";
import { publicUser } from "../repositories/userRepository.js";

export const profileRouter = Router();

profileRouter.get("/", (req, res) => res.json(publicUser(req.user)));
