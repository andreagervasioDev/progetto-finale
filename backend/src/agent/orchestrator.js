/**
 * Orchestratore ReAct basato sul function calling nativo di OpenAI.
 *
 * A ogni passo l'LLM ragiona sulla richiesta e decide in autonomia se:
 *   - rispondere direttamente (saluti, chiarimenti, sintesi di quanto già emerso)
 *   - interrogare la knowledge base (RAG su ChromaDB)
 *   - delegare un'analisi numerica al data agent Python
 *   - combinare i due strumenti (es. prima recupera una soglia dal protocollo, poi la applica ai dati)
 * Il ciclo continua finché il modello non produce la risposta finale.
 */
import { config } from "../config.js";
import { getOpenAI } from "../openaiClient.js";
import { executeTool, toolDefinitionsFor } from "../tools/index.js";

const BASE_PROMPT = `Sei "Management AI", l'assistente AI per la gestione del club, una società di calcio di Serie A.
Aiuti lo staff del club (direzione, area tecnica, area medica, mercato, uffici commerciali) a trovare informazioni
nei documenti dell'archivio e ad analizzare i dati.

Hai due strumenti e decidi TU quale usare:
1. search_knowledge_base → per il contenuto dei documenti di testo: contratti, sponsorizzazioni, certificati medici,
   offerte di mercato, analisi delle prestazioni, regolamenti, protocolli, procedure, FAQ.
   Puoi limitare la ricerca a una categoria con il parametro "category" quando la domanda è chiaramente su quella.
   Le informazioni del club NON sono conoscenza generale: cerca SEMPRE nei documenti e non inventare.
2. analyze_data → per qualunque numero, classifica, somma, media, trend, confronto o grafico su una TABELLA di dati
   (dataset partite o file CSV/Excel caricati). Scegli il dataset giusto con "dataset_id".
   Non calcolare mai numeri a mente e non inventarli: delega sempre al data agent.

Strategie:
- Domande ibride (es. "chi ha superato la soglia di carico prevista?", "rispettiamo l'obiettivo sugli infortuni?"):
  prima cerca la regola/soglia nei documenti, poi chiama analyze_data passando la regola nel campo "context".
- Per domande su scadenze e importi (contratti in scadenza, certificati da rinnovare, valore degli sponsor) usa
  l'elenco "Dati chiave estratti" qui sotto come punto di partenza e verifica i dettagli nei documenti.
- Se la domanda si riferisce a messaggi precedenti ("e per i difensori?", "fai lo stesso per la scorsa stagione"),
  ricostruisci una richiesta completa e autonoma prima di chiamare gli strumenti.
- Se l'archivio non contiene l'informazione, dillo chiaramente invece di rispondere con conoscenza generica.
- Se una domanda è ambigua, scegli l'interpretazione più utile e dichiarala; chiedi chiarimenti solo se proprio necessario.
- Per saluti o domande su cosa sai fare, rispondi direttamente senza strumenti.
- I documenti medici e contrattuali contengono dati personali: riporta solo le informazioni necessarie alla domanda.

Formato della risposta finale (italiano, markdown):
- vai dritto al punto, usa elenchi e tabelle quando aiutano;
- quando usi i documenti cita le fonti tra parentesi quadre, es. [Protocollo Medico – Semaforo di disponibilità] o [Contratto Okafor – Pagina 2];
- quando usi il data agent riporta i numeri chiave e gli insight, e menziona brevemente la pulizia dati rilevante;
- NON inserire immagini o link ai grafici: vengono mostrati automaticamente sotto la risposta;
- chiudi, quando utile, con un'azione consigliata.`;

const TOOL_LABELS = {
  search_knowledge_base: "Consulto i documenti",
  analyze_data: "Il data agent analizza i dati",
};

const fmtAmount = (n) => `${n.toLocaleString("it-IT")} €`;
const fmtDate = (iso) => iso.split("-").reverse().join("/");

/** System prompt della richiesta: archivio per categoria, dati chiave, dataset ed eventuale elemento aperto. */
function buildSystemPrompt(ctx) {
  const parts = [BASE_PROMPT, `\nOggi è il ${new Date().toLocaleDateString("it-IT")}.`];
  if (ctx.user) parts.push(`L'utente è ${ctx.user.name} (${ctx.user.role}).`);

  if (ctx.documents?.length) {
    const byCat = new Map();
    for (const d of ctx.documents) byCat.set(d.categoryLabel, [...(byCat.get(d.categoryLabel) ?? []), d.title]);
    parts.push(
      `\nArchivio documenti (${ctx.documents.length}):\n` +
        [...byCat].map(([cat, titles]) => `- ${cat}: ${titles.slice(0, 25).join(" | ")}`).join("\n"),
    );
  }

  const facts = (ctx.documents ?? []).filter((d) => d.facts).slice(0, 40);
  if (facts.length) {
    parts.push(
      "\nDati chiave estratti dai documenti (verifica nei documenti prima di citare clausole):\n" +
        facts
          .map(({ title, facts: f }) =>
            [
              `- ${title}`,
              f.subject && `persona: ${f.subject}`,
              f.counterparty && `controparte: ${f.counterparty}`,
              f.amount != null && `${f.amountLabel ?? "importo"}: ${fmtAmount(f.amount)}`,
              f.expiryDate && `${f.expiryLabel ?? "scadenza"}: ${fmtDate(f.expiryDate)}`,
            ]
              .filter(Boolean)
              .join(" · "),
          )
          .join("\n"),
    );
  }

  if (ctx.datasets?.length) {
    parts.push(
      "\nDataset analizzabili con analyze_data:\n" +
        ctx.datasets.map((d) => `- '${d.id}': ${d.title} (${d.rows} righe; colonne: ${d.columns.slice(0, 15).join(", ")})`).join("\n"),
    );
  }

  if (ctx.document) {
    parts.push(
      `\nL'utente sta leggendo il documento "${ctx.document.title}". Per domande su "questo documento", ` +
        `"qui", "in questo file" usa search_knowledge_base con scope "documento_aperto"; ` +
        `per domande generali usa scope "tutti".`,
    );
  }
  if (ctx.dataset) {
    parts.push(
      `\nL'utente sta guardando il dataset "${ctx.dataset.title}" ('${ctx.dataset.id}'): per domande su "questi dati" ` +
        `o "questo file" usa analyze_data con dataset_id '${ctx.dataset.id}'.`,
    );
  }
  return parts.join("\n");
}

/**
 * @param {Array} history  messaggi precedenti della sessione [{role, content}]
 * @param {string} userMessage
 * @param {(event: object) => void} onEvent  callback per aggiornare il client sullo stato (streaming)
 * @param {{userId: string, user?: object, document?: object, dataset?: object, documents?: object[], datasets?: object[]}} ctx
 */
export async function runAgent(history, userMessage, onEvent = () => {}, ctx = {}) {
  const openai = getOpenAI();
  const tools = toolDefinitionsFor(ctx);
  const messages = [{ role: "system", content: buildSystemPrompt(ctx) }, ...history, { role: "user", content: userMessage }];

  const trace = []; // passi eseguiti, mostrati nel frontend per rendere il flusso verificabile
  const sources = [];
  const charts = [];

  for (let step = 1; step <= config.maxAgentSteps; step++) {
    onEvent({ type: "status", stage: "thinking", label: step === 1 ? "Analizzo la richiesta" : "Valuto i risultati" });

    const completion = await openai.chat.completions.create({
      model: config.chatModel,
      messages,
      tools,
      tool_choice: "auto",
      parallel_tool_calls: true,
      temperature: 0.2,
    });
    const msg = completion.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      return { reply: msg.content ?? "", trace, sources: dedupeSources(sources), charts };
    }

    // Act: esegue tutti gli strumenti richiesti in questo passo (anche in parallelo)
    const results = await Promise.all(
      msg.tool_calls.map(async (call) => {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* argomenti non validi: l'handler segnalerà l'errore */
        }
        const name = call.function.name;
        onEvent({ type: "status", stage: "tool", tool: name, label: TOOL_LABELS[name] ?? name, args });
        const started = Date.now();
        const entry = { step, tool: name, args };
        try {
          const out = await executeTool(name, args, ctx);
          if (out.sources) sources.push(...out.sources);
          if (out.charts) charts.push(...out.charts);
          Object.assign(entry, {
            ok: true,
            ms: Date.now() - started,
            sources: out.sources,
            code: out.code,
            cleaning: out.cleaning,
            charts: out.charts,
          });
          return { call, content: out.content, entry };
        } catch (err) {
          Object.assign(entry, { ok: false, ms: Date.now() - started, error: err.message });
          return { call, content: `ERRORE nello strumento ${name}: ${err.message}. Informa l'utente o prova un'alternativa.`, entry };
        }
      }),
    );

    // Observe: i risultati tornano al modello come messaggi "tool"
    for (const { call, content, entry } of results) {
      trace.push(entry);
      onEvent({ type: "tool_result", entry: { ...entry, code: undefined } });
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }

  // limite di passi raggiunto: chiede comunque una risposta con quanto raccolto
  onEvent({ type: "status", stage: "thinking", label: "Preparo la risposta" });
  messages.push({ role: "user", content: "Rispondi ora con le informazioni raccolte, senza usare altri strumenti." });
  const final = await openai.chat.completions.create({ model: config.chatModel, messages, temperature: 0.2 });
  return { reply: final.choices[0].message.content ?? "", trace, sources: dedupeSources(sources), charts };
}

function dedupeSources(sources) {
  const seen = new Map();
  for (const s of sources) {
    const key = `${s.docId ?? s.source}::${s.section}`;
    if (!seen.has(key) || seen.get(key).score < s.score) seen.set(key, s);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}
