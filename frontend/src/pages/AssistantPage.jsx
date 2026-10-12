import ChatView from "../components/ChatView.jsx";
import Icon from "../components/Icon.jsx";
import { useChat } from "../context/ChatContext.jsx";

const DAY = 24 * 60 * 60 * 1000;

/** Raggruppa le conversazioni per data, come nelle app di chat più diffuse. */
function groupByDate(conversations) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups = [
    { label: "Oggi", items: [] },
    { label: "Ieri", items: [] },
    { label: "Ultimi 7 giorni", items: [] },
    { label: "Meno recenti", items: [] },
  ];
  for (const c of conversations) {
    if (c.updatedAt >= startOfToday) groups[0].items.push(c);
    else if (c.updatedAt >= startOfToday - DAY) groups[1].items.push(c);
    else if (c.updatedAt >= startOfToday - 6 * DAY) groups[2].items.push(c);
    else groups[3].items.push(c);
  }
  return groups.filter((g) => g.items.length);
}

/** Assistente a tutta pagina: cronologia a sinistra, conversazione a destra. */
export default function AssistantPage() {
  const { conversations, activeId, openConversation, removeConversation, newChat, pending } = useChat();

  return (
    <div className="assistant-page">
      <aside className="history-panel" aria-label="Cronologia conversazioni">
        <button className="btn primary block" onClick={newChat}>
          <Icon name="plus" size={17} /> Nuova conversazione
        </button>
        <div className="history">
          {conversations.length === 0 && <p className="history-empty">Le tue conversazioni compariranno qui.</p>}
          {groupByDate(conversations).map((g) => (
            <div key={g.label} className="history-group">
              <h4>{g.label}</h4>
              {g.items.map((c) => (
                <div key={c.id} className={`history-item ${c.id === activeId ? "active" : ""}`}>
                  <button className="history-open" onClick={() => openConversation(c.id)} disabled={Boolean(pending)} title={c.title}>
                    {c.title}
                  </button>
                  <button
                    className="history-delete"
                    onClick={() => removeConversation(c.id)}
                    disabled={Boolean(pending)}
                    aria-label={`Elimina: ${c.title}`}
                    title="Elimina conversazione"
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <section className="assistant-main">
        <ChatView />
      </section>
    </div>
  );
}
