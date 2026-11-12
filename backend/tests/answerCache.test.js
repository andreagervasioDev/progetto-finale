import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";
import {
  answerCacheStatus,
  archiveVersion,
  cacheKey,
  getCachedAnswer,
  isCacheable,
  normalizeQuestion,
  storeAnswer,
} from "../src/services/answerCacheService.js";

const docs = [
  { id: "a", title: "Protocollo medico", category: "regolamenti", size: 100, chunks: 9 },
  { id: "b", title: "partite 2025-26", category: "dati", size: 50, chunks: 0, rows: 38 },
];
const answer = (reply = "Le fasi sono sei.") => ({
  reply,
  charts: [],
  tables: [],
  sources: [{ docId: "a", section: "5. Return-to-play", score: 0.7 }],
  trace: [{ tool: "search_knowledge_base", ok: true }],
});

test("la domanda normalizzata ignora maiuscole, spazi e punteggiatura finale", () => {
  assert.equal(normalizeQuestion("  Quali sono le FASI   del return-to-play?? "), "quali sono le fasi del return-to-play");
  assert.equal(
    cacheKey({ question: "Che multa rischia un giocatore in ritardo?", docs }),
    cacheKey({ question: "che multa rischia un giocatore in ritardo", docs }),
  );
});

test("la chiave cambia con il documento aperto, l'archivio e il modello", () => {
  const base = cacheKey({ question: "Riassumi", docs });
  assert.notEqual(base, cacheKey({ question: "Riassumi", docId: "a", docs }));
  assert.notEqual(base, cacheKey({ question: "Riassumi", docs: [...docs, { id: "c", title: "Nuovo", category: "altro", size: 1 }] }));
  assert.notEqual(base, cacheKey({ question: "Riassumi", docs: [{ ...docs[0], size: 101 }, docs[1]] }));
  assert.notEqual(base, cacheKey({ question: "Riassumi", docs, model: "gpt-4.1" }));
});

test("l'impronta dell'archivio non dipende dall'ordine dei documenti", () => {
  assert.equal(archiveVersion(docs), archiveVersion([...docs].reverse()));
});

test("una risposta salvata viene ritrovata e conta gli utilizzi", async () => {
  const key = cacheKey({ question: "Quali sono le fasi del return-to-play?", docs });
  assert.equal(await getCachedAnswer(key), null);
  assert.equal(await storeAnswer(key, answer()), true);
  const hit = await getCachedAnswer(key);
  assert.equal(hit.reply, "Le fasi sono sei.");
  assert.deepEqual(hit.sources, answer().sources);
});

test("le risposte scadute non vengono restituite", async () => {
  const key = cacheKey({ question: "Domanda che scade", docs });
  const t0 = 1_000_000;
  await storeAnswer(key, answer(), t0);
  const ttl = config.answerCache.ttlHours * 3600 * 1000;
  assert.ok(await getCachedAnswer(key, t0 + ttl - 1));
  assert.equal(await getCachedAnswer(key, t0 + ttl + 1), null);
});

test("risposte vuote o con uno strumento fallito non si salvano", async () => {
  assert.equal(isCacheable(answer("   ")), false);
  assert.equal(isCacheable({ ...answer(), trace: [{ tool: "analyze_data", ok: false }] }), false);
  const key = cacheKey({ question: "Domanda con errore", docs });
  assert.equal(await storeAnswer(key, { ...answer(), trace: [{ tool: "analyze_data", ok: false }] }), false);
  assert.equal(await getCachedAnswer(key), null);
});

test("oltre il limite si eliminano le voci usate meno di recente", async () => {
  const previous = config.answerCache.maxEntries;
  config.answerCache.maxEntries = 2;
  try {
    const now = Date.now();
    const keys = ["uno", "due", "tre"].map((q) => cacheKey({ question: `limite ${q}`, docs }));
    await storeAnswer(keys[0], answer("1"), now);
    await storeAnswer(keys[1], answer("2"), now + 1);
    await getCachedAnswer(keys[0], now + 2); // la prima torna la più recente
    await storeAnswer(keys[2], answer("3"), now + 3);
    assert.ok(await getCachedAnswer(keys[0], now + 4));
    assert.equal(await getCachedAnswer(keys[1], now + 4), null);
    assert.ok(await getCachedAnswer(keys[2], now + 4));
  } finally {
    config.answerCache.maxEntries = previous;
  }
});

test("con durata 0 la cache è disattivata", async () => {
  const previous = config.answerCache.ttlHours;
  config.answerCache.ttlHours = 0;
  try {
    const key = cacheKey({ question: "Cache spenta", docs });
    assert.equal(await storeAnswer(key, answer()), false);
    assert.equal(await getCachedAnswer(key), null);
  } finally {
    config.answerCache.ttlHours = previous;
  }
});

// --- spazio: limite per singola risposta e limite totale ---
const big = (kb, tag) => answer(tag + "a".repeat(kb * 1024));

/** Esegue `fn` con limiti della cache temporanei, poi ripristina quelli di partenza. */
async function withLimits(limits, fn) {
  const previous = { ...config.answerCache };
  Object.assign(config.answerCache, limits);
  try {
    await fn();
  } finally {
    Object.assign(config.answerCache, previous);
  }
}

test("una sola risposta oltre il limite per voce non si salva, anche con spazio totale libero", async () => {
  await withLimits({ maxMb: 20, maxEntryKb: 512 }, async () => {
    const before = (await answerCacheStatus()).tooLarge;
    const ok = cacheKey({ question: "Risposta da 400 KB", docs });
    const huge = cacheKey({ question: "Risposta da 600 KB", docs });
    assert.equal(await storeAnswer(ok, big(400, "ok")), true);
    assert.equal(await storeAnswer(huge, big(600, "huge")), false);
    assert.equal(await getCachedAnswer(huge), null);
    const status = await answerCacheStatus();
    assert.equal(status.tooLarge, before + 1);
    assert.equal(status.maxEntryKb, 512);
  });
});

test("oltre lo spazio totale escono le risposte usate meno di recente", async () => {
  await withLimits({ maxMb: 1, maxEntryKb: 512, maxEntries: 100 }, async () => {
    const now = Date.now();
    const keys = [1, 2, 3, 4, 5].map((i) => cacheKey({ question: `spazio ${i}`, docs }));
    for (const [i, key] of keys.entries()) await storeAnswer(key, big(300, String(i)), now + i);
    // 5 risposte da 300 KB con 1 MB: ne restano 3, le più recenti
    const kept = await Promise.all(keys.map((k) => getCachedAnswer(k, now + 10).then(Boolean)));
    assert.deepEqual(kept, [false, false, true, true, true]);
    const status = await answerCacheStatus(now + 10);
    assert.ok(status.sizeMb <= 1 && status.sizeMb >= 0.85, `${status.sizeMb} MB`);
  });
});

test("limiti di spazio a 0: nessun limite", async () => {
  await withLimits({ maxMb: 0, maxEntryKb: 0 }, async () => {
    assert.equal(await storeAnswer(cacheKey({ question: "Senza limiti", docs }), big(600, "x")), true);
  });
});

test("/api/health espone lo stato della cache delle risposte", async () => {
  const status = await answerCacheStatus();
  assert.deepEqual(Object.keys(status).sort(), ["entries", "maxEntryKb", "maxMb", "sizeMb", "tooLarge", "ttlHours"]);
  assert.equal(status.maxMb, 20);
  assert.equal(status.maxEntryKb, 512);
});
