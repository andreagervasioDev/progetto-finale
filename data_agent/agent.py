"""
Pandas agent (paradigma ReAct) di Management AI: analizza il dataset delle partite o qualsiasi
tabella (CSV / Excel) caricata dagli utenti.

Ciclo:  Reason -> l'LLM decide quale analisi serve e scrive codice pandas
        Act    -> il codice viene eseguito davvero da PythonExecutor
        Observe-> l'output reale torna all'LLM, che corregge o prosegue
fino a quando l'LLM produce la sintesi finale per lo staff.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # backend senza GUI: i grafici vengono solo salvati su file
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import seaborn as sns  # noqa: E402
from openai import OpenAI  # noqa: E402

from datasets import Dataset, DatasetStore  # noqa: E402
from executor import PythonExecutor  # noqa: E402

CHARTS_DIR = Path(__file__).parent / "charts"
CHARTS_DIR.mkdir(exist_ok=True)
MAX_STEPS = int(os.getenv("DATA_AGENT_MAX_STEPS", "8"))

CLUB_PALETTE = ["#16774a", "#ff7a1a", "#2bb673", "#f2b134", "#0b4d2c", "#c0392b", "#7a8a80"]

SCHEMA_DESCRIPTION = """
Ogni riga = un giocatore in una partita (solo chi e' sceso in campo). Colonne del DataFrame `df`:
- match_id, match_date (datetime), season ('2024-25' | '2025-26'), competition ('Serie A' | 'Europa League' | 'Coppa Italia'),
  matchday, opponent, venue ('Casa' | 'Trasferta'), goals_for, goals_against, result ('V' vittoria | 'N' pareggio | 'P' sconfitta)
- player_id, player_name, position ('POR' portiere | 'DIF' difensore | 'CEN' centrocampista | 'ATT' attaccante), age, starter (1 titolare / 0 subentrato)
- minutes_played, goals, assists, shots, shots_on_target, xg (expected goals), xa (expected assists),
  passes_completed, pass_accuracy_pct (0-100), key_passes, tackles, interceptions, duels_won_pct (0-100)
- dati GPS: distance_km, hsr_distance_m (metri ad alta intensita' >19.8 km/h), sprints (n. sprint >25 km/h), top_speed_kmh
- carico/benessere: rpe (sforzo percepito 1-10), wellness_score (questionario 1-10, alto = meglio)
- yellow_cards, red_cards, rating (voto 1-10, puo' essere NaN), injury (1 se infortunio in quella partita),
  injury_type (testo, '' se nessuno), days_out (giorni di stop previsti)
Nota: il carico di sessione (sRPE) = rpe * minutes_played. Le metriche "per 90" = valore / minutes_played * 90.
""".strip()

# istruzioni specifiche per il dataset delle partite (regole di dominio della knowledge base)
BUILTIN_NOTES = """- escludi i rating NaN dalle medie, usa una soglia minima di minuti quando confronti metriche per 90',
  escludi i portieri dalle metriche offensive"""

GENERIC_NOTES = """- e' un file caricato dagli utenti: prima di rispondere controlla colonne e valori (df.head(), df.dtypes),
  perche' nomi e formati possono essere incoerenti; gestisci i NaN in modo esplicito"""


def build_system_prompt(ds: Dataset) -> str:
    notes = BUILTIN_NOTES if ds.builtin else GENERIC_NOTES
    return f"""Sei il data analyst della piattaforma Management AI, che supporta la gestione di un club di calcio di Serie A.
Rispondi alle domande dello staff analizzando con Python/pandas il dataset "{ds.title}" (file: {ds.filename}).

HAI UN SOLO STRUMENTO: `run_python`, un interprete Python con stato. Nel namespace trovi gia':
- `df`: il DataFrame GIA' PULITO (vedi cleaning_report)
- `df_raw`: il file grezzo originale, da usare SOLO se la domanda riguarda la qualita' dei dati
- `cleaning_report`: stringa con i passi di pulizia applicati
- `pd`, `np`, `plt`, `sns` e la funzione `save_chart(title)` che salva la figura matplotlib corrente e ne restituisce il nome file

{ds.schema}

METODO DI LAVORO (ReAct):
1. Ragiona su quali colonne e aggregazioni servono. Se serve, esplora prima (es. df['col'].unique()).
2. Scrivi codice pandas conciso e stampa SEMPRE i risultati con print(). Non inventare mai numeri: usa solo gli output reali.
3. Esegui eventuale pulizia aggiuntiva specifica per la domanda:
{notes}
4. Genera UN grafico chiaro quando aiuta a capire il risultato (trend, confronti, distribuzioni):
   titolo e assi in italiano, etichette leggibili, poi chiama save_chart("titolo"). Non usare plt.show().
   Se la domanda chiede esplicitamente piu' grafici puoi generarne fino a 3.
5. Se il codice va in errore, leggi il traceback e correggi.

RISPOSTA FINALE (in italiano, senza chiamare altri strumenti), in markdown:
- **Risultato chiave** in 1-2 frasi con i numeri principali
- una breve tabella o elenco con i dati rilevanti (max ~10 righe)
- **Insight**: cosa significano i numeri e cosa conviene fare
- una riga finale "_Qualita' dati:_ ..." che cita solo le operazioni di pulizia rilevanti per questa analisi
Non includere il codice nella risposta finale e non inserire immagini markdown: i grafici vengono allegati automaticamente.
"""


TOOLS = [{
    "type": "function",
    "function": {
        "name": "run_python",
        "description": "Esegue codice Python sul DataFrame `df` e restituisce stdout (o il traceback in caso di errore).",
        "parameters": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Codice Python da eseguire. Usa print() per mostrare i risultati."},
                "thought": {"type": "string", "description": "Breve ragionamento: perche' esegui questo codice."},
            },
            "required": ["code", "thought"],
        },
    },
}]


def _setup_plot_style() -> None:
    sns.set_theme(style="whitegrid", palette=CLUB_PALETTE)
    plt.rcParams.update({"figure.figsize": (10, 5.5), "figure.dpi": 110, "axes.titleweight": "bold",
                         "axes.titlesize": 13, "axes.spines.top": False, "axes.spines.right": False})


class PandasAgent:
    def __init__(self, store: DatasetStore):
        self.store = store
        self.client = OpenAI()  # legge OPENAI_API_KEY dalle variabili d'ambiente
        self.model = os.getenv("DATA_AGENT_MODEL") or os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
        _setup_plot_style()

    def _new_namespace(self, ds: Dataset, charts: list[dict]) -> dict:
        def save_chart(title: str = "grafico") -> str:
            fig = plt.gcf()
            if not fig.get_axes():
                return "Nessuna figura da salvare: crea prima il grafico."
            fig.tight_layout()
            name = f"chart_{uuid.uuid4().hex[:10]}.png"
            fig.savefig(CHARTS_DIR / name, bbox_inches="tight")
            plt.close("all")
            charts.append({"filename": name, "title": title})
            return f"Grafico salvato: {name}"

        return {
            "df": ds.clean.copy(),
            "df_raw": ds.raw.copy(),
            "cleaning_report": str(ds.report),
            "pd": pd, "np": np, "plt": plt, "sns": sns,
            "save_chart": save_chart,
        }

    def analyze(self, question: str, context: str | None, ds: Dataset) -> dict:
        charts: list[dict] = []
        executor = PythonExecutor(self._new_namespace(ds, charts))
        steps: list[dict] = []
        usage: dict[str, dict] = {}  # token consumati per modello, restituiti al backend per i KPI di spesa

        user_msg = question if not context else f"{question}\n\nContesto aggiuntivo fornito dall'orchestratore:\n{context}"
        messages = [{"role": "system", "content": build_system_prompt(ds)}, {"role": "user", "content": user_msg}]

        for _ in range(MAX_STEPS):
            resp = self.client.chat.completions.create(
                model=self.model, messages=messages, tools=TOOLS, temperature=0)
            _add_usage(usage, resp, self.model)
            msg = resp.choices[0].message
            messages.append(msg.model_dump(exclude_none=True))

            if not msg.tool_calls:
                return self._result(msg.content or "", steps, charts, ds, usage)

            for call in msg.tool_calls:
                try:
                    args = json.loads(call.function.arguments)
                except json.JSONDecodeError:
                    args = {"code": "", "thought": ""}
                code = args.get("code", "")
                output = executor.run(code)
                steps.append({"thought": args.get("thought", ""), "code": code, "output": output[:1500]})
                messages.append({"role": "tool", "tool_call_id": call.id, "content": output})

        # troppi passi: chiedo una sintesi con quello che e' stato calcolato finora
        messages.append({"role": "user", "content": "Hai raggiunto il numero massimo di passi. "
                                                    "Scrivi ora la risposta finale con i risultati ottenuti."})
        resp = self.client.chat.completions.create(model=self.model, messages=messages, temperature=0)
        _add_usage(usage, resp, self.model)
        return self._result(resp.choices[0].message.content or "", steps, charts, ds, usage)

    def _result(self, answer: str, steps: list[dict], charts: list[dict], ds: Dataset, usage: dict) -> dict:
        plt.close("all")
        return {
            "answer": answer.strip(),
            "charts": charts,
            "steps": steps,
            "dataset": {"id": ds.id, "title": ds.title},
            "cleaning_report": ds.report.to_dict(),
            "usage": list(usage.values()),
        }


def _add_usage(usage: dict, resp, default_model: str) -> None:
    """Somma i token di una risposta OpenAI per modello."""
    if not getattr(resp, "usage", None):
        return
    model = getattr(resp, "model", None) or default_model
    entry = usage.setdefault(model, {"model": model, "prompt_tokens": 0, "completion_tokens": 0, "calls": 0})
    entry["prompt_tokens"] += resp.usage.prompt_tokens or 0
    entry["completion_tokens"] += resp.usage.completion_tokens or 0
    entry["calls"] += 1
