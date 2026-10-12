import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listDatasets } from "../api.js";
import BallLoader from "../components/BallLoader.jsx";
import DatasetView from "../components/DatasetView.jsx";
import Icon from "../components/Icon.jsx";
import { useChat } from "../context/ChatContext.jsx";

/** Pagina "Dati": i dataset analizzabili dal data agent (dati partite + file CSV/Excel caricati). */
export default function DataPage() {
  const { openDrawer, setReadingDocument, handleError } = useChat();
  const [params, setParams] = useSearchParams();
  const [datasets, setDatasets] = useState(undefined);
  const selectedId = params.get("dataset") || "partite";

  useEffect(() => {
    listDatasets()
      .then(setDatasets)
      .catch((err) => {
        handleError(err);
        setDatasets(null);
      });
  }, [handleError]);

  const selected = datasets?.find((d) => d.id === selectedId) ?? datasets?.[0];

  // i file caricati sono anche documenti: l'assistente li analizza come "dati aperti"
  useEffect(() => {
    if (selected?.docId) setReadingDocument({ id: selected.docId, title: selected.title, kind: "dataset" });
    return () => setReadingDocument(null);
  }, [selected?.docId, selected?.title, setReadingDocument]);

  if (datasets === undefined)
    return (
      <div className="page page-loading">
        <BallLoader size={44} label="Carico i dati…" />
      </div>
    );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Dati</h1>
          <p>
            Le tabelle che il data agent può analizzare: i dati delle partite e i file Excel o CSV caricati in Documenti.
            Prima di ogni analisi i dati vengono puliti automaticamente.
          </p>
        </div>
        <button className="btn primary" onClick={() => openDrawer({ fresh: true })}>
          <Icon name="sparkles" size={17} /> Chiedi un'analisi
        </button>
      </header>

      {datasets === null ? (
        <div className="empty-state-box">
          <Icon name="data" size={34} />
          <h3>Dati non disponibili</h3>
          <p>Il data agent Python non risponde: verifica che sia avviato.</p>
        </div>
      ) : (
        <>
          <div className="dataset-picker" role="tablist" aria-label="Dataset">
            {datasets.map((d) => (
              <button
                key={d.id}
                role="tab"
                aria-selected={d.id === selected?.id}
                className={d.id === selected?.id ? "active" : ""}
                onClick={() => setParams(d.id === "partite" ? {} : { dataset: d.id })}
              >
                <Icon name="table" size={16} />
                <span>
                  <strong>{d.title}</strong>
                  <small>
                    {d.rows.toLocaleString("it-IT")} righe · {d.columns.length} colonne
                  </small>
                </span>
              </button>
            ))}
            <Link to="/documenti?categoria=dati" className="dataset-add">
              <Icon name="plus" size={16} /> Carica un Excel o CSV
            </Link>
          </div>
          {selected && <DatasetView datasetId={selected.id} onError={handleError} />}
        </>
      )}
    </div>
  );
}
