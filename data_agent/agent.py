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
from pathlib import Path

import numpy as np
import pandas as pd
from openai import OpenAI

from charts import make_helpers
from datasets import Dataset, DatasetStore
from executor import PythonExecutor

CHARTS_DIR = Path(__file__).parent / "charts"
CHARTS_DIR.mkdir(exist_ok=True)
MAX_STEPS = int(os.getenv("DATA_AGENT_MAX_STEPS", "8"))


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
- `pd`, `np`
- `chart(data, kind, x, y, title, x_label, y_label)`: crea un GRAFICO dai dati. `data` è un DataFrame o una Series
  (anche il risultato di un groupby); `kind` = "bar" (barre verticali), "barh" (barre orizzontali, per classifiche
  con nomi lunghi), "line" (andamento nel tempo), "scatter" (relazione tra due misure); `x` = colonna delle categorie
  o del tempo, `y` = colonna dei valori oppure una lista di massimo 4 colonne da confrontare (stessa unità di misura).
  Il grafico viene mostrato all'utente nella chat, interattivo.
- `table(data, title)`: mostra un DataFrame come TABELLA nella chat (massimo 50 righe), es. una classifica.
I grafici si creano SOLO con chart(): matplotlib e seaborn non sono disponibili. Se un grafico non è tra i tipi
supportati (es. una heatmap), mostra i dati con table().

{ds.schema}

METODO DI LAVORO (ReAct):
1. Ragiona su quali colonne e aggregazioni servono. Se serve, esplora prima (es. df['col'].unique()).
2. Scrivi codice pandas conciso e stampa SEMPRE i risultati con print(). Non inventare mai numeri: usa solo gli output reali.
3. Esegui eventuale pulizia aggiuntiva specifica per la domanda:
{notes}
4. Quando aiuta a capire il risultato crea UN grafico con chart() (trend, confronti, distribuzioni), con titolo e
   etichette degli assi in italiano. Prima prepara i dati (aggrega, ordina, tieni i valori principali: massimo 40
   categorie per le barre). Esempio:
       top = df.groupby('player_name')['goals'].sum().sort_values(ascending=False).head(10)
       chart(top, kind="barh", title="Migliori marcatori", x_label="Giocatore", y_label="Gol")
   I nomi delle colonne diventano le etichette di serie e tabelle: rinominale in italiano prima di chiamare
   chart() o table() (es. .rename(columns={{'goals': 'Gol', 'xg': 'xG'}})).
   Per una classifica o un elenco di dati usa table(). Se la domanda chiede piu' grafici puoi crearne fino a 3.
   Non confrontare nello stesso grafico misure con unità diverse (es. gol e km): fai due grafici.
5. Se il codice va in errore, leggi il traceback e correggi.

RISPOSTA FINALE (in italiano, senza chiamare altri strumenti), in markdown:
- **Risultato chiave** in 1-2 frasi con i numeri principali
- una breve tabella o elenco con i dati rilevanti (max ~10 righe), a meno che tu non abbia gia' creato la tabella con table()
- **Insight**: cosa significano i numeri e cosa conviene fare
- una riga finale "_Qualita' dati:_ ..." che cita solo le operazioni di pulizia rilevanti per questa analisi
Non includere il codice nella risposta finale e non inserire immagini markdown: grafici e tabelle creati con chart()
e table() vengono allegati automaticamente sotto la risposta.
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


class PandasAgent:
    def __init__(self, store: DatasetStore):
        self.store = store
        self.client = OpenAI()  # legge OPENAI_API_KEY dalle variabili d'ambiente
        self.model = os.getenv("DATA_AGENT_MODEL") or os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

    def _new_namespace(self, ds: Dataset, charts: list[dict], tables: list[dict]) -> dict:
        # i grafici si creano solo con chart(): JSON per il frontend React + PNG con matplotlib (charts.py)
        chart, table = make_helpers(CHARTS_DIR, charts, tables)
        return {
            "df": ds.clean.copy(),
            "df_raw": ds.raw.copy(),
            "cleaning_report": str(ds.report),
            "pd": pd, "np": np,
            "chart": chart,
            "table": table,
        }

    def analyze(self, question: str, context: str | None, ds: Dataset) -> dict:
        charts: list[dict] = []
        tables: list[dict] = []
        executor = PythonExecutor(self._new_namespace(ds, charts, tables))
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
                return self._result(msg.content or "", steps, charts, tables, ds, usage)

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
        return self._result(resp.choices[0].message.content or "", steps, charts, tables, ds, usage)

    def _result(self, answer: str, steps: list[dict], charts: list[dict], tables: list[dict], ds: Dataset, usage: dict) -> dict:
        return {
            "answer": answer.strip(),
            "charts": charts,
            "tables": tables,
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
