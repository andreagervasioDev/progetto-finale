import { useEffect, useState } from "react";

export default function ChartGallery({ charts }) {
  const [zoomed, setZoomed] = useState(null);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e) => e.key === "Escape" && setZoomed(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  return (
    <>
      <div className={`charts ${charts.length > 1 ? "multi" : ""}`}>
        {charts.map((c) => (
          <figure key={c.filename}>
            <button className="chart-btn" onClick={() => setZoomed(c)} aria-label={`Ingrandisci: ${c.title}`}>
              <img src={c.url} alt={c.title} loading="lazy" />
            </button>
            <figcaption>
              <span>{c.title}</span>
              <a href={c.url} download={c.filename}>
                Scarica PNG
              </a>
            </figcaption>
          </figure>
        ))}
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
