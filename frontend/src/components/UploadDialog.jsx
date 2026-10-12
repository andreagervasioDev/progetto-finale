import { useEffect, useRef, useState } from "react";
import { getCategories, suggestCategory, uploadDocument } from "../api.js";
import { categoryMeta } from "../categoryMeta.js";
import { ACCEPTED_EXT, MAX_SIZE_MB, formatSize } from "../format.js";
import BallLoader from "./BallLoader.jsx";
import Icon from "./Icon.jsx";

const extOf = (name) => name.slice(name.lastIndexOf(".")).toLowerCase();
const baseName = (name) => (name.slice(0, name.lastIndexOf(".")) || name).replace(/[_-]+/g, " ").trim();
const TABULAR = [".csv", ".xlsx", ".xls"];

/**
 * Finestra di caricamento: scelta del file, poi l'AI propone categoria e titolo (modificabili),
 * infine invio ed elaborazione (indicizzazione per i testi, data agent per Excel/CSV).
 */
export default function UploadDialog({ initialFile, initialCategory, onClose, onUploaded }) {
  const [categories, setCategories] = useState([]);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(initialCategory ?? "");
  const [suggestion, setSuggestion] = useState(null); // null | "loading" | { ai: boolean }
  const [progress, setProgress] = useState(null); // null | 0..1 | "processing"
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const picked = useRef(0); // per ignorare proposte arrivate per un file già sostituito

  useEffect(() => {
    getCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && progress === null && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, progress]);

  const pick = async (f) => {
    setError("");
    if (!f) return;
    const ext = extOf(f.name);
    if (!ACCEPTED_EXT.includes(ext)) return setError("Formato non supportato: carica PDF, Word (.docx), TXT, Markdown, Excel o CSV.");
    if (f.size > MAX_SIZE_MB * 1024 * 1024) return setError(`File troppo grande (massimo ${MAX_SIZE_MB} MB).`);
    setFile(f);
    setTitle(baseName(f.name));
    if (TABULAR.includes(ext)) {
      setCategory("dati");
      setSuggestion(null);
      return;
    }
    // l'AI legge l'inizio del documento e propone categoria e titolo
    const ticket = ++picked.current;
    setSuggestion("loading");
    try {
      const s = await suggestCategory(f);
      if (ticket !== picked.current) return;
      setCategory(s.category);
      if (s.title) setTitle(s.title);
      setSuggestion({ ai: s.ai });
    } catch {
      if (ticket === picked.current) setSuggestion({ ai: false });
    }
  };

  useEffect(() => {
    if (initialFile) pick(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return setError("Scegli un file da caricare.");
    if (!category) return setError("Scegli una categoria.");
    setError("");
    setProgress(0);
    try {
      const doc = await uploadDocument({
        file,
        title: title.trim(),
        category,
        onProgress: (p) => setProgress(p >= 1 ? "processing" : p),
      });
      onUploaded(doc);
    } catch (err) {
      setError(err.message);
      setProgress(null);
    }
  };

  const busy = progress !== null;
  const tabular = file && TABULAR.includes(extOf(file.name));
  const textCategories = categories.filter((c) => !c.tabular);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal" onSubmit={submit} role="dialog" aria-labelledby="upload-title">
        <header className="modal-header">
          <h2 id="upload-title">Carica un documento</h2>
          <button type="button" className="icon-only" onClick={onClose} disabled={busy} aria-label="Chiudi">
            <Icon name="close" />
          </button>
        </header>

        <button
          type="button"
          className={`file-picker ${file ? "has-file" : ""}`}
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          <Icon name={file ? "file" : "upload"} size={26} />
          {file ? (
            <span>
              <strong>{file.name}</strong>
              <small>{formatSize(file.size)} · clicca per cambiare file</small>
            </span>
          ) : (
            <span>
              <strong>Scegli un file dal computer</strong>
              <small>PDF, Word, TXT, Markdown, Excel o CSV · massimo {MAX_SIZE_MB} MB</small>
            </span>
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXT.join(",")}
          hidden
          onChange={(e) => pick(e.target.files?.[0])}
        />

        {file && (
          <>
            <label className="field">
              Categoria
              {tabular ? (
                <div className="fixed-category">
                  <Icon name="table" size={17} />
                  <span>
                    <strong>Dati (Excel / CSV)</strong>
                    <small>Il file verrà pulito e sarà analizzabile dal data agent, con grafici.</small>
                  </span>
                </div>
              ) : suggestion === "loading" ? (
                <div className="suggesting">
                  <BallLoader size={20} inline label="L'AI sta leggendo il documento per proporre la categoria…" />
                </div>
              ) : (
                <>
                  <div className="category-grid" role="radiogroup">
                    {textCategories.map((c) => (
                      <button
                        type="button"
                        key={c.id}
                        role="radio"
                        aria-checked={category === c.id}
                        className={category === c.id ? "selected" : ""}
                        style={{ "--cat": categoryMeta(c.id).color }}
                        onClick={() => setCategory(c.id)}
                        disabled={busy}
                      >
                        <Icon name={categoryMeta(c.id).icon} size={16} />
                        {c.label}
                      </button>
                    ))}
                  </div>
                  {suggestion?.ai && <small className="ai-note">Categoria e titolo proposti dall'AI: puoi cambiarli.</small>}
                </>
              )}
            </label>

            <label className="field">
              Titolo
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                placeholder="Es. Contratto Victor Okafor 2025-2028"
                disabled={busy}
              />
            </label>
          </>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {busy && (
          <div className="upload-progress">
            {progress === "processing" ? (
              <BallLoader
                size={26}
                inline
                label={tabular ? "Leggo e pulisco i dati…" : "Leggo il documento, lo indicizzo ed estraggo i dati chiave…"}
              />
            ) : (
              <>
                <div className="bar">
                  <span style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <small>Caricamento {Math.round(progress * 100)}%</small>
              </>
            )}
          </div>
        )}

        <footer className="modal-footer">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Annulla
          </button>
          <button type="submit" className="btn primary" disabled={busy || !file || !category || suggestion === "loading"}>
            <Icon name="upload" size={17} /> Carica
          </button>
        </footer>
      </form>
    </div>
  );
}
