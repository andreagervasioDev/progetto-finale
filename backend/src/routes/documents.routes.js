/**
 * API dei documenti:
 *   GET    /api/documents/categories   categorie dell'archivio
 *   GET    /api/documents              elenco dei documenti
 *   GET    /api/documents/deadlines    scadenze estratte dall'AI (contratti, sponsor, certificati, offerte)
 *   POST   /api/documents/suggest      l'AI propone categoria e titolo per un file (multipart: file)
 *   POST   /api/documents              carica un file (multipart: file, category, title?)
 *   GET    /api/documents/:id          metadati
 *   PATCH  /api/documents/:id          modifica titolo e/o categoria (documenti caricati)
 *   GET    /api/documents/:id/content  contenuto per il lettore (markdown / testo / html / pdf / dataset)
 *   GET    /api/documents/:id/file     file originale (inline; ?download=1 per scaricarlo)
 *   DELETE /api/documents/:id          elimina (non i documenti ufficiali)
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { removeDataset } from "../clients/dataAgentClient.js";
import { CATEGORIES, getCategory, isCategory } from "../documents/categories.js";
import { SUPPORTED_TYPES, isTabular, readableContent } from "../documents/extract.js";
import { UnsafeFileError, verifyFileContent } from "../documents/fileCheck.js";
import { deleteDocumentChunks } from "../rag/vectorStore.js";
import {
  SYSTEM_OWNER,
  addDocument,
  canDelete,
  canRead,
  filePathOf,
  getDocument,
  listVisible,
  removeDocument,
  updateDocument,
} from "../repositories/documentRepository.js";
import { logActivity } from "../services/activityService.js";
import { upcomingDeadlines } from "../services/deadlineService.js";
import { suggestCategory } from "../services/documentAiService.js";
import { DocumentError, plainText, processDocument } from "../services/documentService.js";
import { assertWithinBudget } from "../services/usageService.js";

const MAX_SIZE_MB = 20;

const upload = multer({
  dest: path.join(os.tmpdir(), "managementai-uploads"),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (SUPPORTED_TYPES[ext]) return cb(null, true);
    cb(new DocumentError("Formato non supportato. Carica un file PDF, Word (.docx), TXT, Markdown, CSV o Excel."));
  },
});

/**
 * multer come promessa, con messaggi d'errore leggibili. Il file ricevuto viene subito controllato
 * (firma del formato, zip bomb): se non è valido viene cancellato e la risposta è 422.
 */
function receiveFile(req, res) {
  return new Promise((resolve) => {
    upload.single("file")(req, res, async (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? `File troppo grande (massimo ${MAX_SIZE_MB} MB).` : err.message;
        res.status(err.status ?? 400).json({ error: msg });
        return resolve(null);
      }
      if (!req.file) {
        res.status(400).json({ error: "Nessun file ricevuto." });
        return resolve(null);
      }
      // multer decodifica i nomi come latin1: li riporto in UTF-8 (accenti nei nomi dei file)
      req.file.originalname = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      try {
        await verifyFileContent(req.file.path, path.extname(req.file.originalname).toLowerCase());
      } catch (checkErr) {
        await fs.unlink(req.file.path).catch(() => {});
        const expected = checkErr instanceof UnsafeFileError;
        if (!expected) console.error("[documenti] controllo del file non riuscito:", checkErr.message);
        res.status(expected ? 422 : 400).json({ error: expected ? checkErr.message : "File non leggibile." });
        return resolve(null);
      }
      resolve(req.file);
    });
  });
}

/** Dati del documento da inviare al frontend. */
const toPublic = (doc, user) => ({
  id: doc.id,
  title: doc.title,
  originalName: doc.originalName,
  type: SUPPORTED_TYPES[doc.ext]?.label ?? doc.ext,
  ext: doc.ext,
  size: doc.size,
  category: doc.category ?? "altro",
  categoryLabel: getCategory(doc.category).label,
  tabular: isTabular(doc.ext),
  rows: doc.rows ?? null,
  facts: doc.facts ?? null,
  official: doc.ownerId === SYSTEM_OWNER,
  canDelete: canDelete(doc, user),
  canEdit: canDelete(doc, user),
  ownerName: doc.ownerName ?? null,
  chunks: doc.chunks,
  createdAt: doc.createdAt,
});

export const documentsRouter = Router();

/** Carica il documento e verifica che l'utente possa leggerlo. */
async function loadReadable(req, res) {
  const doc = await getDocument(req.params.id);
  if (!doc || !canRead(doc, req.user)) {
    res.status(404).json({ error: "Documento non trovato." });
    return null;
  }
  return doc;
}

documentsRouter.get("/categories", (_req, res) => {
  res.json(CATEGORIES.map(({ id, label, facts, tabular }) => ({ id, label, facts, tabular: Boolean(tabular) })));
});

documentsRouter.get("/", async (req, res) => {
  res.json((await listVisible(req.user)).map((d) => toPublic(d, req.user)));
});

/** Scadenze: documenti con una data estratta dall'AI, dalla più vicina. Include le scadute da meno di 60 giorni. */
documentsRouter.get("/deadlines", async (req, res) => {
  const items = upcomingDeadlines(await listVisible(req.user));
  res.json(items.map(({ doc, daysLeft }) => ({ ...toPublic(doc, req.user), daysLeft })));
});

/** L'AI legge l'inizio del file e propone categoria e titolo (l'utente conferma prima di caricare). */
documentsRouter.post("/suggest", async (req, res) => {
  const file = await receiveFile(req, res);
  if (!file) return;
  const ext = path.extname(file.originalname).toLowerCase();
  const fallbackTitle = path.basename(file.originalname, ext).replace(/[_-]+/g, " ").trim();
  try {
    if (isTabular(ext)) return res.json({ category: "dati", title: fallbackTitle, ai: false });
    const text = await plainText(file.path, ext);
    if (!text.trim()) return res.json({ category: "altro", title: fallbackTitle, ai: false });
    // fuori budget: niente proposta dall'AI, si parte da una categoria neutra (l'utente sceglie)
    await assertWithinBudget().catch(() => {
      throw new DocumentError("Tetto di spesa giornaliero raggiunto: scegli tu la categoria.");
    });
    const s = await suggestCategory(text, file.originalname);
    res.json({ category: s.category, title: s.title || fallbackTitle, ai: true });
  } catch (err) {
    console.error("[documenti] proposta categoria non riuscita:", err.message);
    res.json({ category: "altro", title: fallbackTitle, ai: false });
  } finally {
    await fs.unlink(file.path).catch(() => {});
  }
});

documentsRouter.post("/", async (req, res) => {
  const file = await receiveFile(req, res);
  if (!file) return;

  const originalName = file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  // i documenti di testo richiedono embedding (ed estrazione dati chiave): se fuori budget, si rifiuta
  // prima di salvare il file. I file di dati (CSV/Excel) non usano OpenAI, quindi passano sempre.
  if (!isTabular(ext)) {
    try {
      await assertWithinBudget();
    } catch (err) {
      await fs.unlink(file.path).catch(() => {});
      return res.status(err.status ?? 402).json({ error: err.message });
    }
  }
  // i file di dati vanno sempre nella categoria "dati"; i documenti di testo mai
  let category = isCategory(req.body.category) ? req.body.category : "altro";
  if (isTabular(ext)) category = "dati";
  else if (category === "dati") category = "altro";
  const title = (req.body.title || "").trim().slice(0, 120) || path.basename(originalName, ext);

  let doc;
  try {
    doc = await addDocument({
      title,
      originalName,
      ext,
      size: file.size,
      category,
      // senza login c'è un solo profilo: tutti i documenti caricati sono del club
      visibility: "club",
      ownerId: req.user.id,
      ownerName: req.user.name,
    });
    await fs.rename(file.path, filePathOf(doc)).catch(async () => {
      // rename tra dischi diversi non è possibile: copio e cancello
      await fs.copyFile(file.path, filePathOf(doc));
      await fs.unlink(file.path);
    });
    doc = await processDocument(doc);
    console.log(`[documenti] caricato "${title}" (${getCategory(category).label})`);
    logActivity("upload", { docId: doc.id, title, category, fileName: originalName, size: file.size });
    res.status(201).json(toPublic(doc, req.user));
  } catch (err) {
    // qualcosa è andato storto: niente documenti "a metà"
    await fs.unlink(file.path).catch(() => {});
    if (doc) {
      await deleteDocumentChunks(doc.id).catch(() => {});
      if (isTabular(doc.ext)) await removeDataset(doc.id).catch(() => {});
      await removeDocument(doc.id);
    }
    console.error("[documenti] caricamento fallito:", err.message);
    const expected = err instanceof DocumentError || err.status === 422;
    res
      .status(expected ? 422 : 502)
      .json({ error: expected ? err.message : "Elaborazione non riuscita: verifica che tutti i servizi siano attivi e riprova." });
  }
});

documentsRouter.get("/:id", async (req, res) => {
  const doc = await loadReadable(req, res);
  if (doc) res.json(toPublic(doc, req.user));
});

/** Modifica titolo e/o categoria; il documento viene rielaborato (indice e dati chiave). */
documentsRouter.patch("/:id", async (req, res) => {
  let doc = await loadReadable(req, res);
  if (!doc) return;
  if (doc.ownerId === SYSTEM_OWNER) {
    return res.status(403).json({ error: "I documenti ufficiali si modificano dalla cartella knowledge_base/." });
  }
  if (!canDelete(doc, req.user)) {
    return res.status(403).json({ error: "Puoi modificare solo i documenti che hai caricato." });
  }
  const patch = {};
  if (typeof req.body?.title === "string" && req.body.title.trim()) patch.title = req.body.title.trim().slice(0, 120);
  if (isCategory(req.body?.category) && !isTabular(doc.ext) && req.body.category !== "dati") patch.category = req.body.category;
  if (!Object.keys(patch).length) return res.status(400).json({ error: "Niente da modificare." });
  try {
    doc = await updateDocument(doc.id, patch);
    logActivity("edit", { docId: doc.id, title: doc.title, ...patch });
    doc = await processDocument(doc);
    res.json(toPublic(doc, req.user));
  } catch (err) {
    console.error("[documenti] modifica non riuscita:", err.message);
    res.status(502).json({ error: "Modifica salvata, ma la rielaborazione non è riuscita: riprova." });
  }
});

documentsRouter.get("/:id/content", async (req, res) => {
  const doc = await loadReadable(req, res);
  if (!doc) return;
  try {
    res.json({ ...toPublic(doc, req.user), ...(await readableContent(filePathOf(doc), doc.ext)) });
  } catch {
    res.status(500).json({ error: "Impossibile leggere il documento." });
  }
});

documentsRouter.get("/:id/file", async (req, res) => {
  const doc = await loadReadable(req, res);
  if (!doc) return;
  const disposition = req.query.download ? "attachment" : "inline";
  res.setHeader("Content-Type", SUPPORTED_TYPES[doc.ext]?.mime ?? "application/octet-stream");
  res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(filePathOf(doc));
});

documentsRouter.delete("/:id", async (req, res) => {
  const doc = await loadReadable(req, res);
  if (!doc) return;
  if (!canDelete(doc, req.user)) {
    const error = doc.ownerId === SYSTEM_OWNER ? "I documenti ufficiali non si possono eliminare dall'app." : "Puoi eliminare solo i documenti che hai caricato.";
    return res.status(403).json({ error });
  }
  await deleteDocumentChunks(doc.id);
  if (isTabular(doc.ext)) await removeDataset(doc.id).catch(() => {});
  await removeDocument(doc.id);
  logActivity("delete", { docId: doc.id, title: doc.title, category: doc.category });
  res.json({ deleted: true });
});
