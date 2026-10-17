/**
 * Test delle API HTTP sull'app Express reale (createApp), avviata su una porta casuale.
 * Verificano validazione dell'input e rotte che non richiedono OpenAI, ChromaDB o il data agent.
 */
import "./env.js";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";

let server;
let base;
let testCookie; // sessione dell'utente "test"
let adminCookie; // sessione dell'utente "admin"

async function loginAs(username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  testCookie = (await loginAs("test", "test")).cookie;
  adminCookie = (await loginAs("admin", "admin")).cookie;
});
after(() => server.close());

/** fetch con la sessione dell'utente test (o quella indicata). */
const get = (path, cookie = testCookie) => fetch(base + path, { headers: { Cookie: cookie } });
const post = (path, body, cookie = testCookie) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

describe("login e sessione", () => {
  test("senza sessione le API rispondono 401 (tranne health e login)", async () => {
    for (const path of ["/api/me", "/api/documents", "/api/conversations", "/api/admin/overview"]) {
      assert.equal((await fetch(base + path)).status, 401, path);
    }
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });

  test("credenziali errate → 401, senza cookie", async () => {
    const { res, cookie } = await loginAs("test", "sbagliata");
    assert.equal(res.status, 401);
    assert.equal(cookie, undefined);
    assert.equal((await loginAs("nessuno", "x")).res.status, 401);
  });

  test("il login imposta un cookie HttpOnly e restituisce il profilo senza password", async () => {
    const { res } = await loginAs("TEST", "test"); // il nome utente non distingue maiuscole
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie"), /HttpOnly/);
    const me = await res.json();
    assert.equal(me.username, "test");
    assert.equal(me.isAdmin, false);
    assert.equal(me.passwordHash, undefined);
  });

  test("un cookie manomesso non è valido", async () => {
    const forged = testCookie.replace(/\.[^.]+$/, ".firmafalsa");
    assert.equal((await get("/api/me", forged)).status, 401);
  });

  test("dopo 5 tentativi sbagliati l'accesso viene bloccato per qualche minuto", async () => {
    for (let i = 0; i < 5; i++) await loginAs("admin", "tentativo" + i);
    assert.equal((await loginAs("admin", "admin")).res.status, 429);
  });
});

describe("permessi", () => {
  test("l'utente test non entra nell'area admin", async () => {
    assert.equal((await get("/api/admin/overview")).status, 403);
    assert.equal((await get("/api/admin/users")).status, 403);
  });

  test("l'admin vede utenti, KPI e storico delle attività", async () => {
    const users = await (await get("/api/admin/users", adminCookie)).json();
    assert.deepEqual(users.map((u) => u.username).sort(), ["admin", "test"]);
    const overview = await (await get("/api/admin/overview", adminCookie)).json();
    assert.equal(overview.users, 2);
    assert.ok("costUsd" in overview.usage.total);
    assert.equal(overview.usage.daily.length, 30);
  });

  test("ricerche e accessi finiscono nello storico dell'admin", async () => {
    assert.equal((await post("/api/activity/search", { query: "contratto Okafor", source: "home" })).status, 204);
    await new Promise((r) => setTimeout(r, 50));
    const events = await (await get("/api/admin/activity", adminCookie)).json();
    assert.ok(events.some((e) => e.type === "search" && e.query === "contratto Okafor" && e.userName === "Utente Test"));
    assert.ok(events.some((e) => e.type === "login_failed" && e.username === "nessuno"));
  });
});

describe("POST /api/chat: validazione", () => {
  test("messaggio mancante o vuoto → 400", async () => {
    for (const body of [{}, { message: "   " }, { message: 42 }]) {
      const res = await post("/api/chat", body);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /obbligatorio/);
    }
  });

  test("messaggio troppo lungo → 400", async () => {
    const res = await post("/api/chat", { message: "a".repeat(4001) });
    assert.equal(res.status, 400);
  });

  test("sessionId non valido (es. path traversal) → 400", async () => {
    const res = await post("/api/chat/stream", { message: "ciao", sessionId: "../../etc/passwd" });
    assert.equal(res.status, 400);
  });
});

describe("profilo e conversazioni", () => {
  test("GET /api/me restituisce l'utente collegato", async () => {
    const me = await (await get("/api/me")).json();
    assert.equal(me.name, "Utente Test");
  });

  test("GET /api/conversations parte vuoto; una conversazione inesistente → 404", async () => {
    assert.deepEqual(await (await get("/api/conversations")).json(), []);
    assert.equal((await get("/api/conversations/00000000-0000-0000-0000-000000000000")).status, 404);
  });
});

describe("documenti", () => {
  test("GET /api/documents/categories restituisce le 8 categorie", async () => {
    const cats = await (await get("/api/documents/categories")).json();
    assert.equal(cats.length, 8);
    assert.ok(cats.find((c) => c.id === "dati").tabular);
  });

  test("archivio vuoto: nessun documento e nessuna scadenza", async () => {
    assert.deepEqual(await (await get("/api/documents")).json(), []);
    assert.deepEqual(await (await get("/api/documents/deadlines")).json(), []);
    assert.equal((await get("/api/documents/inesistente")).status, 404);
  });

  test("formato non supportato → rifiutato prima di salvare il file", async () => {
    const form = new FormData();
    form.append("file", new Blob(["MZ"]), "virus.exe");
    const res = await fetch(`${base}/api/documents`, { method: "POST", body: form, headers: { Cookie: testCookie } });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /Formato non supportato/);
  });

  test("estensione cambiata (eseguibile rinominato .pdf) → 422, senza arrivare all'AI", async () => {
    for (const endpoint of ["/api/documents", "/api/documents/suggest"]) {
      const form = new FormData();
      form.append("file", new Blob([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])]), "contratto.pdf");
      const res = await fetch(base + endpoint, { method: "POST", body: form, headers: { Cookie: testCookie } });
      assert.equal(res.status, 422, endpoint);
      assert.match((await res.json()).error, /non corrisponde a un PDF/);
    }
    assert.deepEqual(await (await get("/api/documents")).json(), []); // nessun documento salvato
  });
});

test("grafici: nomi di file non validi → 400", async () => {
  assert.equal((await get("/api/charts/..%2F..%2F.env")).status, 400);
});

test("endpoint inesistente → 404 JSON", async () => {
  const res = await get("/api/non-esiste");
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /non trovato/);
});
