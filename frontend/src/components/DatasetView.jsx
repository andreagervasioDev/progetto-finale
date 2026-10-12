import { useEffect, useMemo, useState } from "react";
import { getDatasetOverview } from "../api.js";
import BallLoader from "./BallLoader.jsx";
import Icon from "./Icon.jsx";

// per il dataset partite (40 colonne) l'anteprima mostra solo le più significative; le altre sono nello schema
const BUILTIN_COLS = [
  "match_date", "competition", "opponent", "venue", "result", "player_name", "position", "minutes_played",
  "goals", "assists", "xg", "pass_accuracy_pct", "distance_km", "top_speed_kmh", "wellness_score", "rating", "injury", "injury_type",
];

const isoDay = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v.slice(0, 10).split("-").reverse().join("/") : null);

function cell(v) {
  if (v === null || v === undefined || v === "") return <span className="null">—</span>;
  if (typeof v === "number") return v.toLocaleString("it-IT", { maximumFractionDigits: 2 });
  return isoDay(v) ?? String(v);
}

const fmtDay = (iso) => iso.split("-").reverse().join("/");

/** Panoramica di un dataset: numeri principali, pulizia automatica, valori mancanti, anteprima righe, schema. */
export default function DatasetView({ datasetId, onError }) {
  const [data, setData] = useState(undefined);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(undefined);
    getDatasetOverview(datasetId, 60)
      .then((d) => alive && setData(d))
      .catch((err) => {
        onError?.(err);
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [datasetId, onError]);

  const schemaLines = useMemo(
    () => (data?.schema ?? "").split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.trim().slice(2)),
    [data],
  );

  if (data === undefined)
    return (
      <div className="page-loading">
        <BallLoader size={44} label="Carico i dati…" />
      </div>
    );
  if (data === null)
    return (
      <div className="empty-state-box">
        <Icon name="data" size={34} />
        <h3>Dati non disponibili</h3>
        <p>Il data agent Python non risponde o il file non è più disponibile.</p>
      </div>
    );

  const s = data.summary;
  const kpis = data.builtin
    ? [
        { label: "Righe grezze → pulite", value: `${data.rows_raw.toLocaleString("it-IT")} → ${data.rows_clean.toLocaleString("it-IT")}` },
        { label: "Partite", value: s.matches },
        { label: "Giocatori", value: s.players },
        { label: "Stagioni", value: s.seasons.join(" · ") },
        { label: "Gol segnati", value: s.goals },
        { label: "Infortuni registrati", value: s.injuries },
      ]
    : [
        { label: "Righe grezze → pulite", value: `${data.rows_raw.toLocaleString("it-IT")} → ${data.rows_clean.toLocaleString("it-IT")}` },
        { label: "Colonne", value: s.columns },
        { label: "Colonne numeriche", value: s.numeric_columns },
        { label: "Colonne con date", value: s.date_columns },
        ...(s.date_from ? [{ label: "Periodo", value: `${fmtDay(s.date_from)} – ${fmtDay(s.date_to)}` }] : []),
      ];
  const rows = raw ? data.preview_raw : data.preview_clean;
  const cols = data.builtin ? BUILTIN_COLS : Object.keys(rows[0] ?? {});
  const missing = Object.entries(data.missing_raw).sort((a, b) => b[1] - a[1]);
  const maxMissing = Math.max(...missing.map(([, v]) => v), 1);

  return (
    <>
      <section className="kpis">
        {kpis.map((k) => (
          <div key={k.label} className="kpi">
            <strong>{k.value}</strong>
            <span>{k.label}</span>
          </div>
        ))}
      </section>

      <div className="data-grid">
        <section className="panel">
          <header>
            <h2>Pulizia automatica dei dati</h2>
          </header>
          <ol className="cleaning-steps">
            {data.cleaning_report.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </section>
        <section className="panel">
          <header>
            <h2>Valori mancanti nel file grezzo</h2>
            <span className="panel-note">
              {data.duplicates_raw === 1 ? "1 riga duplicata" : `${data.duplicates_raw} righe duplicate`}
            </span>
          </header>
          {missing.length ? (
            <ul className="bars">
              {missing.map(([col, n]) => (
                <li key={col}>
                  <span className="bar-label" title={col}>
                    {col}
                  </span>
                  <span className="bar-track">
                    <span style={{ width: `${(n / maxMissing) * 100}%` }} />
                  </span>
                  <span className="bar-value">{n}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-empty">Nessun valore mancante.</p>
          )}
        </section>
      </div>

      <section className="panel">
        <header>
          <h2>
            Anteprima ({rows.length} righe{raw ? ", file grezzo" : data.builtin ? ", dati puliti più recenti" : ", dati puliti"})
          </h2>
          <div className="tabs small" role="tablist">
            <button role="tab" aria-selected={!raw} className={!raw ? "active" : ""} onClick={() => setRaw(false)}>
              Puliti
            </button>
            <button role="tab" aria-selected={raw} className={raw ? "active" : ""} onClick={() => setRaw(true)}>
              Grezzi
            </button>
          </div>
        </header>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c}>{cell(r[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <details className="panel schema">
        <summary>Schema completo ({data.columns.length} colonne)</summary>
        <ul>
          {schemaLines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </details>
    </>
  );
}
