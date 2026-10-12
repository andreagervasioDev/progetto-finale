import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useChat } from "../context/ChatContext.jsx";
import ChatView from "./ChatView.jsx";
import Icon from "./Icon.jsx";

/** Assistente AI nel pannello laterale destro, apribile da qualsiasi pagina. */
export default function ChatDrawer() {
  const { drawerOpen, setDrawerOpen, newChat, pending } = useChat();
  const navigate = useNavigate();

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, setDrawerOpen]);

  if (!drawerOpen) return null;

  return (
    <aside className="drawer" aria-label="Assistente AI">
      <header className="drawer-header">
        <img src="/logo-icon.png" alt="" width="30" height="30" />
        <strong>Assistente AI</strong>
        <div className="drawer-actions">
          <button onClick={newChat} disabled={Boolean(pending)} title="Nuova conversazione" aria-label="Nuova conversazione">
            <Icon name="plus" />
          </button>
          <button
            onClick={() => {
              setDrawerOpen(false);
              navigate("/assistente");
            }}
            title="Apri a tutta pagina"
            aria-label="Apri a tutta pagina"
          >
            <Icon name="expand" />
          </button>
          <button onClick={() => setDrawerOpen(false)} title="Chiudi (Esc)" aria-label="Chiudi">
            <Icon name="close" />
          </button>
        </div>
      </header>
      <ChatView compact />
    </aside>
  );
}
