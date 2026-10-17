import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkMarkdown, chunkPlainText, splitLongText } from "../src/rag/chunker.js";

const MAX_CHARS = 1400;
const OVERLAP = 200;

describe("chunkMarkdown", () => {
  const md = `# Protocollo medico

Introduzione al protocollo.

## Return-to-play

### Fase 1
Riposo e terapie.

### Fase 2
Corsa leggera.

## Commozione cerebrale
Stop di almeno 7 giorni.`;

  const chunks = chunkMarkdown(md, "protocollo.md");

  test("divide per sezioni ## e ###, con il percorso dei titoli", () => {
    assert.deepEqual(
      chunks.map((c) => c.metadata.section),
      ["Introduzione", "Return-to-play › Fase 1", "Return-to-play › Fase 2", "Commozione cerebrale"],
    );
  });

  test("il testo indicizzato contiene titolo del documento e sezione", () => {
    assert.ok(chunks[1].text.startsWith("Protocollo medico\nSezione: Return-to-play › Fase 1\n\n"));
    assert.ok(chunks[1].text.includes("Riposo e terapie."));
    assert.equal(chunks[1].metadata.title, "Protocollo medico");
  });

  test("senza titolo # usa il nome del file", () => {
    const [c] = chunkMarkdown("## Sezione\nTesto", "faq.md");
    assert.equal(c.metadata.title, "faq.md");
  });
});

describe("splitLongText", () => {
  test("lascia intatti i testi corti", () => {
    assert.deepEqual(splitLongText("breve"), ["breve"]);
  });

  test("spezza i testi lunghi in chunk di dimensione limitata, senza perdere contenuto", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragrafo ${i}. ` + "parola ".repeat(25));
    const chunks = splitLongText(paragraphs.join("\n\n"));
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= MAX_CHARS + OVERLAP, `chunk di ${c.length} caratteri`);
    for (let i = 0; i < 30; i++) assert.ok(chunks.some((c) => c.includes(`Paragrafo ${i}.`)), `manca il paragrafo ${i}`);
  });

  test("chunk consecutivi si sovrappongono (contesto al confine)", () => {
    const text = Array.from({ length: 12 }, (_, i) => `P${i} ` + "x".repeat(300)).join("\n\n");
    const [first, second] = splitLongText(text);
    assert.ok(second.startsWith(first.slice(-OVERLAP)));
  });

  test("spezza anche un unico paragrafo enorme senza punteggiatura", () => {
    const chunks = splitLongText("a".repeat(5000));
    assert.ok(chunks.every((c) => c.length <= MAX_CHARS + OVERLAP));
  });
});

describe("chunkPlainText", () => {
  test("un chunk per pagina con il numero di pagina, pagine vuote ignorate", () => {
    const chunks = chunkPlainText(
      [
        { num: 1, text: "Contratto di prestazione sportiva." },
        { num: 2, text: "   \n  " },
        { num: 3, text: "Scadenza: 30/06/2028." },
      ],
      { title: "Contratto Okafor" },
    );
    assert.deepEqual(chunks.map((c) => c.metadata.section), ["Pagina 1", "Pagina 3"]);
    assert.equal(chunks[1].metadata.page, 3);
    assert.ok(chunks[1].text.startsWith("Contratto Okafor\nSezione: Pagina 3"));
  });
});
