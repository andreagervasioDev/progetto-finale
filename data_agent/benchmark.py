"""
Benchmark delle analisi piu' frequenti su dataset di dimensioni crescenti.

Misura tempo e memoria di caricamento del CSV, pulizia e analisi tipiche delle domande alla chat
(classifiche, medie per 90', soglie di wellness, incidenza infortuni, carico ACWR), con pandas e,
se installato, con DuckDB sugli stessi dati. I risultati servono a decidere quando pandas in memoria
non basta piu' e conviene introdurre DuckDB, SQLite o altre ottimizzazioni.

Uso (dalla cartella data_agent, con il virtualenv):
    .venv/bin/python benchmark.py                       # dimensioni predefinite
    .venv/bin/python benchmark.py --sizes 1578 20000    # dimensioni a scelta
    .venv/bin/pip install duckdb && .venv/bin/python benchmark.py   # con il confronto DuckDB

Output: tabella a schermo e benchmark_results/results.json + results.md.
I dataset grandi si ottengono replicando le 1.578 righe reali (anomalie comprese) con un
match_id diverso per ogni copia, cosi' la pulizia lavora sugli stessi problemi del file vero.
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import tempfile
import time
import tracemalloc
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from cleaning import clean_dataset

BASE_DIR = Path(__file__).parent
CSV_PATH = BASE_DIR / "data" / "player_performance.csv"
OUT_DIR = BASE_DIR / "benchmark_results"
DEFAULT_SIZES = [1_578, 10_000, 50_000, 100_000, 250_000]

# soglie usate per la raccomandazione finale
INTERACTIVE_SECONDS = 1.0  # una singola analisi oltre 1 s si somma ai 2-5 s di ogni passo dell'LLM
# il piano gratuito di Render ha 512 MB per tutto il container: circa meta' resta a Python, backend Node e
# ChromaDB, l'altra meta' e' lo spazio per i dati del data agent
MEMORY_BUDGET_MB = 256


# --------------------------------------------------------------------------- #
# Dati
# --------------------------------------------------------------------------- #
def scaled_raw(raw: pd.DataFrame, size: int) -> pd.DataFrame:
    """Replica il CSV grezzo fino a `size` righe; ogni copia ha match_id diversi (niente falsi duplicati)."""
    copies = -(-size // len(raw))
    parts = []
    for k in range(copies):
        part = raw.copy()
        if k:
            part["match_id"] = part["match_id"].astype(str) + f"-{k}"
        parts.append(part)
    return pd.concat(parts, ignore_index=True).head(size)


# --------------------------------------------------------------------------- #
# Analisi frequenti (stesso codice che scriverebbe il pandas agent)
# --------------------------------------------------------------------------- #
def top_scorers(df):
    season = df[df["season"] == "2025-26"]
    return season.groupby("player_name")[["goals", "xg"]].sum().nlargest(10, "goals")


def per90_by_position(df):
    g = df[df["position"] != "POR"].groupby(["season", "position"])
    out = g[["distance_km", "minutes_played"]].sum()
    out["distance_per90"] = out["distance_km"] / out["minutes_played"] * 90
    return out


def wellness_below_threshold(df):
    w = df[df["season"] == "2025-26"].groupby("player_name")["wellness_score"].mean()
    return w[w < 5].sort_values()


def injury_incidence(df):
    g = df.groupby("season")
    return g["injury"].sum() / (g["minutes_played"].sum() / 60) * 1000


def acwr(df):
    d = df.sort_values(["player_id", "match_date"]).copy()
    d["load"] = d["rpe"] * d["minutes_played"]
    g = d.groupby("player_id")["load"]
    acute = g.transform(lambda s: s.rolling(1, min_periods=1).mean())
    chronic = g.transform(lambda s: s.rolling(4, min_periods=1).mean())
    d["acwr"] = acute / chronic
    return d.loc[d["acwr"] > 1.5, ["player_name", "match_date", "acwr"]]


PANDAS_ANALYSES = {
    "Classifica marcatori": top_scorers,
    "Distanza per 90' per ruolo": per90_by_position,
    "Wellness sotto soglia": wellness_below_threshold,
    "Incidenza infortuni": injury_incidence,
    "ACWR (carico acuto/cronico)": acwr,
}

DUCKDB_QUERIES = {
    "Classifica marcatori": """
        SELECT player_name, SUM(goals) goals, SUM(xg) xg FROM df WHERE season = '2025-26'
        GROUP BY player_name ORDER BY goals DESC LIMIT 10""",
    "Distanza per 90' per ruolo": """
        SELECT season, position, SUM(distance_km) / SUM(minutes_played) * 90 AS distance_per90
        FROM df WHERE position <> 'POR' GROUP BY season, position""",
    "Wellness sotto soglia": """
        SELECT player_name, AVG(wellness_score) w FROM df WHERE season = '2025-26'
        GROUP BY player_name HAVING w < 5 ORDER BY w""",
    "Incidenza infortuni": """
        SELECT season, SUM(injury) / (SUM(minutes_played) / 60.0) * 1000 FROM df GROUP BY season""",
    "ACWR (carico acuto/cronico)": """
        SELECT * FROM (
          SELECT player_name, match_date, rpe * minutes_played /
                 AVG(rpe * minutes_played) OVER (PARTITION BY player_id ORDER BY match_date
                                                 ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) AS acwr
          FROM df) WHERE acwr > 1.5""",
}


# --------------------------------------------------------------------------- #
# Misure
# --------------------------------------------------------------------------- #
def measure(fn, repeat: int) -> dict:
    """Tempo mediano su `repeat` esecuzioni e picco di memoria allocata (tracemalloc, esecuzione separata)."""
    times = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        times.append(time.perf_counter() - t0)
    tracemalloc.start()
    fn()
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return {"seconds": round(statistics.median(times), 4), "peak_mb": round(peak / 2**20, 1)}


def run(sizes: list[int], repeat: int) -> dict:
    try:
        import duckdb
    except ImportError:
        duckdb = None

    raw_full = pd.read_csv(CSV_PATH)
    results = []
    for size in sizes:
        print(f"\n== {size:,} righe ==".replace(",", "."))
        raw = scaled_raw(raw_full, size)
        row: dict = {"rows": size, "steps": {}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bench.csv"
            raw.to_csv(path, index=False)
            row["csv_mb"] = round(path.stat().st_size / 2**20, 1)
            row["steps"]["Caricamento CSV"] = measure(lambda: pd.read_csv(path), repeat)
        # la pulizia e' la parte piu' lenta: una sola ripetizione oltre le 50.000 righe
        row["steps"]["Pulizia"] = measure(lambda: clean_dataset(raw), 1 if size > 50_000 else repeat)
        clean, _ = clean_dataset(raw)
        row["clean_rows"] = len(clean)
        row["raw_dataframe_mb"] = round(raw.memory_usage(deep=True).sum() / 2**20, 1)
        row["dataframe_mb"] = round(clean.memory_usage(deep=True).sum() / 2**20, 1)
        # il data agent tiene in memoria grezzo e pulito; all'avvio si aggiunge il picco della pulizia
        row["startup_peak_mb"] = round(row["raw_dataframe_mb"] + row["steps"]["Pulizia"]["peak_mb"], 1)
        for name, fn in PANDAS_ANALYSES.items():
            row["steps"][name] = measure(lambda fn=fn: fn(clean), repeat)
        if duckdb:
            con = duckdb.connect()
            con.register("df", clean)
            row["duckdb"] = {name: measure(lambda q=q: con.execute(q).fetchall(), repeat) for name, q in DUCKDB_QUERIES.items()}
            con.close()
        for name, m in row["steps"].items():
            dk = row.get("duckdb", {}).get(name)
            extra = f"   DuckDB {dk['seconds']:.3f} s" if dk else ""
            print(f"  {name:<30} {m['seconds']:>8.3f} s  {m['peak_mb']:>7.1f} MB{extra}")
        print(f"  DataFrame grezzo + pulito: {row['raw_dataframe_mb']} + {row['dataframe_mb']} MB,"
              f" picco all'avvio circa {row['startup_peak_mb']} MB")
        results.append(row)

    return {
        "date": datetime.now().isoformat(timespec="seconds"),
        "machine": {"python": platform.python_version(), "pandas": pd.__version__, "numpy": np.__version__,
                    "platform": platform.platform(), "processor": platform.processor() or platform.machine()},
        "duckdb": getattr(duckdb, "__version__", None) if duckdb else None,
        "repeat": repeat,
        "results": results,
        "recommendation": recommend(results),
    }


def recommend(results: list[dict]) -> dict:
    """Prima dimensione in cui un'analisi supera la soglia di tempo o la memoria stimata supera il budget."""
    slow, heavy = None, None
    for r in results:
        analyses = {k: v for k, v in r["steps"].items() if k not in ("Caricamento CSV", "Pulizia")}
        worst = max(analyses.items(), key=lambda kv: kv[1]["seconds"])
        if slow is None and worst[1]["seconds"] > INTERACTIVE_SECONDS:
            slow = {"rows": r["rows"], "analysis": worst[0], "seconds": worst[1]["seconds"]}
        if heavy is None and r["startup_peak_mb"] > MEMORY_BUDGET_MB:
            heavy = {"rows": r["rows"], "estimated_mb": r["startup_peak_mb"]}
    return {"interactive_seconds": INTERACTIVE_SECONDS, "memory_budget_mb": MEMORY_BUDGET_MB,
            "first_slow": slow, "first_over_memory": heavy}


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
def to_markdown(report: dict) -> str:
    res = report["results"]
    steps = list(res[0]["steps"])
    fmt_rows = lambda n: f"{n:,}".replace(",", ".")  # noqa: E731
    lines = [
        "# Benchmark del data agent",
        "",
        f"Eseguito il {report['date']} · Python {report['machine']['python']} · pandas {report['machine']['pandas']}"
        f" · {report['machine']['platform']}" + (f" · DuckDB {report['duckdb']}" if report["duckdb"] else ""),
        "",
        "## Tempo (secondi, mediana)",
        "",
        "| Operazione | " + " | ".join(fmt_rows(r["rows"]) + " righe" for r in res) + " |",
        "|---|" + "---:|" * len(res),
    ]
    for s in steps:
        lines.append(f"| {s} | " + " | ".join(f"{r['steps'][s]['seconds']:.3f}" for r in res) + " |")
    if report["duckdb"]:
        for s in DUCKDB_QUERIES:
            lines.append(f"| {s} (DuckDB) | " + " | ".join(f"{r['duckdb'][s]['seconds']:.3f}" for r in res) + " |")
    lines += [
        "",
        "## Memoria (MB)",
        "",
        "| Misura | " + " | ".join(fmt_rows(r["rows"]) + " righe" for r in res) + " |",
        "|---|" + "---:|" * len(res),
        "| File CSV | " + " | ".join(str(r["csv_mb"]) for r in res) + " |",
        "| DataFrame grezzo | " + " | ".join(str(r["raw_dataframe_mb"]) for r in res) + " |",
        "| DataFrame pulito | " + " | ".join(str(r["dataframe_mb"]) for r in res) + " |",
        "| **Picco all'avvio** (grezzo + pulizia) | " + " | ".join(f"**{r['startup_peak_mb']}**" for r in res) + " |",
    ]
    for s in steps:
        lines.append(f"| Picco: {s} | " + " | ".join(f"{r['steps'][s]['peak_mb']:.1f}" for r in res) + " |")

    rec = report["recommendation"]
    lines += ["", "## Quando cambiare strumento", ""]
    if rec["first_slow"]:
        s = rec["first_slow"]
        lines.append(f"- **Tempo**: a {fmt_rows(s['rows'])} righe l'analisi più lenta ({s['analysis']}) richiede "
                     f"{s['seconds']:.2f} s, oltre la soglia di {rec['interactive_seconds']:.0f} s per un'analisi interattiva.")
    else:
        lines.append(f"- **Tempo**: fino a {fmt_rows(res[-1]['rows'])} righe tutte le analisi restano sotto "
                     f"{rec['interactive_seconds']:.0f} s: pandas basta.")
    if rec["first_over_memory"]:
        m = rec["first_over_memory"]
        lines.append(f"- **Memoria**: a {fmt_rows(m['rows'])} righe il picco all'avvio ({m['estimated_mb']} MB) supera i "
                     f"{rec['memory_budget_mb']} MB disponibili per i dati sul piano gratuito di Render (512 MB in tutto, "
                     "condivisi con Python, backend Node e ChromaDB).")
    else:
        lines.append(f"- **Memoria**: fino a {fmt_rows(res[-1]['rows'])} righe il picco all'avvio resta sotto i "
                     f"{rec['memory_budget_mb']} MB disponibili per i dati sul piano gratuito di Render.")
    lines += [
        "- **Pulizia**: è l'operazione più costosa perché converte i valori uno per uno (date e numeri in più formati). "
        "Si esegue una sola volta all'avvio, quindi pesa sul tempo di avvio, non sulle risposte.",
        "",
        "Regola pratica: quando una delle due soglie viene superata, conviene salvare i dati puliti in DuckDB "
        "(o in Parquet letto da DuckDB) e far scrivere all'agente query SQL, invece di tenere tutto in un DataFrame pandas. "
        "SQLite ha senso se servono scritture frequenti e concorrenti; per analisi in sola lettura DuckDB è più veloce.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sizes", type=int, nargs="+", default=DEFAULT_SIZES, help="righe dei dataset da provare")
    parser.add_argument("--repeat", type=int, default=3, help="ripetizioni per la mediana dei tempi")
    parser.add_argument("--out", type=Path, default=OUT_DIR, help="cartella dei risultati")
    args = parser.parse_args()

    report = run(sorted(set(args.sizes)), args.repeat)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    (args.out / "results.md").write_text(to_markdown(report))
    print(f"\nRisultati salvati in {args.out}/results.md e results.json")


if __name__ == "__main__":
    main()
