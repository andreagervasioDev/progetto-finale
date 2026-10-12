import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { deleteDocument, documentFileUrl, getCategories, listDocuments } from "../api.js";
import BallLoader from "../components/BallLoader.jsx";
import Icon from "../components/Icon.jsx";
import TypeBadge from "../components/TypeBadge.jsx";
import UploadDialog from "../components/UploadDialog.jsx";
import { categoryMeta, formatEuro, formatIsoDate } from "../categoryMeta.js";
import { useChat } from "../context/ChatContext.jsx";
import { formatDate, formatSize } from "../format.js";

/** Riga di dettaglio sotto il titolo: dati chiave estratti dall'AI, oppure righe del file di dati. */
function docDetail(d) {
  if (d.tabular) return `${d.originalName} · ${d.rows != null ? `${d.rows.toLocaleString("it-IT")} righe · ` : ""}${formatSize(d.size)}`;
  const f = d.facts;
  const parts = [];
  if (f?.subject) parts.push(f.subject);
  if (f?.amount != null) parts.push(formatEuro(f.amount));
  if (f?.expiryDate) parts.push(`${f.expiryLabel ?? "Scadenza"} ${formatIsoDate(f.expiryDate)}`);
  return parts.length ? parts.join(" · ") : `${d.originalName} · ${formatSize(d.size)} · ${formatDate(d.createdAt)}`;
}

/** Archivio documenti organizzato per categoria, con ricerca e caricamento drag & drop. */
export default function DocumentsPage() {
  const { handleError } = useChat();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [docs, setDocs] = useState(null);
  const [categories, setCategories] = useState([]);
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [upload, setUpload] = useState(null); // null | { file?: File }
  const [dragging, setDragging] = useState(false);
  const active = params.get("categoria") || "tutti";

  const load = useCallback(() => {
    listDocuments()
      .then(setDocs)
      .catch((err) => {
        handleError(err);
        setDocs([]);
      });
  }, [handleError]);

  useEffect(load, [load]);
  useEffect(() => {
    getCategories().then(setCategories).catch(handleError);
  }, [handleError]);

  const counts = useMemo(() => {
    const c = { tutti: docs?.length ?? 0 };
    for (const d of docs ?? []) c[d.category] = (c[d.category] ?? 0) + 1;
    return c;
  }, [docs]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (docs ?? []).filter((d) => {
      if (active !== "tutti" && d.category !== active) return false;
      if (!q) return true;
      const facts = d.facts ? [d.facts.subject, d.facts.counterparty, d.facts.summary].join(" ").toLowerCase() : "";
      return d.title.toLowerCase().includes(q) || d.originalName.toLowerCase().includes(q) || facts.includes(q);
    });
  }, [docs, active, query]);

  const activeLabel = active === "tutti" ? "Tutti i documenti" : categories.find((c) => c.id === active)?.label ?? "";

  const remove = async (doc) => {
    if (!window.confirm(`Eliminare "${doc.title}"? Verrà rimosso anche dalla memoria dell'AI.`)) return;
    try {
      await deleteDocument(doc.id);
      load();
    } catch (err) {
      handleError(err);
      window.alert(err.message);
    }
  };

  // drag & drop di un file in qualsiasi punto della pagina
  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) setUpload({ file });
  };

  return (
    <div
      className={`page ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <header className="page-header">
        <div>
          <h1>Documenti</h1>
          <p>
            L'archivio del club diviso per categoria. L'AI legge i documenti di testo, estrae scadenze e importi, e
            analizza i file Excel e CSV.
          </p>
        </div>
        <button className="btn primary" onClick={() => setUpload({})}>
          <Icon name="upload" size={17} /> Carica documento
        </button>
      </header>

      <div className="archive">
        <nav className="category-nav" aria-label="Categorie">
          <button className={active === "tutti" ? "active" : ""} onClick={() => setParams({})}>
            <Icon name="docs" size={17} />
            <span>Tutti</span>
            <span className="count">{counts.tutti}</span>
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              className={active === c.id ? "active" : ""}
              style={{ "--cat": categoryMeta(c.id).color }}
              onClick={() => setParams({ categoria: c.id })}
            >
              <Icon name={categoryMeta(c.id).icon} size={17} />
              <span>{c.label}</span>
              <span className="count">{counts[c.id] ?? 0}</span>
            </button>
          ))}
        </nav>

        <div className="archive-main">
          <div className="toolbar">
            <h2 className="archive-title">{activeLabel}</h2>
            <label className="search">
              <Icon name="search" size={17} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cerca per titolo, persona o controparte" />
            </label>
          </div>

          {docs === null ? (
            <div className="page-loading">
              <BallLoader size={44} label="Carico i documenti…" />
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-state-box">
              <Icon name={active === "tutti" ? "docs" : categoryMeta(active).icon} size={34} />
              <h3>{query ? "Nessun documento corrisponde alla ricerca" : "Nessun documento in questa categoria"}</h3>
              <p>Trascina qui un file oppure usa il pulsante "Carica documento".</p>
            </div>
          ) : (
            <ul className="doc-list">
              {visible.map((d) => (
                <li key={d.id} className="doc-row">
                  <Link to={`/documenti/${d.id}`} className="doc-main">
                    <TypeBadge type={d.type} />
                    <span className="doc-text">
                      <strong>{d.title}</strong>
                      <small>{docDetail(d)}</small>
                    </span>
                  </Link>
                  <span className="cat-badge" style={{ "--cat": categoryMeta(d.category).color }}>
                    <Icon name={categoryMeta(d.category).icon} size={13} />
                    {d.categoryLabel}
                  </span>
                  <span className="doc-actions">
                    <button
                      className="icon-only"
                      title={d.tabular ? "Chiedi un'analisi su questo file" : "Chiedi all'AI su questo documento"}
                      onClick={() => navigate(`/documenti/${d.id}?ai=1`)}
                    >
                      <Icon name="sparkles" />
                    </button>
                    <a className="icon-only" href={documentFileUrl(d.id, { download: true })} title="Scarica">
                      <Icon name="download" />
                    </a>
                    {d.canDelete && (
                      <button className="icon-only danger" title="Elimina" onClick={() => remove(d)}>
                        <Icon name="trash" />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <Icon name="upload" size={40} />
          <strong>Rilascia il file per caricarlo</strong>
          <span>PDF, Word, TXT, Markdown, Excel o CSV</span>
        </div>
      )}

      {upload && (
        <UploadDialog
          initialFile={upload.file}
          initialCategory={active !== "tutti" ? active : undefined}
          onClose={() => setUpload(null)}
          onUploaded={(doc) => {
            setUpload(null);
            navigate(`/documenti/${doc.id}`);
          }}
        />
      )}
    </div>
  );
}
