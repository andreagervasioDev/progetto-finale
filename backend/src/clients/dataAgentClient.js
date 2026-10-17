/**
 * Client HTTP verso il data agent Python (FastAPI): unico punto del backend che lo chiama.
 *  - analisi (tool analyze_data dell'orchestratore)
 *  - dataset (file CSV / Excel): il backend conserva il file originale (download e anteprima)
 *    e lo registra nel data agent, che lo carica con pandas e lo rende analizzabile
 *  - grafici generati e stato del servizio
 */
import fs from "node:fs/promises";
import { config } from "../config.js";

const url = (p) => `${config.dataAgentUrl}${p}`;

async function check(res) {
  if (res.ok) return res.json();
  const body = await res.json().catch(() => ({}));
  const err = new Error(body.detail || `Data agent: HTTP ${res.status}`);
  err.status = res.status;
  throw err;
}

/** Analisi in linguaggio naturale su un dataset: risposta, grafici, codice eseguito e report di pulizia. */
export async function analyzeData({ question, context, datasetId }) {
  const res = await fetch(url("/analyze"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, context, dataset_id: datasetId }),
    signal: AbortSignal.timeout(config.dataAgentTimeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Data agent ha risposto ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

/** Immagine PNG di un grafico generato (risposta fetch, da inoltrare al browser). */
export function fetchChart(file) {
  return fetch(url(`/charts/${file}`));
}

/** Stato del data agent, o null se non raggiungibile. */
export async function dataAgentHealth() {
  return fetch(url("/health"), { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json())
    .catch(() => null);
}

export async function registerDataset(doc, filePath) {
  const form = new FormData();
  form.append("id", doc.id);
  form.append("title", doc.title);
  form.append("file", new Blob([await fs.readFile(filePath)]), doc.originalName);
  return check(await fetch(url("/datasets"), { method: "POST", body: form, signal: AbortSignal.timeout(60000) }));
}

export async function removeDataset(id) {
  return check(await fetch(url(`/datasets/${encodeURIComponent(id)}`), { method: "DELETE" }));
}

export async function listDatasets() {
  return check(await fetch(url("/datasets"), { signal: AbortSignal.timeout(5000) }));
}

export async function datasetOverview(id, rows = 50) {
  return check(await fetch(url(`/datasets/${encodeURIComponent(id)}/overview?rows=${rows}`), { signal: AbortSignal.timeout(15000) }));
}
