import { useState } from "react";
import { login } from "../api.js";
import BallLoader from "../components/BallLoader.jsx";
import Icon from "../components/Icon.jsx";

/** Accesso con nome utente e password. */
export default function LoginPage({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      onLogin(await login(username.trim(), password));
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login-side" aria-hidden="true">
        <img src="/logo-icon.png" alt="" width="132" height="132" />
        <h1>Management AI</h1>
        <p>L'assistente AI per la gestione del club: documenti, contratti, area medica e analisi dei dati in un solo posto.</p>
      </section>

      <section className="login-main">
        <form className="login-card" onSubmit={submit}>
          <img className="login-logo" src="/logo-icon.png" alt="" width="64" height="64" />
          <h2>Accedi</h2>
          <p className="login-sub">Inserisci le tue credenziali per entrare nella piattaforma.</p>

          <label className="field">
            Nome utente
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck="false"
              autoFocus
              required
            />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {error && (
            <p className="form-error" role="alert">
              <Icon name="alert" size={15} /> {error}
            </p>
          )}

          <button className="btn primary login-submit" type="submit" disabled={busy}>
            {busy ? <BallLoader size={18} inline label="Accesso in corso…" /> : "Entra"}
          </button>
        </form>
      </section>
    </div>
  );
}
