/**
 * Funzioni AI sui documenti (OpenAI, risposta in JSON):
 *  - suggestCategory: propone categoria e titolo leggendo l'inizio del documento
 *  - extractFacts:    estrae i dati chiave (persona, controparte, importo, scadenza) per il riquadro
 *                     "Prossime scadenze" e per rispondere a domande su date e importi
 * Entrambe sono "best effort": se l'AI non risponde il caricamento prosegue senza.
 */
import { config } from "../config.js";
import { getOpenAI } from "../openaiClient.js";
import { CATEGORIES, TEXT_CATEGORY_IDS, isCategory } from "./categories.js";

const MAX_CHARS = 6000;

async function askJson(system, user) {
  const res = await getOpenAI().chat.completions.create({
    model: config.chatModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return JSON.parse(res.choices[0].message.content || "{}");
}

export async function suggestCategory(text, fileName) {
  const list = CATEGORIES.filter((c) => TEXT_CATEGORY_IDS.includes(c.id))
    .map((c) => `- ${c.id}: ${c.label} (${c.hint})`)
    .join("\n");
  const out = await askJson(
    `Classifichi i documenti di una società di calcio. Categorie disponibili:\n${list}\n` +
      `Rispondi in JSON: {"category": "<id>", "title": "<titolo breve e chiaro in italiano, max 70 caratteri>"}`,
    `Nome file: ${fileName}\n\nInizio del documento:\n${text.slice(0, 3000)}`,
  );
  return {
    category: isCategory(out.category) ? out.category : "altro",
    title: typeof out.title === "string" ? out.title.trim().slice(0, 120) : "",
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function extractFacts(text, category) {
  const out = await askJson(
    `Estrai i dati chiave da un documento della categoria "${category}" di una società di calcio.
Rispondi in JSON con queste chiavi (usa null se il dato non c'è, non inventare nulla):
{
  "summary": "riassunto in una frase (max 160 caratteri)",
  "subject": "persona principale a cui si riferisce (es. il calciatore), o null",
  "counterparty": "controparte (club, sponsor, agente, struttura medica), o null",
  "amount": numero in euro senza simboli (es. 2400000) o null,
  "amount_label": "cosa rappresenta l'importo (es. 'Ingaggio annuo lordo', 'Corrispettivo annuo', 'Offerta'), o null",
  "expiry_date": "data di scadenza o termine più rilevante in formato YYYY-MM-DD, o null",
  "expiry_label": "cosa scade (es. 'Scadenza contratto', 'Scadenza certificato', 'Termine offerta'), o null"
}`,
    text.slice(0, MAX_CHARS),
  );
  const facts = {
    summary: typeof out.summary === "string" ? out.summary.slice(0, 200) : null,
    subject: typeof out.subject === "string" ? out.subject : null,
    counterparty: typeof out.counterparty === "string" ? out.counterparty : null,
    amount: Number.isFinite(Number(out.amount)) && out.amount !== null ? Number(out.amount) : null,
    amountLabel: typeof out.amount_label === "string" ? out.amount_label : null,
    expiryDate: typeof out.expiry_date === "string" && ISO_DATE.test(out.expiry_date) ? out.expiry_date : null,
    expiryLabel: typeof out.expiry_label === "string" ? out.expiry_label : null,
  };
  return Object.values(facts).some((v) => v !== null) ? facts : null;
}
