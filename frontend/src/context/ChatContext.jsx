/**
 * Stato condiviso della chat: lo usano sia la pagina "Assistente" (a tutta pagina) sia il pannello
 * laterale apribile da ogni pagina. Così la conversazione è una sola e "espandi" cambia solo la vista.
 *
 * Gestisce anche il "documento aperto": quando l'utente legge un documento, le domande possono
 * essere limitate a quel file.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { deleteConversation, getConversation, listConversations, sendMessageStream } from "../api.js";

const ChatContext = createContext(null);

// il browser ricorda solo quale conversazione era aperta (per utente); i messaggi sono salvati dal backend
const activeKey = (userId) => `managementai-active-conversation:${userId}`;

function readActive(userId) {
  try {
    return localStorage.getItem(activeKey(userId));
  } catch {
    return null;
  }
}

function writeActive(userId, id) {
  try {
    if (id) localStorage.setItem(activeKey(userId), id);
    else localStorage.removeItem(activeKey(userId));
  } catch {
    /* storage non disponibile: nessun problema */
  }
}

export function ChatProvider({ user, children }) {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [pending, setPending] = useState(null); // { label, tool, steps } mentre l'agente lavora
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // documento che l'utente sta leggendo (impostato dal lettore) e se usarlo come contesto delle domande
  const [openDocument, setOpenDocument] = useState(null);
  const [useDocument, setUseDocument] = useState(true);
  const abortRef = useRef(null);

  // errori di rete/backend: le pagine mostrano il proprio stato vuoto, qui li registro in console
  const handleError = useCallback((err) => {
    console.error(err);
  }, []);

  const refreshConversations = useCallback(() => {
    listConversations().then(setConversations).catch(handleError);
  }, [handleError]);

  const openConversation = useCallback(
    async (id) => {
      abortRef.current?.abort();
      setPending(null);
      setLoadingConversation(true);
      try {
        const conv = await getConversation(id);
        setActiveId(conv?.id ?? null);
        setMessages(conv?.messages ?? []);
        writeActive(user.id, conv?.id ?? null);
      } catch (err) {
        handleError(err);
      } finally {
        setLoadingConversation(false);
      }
    },
    [user.id, handleError],
  );

  // all'avvio: carica la cronologia e riapre l'ultima conversazione
  useEffect(() => {
    refreshConversations();
    const last = readActive(user.id);
    if (last) openConversation(last);
  }, [refreshConversations, openConversation, user.id]);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setActiveId(null);
    setMessages([]);
    setPending(null);
    writeActive(user.id, null);
  }, [user.id]);

  const send = useCallback(
    async (text, { fresh = false } = {}) => {
      if (!text.trim() || pending) return;
      // l'id della conversazione nasce nel browser, così la chat compare subito in cronologia
      const conversationId = (!fresh && activeId) || crypto.randomUUID();
      if (conversationId !== activeId) {
        setActiveId(conversationId);
        writeActive(user.id, conversationId);
      }
      const document = openDocument && useDocument ? openDocument : null;
      const userMsg = {
        id: crypto.randomUUID(),
        role: "user",
        content: text.trim(),
        createdAt: Date.now(),
        ...(document && { document }),
      };
      setMessages((m) => (fresh ? [userMsg] : [...m, userMsg]));
      setPending({ label: "Invio la richiesta", steps: [] });

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await sendMessageStream({
          message: userMsg.content,
          sessionId: conversationId,
          docId: document?.id,
          signal: controller.signal,
          onEvent: (event, data) => {
            if (event === "status") setPending((p) => p && { ...p, label: data.label, tool: data.tool });
            if (event === "tool_result") setPending((p) => p && { ...p, steps: [...p.steps, data.entry] });
          },
        });
        setMessages((m) => [...m, result.message]);
        refreshConversations();
      } catch (err) {
        if (err.name === "AbortError") return;
        setMessages((m) => [
          ...m,
          { id: crypto.randomUUID(), role: "assistant", error: true, content: err.message, createdAt: Date.now() },
        ]);
      } finally {
        setPending(null);
        abortRef.current = null;
      }
    },
    [pending, activeId, openDocument, useDocument, refreshConversations, user.id],
  );

  const removeConversation = useCallback(
    async (id) => {
      if (!window.confirm("Eliminare definitivamente questa conversazione?")) return;
      try {
        await deleteConversation(id);
      } catch (err) {
        return handleError(err);
      }
      if (id === activeId) newChat();
      refreshConversations();
    },
    [activeId, newChat, refreshConversations, handleError],
  );

  /** Apre il pannello laterale; opzionalmente con una domanda già inviata o in una nuova chat. */
  const openDrawer = useCallback(
    ({ question, fresh = false } = {}) => {
      setDrawerOpen(true);
      if (question) send(question, { fresh });
      else if (fresh) newChat();
    },
    [newChat, send],
  );

  /** Il lettore di documenti registra il documento aperto (e lo rimuove quando si esce). */
  const setReadingDocument = useCallback((doc) => {
    // kind: "document" (domande sul testo) oppure "dataset" (analisi con il data agent)
    setOpenDocument(doc ? { id: doc.id, title: doc.title, kind: doc.kind ?? (doc.tabular ? "dataset" : "document") } : null);
    setUseDocument(true);
  }, []);

  const value = {
    user,
    conversations,
    activeId,
    messages,
    pending,
    loadingConversation,
    drawerOpen,
    openDocument,
    useDocument,
    setUseDocument,
    setReadingDocument,
    setDrawerOpen,
    openDrawer,
    send,
    newChat,
    openConversation,
    removeConversation,
    handleError,
  };
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat va usato dentro ChatProvider");
  return ctx;
}
