import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORIES, TEXT_CATEGORY_IDS, categoryFromFolder, getCategory, isCategory } from "../src/documents/categories.js";
import { SUPPORTED_TYPES, isTabular } from "../src/documents/extract.js";

test("le categorie richieste dall'archivio esistono", () => {
  for (const id of ["contratti", "sponsor", "medico", "mercato", "prestazioni", "dati"]) assert.ok(isCategory(id), id);
  assert.equal(isCategory("inesistente"), false);
});

test("l'estrazione di scadenze e importi è attiva solo per contratti, sponsor, medico e mercato", () => {
  assert.deepEqual(
    CATEGORIES.filter((c) => c.facts).map((c) => c.id),
    ["contratti", "sponsor", "medico", "mercato"],
  );
});

test("la categoria 'dati' (tabelle) non è tra quelle cercabili con la RAG", () => {
  assert.ok(!TEXT_CATEGORY_IDS.includes("dati"));
  assert.ok(TEXT_CATEGORY_IDS.includes("regolamenti"));
});

test("categoria sconosciuta → 'Altri documenti'", () => {
  assert.equal(getCategory("boh").id, "altro");
});

test("la sottocartella di knowledge_base/ decide la categoria dei documenti ufficiali", () => {
  assert.equal(categoryFromFolder(""), "regolamenti");
  assert.equal(categoryFromFolder("contratti"), "contratti");
  assert.equal(categoryFromFolder("Medico"), "medico");
  assert.equal(categoryFromFolder("varie"), "altro");
});

test("CSV ed Excel sono file di dati, PDF/Word/MD/TXT sono documenti di testo", () => {
  for (const ext of [".csv", ".xlsx", ".xls"]) assert.ok(isTabular(ext), ext);
  for (const ext of [".pdf", ".docx", ".md", ".txt"]) {
    assert.ok(SUPPORTED_TYPES[ext], ext);
    assert.equal(isTabular(ext), false, ext);
  }
  assert.equal(SUPPORTED_TYPES[".exe"], undefined);
});
