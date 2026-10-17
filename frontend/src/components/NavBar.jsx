import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { listDocuments } from "../api.js";
import Icon from "./Icon.jsx";

const LINKS = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/documenti", label: "Documenti", icon: "docs" },
  { to: "/assistente", label: "Assistente AI", icon: "chat" },
  { to: "/dati", label: "Dati", icon: "data" },
];

/** Menu di navigazione principale (a sinistra; a scomparsa su mobile). */
const initials = (name) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");

export default function NavBar({ open, onClose, user, onLogout }) {
  const { pathname } = useLocation();
  const [docCount, setDocCount] = useState(null);

  // numero di documenti accanto a "Documenti", aggiornato a ogni cambio pagina (dopo caricamenti o eliminazioni)
  useEffect(() => {
    listDocuments()
      .then((docs) => setDocCount(docs.length))
      .catch(() => setDocCount(null));
  }, [pathname]);

  return (
    <>
      <div className={`backdrop ${open ? "show" : ""}`} onClick={onClose} />
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand">
          <img className="brand-logo" src="/logo-icon.png" alt="" width="56" height="56" />
          <div>
            <strong>Management AI</strong>
            <span>Gestione del club</span>
          </div>
        </div>

        <nav className="main-nav" aria-label="Navigazione principale">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className="nav-link" onClick={onClose}>
              <Icon name={l.icon} size={19} />
              {l.label}
              {l.to === "/documenti" && docCount ? <span className="nav-count">{docCount}</span> : null}
            </NavLink>
          ))}
          {user.isAdmin && (
            <NavLink to="/admin" className="nav-link" onClick={onClose}>
              <Icon name="shield" size={19} />
              Amministrazione
            </NavLink>
          )}
        </nav>

        <div className="nav-spacer" />

        <div className="nav-account">
          <span className="nav-avatar" aria-hidden="true">
            {initials(user.name)}
          </span>
          <span className="nav-account-text">
            <strong title={user.name}>{user.name}</strong>
            <small>{user.isAdmin ? "Amministratore" : user.role}</small>
          </span>
          <button className="nav-logout" onClick={onLogout} title="Esci" aria-label="Esci">
            <Icon name="logout" size={17} />
          </button>
        </div>
      </aside>
    </>
  );
}
