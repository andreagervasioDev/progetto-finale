import { useEffect, useRef } from "react";
import { useChat } from "../context/ChatContext.jsx";
import BallLoader from "./BallLoader.jsx";
import ChatMessage from "./ChatMessage.jsx";
import Composer from "./Composer.jsx";
import EmptyState from "./EmptyState.jsx";
import Icon from "./Icon.jsx";
import TypingIndicator from "./TypingIndicator.jsx";

/**
 * Conversazione (messaggi + campo di testo). Usata sia a tutta pagina sia nel pannello laterale (compact).
 */
export default function ChatView({ compact = false }) {
  const { messages, pending, loadingConversation, send, user, openDocument, useDocument, setUseDocument } = useChat();
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  const docActive = openDocument && useDocument;
  const isDataset = openDocument?.kind === "dataset";

  return (
    <div className={`chat-view ${compact ? "compact" : ""}`}>
      <section className="messages" aria-live="polite">
        {loadingConversation ? (
          <div className="loading-conv">
            <BallLoader size={44} label="Carico la conversazione…" />
          </div>
        ) : messages.length === 0 && !pending ? (
          <EmptyState onAsk={send} userName={user.name} compact={compact} document={docActive ? openDocument : null} />
        ) : (
          messages.map((m) => <ChatMessage key={m.id} message={m} compact={compact} />)
        )}
        {pending && <TypingIndicator pending={pending} />}
        <div ref={bottomRef} />
      </section>

      {openDocument && (
        <div className={`doc-context ${docActive ? "on" : ""}`}>
          <Icon name={isDataset ? "table" : "file"} size={15} />
          <span>
            {docActive ? (isDataset ? "Analisi su: " : "Domande su: ") : isDataset ? "Dati aperti: " : "Documento aperto: "}
            <strong>{openDocument.title}</strong>
          </span>
          <button onClick={() => setUseDocument(!useDocument)}>
            {docActive ? (isDataset ? "Domande generali" : "Cerca in tutti i documenti") : isDataset ? "Usa questi dati" : "Usa questo documento"}
          </button>
        </div>
      )}

      <Composer
        onSend={send}
        disabled={Boolean(pending) || loadingConversation}
        placeholder={docActive ? (isDataset ? "Chiedi un'analisi su questi dati…" : "Chiedi qualcosa su questo documento…") : undefined}
        compact={compact}
      />
    </div>
  );
}
