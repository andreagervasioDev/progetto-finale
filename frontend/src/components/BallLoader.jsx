/**
 * Indicatore di caricamento: un pallone da calcio che rimbalza ruotando, con la sua ombra.
 * size = diametro del pallone in px; label = testo opzionale accanto o sotto.
 */
export default function BallLoader({ size = 40, label, inline = false }) {
  return (
    <span className={`ball-loader ${inline ? "inline" : ""}`} role="status" style={{ "--ball": `${size}px` }}>
      <span className="ball-loader-track" aria-hidden="true">
        <img className="ball-loader-ball" src="/favicon.svg" alt="" width={size} height={size} />
        <span className="ball-loader-shadow" />
      </span>
      {label ? <span className="ball-loader-label">{label}</span> : <span className="sr-only">Caricamento…</span>}
    </span>
  );
}
