import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import Icon from "./Icon.jsx";
import UploadDialog from "./UploadDialog.jsx";

const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
// la finestra di caricamento gestisce da sola i file trascinati sopra di lei
const insideDialog = (e) => Boolean(e.target?.closest?.(".modal-backdrop"));

/**
 * Trascinamento di file da Finder / Esplora risorse in qualsiasi pagina: compare un riquadro
 * "Rilascia per caricare" e, al rilascio, si apre la finestra di caricamento con il file già scelto.
 * Nella pagina Documenti la categoria aperta viene proposta come predefinita.
 */
export default function FileDropUpload() {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState(null);
  const depth = useRef(0); // dragenter/dragleave scattano anche entrando e uscendo dagli elementi interni
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const category = pathname === "/documenti" ? params.get("categoria") ?? undefined : undefined;

  useEffect(() => {
    const onEnter = (e) => {
      if (!hasFiles(e) || insideDialog(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (e) => {
      // senza preventDefault il browser aprirebbe il file al posto dell'app
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (insideDialog(e)) return;
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) setFile(dropped);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <>
      {dragging && !file && (
        <div className="drop-overlay">
          <Icon name="upload" size={40} />
          <strong>Rilascia il file per caricarlo</strong>
          <span>PDF, Word, TXT, Markdown, Excel o CSV</span>
        </div>
      )}
      {file && (
        <UploadDialog
          initialFile={file}
          initialCategory={category}
          onClose={() => setFile(null)}
          onUploaded={(doc) => {
            setFile(null);
            navigate(`/documenti/${doc.id}`);
          }}
        />
      )}
    </>
  );
}
