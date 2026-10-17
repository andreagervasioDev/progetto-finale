import { useEffect, useState } from "react";

/**
 * Grafici come immagini PNG: per le conversazioni salvate prima dei grafici React e per i grafici
 * che il data agent disegna a mano con matplotlib (save_chart). Se il file non c'è più, lo dice.
 */
export default function ChartGallery({ charts }) {
  const [zoomed, setZoomed] = useState(null);
  const [missing, setMissing] = useState(() => new Set());

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e) => e.key === "Escape" && setZoomed(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  return (
    <>
      <div className={`charts ${charts.length > 1 ? "multi" : ""}`}>
        {charts.map((c) =>
          missing.has(c.filename) ? (
            <figure key={c.filename} className="chart-missing">
              <p>Grafico non più disponibile: rifai la domanda per generarlo di nuovo.</p>
              <figcaption>
                <span>{c.title}</span>
              </figcaption>
            </figure>
          ) : (
            <figure key={c.filename}>
              <button className="chart-btn" onClick={() => setZoomed(c)} aria-label={`Ingrandisci: ${c.title}`}>
                <img
                  src={c.url}
                  alt={c.title}
                  loading="lazy"
                  onError={() => setMissing((s) => new Set(s).add(c.filename))}
                />
              </button>
              <figcaption>
                <span>{c.title}</span>
                <a href={c.url} download={c.filename}>
                  Scarica PNG
                </a>
              </figcaption>
            </figure>
          ),
        )}
      </div>
      {zoomed && (
        <div className="lightbox" onClick={() => setZoomed(null)} role="dialog" aria-label={zoomed.title}>
          <img src={zoomed.url} alt={zoomed.title} />
          <p>{zoomed.title} · clicca o premi Esc per chiudere</p>
        </div>
      )}
    </>
  );
}
