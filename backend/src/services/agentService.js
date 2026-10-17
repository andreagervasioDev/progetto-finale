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
import { getOpenAI } from "../clients/openaiClient.js";
import { config } from "../config.js";
import { buildSystemPrompt } from "../prompts/systemPrompt.js";
import { executeTool, toolDefinitionsFor } from "../tools/index.js";
import { recordUsage } from "./usageService.js";

const TOOL_LABELS = {
  search_knowledge_base: "Consulto i documenti",
  analyze_data: "Il data agent analizza i dati",
};

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
    recordUsage({ kind: "chat", model: completion.model ?? config.chatModel, usage: completion.usage });
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
  recordUsage({ kind: "chat", model: final.model ?? config.chatModel, usage: final.usage });
  return { reply: final.choices[0].message.content ?? "", trace, sources: dedupeSources(sources), charts };
}

/** Fonti uniche (stesso documento e sezione → la più pertinente), ordinate per pertinenza. */
export function dedupeSources(sources) {
  const seen = new Map();
  for (const s of sources) {
    const key = `${s.docId ?? s.source}::${s.section}`;
    if (!seen.has(key) || seen.get(key).score < s.score) seen.set(key, s);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}
