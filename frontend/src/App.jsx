import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getMe } from "./api.js";
import AiFab from "./components/AiFab.jsx";
import ChatDrawer from "./components/ChatDrawer.jsx";
import Icon from "./components/Icon.jsx";
import NavBar from "./components/NavBar.jsx";
import { ChatProvider, useChat } from "./context/ChatContext.jsx";
import AssistantPage from "./pages/AssistantPage.jsx";
import DataPage from "./pages/DataPage.jsx";
import DocumentViewerPage from "./pages/DocumentViewerPage.jsx";
import DocumentsPage from "./pages/DocumentsPage.jsx";
import HomePage from "./pages/HomePage.jsx";

/** Radice dell'app: carica il profilo e mostra l'area di lavoro (nessun login). */
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = caricamento, null = backend non raggiungibile
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    getMe()
      .then(setUser)
      .catch(() => setUser(null));
  }, [attempt]);

  // il pallone iniziale è in index.html (compare prima del codice React): lo togliamo quando l'app è pronta
  const ready = user !== undefined;
  useEffect(() => {
    if (!ready) return;
    const boot = document.getElementById("boot");
    if (!boot) return;
    boot.classList.add("hide");
    const t = setTimeout(() => boot.remove(), 300);
    return () => clearTimeout(t);
  }, [ready]);

  if (!ready) return null;
  if (!user)
    return (
      <div className="splash">
        <div className="offline">
          <img src="/logo-icon.png" alt="" width="72" height="72" />
          <h2>Backend non raggiungibile</h2>
          <p>Avvia i servizi con <code>npm run dev</code> dalla cartella del progetto, poi riprova.</p>
          <button
            className="btn primary"
            onClick={() => {
              setUser(undefined);
              setAttempt((a) => a + 1);
            }}
          >
            Riprova
          </button>
        </div>
      </div>
    );
  return (
    <ChatProvider key={user.id} user={user}>
      <Shell />
    </ChatProvider>
  );
}

const TITLES = { "/": "Home", "/documenti": "Documenti", "/assistente": "Assistente AI", "/dati": "Dati" };

/** Struttura: menu a sinistra, pagina al centro, assistente nel pannello a destra. */
function Shell() {
  const { user, drawerOpen } = useChat();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const onAssistant = location.pathname.startsWith("/assistente");
  const title = TITLES[location.pathname] ?? (location.pathname.startsWith("/documenti") ? "Documento" : "");

  return (
    <div className={`shell ${drawerOpen && !onAssistant ? "with-drawer" : ""}`}>
      <NavBar user={user} open={navOpen} onClose={() => setNavOpen(false)} />

      <main className="content">
        <header className="mobile-bar">
          <button className="icon-only" onClick={() => setNavOpen(true)} aria-label="Apri menu">
            <Icon name="menu" size={20} />
          </button>
          <img src="/logo-icon.png" alt="" width="30" height="30" />
          <strong>{title}</strong>
        </header>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/documenti" element={<DocumentsPage />} />
          <Route path="/documenti/:id" element={<DocumentViewerPage />} />
          <Route path="/assistente" element={<AssistantPage />} />
          <Route path="/dati" element={<DataPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* sulla pagina Assistente la chat è già a tutta pagina: niente pannello né pulsante flottante */}
      {!onAssistant && <ChatDrawer />}
      {!onAssistant && <AiFab />}
    </div>
  );
}
