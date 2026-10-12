// icona e colore di ogni categoria dell'archivio (le etichette arrivano dal backend)
export const CATEGORY_META = {
  contratti: { icon: "contract", color: "#16774a" },
  sponsor: { icon: "handshake", color: "#d9570a" },
  medico: { icon: "medical", color: "#c93c4b" },
  mercato: { icon: "transfer", color: "#2b6cb0" },
  prestazioni: { icon: "chart", color: "#7b5ea7" },
  regolamenti: { icon: "book", color: "#0b4d2c" },
  dati: { icon: "table", color: "#b7791f" },
  altro: { icon: "folder", color: "#6b7a72" },
};

export const categoryMeta = (id) => CATEGORY_META[id] ?? CATEGORY_META.altro;

export const formatEuro = (n) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString("it-IT", { maximumFractionDigits: 2 })} M€`
    : `${n.toLocaleString("it-IT")} €`;

export const formatIsoDate = (iso) => iso.split("-").reverse().join("/");
