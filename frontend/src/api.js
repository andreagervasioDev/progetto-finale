async function check(res, fallback) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || fallback);
  }
  return res;
}

/**
 * Client verso il backend Node.
 * sendMessageStream usa POST /api/chat/stream e legge gli eventi Server-Sent Events
 * per mostrare in tempo reale cosa sta facendo l'agente.
 */

export async function sendMessageStream({ message, sessionId, docId, onEvent, signal }) {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId, docId }),
    signal,
  });
  await check(res, `Errore HTTP ${res.status}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let final = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop();
    for (const block of blocks) {
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === "error") throw new Error(payload.error);
      if (event === "final") final = payload;
      onEvent?.(event, payload);
    }
  }
  if (!final) throw new Error("Connessione interrotta prima della risposta finale.");
  return final;
}

/* ---------------- Cronologia conversazioni ---------------- */

export async function listConversations() {
  const res = await check(await fetch("/api/conversations"), "Impossibile caricare la cronologia");
  return res.json();
}

export async function getConversation(id) {
  const res = await fetch(`/api/conversations/${id}`);
  if (res.status === 404) return null;
  await check(res, "Impossibile caricare la conversazione");
  return res.json();
}

export async function deleteConversation(id) {
  await check(await fetch(`/api/conversations/${id}`, { method: "DELETE" }), "Eliminazione non riuscita");
}

/* ---------------- Profilo ---------------- */

export async function getMe() {
  const res = await check(await fetch("/api/me"), "Backend non raggiungibile");
  return res.json();
}

/* ---------------- Documenti ---------------- */

export async function listDocuments() {
  const res = await check(await fetch("/api/documents"), "Impossibile caricare i documenti");
  return res.json();
}

export async function getDocumentContent(id) {
  const res = await fetch(`/api/documents/${id}/content`);
  if (res.status === 404) return null;
  await check(res, "Impossibile aprire il documento");
  return res.json();
}

export async function deleteDocument(id) {
  await check(await fetch(`/api/documents/${id}`, { method: "DELETE" }), "Eliminazione non riuscita");
}

export const documentFileUrl = (id, { download = false, page } = {}) =>
  `/api/documents/${id}/file${download ? "?download=1" : ""}${page ? `#page=${page}` : ""}`;

export async function getCategories() {
  const res = await check(await fetch("/api/documents/categories"), "Categorie non disponibili");
  return res.json();
}

export async function getDeadlines() {
  const res = await check(await fetch("/api/documents/deadlines"), "Scadenze non disponibili");
  return res.json();
}

/** L'AI propone categoria e titolo per un file (prima del caricamento vero e proprio). */
export async function suggestCategory(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await check(await fetch("/api/documents/suggest", { method: "POST", body: form }), "Proposta non disponibile");
  return res.json();
}

export async function updateDocument(id, patch) {
  const res = await check(
    await fetch(`/api/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
    "Modifica non riuscita",
  );
  return res.json();
}

/**
 * Caricamento con avanzamento (XMLHttpRequest: fetch non espone il progresso dell'upload).
 * onProgress riceve un valore 0-1; al termine dell'invio il server elabora il documento.
 */
export function uploadDocument({ file, title, category, onProgress }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("category", category);
    if (title) form.append("title", title);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* risposta non JSON */
      }
      if (xhr.status >= 400) return reject(new Error(data.error || "Caricamento non riuscito"));
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Connessione al server non riuscita"));
    xhr.send(form);
  });
}

/* ---------------- Dataset ---------------- */

export async function listDatasets() {
  const res = await check(await fetch("/api/datasets"), "Dati non disponibili");
  return res.json();
}

export async function getDatasetOverview(id, rows = 50) {
  const res = await check(await fetch(`/api/datasets/${id}/overview?rows=${rows}`), "Dati non disponibili");
  return res.json();
}

/** Compatibilità: panoramica del dataset partite. */
export const getDataOverview = (rows = 50) => getDatasetOverview("partite", rows);
