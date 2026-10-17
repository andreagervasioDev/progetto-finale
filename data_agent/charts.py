"""
Grafici e tabelle dell'analisi: dal DataFrame a un JSON per il frontend React, più il PNG.

Il pandas agent non disegna più a mano con matplotlib: chiama `chart(...)` e `table(...)`.
- `chart` valida i dati e produce una "specifica" JSON (tipo, assi, serie, punti) che il frontend
  disegna con componenti React, interattivi e nello stile dell'app. Con lo stesso codice (nostro, non
  scritto dall'LLM) disegna anche il PNG con matplotlib e lo salva su disco, come chiede la traccia:
  l'immagine resta scaricabile ed è il ripiego per le conversazioni salvate prima di questa versione.
- `table` produce una tabella JSON (colonne + righe) mostrata come tabella vera nella chat.
"""

from __future__ import annotations

import math
import uuid
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # backend senza GUI: i grafici vengono solo salvati su file
import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

# Palette categoriale validata (contrasto e separazione per daltonismo) sullo sfondo bianco dell'app:
# verde campo, arancione del club, blu, ocra. Ordine fisso: il colore segue la serie, mai la posizione.
PALETTE = ["#16774a", "#ff7a1a", "#2b6cb0", "#c49a00"]
TEXT = "#13231a"
MUTED = "#52655a"
GRID = "#e3eae1"

CHART_TYPES = {"bar", "barh", "line", "scatter"}
MAX_SERIES = 4  # oltre, i colori non restano distinguibili: si usano più grafici
MAX_POINTS = {"bar": 40, "barh": 40, "line": 500, "scatter": 1000}
MAX_TABLE_ROWS = 50


class ChartError(ValueError):
    """Dati non adatti al grafico richiesto: il messaggio torna all'LLM, che corregge il codice."""


def _json_value(v):
    """Valore serializzabile in JSON: numeri arrotondati, date in ISO, NaN come null."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, pd.Timestamp):
        return v.date().isoformat() if v == v.normalize() else v.isoformat()
    if hasattr(v, "item"):  # tipi numpy
        v = v.item()
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        return round(v, 4)
    if isinstance(v, (int, bool, str)):
        return v
    return str(v)


def _as_frame(data) -> pd.DataFrame:
    if isinstance(data, pd.Series):
        name = data.name or "valore"
        return data.rename(name).reset_index()
    if isinstance(data, pd.DataFrame):
        # un indice con nome (es. dopo un groupby) diventa una colonna utilizzabile come asse x
        return data.reset_index() if data.index.name or isinstance(data.index, pd.MultiIndex) else data
    raise ChartError("chart() e table() accettano un DataFrame o una Series di pandas.")


def build_chart_spec(data, kind="bar", x=None, y=None, title="", x_label=None, y_label=None) -> dict:
    """Specifica JSON del grafico, validata. Lancia ChartError con un messaggio utile all'LLM."""
    if kind not in CHART_TYPES:
        raise ChartError(f"Tipo di grafico '{kind}' non supportato: usa uno tra {sorted(CHART_TYPES)}.")
    df = _as_frame(data)
    if df.empty:
        raise ChartError("Nessun dato da disegnare: il DataFrame è vuoto.")

    x = x or df.columns[0]
    if x not in df.columns:
        raise ChartError(f"Colonna x '{x}' non trovata. Colonne disponibili: {list(df.columns)}.")
    ys = [y] if isinstance(y, str) else list(y) if y else [c for c in df.columns if c != x and pd.api.types.is_numeric_dtype(df[c])]
    if not ys:
        raise ChartError("Indica la colonna dei valori con y='nome_colonna' (deve essere numerica).")
    if len(ys) > MAX_SERIES:
        raise ChartError(f"Massimo {MAX_SERIES} serie per grafico: dividi in più grafici.")
    for col in ys:
        if col not in df.columns:
            raise ChartError(f"Colonna y '{col}' non trovata. Colonne disponibili: {list(df.columns)}.")
        if not pd.api.types.is_numeric_dtype(df[col]):
            raise ChartError(f"La colonna '{col}' non è numerica: converti i valori o scegli un'altra colonna.")
    if kind == "scatter" and not pd.api.types.is_numeric_dtype(df[x]):
        raise ChartError(f"Per un grafico 'scatter' anche la colonna x ('{x}') deve essere numerica.")
    if len(df) > MAX_POINTS[kind]:
        raise ChartError(
            f"Troppi punti ({len(df)}) per un grafico '{kind}' (massimo {MAX_POINTS[kind]}): "
            "aggrega i dati o tieni solo i valori principali (es. .head(15))."
        )

    rows = [{"x": _json_value(rec[x]), **{f"s{i}": _json_value(rec[c]) for i, c in enumerate(ys)}} for rec in df[[x, *ys]].to_dict("records")]
    return {
        "type": kind,
        "title": str(title or ""),
        "xLabel": str(x_label or x),
        "yLabel": str(y_label or (ys[0] if len(ys) == 1 else "")),
        "series": [{"key": f"s{i}", "label": str(c), "color": PALETTE[i]} for i, c in enumerate(ys)],
        "data": rows,
    }


def render_png(spec: dict, path: Path) -> None:
    """Disegna il PNG del grafico dalla specifica, con lo stesso stile del frontend."""
    fig, ax = plt.subplots(figsize=(10, 5.5), dpi=110)
    xs = [r["x"] for r in spec["data"]]
    labels = [str(v) for v in xs]
    n = len(spec["series"])
    for i, s in enumerate(spec["series"]):
        vals = [r[s["key"]] if r[s["key"]] is not None else math.nan for r in spec["data"]]
        if spec["type"] == "bar":
            width = 0.8 / n
            pos = [k - 0.4 + width * (i + 0.5) for k in range(len(xs))]
            ax.bar(pos, vals, width=width * 0.92, color=s["color"], label=s["label"])
            ax.set_xticks(range(len(xs)), labels, rotation=30 if len(xs) > 6 else 0, ha="right" if len(xs) > 6 else "center")
        elif spec["type"] == "barh":
            height = 0.8 / n
            pos = [k - 0.4 + height * (i + 0.5) for k in range(len(xs))]
            ax.barh(pos, vals, height=height * 0.92, color=s["color"], label=s["label"])
            ax.set_yticks(range(len(xs)), labels)
            ax.invert_yaxis()  # il primo valore in alto, come nella tabella
        elif spec["type"] == "line":
            ax.plot(labels if not all(isinstance(v, (int, float)) for v in xs) else xs, vals, color=s["color"], linewidth=2, label=s["label"])
        else:  # scatter
            ax.scatter(xs, vals, s=36, color=s["color"], edgecolors="white", linewidths=1, label=s["label"])

    ax.set_title(spec["title"], color=TEXT, fontsize=13, fontweight="bold", loc="left")
    if spec["type"] == "barh":
        ax.set_xlabel(spec["yLabel"], color=MUTED)
        ax.set_ylabel(spec["xLabel"], color=MUTED)
    else:
        ax.set_xlabel(spec["xLabel"], color=MUTED)
        ax.set_ylabel(spec["yLabel"], color=MUTED)
    ax.grid(False)  # azzera la griglia predefinita, poi solo quella utile
    ax.grid(axis="x" if spec["type"] == "barh" else "y", color=GRID, linewidth=1)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.tick_params(colors=MUTED)
    if n > 1:
        ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)


def build_table(data, title="") -> dict:
    """Tabella JSON (colonne e righe), al massimo MAX_TABLE_ROWS righe."""
    df = _as_frame(data)
    total = len(df)
    df = df.head(MAX_TABLE_ROWS)
    columns = [
        {"key": f"c{i}", "label": str(c), "numeric": bool(pd.api.types.is_numeric_dtype(df[c]))}
        for i, c in enumerate(df.columns)
    ]
    rows = [{f"c{i}": _json_value(v) for i, v in enumerate(rec)} for rec in df.itertuples(index=False)]
    return {"title": str(title or ""), "columns": columns, "rows": rows, "totalRows": total}


def make_helpers(charts_dir: Path, charts: list, tables: list):
    """Funzioni chart() e table() da mettere nel namespace del pandas agent."""

    def chart(data, kind="bar", x=None, y=None, title="", x_label=None, y_label=None) -> str:
        spec = build_chart_spec(data, kind=kind, x=x, y=y, title=title, x_label=x_label, y_label=y_label)
        name = f"chart_{uuid.uuid4().hex[:10]}.png"
        render_png(spec, charts_dir / name)
        charts.append({"filename": name, "title": spec["title"] or "Grafico", "spec": spec})
        return f"Grafico '{spec['title']}' creato ({len(spec['data'])} punti, {len(spec['series'])} serie)."

    def table(data, title="") -> str:
        t = build_table(data, title=title)
        tables.append(t)
        extra = f" (prime {len(t['rows'])} di {t['totalRows']})" if t["totalRows"] > len(t["rows"]) else ""
        return f"Tabella '{t['title']}' creata: {len(t['rows'])} righe{extra}."

    return chart, table
