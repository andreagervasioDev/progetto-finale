"""
Configurazione dei test del data agent.

- I moduli del data agent (cleaning, datasets, executor, app) si importano dalla cartella superiore.
- I dataset caricati durante i test finiscono in una cartella temporanea, mai in data_agent/datasets/.
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
os.environ["OPENAI_API_KEY"] = ""  # load_dotenv non sovrascrive le variabili già presenti

CSV_PATH = AGENT_DIR / "data" / "player_performance.csv"


@pytest.fixture(scope="session")
def raw_matches() -> pd.DataFrame:
    return pd.read_csv(CSV_PATH)


@pytest.fixture(scope="session")
def cleaned_matches(raw_matches):
    from cleaning import clean_dataset

    return clean_dataset(raw_matches)
