import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { deleteDocument, documentFileUrl, getCategories, getDocumentContent, updateDocument } from "../api.js";
import BallLoader from "../components/BallLoader.jsx";
import DatasetView from "../components/DatasetView.jsx";
import Icon from "../components/Icon.jsx";
import TypeBadge from "../components/TypeBadge.jsx";
import { categoryMeta, formatEuro, formatIsoDate } from "../categoryMeta.js";
import { useChat } from "../context/ChatContext.jsx";
import { formatDate, formatSize } from "../format.js";

/** Scheda con i dati chiave estratti dall'AI (persona, controparte, importo, scadenza). */
function FactsCard({ facts }) {
  const rows = [
    ["Persona", facts.subject],
    ["Controparte", facts.counterparty],
    [facts.amountLabel ?? "Importo", facts.amount != null ? formatEuro(facts.amount) : null],
    [facts.expiryLabel ?? "Scadenza", facts.expiryDate ? formatIsoDate(facts.expiryDate) : null],
  ].filter(([, v]) => v);
  return (
    <section className="facts-card">
      <header>
        <Icon name="sparkles" size={16} />
        <strong>Dati chiave estratti dall'AI</strong>
        <small>da verificare sul documento</small>
      </header>
      {facts.summary && <p>{facts.summary}</p>}
      {rows.length > 0 && (
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** Lettore di un documento (PDF, Word, Markdown, testo) o di un file di dati, con accesso diretto all'assistente. */
export default function DocumentViewerPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setReadingDocument, openDrawer, handleError } = useChat();
  const [doc, setDoc] = useState(undefined); // undefined = caricamento, null = non trovato
  const [categories, setCategories] = useState([]);
  const [saving, setSaving] = useState(false);
  const page = params.get("pagina");

  useEffect(() => {
    let alive = true;
    setDoc(undefined);
    getDocumentContent(id)
      .then((d) => alive && setDoc(d))
      .catch((err) => {
        handleError(err);
        if (alive) setDoc(null);
      });
    return () => {
      alive = false;
    };
  }, [id, handleError]);

  useEffect(() => {
    getCategories().then(setCategories).catch(handleError);
  }, [handleError]);

  // mentre il documento è aperto, l'assistente può rispondere su questo file
  useEffect(() => {
    if (!doc) return;
    setReadingDocument(doc);
    if (params.get("ai")) openDrawer({ fresh: true });
    return () => setReadingDocument(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id]);

  if (doc === undefined) {
    return (
      <div className="page page-loading">
        <BallLoader size={44} label="Apro il documento…" />
      </div>
    );
  }
  if (doc === null) {
    return (
      <div className="page">
        <div className="empty-state-box">
          <Icon name="docs" size={34} />
          <h3>Documento non trovato</h3>
          <p>Potrebbe essere stato eliminato.</p>
          <Link className="btn ghost" to="/documenti">
            Torna ai documenti
          </Link>
        </div>
      </div>
    );
  }

  const remove = async () => {
    if (!window.confirm(`Eliminare "${doc.title}"? Verrà rimosso anche dalla memoria dell'AI.`)) return;
    try {
      await deleteDocument(doc.id);
      navigate(`/documenti?categoria=${doc.category}`);
    } catch (err) {
      handleError(err);
      window.alert(err.message);
    }
  };

  const changeCategory = async (category) => {
    setSaving(true);
    try {
      const updated = await updateDocument(doc.id, { category });
      setDoc((d) => ({ ...d, ...updated }));
    } catch (err) {
      window.alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const meta = categoryMeta(doc.category);

  return (
    <div className="page viewer-page">
      <header className="viewer-header">
        <Link to={`/documenti?categoria=${doc.category}`} className="back-link">
          <Icon name="back" size={17} /> {doc.categoryLabel}
        </Link>
        <div className="viewer-title">
          <TypeBadge type={doc.type} large />
          <div>
            <h1>{doc.title}</h1>
            <p>
              {doc.canEdit && !doc.tabular ? (
                <label className="cat-select" style={{ "--cat": meta.color }} title="Cambia categoria">
                  <Icon name={meta.icon} size={13} />
                  <select value={doc.category} onChange={(e) => changeCategory(e.target.value)} disabled={saving}>
                    {categories
                      .filter((c) => !c.tabular)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <span className="cat-badge" style={{ "--cat": meta.color }}>
                  <Icon name={meta.icon} size={13} />
                  {doc.categoryLabel}
                </span>
              )}
              {saving && <BallLoader size={14} inline label="Aggiorno…" />}
              {doc.official ? "Documento ufficiale" : "Documento caricato"} · {formatDate(doc.createdAt)} · {formatSize(doc.size)}
              {doc.tabular ? ` · ${doc.rows?.toLocaleString("it-IT") ?? "–"} righe` : ` · ${doc.chunks} sezioni indicizzate`}
            </p>
          </div>
        </div>
        <div className="viewer-actions">
          <button className="btn primary" onClick={() => openDrawer({ fresh: true })}>
            <Icon name="sparkles" size={17} /> {doc.tabular ? "Chiedi un'analisi" : "Chiedi all'AI"}
          </button>
          <a className="btn ghost" href={documentFileUrl(doc.id, { download: true })}>
            <Icon name="download" size={17} /> Scarica
          </a>
          {doc.canDelete && (
            <button className="btn ghost danger" onClick={remove}>
              <Icon name="trash" size={17} /> Elimina
            </button>
          )}
        </div>
      </header>

      {doc.facts && <FactsCard facts={doc.facts} />}

      {doc.format === "dataset" ? (
        <DatasetView datasetId={doc.id} onError={handleError} />
      ) : (
        <div className="viewer-body">
          {doc.format === "pdf" ? (
            <iframe className="pdf-frame" title={doc.title} src={documentFileUrl(doc.id, { page })} />
          ) : doc.format === "html" ? (
            // HTML generato dal server con mammoth a partire dal .docx (solo formattazione del testo)
            <article className="doc-article" dangerouslySetInnerHTML={{ __html: doc.content }} />
          ) : doc.format === "markdown" ? (
            <article className="doc-article markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
            </article>
          ) : (
            <article className="doc-article plain">{doc.content}</article>
          )}
        </div>
      )}
    </div>
  );
}
