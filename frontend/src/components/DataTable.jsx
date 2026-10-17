/**
 * Tabella creata dal data agent con table(): { title, columns: [{key, label, numeric}], rows, totalRows }.
 * I numeri sono allineati a destra in formato italiano.
 */
const fmt = (v, numeric) => {
  if (v === null || v === undefined || v === "") return <span className="null">–</span>;
  if (numeric && typeof v === "number") return v.toLocaleString("it-IT", { maximumFractionDigits: 2 });
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v.split("-").reverse().join("/");
  return String(v);
};

export default function DataTable({ table }) {
  return (
    <figure className="data-chart data-table-block">
      {table.title && (
        <header>
          <strong>{table.title}</strong>
        </header>
      )}
      <div className="result-table-wrap">
        <table className="result-table">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c.key} className={c.numeric ? "num" : ""}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                {table.columns.map((c) => (
                  <td key={c.key} className={c.numeric ? "num" : ""}>
                    {fmt(row[c.key], c.numeric)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.totalRows > table.rows.length && (
        <figcaption>
          <span>
            Prime {table.rows.length} righe di {table.totalRows.toLocaleString("it-IT")}
          </span>
        </figcaption>
      )}
    </figure>
  );
}
