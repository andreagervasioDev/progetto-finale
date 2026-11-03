import { TEST_STORAGE } from "./env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { appendTurn, deleteConversation, getConversation, renameConversation } from "../src/repositories/conversationRepository.js";
import { listUsers, recordLogin } from "../src/repositories/userRepository.js";
import { withLock, writeJsonAtomic } from "../src/repositories/jsonFile.js";

const USER = "utente-test-01";
const reply = (content) => ({ content, charts: [], sources: [] });
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const leftoverTmp = async (dir) => (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"));

test("due appendTurn in parallelo sulla stessa conversazione nuova: nessun turno perso", async () => {
  const id = randomUUID();
  // es. pannello laterale e pagina Assistente aperti sulla stessa conversazione
  await Promise.all([
    appendTurn(USER, id, "Domanda dal pannello", reply("Risposta 1")),
    appendTurn(USER, id, "Domanda dalla pagina Assistente", reply("Risposta 2")),
  ]);
  const dir = path.join(TEST_STORAGE, "conversations", USER);
  const saved = await readJson(path.join(dir, `${id}.json`));
  assert.equal(saved.messages.length, 4);
  assert.deepEqual(saved.messages.map((m) => m.content).sort(), ["Domanda dal pannello", "Domanda dalla pagina Assistente", "Risposta 1", "Risposta 2"]);
  // ogni turno resta unito: domanda seguita dalla sua risposta
  assert.equal(saved.messages[1].content, saved.messages[0].content === "Domanda dal pannello" ? "Risposta 1" : "Risposta 2");
  assert.deepEqual(await leftoverTmp(dir), []);
});

test("molte scritture in parallelo: il file finale contiene tutti i turni", async () => {
  const id = randomUUID();
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendTurn(USER, id, `Domanda ${i}`, reply(`Risposta ${i}`))));
  const saved = await readJson(path.join(TEST_STORAGE, "conversations", USER, `${id}.json`));
  assert.equal(saved.messages.length, 40);
  assert.equal((await getConversation(USER, id)).messages.length, 40);
});

test("rinomina e nuovo turno in parallelo: si conservano entrambi", async () => {
  const id = randomUUID();
  await appendTurn(USER, id, "Prima domanda", reply("Prima risposta"));
  await Promise.all([renameConversation(USER, id, "Rinnovi in scadenza"), appendTurn(USER, id, "Seconda domanda", reply("Seconda risposta"))]);
  const saved = await readJson(path.join(TEST_STORAGE, "conversations", USER, `${id}.json`));
  assert.equal(saved.title, "Rinnovi in scadenza");
  assert.equal(saved.messages.length, 4);
});

test("una conversazione eliminata non viene riscritta da un salvataggio già in coda", async () => {
  const id = randomUUID();
  await appendTurn(USER, id, "Domanda", reply("Risposta"));
  await Promise.all([renameConversation(USER, id, "Nuovo titolo"), deleteConversation(USER, id)]);
  assert.equal(await getConversation(USER, id), null);
});

test("accessi in parallelo: users.json resta valido e senza file temporanei", async () => {
  const users = await listUsers();
  await Promise.all(users.flatMap((u) => [recordLogin(u.id), recordLogin(u.id), recordLogin(u.id)]));
  const saved = await readJson(path.join(TEST_STORAGE, "users.json"));
  assert.deepEqual(saved.map((u) => u.username).sort(), ["admin", "test"]);
  assert.ok(saved.every((u) => u.lastLoginAt));
  assert.deepEqual(await leftoverTmp(TEST_STORAGE), []);
});

test("withLock: stessa chiave in fila, chiavi diverse in parallelo, un errore non blocca la coda", async () => {
  const order = [];
  const step = (name, ms) => async () => {
    order.push(`${name}:inizio`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${name}:fine`);
    return name;
  };
  const failing = withLock("a", async () => {
    throw new Error("errore voluto");
  });
  const results = await Promise.allSettled([failing, withLock("a", step("a1", 20)), withLock("a", step("a2", 1)), withLock("b", step("b1", 5))]);
  assert.equal(results[0].status, "rejected");
  assert.deepEqual(results.slice(1).map((r) => r.value), ["a1", "a2", "b1"]);
  // a2 parte solo quando a1 è finito; b1 non aspetta la coda di "a"
  assert.ok(order.indexOf("a2:inizio") > order.indexOf("a1:fine"));
  assert.ok(order.indexOf("b1:fine") < order.indexOf("a1:fine"));
});

test("writeJsonAtomic: scritture parallele sullo stesso file usano file temporanei diversi", async () => {
  const dir = await fs.mkdtemp(path.join(TEST_STORAGE, "atomic-"));
  const file = path.join(dir, "dati.json");
  await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, { i })));
  assert.ok(Number.isInteger((await readJson(file)).i)); // un JSON completo, mai mescolato
  assert.deepEqual(await leftoverTmp(dir), []);
});
