import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionToken, verifySessionToken } from "../src/services/authService.js";
import { hashPassword, verifyPassword } from "../src/services/passwordService.js";
import { costUsd, priceFor, summarizeUsage } from "../src/services/usageService.js";

test("password: hash con salt diverso ogni volta, verifica corretta", async () => {
  const a = await hashPassword("admin");
  const b = await hashPassword("admin");
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("admin", a));
  assert.equal(await verifyPassword("Admin", a), false);
  assert.equal(await verifyPassword("admin", "formato-non-valido"), false);
});

test("sessione: token firmato, valido fino alla scadenza", () => {
  const now = Date.now();
  const token = createSessionToken("utente-1", now);
  assert.equal(verifySessionToken(token, now + 1000), "utente-1");
  assert.equal(verifySessionToken(token, now + 30 * 86400000), null, "scaduto");
  assert.equal(verifySessionToken(token.replace("utente-1", "utente-2"), now), null, "id modificato");
  assert.equal(verifySessionToken("spazzatura", now), null);
});

test("prezzi: i modelli con data usano il prezzo del modello base", () => {
  assert.deepEqual(priceFor("gpt-4.1-mini-2025-04-14"), priceFor("gpt-4.1-mini"));
  assert.notDeepEqual(priceFor("gpt-4.1-mini"), priceFor("gpt-4.1"));
  assert.equal(priceFor("modello-sconosciuto"), null);
});

test("costo: 1M token di input + 1M di output con gpt-4.1-mini", () => {
  const p = priceFor("gpt-4.1-mini");
  assert.equal(costUsd("gpt-4.1-mini", 1_000_000, 1_000_000), p.input + p.output);
  assert.equal(costUsd("sconosciuto", 10, 10), null);
});

test("riepilogo dei consumi: totali, giornaliero e raggruppamenti", () => {
  const now = new Date("2026-10-13T12:00:00Z").getTime();
  const day = 86400000;
  const ev = (daysAgo, userId, kind, cost) => ({ ts: now - daysAgo * day, userId, kind, model: "gpt-4.1-mini", inputTokens: 100, outputTokens: 50, costUsd: cost });
  const summary = summarizeUsage(
    [ev(0, "a", "chat", 0.01), ev(0, "b", "data_agent", 0.03), ev(2, "a", "chat", 0.02), ev(40, "a", "chat", 1), { ...ev(0, "a", "chat", null), model: "x" }],
    { now },
  );
  assert.equal(summary.total.calls, 5);
  assert.equal(summary.total.unpricedCalls, 1);
  assert.ok(Math.abs(summary.total.costUsd - 1.06) < 1e-9);
  assert.ok(Math.abs(summary.last30Days.costUsd - 0.06) < 1e-9);
  assert.equal(summary.today.calls, 3);
  assert.equal(summary.daily.length, 30);
  assert.equal(summary.daily.at(-1).calls, 3);
  assert.equal(summary.byUser[0].key, "a"); // ordinati per spesa
  assert.deepEqual(summary.byKind.map((g) => g.key), ["chat", "data_agent"]);
});
