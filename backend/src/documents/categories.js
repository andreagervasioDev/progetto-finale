/**
 * Categorie dell'archivio documenti.
 *  - folder: sottocartella di knowledge_base/ da cui i documenti ufficiali prendono la categoria
 *  - facts:  se true, al caricamento l'AI estrae i dati chiave (persona, controparte, importo, scadenza)
 *  - tabular: categoria dei file di dati (CSV/Excel), analizzati dal data agent invece che dalla RAG
 */
export const CATEGORIES = [
  { id: "contratti", label: "Contratti giocatori", folder: "contratti", facts: true,
    hint: "contratti di lavoro dei calciatori, rinnovi, clausole, prestiti" },
  { id: "sponsor", label: "Sponsorizzazioni", folder: "sponsor", facts: true,
    hint: "accordi con sponsor, fornitori tecnici, partner commerciali" },
  { id: "medico", label: "Area medica", folder: "medico", facts: true,
    hint: "certificati medici, idoneità sportiva, referti, cartelle cliniche" },
  { id: "mercato", label: "Mercato", folder: "mercato", facts: true,
    hint: "offerte di acquisto o cessione di giocatori, trattative, proposte di club e agenti" },
  { id: "prestazioni", label: "Analisi prestazioni", folder: "prestazioni", facts: false,
    hint: "report di match analysis, scouting, valutazioni tecniche e fisiche" },
  { id: "regolamenti", label: "Regolamenti e procedure", folder: "regolamenti", facts: false,
    hint: "regolamenti interni, protocolli, linee guida, policy, FAQ, procedure" },
  { id: "dati", label: "Dati (Excel / CSV)", folder: "dati", facts: false, tabular: true,
    hint: "tabelle di dati da analizzare" },
  { id: "altro", label: "Altri documenti", folder: "altro", facts: false,
    hint: "tutto ciò che non rientra nelle altre categorie" },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export const getCategory = (id) => BY_ID.get(id) ?? BY_ID.get("altro");
export const isCategory = (id) => BY_ID.has(id);
export const TEXT_CATEGORY_IDS = CATEGORIES.filter((c) => !c.tabular).map((c) => c.id);

/** Categoria di un documento ufficiale dalla sua sottocartella (file nella radice = regolamenti). */
export function categoryFromFolder(folder) {
  if (!folder) return "regolamenti";
  return CATEGORIES.find((c) => c.folder === folder.toLowerCase())?.id ?? "altro";
}
