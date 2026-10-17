/**
 * Strumenti a disposizione dell'LLM orchestratore (function calling).
 * Ogni tool ha: la definizione JSON Schema vista dal modello e un handler che la esegue.
 * Gli handler ricevono il contesto della richiesta (utente, documento o dataset aperto, dataset disponibili).
 */
import { analyzeData } from "../clients/dataAgentClient.js";
import { CATEGORIES, TEXT_CATEGORY_IDS } from "../documents/categories.js";
import { searchKnowledgeBase } from "../rag/vectorStore.js";
import { recordUsage } from "../services/usageService.js";

const categoryList = CATEGORIES.filter((c) => TEXT_CATEGORY_IDS.includes(c.id))
  .map((c) => `'${c.id}' = ${c.label}`)
  .join(", ");

const searchTool = (withDocumentScope) => ({
  type: "function",
  function: {
    name: "search_knowledge_base",
    description:
      "Cerca nei documenti testuali dell'archivio (RAG su ChromaDB): contratti dei giocatori, sponsorizzazioni, " +
      "certificati medici, offerte di mercato, analisi delle prestazioni, regolamenti, protocolli, procedure e FAQ. " +
      "Usalo per domande su clausole, importi, scadenze, regole, procedure e contenuto dei documenti.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Query di ricerca in italiano, riformulata in modo specifico (es. 'scadenza contratto Okafor clausola rescissoria').",
        },
        category: {
          type: "string",
          enum: TEXT_CATEGORY_IDS,
          description: `Opzionale: limita la ricerca a una categoria quando la domanda è chiaramente su quella (${categoryList}). Omettila se incerto.`,
        },
        ...(withDocumentScope && {
          scope: {
            type: "string",
            enum: ["documento_aperto", "tutti"],
            description:
              "'documento_aperto' cerca solo nel documento che l'utente sta leggendo (default per domande su 'questo documento'); 'tutti' cerca in tutto l'archivio.",
          },
        }),
      },
      required: ["query"],
    },
  },
});

const dataTool = (datasets) => ({
  type: "function",
  function: {
    name: "analyze_data",
    description:
      "Delega un'analisi numerica al data agent Python (pandas) su uno dei dataset disponibili (tabelle CSV/Excel): " +
      "pulisce i dati, esegue il codice e restituisce una sintesi con grafici. Usalo per classifiche, somme, medie, " +
      "trend, confronti, conteggi e grafici. Non usarlo per leggere testi di contratti o regolamenti.",
    parameters: {
      type: "object",
      properties: {
        dataset_id: {
          type: "string",
          enum: datasets.map((d) => d.id),
          description:
            "Dataset da analizzare: " + datasets.map((d) => `'${d.id}' = ${d.title}`).join("; ") + ". Default: 'partite'.",
        },
        question: {
          type: "string",
          description: "Richiesta di analisi autonoma e completa in italiano (includi periodo, filtri e se serve un grafico).",
        },
        context: {
          type: "string",
          description:
            "Opzionale: regole o soglie recuperate dai documenti da applicare nell'analisi (es. 'ACWR > 1,5 = zona di pericolo').",
        },
      },
      required: ["question"],
    },
  },
});

/** Definizioni dei tool per questa richiesta (con documento aperto la ricerca può limitarsi a quello). */
export function toolDefinitionsFor(ctx) {
  const datasets = ctx.datasets?.length ? ctx.datasets : [{ id: "partite", title: "Dati partite" }];
  return [searchTool(Boolean(ctx?.document)), dataTool(datasets)];
}

async function runSearchKnowledgeBase({ query, scope, category }, ctx) {
  const onlyOpenDoc = ctx.document && scope !== "tutti";
  let results = await searchKnowledgeBase(query, {
    userId: ctx.userId,
    docId: onlyOpenDoc ? ctx.document.id : undefined,
    category: onlyOpenDoc ? undefined : category,
    topK: onlyOpenDoc ? 5 : 4,
  });
  // se il filtro per categoria non trova nulla, riprovo su tutto l'archivio
  if (!results.length && category && !onlyOpenDoc) {
    results = await searchKnowledgeBase(query, { userId: ctx.userId, topK: 4 });
  }
  return {
    // contenuto passato all'LLM
    content: results.length
      ? results
          .map((r, i) => `[Fonte ${i + 1}: ${r.title} — ${r.section}, similarità ${r.score}]\n${r.text}`)
          .join("\n\n---\n\n")
      : "Nessun documento rilevante trovato nell'archivio.",
    // metadati mostrati nel frontend (docId per aprire il documento dalla fonte)
    sources: results.map(({ docId, category: cat, source, title, section, page, score, text }) => ({
      docId,
      category: cat,
      source,
      title,
      section,
      page,
      score,
      excerpt: text.split("\n\n").slice(1).join(" ").slice(0, 280),
    })),
  };
}

async function runAnalyzeData({ question, context, dataset_id }, ctx) {
  const datasetId = dataset_id || ctx.dataset?.id || "partite";
  const data = await analyzeData({ question, context, datasetId });
  // token consumati dal pandas agent Python, attribuiti all'utente che ha fatto la domanda
  for (const u of data.usage ?? []) recordUsage({ kind: "data_agent", model: u.model, usage: u });
  // ogni grafico ha la specifica JSON (disegnata dal frontend con React) e il PNG di matplotlib (url)
  const charts = data.charts.map((c) => ({ ...c, url: `/api/charts/${c.filename}` }));
  const tables = data.tables ?? [];
  const shown = [...charts.map((c) => `grafico "${c.title}"`), ...tables.map((t) => `tabella "${t.title || "senza titolo"}"`)];
  return {
    content:
      `[Dataset analizzato: ${data.dataset?.title ?? datasetId}]\n${data.answer}\n\n` +
      `[Già mostrati all'utente sotto la risposta: ${shown.length ? shown.join(", ") : "nessun grafico o tabella"}. ` +
      "Non ripetere in forma di tabella markdown i dati di una tabella già mostrata.]",
    charts,
    tables,
    code: data.steps,
    cleaning: data.cleaning_report,
    dataset: data.dataset,
  };
}

const handlers = {
  search_knowledge_base: runSearchKnowledgeBase,
  analyze_data: runAnalyzeData,
  // nome della prima versione, mantenuto per compatibilità
  analyze_performance_data: runAnalyzeData,
};

export async function executeTool(name, args, ctx) {
  const handler = handlers[name];
  if (!handler) throw new Error(`Tool sconosciuto: ${name}`);
  return handler(args, ctx);
}
