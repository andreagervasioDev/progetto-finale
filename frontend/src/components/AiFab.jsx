import { useChat } from "../context/ChatContext.jsx";
import Icon from "./Icon.jsx";

/** Pulsante flottante in basso a destra che apre l'assistente nel pannello laterale. */
export default function AiFab() {
  const { drawerOpen, setDrawerOpen, openDocument } = useChat();
  if (drawerOpen) return null;
  return (
    <button className="ai-fab" onClick={() => setDrawerOpen(true)} aria-label="Apri l'assistente AI">
      <Icon name="sparkles" size={20} />
      <span>
        {!openDocument ? "Chiedi all'AI" : openDocument.kind === "dataset" ? "Chiedi un'analisi su questi dati" : "Chiedi all'AI su questo documento"}
      </span>
    </button>
  );
}
