import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getDeadlines, listDatasets, listDocuments, logSearch } from "../api.js";
import Icon from "../components/Icon.jsx";
import TypeBadge from "../components/TypeBadge.jsx";
import UploadDialog from "../components/UploadDialog.jsx";
import { categoryMeta, formatEuro, formatIsoDate } from "../categoryMeta.js";
import { useChat } from "../context/ChatContext.jsx";
import { relativeTime } from "../format.js";
import { SUGGESTIONS } from "../suggestions.js";

function greeting() {
  const h = new Date().getHours();
  return h < 13 ? "Buongiorno" : h < 18 ? "Buon pomeriggio" : "Buonasera";
}

/** Testo e livello di urgenza di una scadenza. */
function deadlineInfo(days) {
  if (days < 0) return { text: `scaduto da ${-days} g`, level: "expired" };
  if (days === 0) return { text: "scade oggi", level: "urgent" };
  if (days <= 30) return { text: `tra ${days} g`, level: "urgent" };
  if (days <= 90) return { text: `tra ${days} g`, level: "soon" };
  return { text: days < 365 ? `tra ${Math.round(days / 30)} mesi` : `tra ${(days / 365).toFixed(1).replace(".", ",")} anni`, level: "later" };
}

const KIND_LABEL = { rag: "Documenti", data: "Dati", hybrid: "Documenti + Dati" };

/** Disegno del campo (metà destra dell'hero): linea di metà campo, cerchio centrale, area di rigore. */
function PitchLines() {
  return (
    <svg className="hero-pitch" viewBox="0 0 400 260" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <g fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5">
        <rect x="30" y="10" width="420" height="240" />
        <line x1="30" y1="10" x2="30" y2="250" />
        <circle cx="30" cy="130" r="58" />
        <rect x="300" y="55" width="100" height="150" />
        <rect x="360" y="95" width="40" height="70" />
        <path d="M300 102 A 40 40 0 0 0 300 158" />
      </g>
      <circle cx="30" cy="130" r="3" fill="rgba(255,255,255,0.35)" />
      <circle cx="335" cy="130" r="3" fill="rgba(255,255,255,0.35)" />
    </svg>
  );
}

/** Home: barra con data e ricerca, hero con domanda rapida, numeri, documenti, scadenze, conversazioni, domande di esempio. */
export default function HomePage() {
  const { user, conversations, openConversation, openDrawer, handleError } = useChat();
  const navigate = useNavigate();
  const [docs, setDocs] = useState(null);
  const [datasets, setDatasets] = useState(null);
  const [deadlines, setDeadlines] = useState(null);
  const [upload, setUpload] = useState(false);
  const [question, setQuestion] = useState("");
  const [search, setSearch] = useState("");
  const searchRef = useRef(null);

  useEffect(() => {
    listDocuments().then(setDocs).catch((e) => (handleError(e), setDocs([])));
    listDatasets().then(setDatasets).catch(() => setDatasets(null));
    getDeadlines().then(setDeadlines).catch(() => setDeadlines([]));
  }, [handleError]);

  // Cmd+K / Ctrl+K porta il cursore nella ricerca
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ask = (e) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    openDrawer({ question: q, fresh: true });
    setQuestion("");
  };

  const runSearch = (e) => {
    e.preventDefault();
    const q = search.trim();
    if (q.length >= 2) logSearch(q, "home");
    navigate(q ? `/documenti?q=${encodeURIComponent(q)}` : "/documenti");
  };

  const firstName = user.name.split(" ")[0];
  const stats = [
    { label: "Documenti in archivio", value: docs?.filter((d) => !d.tabular).length, icon: "docs", to: "/documenti" },
    {
      label: "Dataset analizzabili",
      value: datasets?.length || null,
      icon: "table",
      tone: "data",
      to: "/dati",
      empty: { text: "Carica un CSV", to: "/documenti?categoria=dati" },
    },
    { label: "Scadenze entro 90 giorni", value: deadlines?.filter((d) => d.daysLeft >= 0 && d.daysLeft <= 90).length, icon: "calendar", to: "/documenti" },
    { label: "Conversazioni", value: conversations.length, icon: "chat", to: "/assistente" },
  ];

  // due domande per tipo, nell'ordine documenti → dati → ibride
  const examples = SUGGESTIONS.flatMap((g) => g.items.slice(0, 2).map((q) => ({ q, kind: g.kind })));

  return (
    <div className="page home">
      <div className="home-top">
        <p className="home-date">{new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}</p>
        <form className="home-search" onSubmit={runSearch} role="search">
          <Icon name="search" size={16} />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cerca documenti, giocatori, scadenze…"
            aria-label="Cerca nei documenti"
          />
          <kbd>⌘K</kbd>
        </form>
      </div>

      <section className="hero">
        <PitchLines />
        <div className="hero-content">
          <h1>
            {greeting()}, {firstName}
          </h1>
          <p>Cerca nei documenti del club, carica i tuoi file e chiedi analisi sui dati: l'assistente fa il resto.</p>
          <form className="hero-ask" onSubmit={ask}>
            <Icon name="sparkles" size={17} />
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Chiedi qualcosa su regolamenti, protocolli o dati…"
              aria-label="Domanda per l'assistente"
            />
            <button className="btn primary" type="submit">
              Chiedi <Icon name="arrow" size={15} />
            </button>
          </form>
          <div className="hero-actions">
            <button className="btn light" onClick={() => setUpload(true)}>
              <Icon name="upload" size={17} /> Carica documento
            </button>
            <span className="hero-formats">PDF, Word, Markdown, CSV, Excel</span>
          </div>
        </div>
      </section>

      <section className="stats">
        {stats.map((s) => (
          <div key={s.label} className="stat">
            <Link to={s.to} className="stat-link" aria-label={s.label} />
            <span className="stat-label">{s.label}</span>
            <span className={`stat-icon ${s.tone ?? ""}`}>
              <Icon name={s.icon} size={16} />
            </span>
            {s.value == null && s.empty ? (
              <span className="stat-value">
                <strong className="muted">–</strong>
                <Link className="stat-cta" to={s.empty.to}>
                  {s.empty.text}
                </Link>
              </span>
            ) : (
              <strong className="stat-value">{s.value ?? "–"}</strong>
            )}
          </div>
        ))}
      </section>

      <div className="home-grid">
        <section className="panel">
          <header>
            <h2>Documenti recenti</h2>
            <Link to="/documenti">
              Vedi tutti <Icon name="arrow" size={13} />
            </Link>
          </header>
          {docs?.length ? (
            <ul className="mini-list plain">
              {docs.slice(0, 5).map((d) => (
                <li key={d.id}>
                  <Link to={`/documenti/${d.id}`}>
                    <TypeBadge type={d.type} />
                    <span>
                      <strong>{d.title}</strong>
                      <small>
                        {d.categoryLabel} · {relativeTime(d.createdAt)}
                      </small>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="panel-empty">Nessun documento ancora.</p>
          )}
        </section>

        <div className="home-col">
          <section className="panel deadlines">
            <header>
              <h2>Prossime scadenze</h2>
              <span className="tag">Estratte dall'AI</span>
            </header>
            {deadlines === null ? null : deadlines.length ? (
              <ul className="deadline-list">
                {deadlines.slice(0, 5).map((d) => {
                  const info = deadlineInfo(d.daysLeft);
                  const meta = categoryMeta(d.category);
                  return (
                    <li key={d.id}>
                      <Link to={`/documenti/${d.id}`}>
                        <span className="deadline-icon" style={{ "--cat": meta.color }}>
                          <Icon name={meta.icon} size={17} />
                        </span>
                        <span className="deadline-text">
                          <strong>{d.title}</strong>
                          <small>
                            {d.facts.expiryLabel ?? "Scadenza"} {formatIsoDate(d.facts.expiryDate)}
                            {d.facts.subject ? ` · ${d.facts.subject}` : ""}
                            {d.facts.amount != null ? ` · ${formatEuro(d.facts.amount)}` : ""}
                          </small>
                        </span>
                        <span className={`deadline-when ${info.level}`}>{info.text}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="empty-inline">
                <span className="empty-inline-icon">
                  <Icon name="calendar" size={17} />
                </span>
                <div>
                  <strong>Nessuna scadenza in arrivo</strong>
                  <p>Carica contratti, sponsorizzazioni, certificati medici o offerte: l'AI ne estrarrà le date.</p>
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <header>
              <h2>Conversazioni recenti</h2>
              <Link to="/assistente">
                Apri l'assistente <Icon name="arrow" size={13} />
              </Link>
            </header>
            {conversations.length ? (
              <ul className="mini-list plain">
                {conversations.slice(0, 4).map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => {
                        openConversation(c.id);
                        navigate("/assistente");
                      }}
                    >
                      <span className="chat-dot">
                        <Icon name="chat" size={15} />
                      </span>
                      <span>
                        <strong>{c.title}</strong>
                        <small>
                          {Math.ceil(c.messageCount / 2) === 1 ? "1 domanda" : `${Math.ceil(c.messageCount / 2)} domande`} ·{" "}
                          {relativeTime(c.updatedAt)}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="panel-empty">Non hai ancora fatto domande all'assistente.</p>
            )}
          </section>
        </div>
      </div>

      <section className="examples">
        <header>
          <h2>Prova a chiedere</h2>
          <span className="legend">
            <span className="rag">Documenti</span>
            <span className="data">Dati</span>
          </span>
        </header>
        <div className="example-grid">
          {examples.map(({ q, kind }) => (
            <button key={q} className={`example-card ${kind}`} onClick={() => openDrawer({ question: q, fresh: true })}>
              <span className="example-kind">{KIND_LABEL[kind]}</span>
              {q}
            </button>
          ))}
        </div>
      </section>

      {upload && (
        <UploadDialog
          onClose={() => setUpload(false)}
          onUploaded={(doc) => navigate(`/documenti/${doc.id}`)}
        />
      )}
    </div>
  );
}
