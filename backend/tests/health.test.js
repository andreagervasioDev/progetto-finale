/**
 * Controlli di salute con ChromaDB e data agent bloccati, come all'avvio su Render mentre si indicizzano i
 * documenti: /api/health/live (il controllo di Render, che concede 5 secondi) deve rispondere subito, e
 * /api/health non deve mai restare appeso.
 */
import "./env.js";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

// un server che accetta le connessioni e non risponde mai
const stuck = http.createServer(() => {}).listen(0);
await new Promise((r) => stuck.once("listening", r));
const stuckPort = stuck.address().port;

process.env.CHROMA_HOST = "127.0.0.1";
process.env.CHROMA_PORT = String(stuckPort);
process.env.DATA_AGENT_URL = `http://127.0.0.1:${stuckPort}`;
const { createApp } = await import("../src/app.js");

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  stuck.closeAllConnections();
  stuck.close();
});

async function timed(path) {
  const started = Date.now();
  const res = await fetch(base + path);
  return { res, ms: Date.now() - started, body: await res.json() };
}

test("/api/health/live risponde subito anche con ChromaDB e data agent bloccati", async () => {
  const { res, ms, body } = await timed("/api/health/live");
  assert.equal(res.status, 200);
  assert.deepEqual(body, { status: "ok" });
  assert.ok(ms < 500, `${ms} ms`);
});

test("/api/health segnala i servizi bloccati come offline entro il limite di Render (5 s)", async () => {
  const { res, ms, body } = await timed("/api/health");
  assert.equal(res.status, 200);
  assert.equal(body.chroma, "offline");
  assert.equal(body.dataAgent, "offline");
  assert.ok(ms < 5000, `${ms} ms`);
});
