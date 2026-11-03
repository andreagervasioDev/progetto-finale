"""
Configurazione dei test del data agent.

- I moduli del data agent (cleaning, datasets, executor, app) si importano dalla cartella superiore.
- I dataset caricati, i PNG dei grafici e la cache delle analisi finiscono in cartelle temporanee, mai in data_agent/datasets/
  o data_agent/charts/: la retention dei grafici, che parte con l'app, non tocca mai i file veri.
- Nessun test chiama OpenAI: la chiave viene svuotata, quindi /analyze risponde 503.
"""

import os
import sys
import tempfile
from pathlib import Path

import pandas as pd
import pytest

AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIR))

_TMP = tempfile.TemporaryDirectory(prefix="management-ai-datasets-")
os.environ["DATASETS_DIR"] = _TMP.name
_CHARTS_TMP = tempfile.TemporaryDirectory(prefix="management-ai-charts-")
os.environ["CHARTS_DIR"] = _CHARTS_TMP.name
_CACHE_TMP = tempfile.TemporaryDirectory(prefix="management-ai-cache-")
os.environ["ANALYZE_CACHE_DIR"] = _CACHE_TMP.name
os.environ["OPENAI_API_KEY"] = ""  # load_dotenv non sovrascrive le variabili già presenti

CSV_PATH = AGENT_DIR / "data" / "player_performance.csv"


@pytest.fixture(scope="session")
def raw_matches() -> pd.DataFrame:
    return pd.read_csv(CSV_PATH)


@pytest.fixture(scope="session")
def cleaned_matches(raw_matches):
    from cleaning import clean_dataset

    return clean_dataset(raw_matches)
