import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Icon from "./Icon.jsx";

/*
 * Grafico di un'analisi, disegnato in React dalla specifica JSON del data agent
 * ({ type, title, xLabel, yLabel, series: [{key, label, color}], data: [{x, s0, s1...}] }).
 * Palette fissa e validata (vedi data_agent/charts.py): il colore segue la serie.
 * Ogni grafico ha anche la vista a tabella e il PNG generato con matplotlib da scaricare.
 */

// niente animazioni: in una chat il grafico deve comparire subito e restare fermo (anche al ridimensionamento)
const AXIS = { fontSize: 12, fill: "var(--text-2)" };
const GRID = "var(--border)";

const fmt = (v) =>
  typeof v === "number" ? v.toLocaleString("it-IT", { maximumFractionDigits: Math.abs(v) < 10 ? 2 : 1 }) : v ?? "–";

/** Suggerimento al passaggio del mouse, nello stile dell'app (testo con colori del testo, non della serie). */
function ChartTooltip({ active, payload, label, spec }) {
  if (!active || !payload?.length) return null;
  const x = spec.type === "scatter" ? payload[0]?.payload?.x : label;
  return (
    <div className="chart-tooltip">
      <strong>
        {spec.xLabel}: {fmt(x)}
      </strong>
      {payload
        .filter((p) => p.dataKey !== "x")
        .map((p) => (
          <span key={p.dataKey}>
            <i style={{ background: p.color ?? p.fill }} />
            {p.name}: <b>{fmt(p.value)}</b>
          </span>
        ))}
    </div>
  );
}

/** Larghezza dell'asse delle categorie nelle barre orizzontali, in base all'etichetta più lunga. */
const categoryWidth = (data) => Math.min(170, Math.max(60, ...data.map((d) => String(d.x).length * 7 + 12)));

function ChartBody({ spec }) {
  const multi = spec.series.length > 1;
  const legend = multi ? <Legend verticalAlign="top" height={30} iconType="circle" wrapperStyle={{ fontSize: 12.5 }} /> : null;
  const tooltip = <Tooltip content={<ChartTooltip spec={spec} />} cursor={{ fill: "var(--surface-2)", stroke: GRID }} />;
  const yAxisLabel = spec.yLabel ? { value: spec.yLabel, angle: -90, position: "insideLeft", style: AXIS, offset: 4 } : undefined;
  const margin = { top: 6, right: 12, bottom: 4, left: 4 };

  if (spec.type === "barh") {
    return (
      <BarChart data={spec.data} layout="vertical" margin={margin} barGap={2} barCategoryGap="22%">
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={AXIS} tickFormatter={fmt} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="x" tick={AXIS} width={categoryWidth(spec.data)} axisLine={{ stroke: GRID }} tickLine={false} />
        {tooltip}
        {legend}
        {spec.series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[0, 4, 4, 0]} maxBarSize={26} isAnimationActive={false} />
        ))}
      </BarChart>
    );
  }
  if (spec.type === "line") {
    return (
      <LineChart data={spec.data} margin={margin}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="x" tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} minTickGap={16} />
        <YAxis tick={AXIS} tickFormatter={fmt} axisLine={false} tickLine={false} width={56} label={yAxisLabel} />
        <Tooltip content={<ChartTooltip spec={spec} />} cursor={{ stroke: "var(--text-3)", strokeDasharray: "3 3" }} />
        {legend}
        {spec.series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stroke={s.color}
            strokeWidth={2}
            dot={spec.data.length <= 24 ? { r: 3, strokeWidth: 0, fill: s.color } : false}
            activeDot={{ r: 5, stroke: "#fff", strokeWidth: 2 }}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  }
  if (spec.type === "scatter") {
    return (
      <ScatterChart margin={margin}>
        <CartesianGrid stroke={GRID} />
        <XAxis type="number" dataKey="x" name={spec.xLabel} tick={AXIS} tickFormatter={fmt} axisLine={{ stroke: GRID }} tickLine={false} />
        <YAxis type="number" tick={AXIS} tickFormatter={fmt} axisLine={false} tickLine={false} width={56} label={yAxisLabel} />
        {tooltip}
        {legend}
        {spec.series.map((s) => (
          <Scatter key={s.key} data={spec.data} dataKey={s.key} name={s.label} fill={s.color} stroke="#fff" strokeWidth={1.5} isAnimationActive={false} />
        ))}
      </ScatterChart>
    );
  }
  // barre verticali
  return (
    <BarChart data={spec.data} margin={margin} barGap={2} barCategoryGap="22%">
      <CartesianGrid vertical={false} stroke={GRID} />
      <XAxis dataKey="x" tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
      <YAxis tick={AXIS} tickFormatter={fmt} axisLine={false} tickLine={false} width={56} label={yAxisLabel} />
      {tooltip}
      {legend}
      {spec.series.map((s) => (
        <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={false} />
      ))}
    </BarChart>
  );
}

/** Gli stessi dati del grafico, in tabella (accessibilità: i valori non dipendono dal colore). */
function ChartTable({ spec }) {
  return (
    <div className="result-table-wrap">
      <table className="result-table">
        <thead>
          <tr>
            <th>{spec.xLabel}</th>
            {spec.series.map((s) => (
              <th key={s.key} className="num">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.data.map((row, i) => (
            <tr key={i}>
              <td>{fmt(row.x)}</td>
              {spec.series.map((s) => (
                <td key={s.key} className="num">
                  {fmt(row[s.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DataChart({ chart }) {
  const [view, setView] = useState("chart");
  const { spec } = chart;
  const height = spec.type === "barh" ? Math.max(220, spec.data.length * 30 + 60) : 300;

  return (
    <figure className="data-chart">
      <header>
        <strong>{spec.title || chart.title}</strong>
        <div className="tabs small" role="tablist" aria-label="Vista">
          <button role="tab" aria-selected={view === "chart"} className={view === "chart" ? "active" : ""} onClick={() => setView("chart")}>
            Grafico
          </button>
          <button role="tab" aria-selected={view === "table"} className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
            Tabella
          </button>
        </div>
      </header>
      {view === "chart" ? (
        <div className="data-chart-plot" style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <ChartBody spec={spec} />
          </ResponsiveContainer>
        </div>
      ) : (
        <ChartTable spec={spec} />
      )}
      {chart.url && (
        <figcaption>
          <span>{spec.series.length === 1 ? spec.series[0].label : `${spec.series.length} serie`} · {spec.data.length} valori</span>
          <a href={chart.url} download={chart.filename}>
            <Icon name="download" size={14} /> Scarica PNG
          </a>
        </figcaption>
      )}
    </figure>
  );
}
