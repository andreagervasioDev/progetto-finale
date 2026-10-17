/**
 * System prompt dell'orchestratore: istruzioni fisse (ruolo, strumenti, strategie, formato della risposta)
 * più il contesto della richiesta (archivio per categoria, dati chiave estratti, dataset, elemento aperto).
 * Le definizioni degli strumenti sono in tools/index.js.
 */
export const BASE_PROMPT = `Sei "Management AI", l'assistente AI per la gestione del club, una società di calcio di Serie A.
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

const fmtAmount = (n) => `${n.toLocaleString("it-IT")} €`;
const fmtDate = (iso) => iso.split("-").reverse().join("/");

/** System prompt della richiesta: archivio per categoria, dati chiave, dataset ed eventuale elemento aperto. */
export function buildSystemPrompt(ctx) {
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
