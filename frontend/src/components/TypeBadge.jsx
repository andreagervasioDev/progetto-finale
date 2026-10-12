/** Etichetta colorata con il tipo di file (PDF, Word, Excel, ...). */
const KEYS = { PDF: "pdf", Word: "word", Markdown: "md", Testo: "txt", CSV: "csv", Excel: "xlsx" };
const SHORT = { Markdown: "MD", Testo: "TXT", Excel: "XLS" };

export default function TypeBadge({ type, large = false }) {
  return <span className={`type-badge ${KEYS[type] ?? "txt"} ${large ? "large" : ""}`}>{SHORT[type] ?? type}</span>;
}
