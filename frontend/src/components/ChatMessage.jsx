import { Suspense, lazy } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ChartGallery from "./ChartGallery.jsx";
import DataTable from "./DataTable.jsx";
import Icon from "./Icon.jsx";
import ToolTrace from "./ToolTrace.jsx";

// Recharts pesa ~400 KB: viene scaricato solo quando una risposta contiene un grafico
const DataChart = lazy(() => import("./DataChart.jsx"));

const time = (ts) => new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

export default function ChatMessage({ message, compact = false }) {
  const { role, content, charts, tables, trace, sources, error, createdAt, document, cached } = message;
  // grafici con i dati (JSON) → disegnati in React; senza (conversazioni precedenti, save_chart) → immagine PNG
  const dataCharts = charts?.filter((c) => c.spec) ?? [];
  const imageCharts = charts?.filter((c) => !c.spec) ?? [];

  if (role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">
          {document && (
            <span className="msg-doc">
              <Icon name="file" size={13} /> {document.title}
            </span>
          )}
          <p>{content}</p>
          <span className="time">{time(createdAt)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`msg assistant ${compact ? "compact" : ""}`}>
      <div className="avatar" aria-hidden="true">
        <img src="/logo-icon.png" alt="" />
      </div>
      <div className={`bubble ${error ? "error" : ""}`}>
        {cached && (
          <p className="cached-note" title="La stessa domanda aveva già una risposta valida: nessuna nuova chiamata all'AI">
            Risposta dalla cache
          </p>
        )}
        {trace?.length > 0 && <ToolTrace trace={trace} sources={sources} />}
        <div className="markdown">
          {error ? (
            <p className="error-text">
              <Icon name="alert" size={17} /> {content}
            </p>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                table: (props) => (
                  <div className="table-wrap">
                    <table {...props} />
                  </div>
                ),
              }}
            >
              {content}
            </ReactMarkdown>
          )}
        </div>
        {(dataCharts.length > 0 || tables?.length > 0) && (
          <div className="analysis-results">
            {dataCharts.map((c) => (
              <Suspense key={c.filename} fallback={<div className="data-chart chart-loading">Carico il grafico…</div>}>
                <DataChart chart={c} />
              </Suspense>
            ))}
            {tables?.map((t, i) => (
              <DataTable key={i} table={t} />
            ))}
          </div>
        )}
        {imageCharts.length > 0 && <ChartGallery charts={imageCharts} />}
        <span className="time">{time(createdAt)}</span>
      </div>
    </div>
  );
}
