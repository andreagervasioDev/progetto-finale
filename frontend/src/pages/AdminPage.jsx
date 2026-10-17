import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  getAdminActivity,
  getAdminConversation,
  getAdminConversations,
  getAdminOverview,
  getAdminUsers,
} from "../api.js";
import BallLoader from "../components/BallLoader.jsx";
import ChatMessage from "../components/ChatMessage.jsx";
import Icon from "../components/Icon.jsx";
import { useChat } from "../context/ChatContext.jsx";
import { formatDate, formatSize, relativeTime } from "../format.js";

const TABS = [
  { id: "panoramica", label: "Panoramica e costi" },
  { id: "utenti", label: "Utenti" },
  { id: "attivita", label: "Attività" },
  { id: "conversazioni", label: "Conversazioni" },
];

const KIND_LABELS = {
  chat: "Chat (orchestratore)",
  data_agent: "Data agent (analisi)",
  documenti: "AI sui documenti",
  embedding: "Embedding (indicizzazione e ricerca)",
};

const ACTIVITY = {
  login: { label: "Accesso", icon: "lock" },
  login_failed: { label: "Accesso non riuscito", icon: "alert" },
  logout: { label: "Uscita", icon: "logout" },
  chat: { label: "Domanda all'AI", icon: "chat" },
  search: { label: "Ricerca", icon: "search" },
  upload: { label: "Caricamento", icon: "upload" },
  edit: { label: "Modifica documento", icon: "edit" },
  delete: { label: "Eliminazione", icon: "trash" },
};

const usd = (n, digits = 2) =>
  n == null ? "–" : `$ ${n.toLocaleString("it-IT", { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, n < 1 ? 4 : 2) })}`;
const num = (n) => (n ?? 0).toLocaleString("it-IT");
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString("it-IT", { maximumFractionDigits: 2 })} M` : n >= 1e4 ? `${Math.round(n / 1000)} K` : num(n));
const dateTime = (ts) => new Date(ts).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Dashboard di amministrazione: costi AI, utenti, storico delle attività e delle conversazioni. */
export default function AdminPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "panoramica";
  const [users, setUsers] = useState([]);
  const { handleError } = useChat();

  useEffect(() => {
    getAdminUsers().then(setUsers).catch(handleError);
  }, [handleError]);

  const open = (next) => setParams(next);

  return (
    <div className="page admin">
      <header className="page-header">
        <div>
          <h1>Amministrazione</h1>
          <p>Spesa per l'AI, utenti della piattaforma e storico di quello che hanno chiesto, cercato e caricato.</p>
        </div>
      </header>

      <div className="tabs admin-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => open({ tab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "panoramica" && <Overview />}
      {tab === "utenti" && <Users users={users} onOpen={open} />}
      {tab === "attivita" && <Activity users={users} userId={params.get("utente") ?? ""} onOpen={open} />}
      {tab === "conversazioni" && (
        <Conversations users={users} userId={params.get("utente") ?? ""} openId={params.get("id")} onOpen={open} />
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="page-loading">
      <BallLoader size={44} label="Carico i dati…" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panoramica: KPI di spesa                                            */
/* ------------------------------------------------------------------ */
function Overview() {
  const [data, setData] = useState(null);
  const { handleError } = useChat();

  useEffect(() => {
    getAdminOverview().then(setData).catch(handleError);
  }, [handleError]);

  if (!data) return <Loading />;
  const u = data.usage;
  const kpis = [
    { label: "Spesa AI totale", value: usd(u.total.costUsd), hint: `${tokens(u.total.inputTokens + u.total.outputTokens)} token` },
    { label: "Ultimi 30 giorni", value: usd(u.last30Days.costUsd), hint: `${num(u.last30Days.calls)} chiamate al modello` },
    {
      label: "Oggi",
      value: usd(u.today.costUsd),
      hint: data.dailyBudgetUsd
        ? `tetto ${usd(data.dailyBudgetUsd, 0)}/giorno`
        : `${tokens(u.today.inputTokens + u.today.outputTokens)} token`,
      warn: data.dailyBudgetUsd && u.today.costUsd >= data.dailyBudgetUsd,
    },
    { label: "Costo medio per domanda", value: usd(data.costPerQuestionUsd, 4), hint: `${num(data.activity.questions)} domande in totale` },
    { label: "Utenti", value: num(data.users), hint: `${num(data.activity.logins)} accessi` },
    { label: "Documenti in archivio", value: num(data.documents), hint: `${num(data.activity.uploads)} caricamenti` },
  ];

  return (
    <>
      <section className="kpis admin-kpis">
        {kpis.map((k) => (
          <div key={k.label} className={`kpi ${k.warn ? "kpi-warn" : ""}`}>
            <span>{k.label}</span>
            <strong>{k.value}</strong>
            <small>{k.hint}</small>
          </div>
        ))}
      </section>

      <section className="panel">
        <header>
          <h2>Spesa giornaliera, ultimi 30 giorni</h2>
          <span className="panel-note">in dollari, stimata dai token</span>
        </header>
        <DailyCostChart daily={u.daily} />
      </section>

      <div className="data-grid admin-grid">
        <section className="panel">
          <header>
            <h2>Dove si spende</h2>
          </header>
          <BreakdownBars rows={u.byKind.map((g) => ({ ...g, label: KIND_LABELS[g.key] ?? g.key }))} />
        </section>
        <section className="panel">
          <header>
            <h2>Spesa per utente</h2>
          </header>
          <BreakdownBars rows={u.byUser.map((g) => ({ ...g, label: g.name }))} />
        </section>
      </div>

      <section className="panel">
        <header>
          <h2>Token per modello</h2>
          <span className="panel-note">
            modello chat: {data.model} · embedding: {data.embeddingModel}
          </span>
        </header>
        {u.byModel.length ? (
          <div className="data-table-wrap">
            <table className="data-table admin-table">
              <thead>
                <tr>
                  <th>Modello</th>
                  <th className="num">Chiamate</th>
                  <th className="num">Token input</th>
                  <th className="num">Token output</th>
                  <th className="num">Prezzo (input / output per 1M)</th>
                  <th className="num">Spesa</th>
                </tr>
              </thead>
              <tbody>
                {u.byModel.map((m) => {
                  const price = Object.entries(data.prices).find(([k]) => m.key === k || m.key.startsWith(`${k}-`))?.[1];
                  return (
                    <tr key={m.key}>
                      <td>{m.key}</td>
                      <td className="num">{num(m.calls)}</td>
                      <td className="num">{num(m.inputTokens)}</td>
                      <td className="num">{num(m.outputTokens)}</td>
                      <td className="num">{price ? `$ ${price.input} / $ ${price.output}` : "non a listino"}</td>
                      <td className="num">{m.unpricedCalls ? "–" : usd(m.costUsd, 4)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="panel-empty">Nessuna chiamata registrata ancora.</p>
        )}
        <p className="admin-footnote">
          La spesa è una stima calcolata con i prezzi di listino OpenAI (in <code>backend/src/services/usageService.js</code>): l'importo
          fatturato è quello indicato nella dashboard di OpenAI.
        </p>
      </section>
    </>
  );
}

/** Colonne della spesa giornaliera (una sola serie: nessuna legenda), con valore al passaggio del mouse. */
function DailyCostChart({ daily }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(...daily.map((d) => d.costUsd), 0);
  const top = max > 0 ? niceMax(max) : 1;
  const ticks = [top, top / 2, 0];
  const dayLabel = (iso) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

  if (max === 0) return <p className="panel-empty">Nessuna spesa negli ultimi 30 giorni.</p>;

  return (
    <div className="cost-chart">
      <div className="cost-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t}>{usd(t, t < 1 ? 2 : 0)}</span>
        ))}
      </div>
      <div className="cost-plot" onMouseLeave={() => setHover(null)}>
        <div className="cost-grid" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <ol className="cost-bars" aria-label="Spesa giornaliera">
          {daily.map((d, i) => (
            <li
              key={d.day}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              tabIndex={0}
              aria-label={`${dayLabel(d.day)}: ${usd(d.costUsd, 4)}, ${num(d.calls)} chiamate`}
            >
              <span className={`bar ${hover === i ? "active" : ""}`} style={{ height: `${(d.costUsd / top) * 100}%` }} />
            </li>
          ))}
        </ol>
        {hover !== null && (
          <div
            className="cost-tooltip"
            style={{
              left: `${((hover + 0.5) / daily.length) * 100}%`,
              // vicino ai bordi il fumetto si allinea verso l'interno per non uscire dal riquadro
              transform: `translate(${hover < 5 ? "-10%" : hover > daily.length - 6 ? "-90%" : "-50%"}, -100%)`,
            }}
          >
            <strong>{usd(daily[hover].costUsd, 4)}</strong>
            <span>
              {formatDate(new Date(daily[hover].day).getTime())} · {num(daily[hover].calls)} chiamate ·{" "}
              {tokens(daily[hover].inputTokens + daily[hover].outputTokens)} token
            </span>
          </div>
        )}
        <div className="cost-x" aria-hidden="true">
          <span>{dayLabel(daily[0].day)}</span>
          <span>{dayLabel(daily[Math.floor(daily.length / 2)].day)}</span>
          <span>oggi</span>
        </div>
      </div>
    </div>
  );
}

/** Massimo "tondo" dell'asse (1, 2 o 5 × 10^n) sopra il valore più alto. */
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/** Barre orizzontali con etichetta e valore: confronto tra poche voci. */
function BreakdownBars({ rows }) {
  if (!rows.length) return <p className="panel-empty">Nessun dato ancora.</p>;
  const max = Math.max(...rows.map((r) => r.costUsd), 1e-9);
  return (
    <ul className="bars breakdown">
      {rows.map((r) => (
        <li key={r.key} title={`${num(r.calls)} chiamate · ${num(r.inputTokens + r.outputTokens)} token`}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span style={{ width: `${(r.costUsd / max) * 100}%` }} />
          </span>
          <span className="bar-value">{usd(r.costUsd, r.costUsd < 1 ? 4 : 2)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Utenti                                                              */
/* ------------------------------------------------------------------ */
function Users({ users, onOpen }) {
  if (!users.length) return <Loading />;
  return (
    <section className="panel">
      <div className="data-table-wrap">
        <table className="data-table admin-table">
          <thead>
            <tr>
              <th>Utente</th>
              <th>Ruolo</th>
              <th className="num">Conversazioni</th>
              <th className="num">Domande</th>
              <th className="num">Ricerche</th>
              <th className="num">Caricamenti</th>
              <th className="num">Token</th>
              <th className="num">Spesa AI</th>
              <th>Ultimo accesso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>
                  <small className="muted"> @{u.username}</small>
                </td>
                <td>{u.isAdmin ? <span className="tag">Admin</span> : u.role}</td>
                <td className="num">{num(u.conversations)}</td>
                <td className="num">{num(u.questions)}</td>
                <td className="num">{num(u.searches)}</td>
                <td className="num">{num(u.uploads)}</td>
                <td className="num">{tokens(u.tokens)}</td>
                <td className="num">{usd(u.costUsd, u.costUsd < 1 ? 4 : 2)}</td>
                <td>{u.lastLoginAt ? relativeTime(u.lastLoginAt) : "mai"}</td>
                <td className="row-actions">
                  <button className="btn ghost small" onClick={() => onOpen({ tab: "attivita", utente: u.id })}>
                    Attività
                  </button>
                  <button className="btn ghost small" onClick={() => onOpen({ tab: "conversazioni", utente: u.id })}>
                    Chat
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UserFilter({ users, userId, onChange }) {
  return (
    <label className="admin-filter">
      <Icon name="users" size={16} />
      <select value={userId} onChange={(e) => onChange(e.target.value)}>
        <option value="">Tutti gli utenti</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Attività                                                            */
/* ------------------------------------------------------------------ */
function activityText(e) {
  switch (e.type) {
    case "chat":
      return e.document ? `${e.text} (su "${e.document}")` : e.text;
    case "search":
      return `"${e.query}" ${e.source === "home" ? "dalla Home" : "nei Documenti"}`;
    case "upload":
      return `${e.title} · ${e.fileName}${e.size ? ` · ${formatSize(e.size)}` : ""}`;
    case "edit":
      return `${e.title}${e.category ? ` → categoria "${e.category}"` : ""}`;
    case "delete":
      return e.title;
    case "login_failed":
      return `nome utente "${e.username}"`;
    default:
      return "";
  }
}

function Activity({ users, userId, onOpen }) {
  const [type, setType] = useState("");
  const [events, setEvents] = useState(null);
  const { handleError } = useChat();

  useEffect(() => {
    setEvents(null);
    getAdminActivity({ userId, type }).then(setEvents).catch(handleError);
  }, [userId, type, handleError]);

  return (
    <>
      <div className="admin-filters">
        <UserFilter users={users} userId={userId} onChange={(id) => onOpen({ tab: "attivita", ...(id && { utente: id }) })} />
        <div className="chip-row">
          {[["", "Tutto"], ["chat", "Domande"], ["search", "Ricerche"], ["upload", "Caricamenti"], ["login", "Accessi"]].map(([id, label]) => (
            <button key={id} className={`chip ${type === id ? "active" : ""}`} onClick={() => setType(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <section className="panel">
        {events === null ? (
          <Loading />
        ) : events.length === 0 ? (
          <p className="panel-empty">Nessuna attività registrata.</p>
        ) : (
          <ul className="activity-list">
            {events.map((e, i) => {
              const meta = ACTIVITY[e.type] ?? { label: e.type, icon: "file" };
              return (
                <li key={`${e.ts}-${i}`} className={`activity-${e.type}`}>
                  <span className="activity-icon">
                    <Icon name={meta.icon} size={15} />
                  </span>
                  <span className="activity-text">
                    <strong>
                      {e.userName} · {meta.label}
                    </strong>
                    {activityText(e) && <span>{activityText(e)}</span>}
                  </span>
                  <span className="activity-when">
                    {dateTime(e.ts)}
                    {e.type === "chat" && e.conversationId && e.userId && (
                      <button
                        className="link-btn"
                        onClick={() => onOpen({ tab: "conversazioni", utente: e.userId, id: e.conversationId })}
                      >
                        Apri chat
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Conversazioni di tutti gli utenti (sola lettura)                    */
/* ------------------------------------------------------------------ */
function Conversations({ users, userId, openId, onOpen }) {
  const [list, setList] = useState(null);
  const [conv, setConv] = useState(null);
  const { handleError } = useChat();

  useEffect(() => {
    setList(null);
    getAdminConversations(userId).then(setList).catch(handleError);
  }, [userId, handleError]);

  const selected = useMemo(() => list?.find((c) => c.id === openId) ?? null, [list, openId]);
  const ownerId = selected?.userId ?? userId;

  const load = useCallback(() => {
    if (!openId || !ownerId) return setConv(null);
    setConv(undefined);
    getAdminConversation(ownerId, openId)
      .then(setConv)
      .catch((err) => {
        handleError(err);
        setConv(null);
      });
  }, [openId, ownerId, handleError]);

  useEffect(load, [load]);

  const select = (c) => onOpen({ tab: "conversazioni", ...(userId && { utente: userId }), id: c.id, ...(!userId && { utente: c.userId }) });

  return (
    <>
      <div className="admin-filters">
        <UserFilter users={users} userId={userId} onChange={(id) => onOpen({ tab: "conversazioni", ...(id && { utente: id }) })} />
      </div>
      <div className="admin-conversations">
        <section className="panel conv-list">
          {list === null ? (
            <Loading />
          ) : list.length === 0 ? (
            <p className="panel-empty">Nessuna conversazione.</p>
          ) : (
            <ul className="mini-list plain">
              {list.map((c) => (
                <li key={`${c.userId}-${c.id}`}>
                  <button className={c.id === openId ? "selected" : ""} onClick={() => select(c)}>
                    <span className="chat-dot">
                      <Icon name="chat" size={15} />
                    </span>
                    <span>
                      <strong>{c.title}</strong>
                      <small>
                        {c.userName} · {Math.ceil(c.messageCount / 2)} {Math.ceil(c.messageCount / 2) === 1 ? "domanda" : "domande"} ·{" "}
                        {relativeTime(c.updatedAt)}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel conv-view">
          {!openId ? (
            <p className="panel-empty">Scegli una conversazione per leggerla.</p>
          ) : conv === undefined ? (
            <Loading />
          ) : !conv ? (
            <p className="panel-empty">Conversazione non trovata.</p>
          ) : (
            <>
              <header>
                <h2>{conv.title}</h2>
                <span className="panel-note">
                  {conv.userName} · {dateTime(conv.createdAt)} · sola lettura
                </span>
              </header>
              <div className="messages admin-messages">
                {conv.messages.map((m) => (
                  <ChatMessage key={m.id} message={m} compact />
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
