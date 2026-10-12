/**
 * Client verso il data agent Python per i dataset (file CSV / Excel).
 * Il backend conserva il file originale (per download e anteprima) e lo registra nel data agent,
 * che lo carica con pandas e lo rende analizzabile.
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
