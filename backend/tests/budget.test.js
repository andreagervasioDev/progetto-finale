/**
 * Tetto di spesa giornaliero. I test non scrivono su disco: la logica di calcolo (spentOn) è pura,
 * e assertWithinBudget accetta la spesa odierna come parametro per non toccare il registro reale.
 */
import "./env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetExceededError, assertWithinBudget, spentOn } from "../src/services/usageService.js";

const DAY = 86400000;
const ev = (costUsd, daysAgo = 0) => ({ ts: Date.now() - daysAgo * DAY, costUsd });

test("spentOn somma solo la spesa di oggi", () => {
  assert.equal(spentOn([ev(0.4), ev(0.1), ev(2, 1), ev(0.5, 3)]), 0.5);
  assert.equal(spentOn([]), 0);
  // le chiamate senza prezzo (modello fuori listino) contano 0, non rompono la somma
  assert.equal(spentOn([ev(0.2), { ts: Date.now(), costUsd: null }]), 0.2);
});

test("assertWithinBudget rispetta il tetto DAILY_BUDGET_USD", async () => {
  // env.js non imposta DAILY_BUDGET_USD: di default (0) non c'è limite, qualunque spesa passa
  await assertWithinBudget(9999);

  // con un tetto impostato: sotto passa, raggiunto blocca con 402
  const { config } = await import("../src/config.js");
  config.dailyBudgetUsd = 1.0;
  await assertWithinBudget(0.5); // sotto il tetto
  await assert.rejects(assertWithinBudget(1.1), (err) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.status, 402);
    assert.match(err.message, /Tetto di spesa giornaliero/);
    assert.match(err.message, /DAILY_BUDGET_USD/);
    return true;
  });
  config.dailyBudgetUsd = 0; // ripristino per gli altri test nello stesso processo
});
