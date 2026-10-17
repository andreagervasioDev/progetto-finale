/**
 * Consumo di token OpenAI e relativa spesa stimata.
 *
 * Ogni chiamata al modello registra modello, token di input e di output e "tipo" di utilizzo:
 *   chat       → orchestratore della chat (function calling)
 *   data_agent → pandas agent Python (i token arrivano nella risposta di /analyze)
 *   documenti  → AI sui documenti (proposta di categoria, estrazione dei dati chiave)
 *   embedding  → indicizzazione dei documenti e ricerche nella knowledge base
 */
import { usageLog } from "../repositories/eventLogRepository.js";
import { currentUserId } from "./requestContext.js";

/**
 * Prezzi indicativi in dollari per 1 milione di token (listino OpenAI standard).
 * Verificali su https://openai.com/api/pricing prima di usare i numeri per un budget reale.
 */
export const PRICES_PER_MILLION = {
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

/** Prezzo del modello; i nomi con data (es. "gpt-4.1-mini-2025-04-14") usano il prezzo del modello base. */
export function priceFor(model) {
  const name = String(model ?? "").toLowerCase();
  const key = Object.keys(PRICES_PER_MILLION)
    .filter((k) => name === k || name.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICES_PER_MILLION[key] : null;
}

/** Costo in dollari; null se il modello non è nel listino. */
export function costUsd(model, inputTokens, outputTokens) {
  const price = priceFor(model);
  if (!price) return null;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Registra il consumo di una chiamata.
 * @param {{kind: string, model: string, usage?: {prompt_tokens?: number, completion_tokens?: number}}} call
 */
export function recordUsage({ kind, model, usage, userId }) {
  const inputTokens = Number(usage?.prompt_tokens) || 0;
  const outputTokens = Number(usage?.completion_tokens) || 0;
  if (!inputTokens && !outputTokens) return;
  usageLog.append({
    userId: userId ?? currentUserId(),
    kind,
    model,
    inputTokens,
    outputTokens,
    costUsd: costUsd(model, inputTokens, outputTokens),
  });
}

const DAY_MS = 86400000;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/** Somma token e costo di un elenco di eventi. */
function totals(events) {
  return events.reduce(
    (t, e) => {
      t.calls += 1;
      t.inputTokens += e.inputTokens;
      t.outputTokens += e.outputTokens;
      t.costUsd += e.costUsd ?? 0;
      if (e.costUsd == null) t.unpricedCalls += 1;
      return t;
    },
    { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0 },
  );
}

function groupTotals(events, keyOf) {
  const groups = new Map();
  for (const e of events) {
    const k = keyOf(e);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups].map(([key, list]) => ({ key, ...totals(list) })).sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Riepilogo per la dashboard: totali, ultimi 30 giorni, andamento giornaliero, per tipo, modello e utente.
 * Funzione pura sugli eventi (testabile senza file).
 */
export function summarizeUsage(events, { now = Date.now(), days = 30 } = {}) {
  const since = now - days * DAY_MS;
  const recent = events.filter((e) => e.ts >= since);
  const today = dayKey(now);
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(now - i * DAY_MS);
    daily.push({ day: key, ...totals(recent.filter((e) => dayKey(e.ts) === key)) });
  }
  return {
    total: totals(events),
    last30Days: totals(recent),
    today: totals(events.filter((e) => dayKey(e.ts) === today)),
    daily,
    byKind: groupTotals(events, (e) => e.kind),
    byModel: groupTotals(events, (e) => e.model),
    byUser: groupTotals(events, (e) => e.userId),
  };
}

export const readUsage = () => usageLog.readAll();
