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
 *
 * API dei dataset (file di dati analizzabili dal data agent):
 *   GET    /api/datasets               dataset disponibili (dati partite + file CSV/Excel caricati)
 *   GET    /api/datasets/:id/overview  schema, pulizia, valori mancanti e anteprima righe
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { deleteDocumentChunks } from "../rag/vectorStore.js";
import { suggestCategory } from "./ai.js";
import { CATEGORIES, getCategory, isCategory } from "./categories.js";
import { datasetOverview, listDatasets, removeDataset } from "./dataAgentClient.js";
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
} from "./documentStore.js";
import { SUPPORTED_TYPES, isTabular, readableContent } from "./extract.js";
import { DocumentError, plainText, processDocument } from "./indexer.js";

const MAX_SIZE_MB = 20;
const BUILTIN_DATASET = "partite";

const upload = multer({
  dest: path.join(os.tmpdir(), "managementai-uploads"),
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (SUPPORTED_TYPES[ext]) return cb(null, true);
    cb(new DocumentError("Formato non supportato. Carica un file PDF, Word (.docx), TXT, Markdown, CSV o Excel."));
  },
});

/** multer come promessa, con messaggi d'errore leggibili. */
function receiveFile(req, res) {
  return new Promise((resolve) => {
    upload.single("file")(req, res, (err) => {
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
  canEdit: doc.ownerId !== SYSTEM_OWNER,
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
  const today = new Date().setHours(0, 0, 0, 0);
  const items = (await listVisible(req.user))
    .filter((d) => d.facts?.expiryDate)
    .map((d) => {
      const daysLeft = Math.round((new Date(d.facts.expiryDate).getTime() - today) / 86400000);
      return { ...toPublic(d, req.user), daysLeft };
    })
    .filter((d) => d.daysLeft >= -60)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  res.json(items);
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
  const patch = {};
  if (typeof req.body?.title === "string" && req.body.title.trim()) patch.title = req.body.title.trim().slice(0, 120);
  if (isCategory(req.body?.category) && !isTabular(doc.ext) && req.body.category !== "dati") patch.category = req.body.category;
  if (!Object.keys(patch).length) return res.status(400).json({ error: "Niente da modificare." });
  try {
    doc = await updateDocument(doc.id, patch);
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
    return res.status(403).json({ error: "I documenti ufficiali non si possono eliminare dall'app." });
  }
  await deleteDocumentChunks(doc.id);
  if (isTabular(doc.ext)) await removeDataset(doc.id).catch(() => {});
  await removeDocument(doc.id);
  res.json({ deleted: true });
});

/* ------------------------------------------------------------------ */
/* Dataset                                                             */
/* ------------------------------------------------------------------ */
export const datasetsRouter = Router();

/** Dataset analizzabili: quello delle partite (incluso nel progetto) + i file di dati dell'archivio. */
export async function availableDatasets(user) {
  const known = new Map((await listDatasets()).map((d) => [d.id, d]));
  const docs = (await listVisible(user)).filter((d) => isTabular(d.ext) && known.has(d.id));
  const builtin = known.get(BUILTIN_DATASET);
  return [
    ...(builtin ? [{ ...builtin, docId: null, official: true }] : []),
    ...docs.map((d) => ({ ...known.get(d.id), title: d.title, docId: d.id, official: d.ownerId === SYSTEM_OWNER })),
  ];
}

datasetsRouter.get("/", async (req, res) => {
  try {
    res.json(await availableDatasets(req.user));
  } catch {
    res.status(502).json({ error: "Data agent non raggiungibile." });
  }
});

datasetsRouter.get("/:id/overview", async (req, res) => {
  const { id } = req.params;
  if (id !== BUILTIN_DATASET) {
    const doc = await getDocument(id);
    if (!doc || !canRead(doc, req.user) || !isTabular(doc.ext)) return res.status(404).json({ error: "Dataset non trovato." });
  }
  try {
    const rows = Math.min(Number(req.query.rows) || 50, 200);
    res.json(await datasetOverview(id, rows));
  } catch (err) {
    res.status(err.status === 404 ? 404 : 502).json({ error: err.status === 404 ? "Dataset non trovato." : "Data agent non raggiungibile." });
  }
});
