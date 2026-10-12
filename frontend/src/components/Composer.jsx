import { useEffect, useRef, useState } from "react";

export default function Composer({ onSend, disabled, placeholder, compact = false }) {
  const [text, setText] = useState("");
  const ref = useRef(null);

  // la textarea cresce con il testo fino a un massimo
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [text]);

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  const submit = (e) => {
    e?.preventDefault();
    if (!text.trim() || disabled) return;
    onSend(text);
    setText("");
  };

  return (
    <form className={`composer ${compact ? "compact" : ""}`} onSubmit={submit}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder ?? "Chiedi di un documento, di una regola o di un'analisi sui dati…"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
        }}
        maxLength={4000}
      />
      <button type="submit" disabled={disabled || !text.trim()} aria-label="Invia">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
      {!compact && <p className="composer-hint">Invio per inviare · Shift+Invio per andare a capo</p>}
    </form>
  );
}
