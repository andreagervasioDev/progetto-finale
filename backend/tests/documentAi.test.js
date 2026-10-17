import "./env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeFacts, normalizeSuggestion } from "../src/services/documentAiService.js";

describe("normalizeSuggestion (proposta di categoria dell'AI)", () => {
  test("accetta una categoria valida e accorcia il titolo", () => {
    const s = normalizeSuggestion({ category: "medico", title: "  " + "T".repeat(200) });
    assert.equal(s.category, "medico");
    assert.equal(s.title.length, 120);
  });

  test("categoria inventata o 'dati' per un testo → 'altro'", () => {
    assert.equal(normalizeSuggestion({ category: "fantasia" }).category, "altro");
    assert.equal(normalizeSuggestion({ category: "dati" }).category, "altro");
    assert.deepEqual(normalizeSuggestion(null), { category: "altro", title: "" });
  });
});

describe("normalizeFacts (dati chiave estratti dall'AI)", () => {
  test("converte i campi nel formato usato dall'app", () => {
    const f = normalizeFacts({
      summary: "Contratto quinquennale",
      subject: "Victor Okafor",
      counterparty: "Club",
      amount: "2400000",
      amount_label: "Ingaggio annuo lordo",
      expiry_date: "2028-06-30",
      expiry_label: "Scadenza contratto",
    });
    assert.deepEqual(f, {
      summary: "Contratto quinquennale",
      subject: "Victor Okafor",
      counterparty: "Club",
      amount: 2400000,
      amountLabel: "Ingaggio annuo lordo",
      expiryDate: "2028-06-30",
      expiryLabel: "Scadenza contratto",
    });
  });

  test("scarta date non ISO e importi non numerici invece di inventarli", () => {
    const f = normalizeFacts({ subject: "Rossi", amount: "circa due milioni", expiry_date: "30/06/2028" });
    assert.equal(f.amount, null);
    assert.equal(f.expiryDate, null);
    assert.equal(normalizeFacts({ subject: "Rossi", amount: "" }).amount, null);
  });

  test("nessun dato trovato → null", () => {
    assert.equal(normalizeFacts({ summary: null, amount: null }), null);
    assert.equal(normalizeFacts({}), null);
  });
});
