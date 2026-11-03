/**
 * Annullamento della chat: se il client chiude la connessione, il ciclo dell'agente si ferma.
 *
 * OpenAI e il data agent sono sostituiti da due finti server locali che contano le chiamate e registrano
 * quando una connessione viene chiusa prima della risposta. Nessuna chiamata reale, nessun token consumato.
 */
import { TEST_STORAGE } from "./env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = async (handler) => {
  const server = http.createServer(handler).listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const json = (res, body) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));

// --- finto OpenAI: primo passo → chiede analyze_data, passo successivo → risposta finale -----------------
const completion = (message) => ({
  id: "chatcmpl-test",
  object: "chat.completion",
  model: "gpt-4.1-mini",
  choices: [{ index: 0, message: { role: "assistant", content: null, ...message }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const toolCall = completion({
  tool_calls: [{ id: "call_1", type: "function", function: { name: "analyze_data", arguments: '{"question":"Chi ha corso di più?"}' } }],
});

let openai; // { calls, closedEarly, delayMs, hang }
let agent; // { calls, closedEarly, delayMs, received }

function trackClose(req, res, state) {
  res.on("close", () => {
    if (!res.writableFinished) state.closedEarly = true;
  });
}

const fakeOpenAI = await listen(async (req, res) => {
  for await (const _ of req); // legge il corpo
  openai.calls++;
  trackClose(req, res, openai);
  openai.onRequest?.();
  if (openai.hang) return; // non risponde mai: deve intervenire il timeout
  await wait(openai.delayMs);
  if (res.destroyed) return;
  json(res, openai.calls === 1 ? toolCall : completion({ content: "Ha corso di più Okafor." }));
});

const fakeDataAgent = await listen(async (req, res) => {
  for await (const _ of req);
  if (req.url === "/datasets") return json(res, []);
  if (req.url !== "/analyze") return res.writeHead(404).end();
  agent.calls++;
  trackClose(req, res, agent);
  agent.onRequest?.();
  await wait(agent.delayMs);
  if (res.destroyed) return;
  json(res, { answer: "Okafor: 11,2 km.", charts: [], tables: [], steps: [], cleaning_report: {}, dataset: { id: "partite", title: "Partite" }, usage: [], cached: false });
});

// configurazione letta da config.js: va impostata prima di importare l'app
process.env.OPENAI_BASE_URL = `${fakeOpenAI.url}/v1`;
process.env.DATA_AGENT_URL = fakeDataAgent.url;
process.env.OPENAI_TIMEOUT_MS = "800";
process.env.OPENAI_MAX_RETRIES = "0";
const { createApp } = await import("../src/app.js");

let server;
let base;
let cookie;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test", password: "test" }),
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
});
after(() => {
  server.close();
  fakeOpenAI.server.close();
  fakeDataAgent.server.close();
});
beforeEach(() => {
  openai = { calls: 0, closedEarly: false, delayMs: 0 };
  agent = { calls: 0, closedEarly: false, delayMs: 0 };
});

let n = 0;
/** Avvia una domanda (ogni volta diversa, così la cache delle risposte non interviene). */
function ask(route, signal) {
  const sessionId = `sessione-annullata-${++n}`;
  const response = fetch(`${base}/api/chat${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ message: `Chi ha corso di più? (${n})`, sessionId }),
    signal,
  }).then((r) => r.text());
  return { sessionId, response: response.catch((err) => err) };
}
const savedConversation = async (sessionId) => {
  const users = JSON.parse(fs.readFileSync(path.join(TEST_STORAGE, "users.json"), "utf8"));
  const id = users.find((u) => u.username === "test").id;
  return fs.existsSync(path.join(TEST_STORAGE, "conversations", id, `${sessionId}.json`));
};
const nextRequest = (state) => new Promise((r) => (state.onRequest = r));

describe("annullamento della chat", () => {
  test("senza annullamento il turno si completa e viene salvato", async () => {
    const { sessionId, response } = ask("/stream");
    const text = await response;
    assert.match(text, /event: final/);
    assert.equal(openai.calls, 2);
    assert.equal(agent.calls, 1);
    assert.ok(await savedConversation(sessionId));
  });

  test("client disconnesso mentre lavora il data agent: chiamata chiusa e nessun altro passo", async () => {
    agent.delayMs = 400; // senza annullamento il data agent risponderebbe e il ciclo andrebbe avanti
    const controller = new AbortController();
    const received = nextRequest(agent);
    const { sessionId, response } = ask("/stream", controller.signal);
    await received;
    controller.abort();
    assert.equal((await response).name, "AbortError");
    await wait(700);
    assert.equal(agent.closedEarly, true, "la chiamata al data agent deve essere chiusa");
    assert.equal(openai.calls, 1, "dopo l'annullamento non deve partire un altro passo verso OpenAI");
    assert.equal(await savedConversation(sessionId), false);
  });

  test("client disconnesso durante la chiamata a OpenAI: chiamata chiusa, nessuno strumento avviato", async () => {
    openai.delayMs = 400;
    const controller = new AbortController();
    const received = nextRequest(openai);
    const { response } = ask("/stream", controller.signal);
    await received;
    controller.abort();
    await response;
    await wait(700);
    assert.equal(openai.closedEarly, true, "la chiamata a OpenAI deve essere chiusa");
    assert.equal(openai.calls, 1);
    assert.equal(agent.calls, 0);
  });

  test("stessa cosa con la rotta JSON /api/chat", async () => {
    agent.delayMs = 400;
    const controller = new AbortController();
    const received = nextRequest(agent);
    ask("", controller.signal);
    await received;
    controller.abort();
    await wait(700);
    assert.equal(agent.closedEarly, true);
    assert.equal(openai.calls, 1);
  });

  test("OpenAI non risponde: la chiamata scade dopo OPENAI_TIMEOUT_MS e l'utente riceve un errore", async () => {
    openai.hang = true;
    const started = Date.now();
    const text = await ask("/stream").response;
    assert.match(text, /event: error/);
    assert.match(text, /errore durante l'elaborazione/);
    assert.ok(Date.now() - started < 3000, "senza timeout esplicito l'SDK aspetterebbe fino a 10 minuti");
    assert.equal(openai.calls, 1); // OPENAI_MAX_RETRIES=0
  });
});
