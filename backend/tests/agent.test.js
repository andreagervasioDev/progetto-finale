import "./env.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSystemPrompt } from "../src/prompts/systemPrompt.js";
import { dedupeSources } from "../src/services/agentService.js";
import { executeTool, toolDefinitionsFor } from "../src/tools/index.js";

const names = (tools) => tools.map((t) => t.function.name);

describe("strumenti del function calling", () => {
  test("l'LLM ha sempre i due strumenti: RAG e data agent", () => {
    assert.deepEqual(names(toolDefinitionsFor({})), ["search_knowledge_base", "analyze_data"]);
  });

  test("lo 'scope' sul documento aperto compare solo se un documento è aperto", () => {
    const [plain] = toolDefinitionsFor({});
    const [withDoc] = toolDefinitionsFor({ document: { id: "d1", title: "Contratto" } });
    assert.equal(plain.function.parameters.properties.scope, undefined);
    assert.deepEqual(withDoc.function.parameters.properties.scope.enum, ["documento_aperto", "tutti"]);
  });

  test("dataset_id accetta solo i dataset disponibili (default: partite)", () => {
    const [, data] = toolDefinitionsFor({});
    assert.deepEqual(data.function.parameters.properties.dataset_id.enum, ["partite"]);
    const [, data2] = toolDefinitionsFor({ datasets: [{ id: "partite", title: "Partite" }, { id: "x1", title: "Ingaggi" }] });
    assert.deepEqual(data2.function.parameters.properties.dataset_id.enum, ["partite", "x1"]);
  });

  test("uno strumento sconosciuto produce un errore (che l'agente riporta al modello)", async () => {
    await assert.rejects(executeTool("cancella_tutto", {}, {}), /Tool sconosciuto/);
  });
});

describe("system prompt", () => {
  const prompt = buildSystemPrompt({
    user: { name: "Andrea Gervasio", role: "Direzione sportiva" },
    documents: [
      { title: "Contratto Okafor", categoryLabel: "Contratti giocatori", facts: { subject: "Victor Okafor", amount: 2400000, expiryDate: "2028-06-30" } },
      { title: "Regolamento interno", categoryLabel: "Regolamenti e procedure", facts: null },
    ],
    datasets: [{ id: "partite", title: "Dati partite", rows: 1539, columns: ["player_name", "goals"] }],
    document: { id: "d1", title: "Contratto Okafor" },
  });

  test("contiene l'archivio per categoria e i dati chiave in formato italiano", () => {
    assert.match(prompt, /- Contratti giocatori: Contratto Okafor/);
    assert.match(prompt, /persona: Victor Okafor/);
    assert.match(prompt, /2\.400\.000 €/);
    assert.match(prompt, /30\/06\/2028/);
  });

  test("elenca i dataset e segnala il documento aperto", () => {
    assert.match(prompt, /'partite': Dati partite \(1539 righe; colonne: player_name, goals\)/);
    assert.match(prompt, /sta leggendo il documento "Contratto Okafor"/);
  });
});

test("dedupeSources tiene la fonte più pertinente per ogni sezione, in ordine di pertinenza", () => {
  const out = dedupeSources([
    { docId: "a", section: "Art. 1", score: 0.5 },
    { docId: "a", section: "Art. 1", score: 0.8 },
    { docId: "b", section: "Pagina 2", score: 0.6 },
  ]);
  assert.deepEqual(out.map((s) => [s.docId, s.score]), [["a", 0.8], ["b", 0.6]]);
});
