import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "./Icon.jsx";
import { toolMeta } from "./toolMeta.js";

/**
 * Mostra il "ragionamento" dell'agente in modo verificabile: quali strumenti ha usato,
 * con quali parametri, le fonti recuperate dalla RAG e il codice eseguito dal data agent.
 */
export default function ToolTrace({ trace, sources }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="trace">
      <button className="trace-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="trace-chips">
          {trace.map((t, i) => (
            <span key={i} className={`chip ${t.tool} ${t.ok ? "" : "failed"}`}>
              <Icon name={toolMeta(t.tool).icon} size={13} /> {toolMeta(t.tool).short}
            </span>
          ))}
        </span>
        <span className="trace-cta">{open ? "Nascondi dettagli" : "Come ho risposto"}</span>
      </button>

      {open && (
        <ol className="trace-steps">
          {trace.map((t, i) => (
            <li key={i}>
              <div className="trace-head">
                <strong>
                  Passo {t.step} · {toolMeta(t.tool).label}
                </strong>
                <span>{(t.ms / 1000).toFixed(1)}s</span>
              </div>
              <p className="trace-args">
                {t.args?.query && <>Query: “{t.args.query}”</>}
                {t.args?.question && <>Richiesta: “{t.args.question}”</>}
              </p>
              {t.args?.context && <p className="trace-args">Contesto passato: {t.args.context}</p>}
              {!t.ok && <p className="trace-error">Errore: {t.error}</p>}

              {t.sources?.length > 0 && (
                <ul className="sources">
                  {t.sources.map((s, j) => (
                    <li key={j}>
                      <div>
                        {s.docId ? (
                          <Link to={`/documenti/${s.docId}${s.page ? `?pagina=${s.page}` : ""}`} className="source-link">
                            <strong>{s.title}</strong>
                          </Link>
                        ) : (
                          <strong>{s.title}</strong>
                        )}{" "}
                        › {s.section}
                        <span className="score">sim. {s.score}</span>
                      </div>
                      <p>{s.excerpt}…</p>
                    </li>
                  ))}
                </ul>
              )}

              {t.cleaning && (
                <details className="cleaning">
                  <summary>
                    Data cleaning: {t.cleaning.rows_raw} righe grezze → {t.cleaning.rows_clean} righe pulite
                  </summary>
                  <ul>
                    {t.cleaning.steps.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ul>
                </details>
              )}

              {t.code?.map((c, j) => (
                <details key={j} className="code-step">
                  <summary>
                    Codice {j + 1}: {c.thought || "esecuzione"}
                  </summary>
                  <pre>
                    <code>{c.code}</code>
                  </pre>
                  <pre className="output">
                    <code>{c.output}</code>
                  </pre>
                </details>
              ))}
            </li>
          ))}
        </ol>
      )}
      {!open && sources?.length > 0 && (
        <p className="trace-sources">
          Fonti:{" "}
          {[...new Map(sources.map((s) => [s.docId ?? s.title, s])).values()].map((s, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {s.docId ? (
                <Link to={`/documenti/${s.docId}${s.page ? `?pagina=${s.page}` : ""}`} className="source-link">
                  {s.title}
                </Link>
              ) : (
                s.title
              )}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
