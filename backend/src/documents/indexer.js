/**
 * Elaborazione dei documenti dopo il caricamento (o all'avvio, per i documenti ufficiali).
 *
 *  - documenti di testo (PDF, Word, MD, TXT): testo estratto, spezzato e indicizzato in ChromaDB.
 *    Ogni chunk porta nei metadati docId, titolo, categoria, sezione/pagina, visibilità e proprietario,
 *    così la ricerca può filtrare per categoria e per singolo documento.
 *    Per contratti, sponsorizzazioni, area medica e mercato l'AI estrae anche i dati chiave
 *    (persona, controparte, importo, scadenza).
 *  - file di dati (CSV, Excel): registrati nel data agent Python, che li analizza con pandas.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { chunkMarkdown, chunkPlainText } from "../rag/chunker.js";
import { deleteChunkIds, deleteDocumentChunks, getCollection, indexInventory } from "../rag/vectorStore.js";
import { extractFacts } from "./ai.js";
import { categoryFromFolder, getCategory } from "./categories.js";
import { listDatasets, registerDataset } from "./dataAgentClient.js";
import {
  SYSTEM_OWNER,
  addDocument,
  filePathOf,
  findBySeed,
  listAll,
  removeDocument,
  updateDocument,
} from "./documentStore.js";
import { SUPPORTED_TYPES, extractText, isTabular } from "./extract.js";

const BATCH_SIZE = 50;

/** Errore "atteso" da mostrare all'utente (es. PDF senza testo). */
export class DocumentError extends Error {
  status = 422;
}

/** Testo semplice del documento (per l'AI che propone la categoria o estrae i dati chiave). */
export async function plainText(filePath, ext) {
  const { pages } = await extractText(filePath, ext);
  return pages.map((p) => p.text).join("\n\n");
}

async function buildChunks(doc) {
  const { pages, markdown } = await extractText(filePathOf(doc), doc.ext);
  const chunks = markdown
    ? chunkMarkdown(pages[0].text, doc.originalName).map((c) => ({ ...c, metadata: { ...c.metadata, page: 0 } }))
    : chunkPlainText(pages, { title: doc.title });
  if (!chunks.length) {
    throw new DocumentError(
      "Non sono riuscito a estrarre testo da questo file. Se è un PDF scansionato (immagine), serve prima l'OCR.",
    );
  }
  return chunks.map((c, i) => ({
    id: `${doc.id}::${i}`,
    text: c.text,
    metadata: {
      ...c.metadata,
      title: doc.title,
      docId: doc.id,
      category: doc.category,
      source: doc.originalName,
      visibility: doc.visibility,
      ownerId: doc.ownerId,
    },
  }));
}

/** Estrae, spezza e indicizza un documento di testo (sostituendo eventuali chunk precedenti). */
export async function indexDocument(doc) {
  const chunks = await buildChunks(doc);
  await deleteDocumentChunks(doc.id);
  const collection = await getCollection();
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    await collection.upsert({
      ids: batch.map((c) => c.id),
      documents: batch.map((c) => c.text),
      metadatas: batch.map((c) => c.metadata),
    });
  }
  await updateDocument(doc.id, { chunks: chunks.length, indexedAt: Date.now() });
  return chunks.length;
}

/** Dati chiave estratti dall'AI (solo per le categorie che li prevedono). Non blocca mai il caricamento. */
async function updateFacts(doc, log) {
  if (!getCategory(doc.category).facts) return updateDocument(doc.id, { facts: null });
  try {
    const facts = await extractFacts(await plainText(filePathOf(doc), doc.ext), getCategory(doc.category).label);
    return updateDocument(doc.id, { facts });
  } catch (err) {
    log?.(`  ERRORE estrazione dati chiave per ${doc.title}: ${err.message}`);
    return doc;
  }
}

/**
 * Elabora un documento appena caricato o modificato: dataset → data agent; testo → indice + dati chiave.
 * @returns il documento aggiornato
 */
export async function processDocument(doc, { log } = {}) {
  if (isTabular(doc.ext)) {
    const ds = await registerDataset(doc, filePathOf(doc));
    return updateDocument(doc.id, { chunks: 0, rows: ds.rows, columns: ds.columns, facts: null });
  }
  await indexDocument(doc);
  return updateFacts(doc, log);
}

/** Titolo leggibile dal nome del file: "05_policy_trasferte.pdf" -> "Policy trasferte". */
function titleFromFileName(file) {
  const base = path
    .basename(file, path.extname(file))
    .replace(/^\d+[\s._-]*/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return base ? base[0].toUpperCase() + base.slice(1) : file;
}

/** File della cartella knowledge_base/: quelli nella radice e quelli nelle sottocartelle di categoria. */
async function listKnowledgeBaseFiles() {
  const out = [];
  for (const entry of await fs.readdir(config.knowledgeBaseDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      for (const f of await fs.readdir(path.join(config.knowledgeBaseDir, entry.name))) {
        if (!f.startsWith(".") && SUPPORTED_TYPES[path.extname(f).toLowerCase()]) out.push(`${entry.name}/${f}`);
      }
    } else if (SUPPORTED_TYPES[path.extname(entry.name).toLowerCase()]) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/**
 * I file della cartella knowledge_base/ diventano documenti ufficiali (non eliminabili dall'interfaccia).
 * La categoria si ricava dalla sottocartella (knowledge_base/contratti/..., knowledge_base/medico/...);
 * i file nella radice sono "Regolamenti e procedure".
 *  - file nuovo → aggiunto · file modificato → aggiornato (hash) · file rimosso → eliminato anche dall'app
 * @returns {Promise<Set<string>>} id dei documenti ufficiali nuovi o modificati, da rielaborare
 */
async function seedKnowledgeBase(log) {
  const changed = new Set();
  const files = await listKnowledgeBaseFiles();

  for (const rel of files) {
    const source = path.join(config.knowledgeBaseDir, rel);
    const ext = path.extname(rel).toLowerCase();
    const buffer = await fs.readFile(source);
    const seedHash = createHash("sha256").update(buffer).digest("hex");
    // per il Markdown il titolo è il primo "# Titolo", per gli altri formati il nome del file
    const heading = ext === ".md" ? buffer.toString("utf8").match(/^#\s+(.+)$/m)?.[1]?.trim() : null;
    const category = isTabular(ext) ? "dati" : categoryFromFolder(path.dirname(rel) === "." ? "" : path.dirname(rel));
    const fields = { title: heading || titleFromFileName(rel), size: buffer.length, seedHash, category };

    let doc = await findBySeed(rel);
    if (doc?.seedHash === seedHash && doc.category) continue;
    if (doc) {
      doc = await updateDocument(doc.id, fields);
      log(`  ~ documento ufficiale aggiornato: ${doc.title}`);
    } else {
      doc = await addDocument({
        ...fields,
        originalName: path.basename(rel),
        ext,
        visibility: "club",
        ownerId: SYSTEM_OWNER,
        ownerName: "Documentazione ufficiale",
        seedFile: rel,
      });
      log(`  + documento ufficiale aggiunto: ${doc.title}`);
    }
    await fs.copyFile(source, filePathOf(doc));
    changed.add(doc.id);
  }

  // documenti ufficiali il cui file è stato tolto dalla cartella
  const present = new Set(files);
  for (const doc of await listAll()) {
    if (doc.seedFile && !present.has(doc.seedFile)) {
      await removeDocument(doc.id);
      log(`  - documento ufficiale rimosso: ${doc.title}`);
    }
  }
  return changed;
}

/** Documenti caricati prima dell'introduzione delle categorie: finiscono in "Altri documenti". */
async function migrateCategories(changed) {
  for (const doc of await listAll()) {
    if (doc.category) continue;
    await updateDocument(doc.id, { category: isTabular(doc.ext) ? "dati" : "altro" });
    changed.add(doc.id);
  }
}

/** Il data agent deve conoscere tutti i file di dati dell'archivio (per esempio dopo un suo riavvio). */
async function syncDatasets(docs, log) {
  const tabular = docs.filter((d) => isTabular(d.ext));
  if (!tabular.length) return;
  let known;
  for (let attempt = 1; ; attempt++) {
    try {
      known = new Set((await listDatasets()).map((d) => d.id));
      break;
    } catch {
      if (attempt === 15) return log("  ATTENZIONE: data agent non raggiungibile, i file di dati verranno registrati più tardi");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  for (const doc of tabular) {
    if (known.has(doc.id)) continue;
    try {
      await processDocument(doc);
      log(`  - dataset registrato nel data agent: ${doc.title}`);
    } catch (err) {
      log(`  ERRORE dataset ${doc.title}: ${err.message}`);
    }
  }
}

/**
 * Allinea l'archivio all'avvio:
 *  - documenti ufficiali nuovi, modificati o rimossi
 *  - indice ChromaDB (documenti senza chunk, chunk orfani; tutto con reset)
 *  - dati chiave mancanti e registrazione dei file di dati nel data agent
 */
export async function syncKnowledgeBase({ reset = false, log = console.log } = {}) {
  const changed = await seedKnowledgeBase(log);
  await migrateCategories(changed);
  const docs = await listAll();
  const textDocs = docs.filter((d) => !isTabular(d.ext));

  const { counts, orphans } = await indexInventory(new Set(textDocs.map((d) => d.id)));
  if (orphans.length) {
    await deleteChunkIds(orphans);
    log(`  - rimossi ${orphans.length} chunk non più associati a un documento`);
  }
  let indexed = 0;
  for (const doc of textDocs) {
    const needsIndex = reset || !counts.get(doc.id) || changed.has(doc.id);
    const needsFacts = needsIndex || doc.facts === undefined;
    if (!needsIndex && !needsFacts) continue;
    try {
      if (needsIndex) {
        const n = await indexDocument(doc);
        indexed++;
        log(`  - indicizzato: ${doc.title} (${n} chunk)`);
      }
      if (needsFacts) await updateFacts(doc, log);
    } catch (err) {
      log(`  ERRORE su ${doc.title}: ${err.message}`);
    }
  }
  const total = (await listAll()).reduce((s, d) => s + (d.chunks || 0), 0);
  log(`Knowledge base pronta: ${textDocs.length} documenti, ${total} chunk (${indexed} documenti indicizzati ora)`);
  await syncDatasets(docs, log);
  return { documents: docs.length, indexed };
}
