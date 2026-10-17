import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPIRED_VISIBLE_DAYS, daysUntil, upcomingDeadlines } from "../src/services/deadlineService.js";

const NOW = new Date(2026, 9, 11, 15, 30); // 11 ottobre 2026, pomeriggio
const doc = (id, expiryDate) => ({ id, facts: expiryDate ? { expiryDate } : null });

test("daysUntil conta i giorni di calendario, indipendentemente dall'ora", () => {
  assert.equal(daysUntil("2026-10-11", NOW), 0);
  assert.equal(daysUntil("2026-10-12", NOW), 1);
  assert.equal(daysUntil("2026-10-01", NOW), -10);
  assert.equal(daysUntil("2027-10-11", NOW), 365);
});

test("ordina dalla più vicina e ignora i documenti senza scadenza", () => {
  const out = upcomingDeadlines([doc("a", "2027-01-01"), doc("b", null), doc("c", "2026-10-20"), { id: "d" }], NOW);
  assert.deepEqual(out.map((d) => d.doc.id), ["c", "a"]);
  assert.equal(out[0].daysLeft, 9);
});

test(`le scadenze passate restano visibili per ${EXPIRED_VISIBLE_DAYS} giorni, poi spariscono`, () => {
  const out = upcomingDeadlines([doc("recente", "2026-09-01"), doc("vecchia", "2025-12-14")], NOW);
  assert.deepEqual(out.map((d) => d.doc.id), ["recente"]);
  assert.equal(out[0].daysLeft, -40);
});
