import { ChromaClient } from "chromadb";
import { config } from "../config.js";
import { getOpenAI } from "../clients/openaiClient.js";
import { recordUsage } from "../services/usageService.js";

/**
 * Funzione di embedding custom per Chroma basata su OpenAI.
 * Chroma la usa sia in indicizzazione (documents) sia in query (queryTexts).
 */
const openAIEmbeddingFunction = {
  name: "openai-custom",
  async generate(texts) {
    const res = await getOpenAI().embeddings.create({ model: config.embeddingModel, input: texts });
    recordUsage({ kind: "embedding", model: res.model ?? config.embeddingModel, usage: res.usage });
    return res.data.map((d) => d.embedding);
  },
};

const chroma = new ChromaClient({ host: config.chroma.host, port: config.chroma.port });

export async function getCollection() {
  return chroma.getOrCreateCollection({
    name: config.chroma.collection,
    embeddingFunction: openAIEmbeddingFunction,
    metadata: { "hnsw:space": "cosine", description: "Knowledge base documentale di Management AI" },
  });
}

export async function resetCollection() {
  try {
    await chroma.deleteCollection({ name: config.chroma.collection });
  } catch {
    // la collection non esisteva ancora
  }
  return getCollection();
}

export async function chromaHeartbeat(timeoutMs = 3000) {
  try {
    await Promise.race([
      chroma.heartbeat(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Filtro Chroma: permessi (documenti del club + privati dell'utente), più eventuale documento o categoria. */
function accessFilter(userId, docId, category) {
  const conditions = [{ $or: [{ visibility: "club" }, { ownerId: userId }] }];
  if (docId) conditions.push({ docId });
  if (category) conditions.push({ category });
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

/**
 * Retrieval semantico: restituisce i chunk più simili alla query, solo tra i documenti
 * che l'utente può leggere (ed eventualmente solo dentro un documento specifico).
 */
export async function searchKnowledgeBase(query, { userId, docId, category, topK = 4 } = {}) {
  const collection = await getCollection();
  const res = await collection.query({ queryTexts: [query], nResults: topK, where: accessFilter(userId, docId, category) });
  const docs = res.documents?.[0] ?? [];
  return docs.map((text, i) => {
    const m = res.metadatas[0][i] ?? {};
    return {
      text,
      docId: m.docId,
      category: m.category,
      source: m.source,
      title: m.title,
      section: m.section,
      page: m.page || null,
      // distanza coseno -> similarità (1 = identico)
      score: Number((1 - res.distances[0][i]).toFixed(3)),
    };
  });
}

export async function deleteDocumentChunks(docId) {
  const collection = await getCollection();
  await collection.delete({ where: { docId } });
}

/** Mappa docId -> numero di chunk presenti nell'indice, più gli id dei chunk "orfani" (senza documento). */
export async function indexInventory(validDocIds) {
  const collection = await getCollection();
  const all = await collection.get({ include: ["metadatas"] });
  const counts = new Map();
  const orphans = [];
  all.ids.forEach((id, i) => {
    const docId = all.metadatas[i]?.docId;
    if (docId && validDocIds.has(docId)) counts.set(docId, (counts.get(docId) ?? 0) + 1);
    else orphans.push(id);
  });
  return { counts, orphans };
}

export async function deleteChunkIds(ids) {
  if (!ids.length) return;
  const collection = await getCollection();
  await collection.delete({ ids });
}
