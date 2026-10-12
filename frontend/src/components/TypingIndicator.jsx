import BallLoader from "./BallLoader.jsx";
import Icon from "./Icon.jsx";
import { toolMeta } from "./toolMeta.js";

/** Indicatore di "sta scrivendo" con lo stato live dell'agente (ragiona, consulta la KB, esegue codice). */
export default function TypingIndicator({ pending }) {
  return (
    <div className="msg assistant">
      <div className="avatar" aria-hidden="true">
        <img src="/logo-icon.png" alt="" />
      </div>
      <div className="bubble typing">
        <div className="typing-row">
          <BallLoader size={24} inline />
          <span className="typing-label">
            {pending.label}…
          </span>
        </div>
        {pending.steps.length > 0 && (
          <ul className="typing-steps">
            {pending.steps.map((s, i) => (
              <li key={i} className={s.ok ? "" : "failed"}>
                <Icon name={s.ok ? "check" : "alert"} size={14} />
                {toolMeta(s.tool).label} {s.ok ? "completato" : "non riuscito"} in {(s.ms / 1000).toFixed(1)}s
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
