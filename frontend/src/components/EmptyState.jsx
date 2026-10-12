import { SUGGESTIONS } from "../suggestions.js";
import Icon from "./Icon.jsx";

const ICONS = { rag: "docs", data: "data", hybrid: "route" };

const DOC_SUGGESTIONS = [
  "Fammi un riassunto di questo documento",
  "Quali sono i punti chiave e le regole principali?",
  "Ci sono scadenze, importi o soglie da ricordare?",
];

const DATASET_SUGGESTIONS = [
  "Descrivimi questi dati: cosa contengono e quali sono i numeri principali?",
  "Fai un grafico con l'andamento o il confronto più interessante",
  "Ci sono anomalie o valori sospetti in questi dati?",
];

/** Schermata iniziale della chat: suggerimenti generali, oppure sul documento aperto. */
export default function EmptyState({ onAsk, userName, compact = false, document = null }) {
  const firstName = userName?.split(" ")[0];

  if (compact) {
    const isDataset = document?.kind === "dataset";
    const items = document ? (isDataset ? DATASET_SUGGESTIONS : DOC_SUGGESTIONS) : SUGGESTIONS.map((g) => g.items[0]);
    return (
      <div className="empty compact">
        <img className="empty-logo" src="/logo-icon.png" alt="" width="64" height="64" />
        <h2>{document ? (isDataset ? "Chiedimi un'analisi" : "Chiedimi del documento") : `Ciao ${firstName ?? ""}, come posso aiutarti?`}</h2>
        <p>
          {document
            ? isDataset
              ? `Analizzo "${document.title}" con il data agent Python.`
              : `Cerco le risposte dentro "${document.title}".`
            : "Documenti del club o analisi sui dati: scelgo io lo strumento giusto."}
        </p>
        <div className="empty-list">
          {items.map((q) => (
            <button key={q} onClick={() => onAsk(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="empty">
      <img className="empty-logo" src="/logo-icon.png" alt="" width="120" height="120" />
      <h2>{firstName ? `Ciao ${firstName}, sono Management AI` : "Ciao, sono Management AI"}</h2>
      <p>
        Posso rispondere usando i documenti del club e quelli che hai caricato, oppure analizzare i dati delle partite
        delle ultime due stagioni. Scelgo da solo lo strumento giusto.
      </p>
      <div className="empty-grid">
        {SUGGESTIONS.map((g) => (
          <div key={g.group} className={`empty-card ${g.kind}`}>
            <h3>
              <Icon name={ICONS[g.kind]} size={17} /> {g.group}
            </h3>
            {g.items.slice(0, 2).map((q) => (
              <button key={q} onClick={() => onAsk(q)}>
                {q}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
