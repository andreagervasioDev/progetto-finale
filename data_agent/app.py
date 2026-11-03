"""
Microservizio FastAPI del data agent.

Endpoint:
  GET    /health                      stato del servizio
  GET    /datasets                    dataset disponibili (partite + file caricati)
  POST   /datasets                    registra un file CSV/Excel (multipart: id, title, file)
  DELETE /datasets/{id}               rimuove un dataset caricato
  GET    /datasets/{id}/overview      schema, report di pulizia, valori mancanti, anteprima righe
  POST   /analyze                     {question, context?, dataset_id?} -> sintesi, grafici, passi eseguiti
  GET    /charts/{file}               immagini PNG dei grafici generati
  GET    /dataset/info, /dataset/preview   (compatibilita') panoramica del dataset partite
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR.parent / ".env")  # .env unico nella root del progetto

from agent import CHARTS_DIR, SCHEMA_DESCRIPTION, AnalysisCancelled, PandasAgent, data_agent_model  # noqa: E402
from analysis_cache import AnalysisCache, cache_key  # noqa: E402
from cleaning import quality_summary  # noqa: E402
from datasets import BUILTIN_ID, Dataset, DatasetError, DatasetStore  # noqa: E402
from retention import RetentionPolicy, charts_status, retention_loop  # noqa: E402
from upload_limit import BodySizeLimitMiddleware, read_limited  # noqa: E402
from validation import SchemaError  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [data_agent] %(message)s")
log = logging.getLogger(__name__)

DATASET_PATH = Path(os.getenv("DATASET_PATH", BASE_DIR / "data" / "player_performance.csv"))
MAX_UPLOAD_MB = 20
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
RETENTION = RetentionPolicy.from_env()
ANALYSIS_CACHE = AnalysisCache.from_env()
state: dict = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        store = DatasetStore(DATASET_PATH, SCHEMA_DESCRIPTION)
    except SchemaError as e:
        # il CSV non ha la struttura attesa: meglio fermarsi con un messaggio chiaro che analizzare dati sbagliati
        log.error("Dataset partite NON valido (%s): %s", DATASET_PATH.name, e)
        log.error("Il data agent non parte: correggi il CSV o rigeneralo con data/generate_dataset.py")
        raise SystemExit(1) from e
    builtin = store.get(BUILTIN_ID)
    log.info("Dataset partite: %s righe grezze -> %s righe pulite", builtin.report.rows_raw, builtin.report.rows_clean)
    check = builtin.validation
    for msg in check.errors:
        log.error("Validazione dataset partite: %s", msg)
    for msg in check.warnings:
        log.warning("Validazione dataset partite: %s", msg)
    if check.ok:
        log.info("Validazione dataset partite: colonne e tipi corretti")
    log.info("Dataset caricati dagli utenti: %s", len(store.list()) - 1)
    state["store"] = store
    if os.getenv("OPENAI_API_KEY", "").strip() in ("", "sk-..."):
        log.warning("OPENAI_API_KEY non impostata: /analyze non funzionera'. Controlla il file .env")
    else:
        state["agent"] = PandasAgent(store)
    # retention dei PNG dei grafici: pulizia subito e poi a intervalli regolari
    cleanup = asyncio.create_task(retention_loop(CHARTS_DIR, RETENTION))
    yield
    cleanup.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await cleanup


app = FastAPI(title="Management AI - Data Agent", version="2.0.0", lifespan=lifespan)
app.mount("/charts", StaticFiles(directory=CHARTS_DIR), name="charts")
# caricamento dei dataset: la lettura si interrompe appena il corpo supera il limite (413)
app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX_UPLOAD_BYTES, paths=("/datasets",))


def _store() -> DatasetStore:
    return state["store"]


def _get(dataset_id: str) -> Dataset:
    ds = _store().get(dataset_id)
    if ds is None:
        raise HTTPException(404, f"Dataset '{dataset_id}' non trovato.")
    return ds


def _records(df: pd.DataFrame) -> list[dict]:
    # to_json converte NaN in null e le date in ISO: sicuro da serializzare
    return json.loads(df.to_json(orient="records", date_format="iso"))


def _summary(ds: Dataset) -> dict:
    """Numeri di sintesi mostrati nella pagina Dati."""
    df = ds.clean
    if ds.builtin:
        return {
            "matches": int(df["match_id"].nunique()),
            "players": int(df["player_id"].nunique()),
            "seasons": sorted(df["season"].unique().tolist()),
            "competitions": df["competition"].value_counts().to_dict(),
            "date_from": df["match_date"].min().date().isoformat(),
            "date_to": df["match_date"].max().date().isoformat(),
            "injuries": int(df["injury"].sum()),
            "goals": int(df["goals"].sum()),
        }
    dates = [c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])]
    out = {
        "columns": int(df.shape[1]),
        "numeric_columns": int(sum(pd.api.types.is_numeric_dtype(df[c]) for c in df.columns)),
        "date_columns": len(dates),
    }
    if dates and df[dates[0]].notna().any():
        out["date_from"] = df[dates[0]].min().date().isoformat()
        out["date_to"] = df[dates[0]].max().date().isoformat()
    return out


class AnalyzeRequest(BaseModel):
    question: str = Field(..., min_length=3, description="Domanda di analisi in linguaggio naturale")
    context: str | None = Field(None, description="Informazioni aggiuntive (es. soglie dalla knowledge base)")
    dataset_id: str = Field(BUILTIN_ID, description="Dataset da analizzare (default: dati partite)")


@app.get("/health")
def health():
    builtin = _store().get(BUILTIN_ID)
    return {
        "status": "ok",
        "dataset_rows": len(builtin.clean),
        "datasets": len(_store().list()),
        "llm_ready": "agent" in state,
        "validation": builtin.validation.to_dict(),
        "charts": charts_status(CHARTS_DIR, RETENTION),
        "analysis_cache": ANALYSIS_CACHE.status(),
    }


@app.get("/datasets")
def list_datasets():
    return [ds.summary() for ds in _store().list()]


@app.post("/datasets", status_code=201)
async def add_dataset(id: str = Form(...), title: str = Form(...), file: UploadFile = File(...)):
    # lettura a blocchi: oltre il limite si ferma senza caricare il resto in memoria
    content = await read_limited(file, MAX_UPLOAD_BYTES)
    try:
        ds = await run_in_threadpool(_store().add, id, title, file.filename or "dati.csv", content)
    except DatasetError as e:
        # messaggio scritto da noi per l'utente
        raise HTTPException(422, str(e)) from e
    except Exception as e:  # noqa: BLE001
        # errore interno (pandas, openpyxl...): il dettaglio resta nel log, all'utente un messaggio generico
        log.exception("Dataset non leggibile")
        raise HTTPException(422, "Impossibile leggere il file: controlla che sia un CSV o un Excel valido.") from e
    log.info("Dataset registrato: %s (%s righe, %s colonne)", title, len(ds.clean), ds.clean.shape[1])
    return ds.summary() | {"cleaning_report": ds.report.to_dict()}


@app.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str):
    return {"deleted": _store().remove(dataset_id)}


@app.get("/datasets/{dataset_id}/overview")
def dataset_overview(dataset_id: str, rows: int = 50):
    ds = _get(dataset_id)
    rows = max(1, min(rows, 200))
    clean = ds.clean.sort_values("match_date", ascending=False) if ds.builtin else ds.clean
    return ds.summary() | {
        "schema": ds.schema,
        "summary": _summary(ds),
        "rows_clean": ds.report.rows_clean,
        "cleaning_report": ds.report.to_dict(),
        "missing_raw": {str(k): int(v) for k, v in ds.raw.isna().sum().items() if v > 0 and k != "injury_type"},
        "duplicates_raw": int(ds.raw.duplicated().sum()),
        "preview_clean": _records(clean.head(rows)),
        "preview_raw": _records(ds.raw.head(rows)),
        "validation": ds.validation.to_dict() if ds.builtin else None,
    }


# --- compatibilita' con la prima versione (dataset partite) ---
@app.get("/dataset/info")
def dataset_info():
    ds = _get(BUILTIN_ID)
    return {
        "path": ds.filename,
        "rows_raw": ds.report.rows_raw,
        "rows_clean": ds.report.rows_clean,
        "columns": list(ds.clean.columns),
        "schema": ds.schema,
        "raw_quality": quality_summary(ds.raw),
        "cleaning_report": ds.report.to_dict(),
    }


@app.get("/dataset/preview")
def dataset_preview(rows: int = 50):
    return dataset_overview(BUILTIN_ID, rows)


DISCONNECT_POLL_S = 0.5


async def watch_disconnect(request: Request, cancel: threading.Event) -> None:
    """Imposta `cancel` appena il backend chiude la connessione (l'utente ha annullato la domanda)."""
    while not await request.is_disconnected():
        await asyncio.sleep(DISCONNECT_POLL_S)
    cancel.set()


@app.post("/analyze")
async def analyze(req: AnalyzeRequest, request: Request):
    ds = _get(req.dataset_id)
    t0 = time.time()
    log.info("Domanda su '%s': %s", ds.title, req.question)

    # stessa domanda, stesso contesto, stessi dati e stesso modello: riuso l'analisi gia' fatta
    key = cache_key(req.question, req.context, ds.id, ds.version, data_agent_model())
    cached = await run_in_threadpool(ANALYSIS_CACHE.get, key, CHARTS_DIR)
    if cached is not None:
        log.info("Analisi dalla cache (%s passi, %s grafici)", len(cached["steps"]), len(cached["charts"]))
        # nessun token consumato: il backend non deve contare di nuovo la spesa
        return cached | {"usage": [], "cached": True, "elapsed_s": round(time.time() - t0, 1)}

    agent: PandasAgent | None = state.get("agent")
    if agent is None:
        raise HTTPException(503, "Data agent non configurato: manca OPENAI_API_KEY")
    cancel = threading.Event()
    watcher = asyncio.create_task(watch_disconnect(request, cancel))
    try:
        # l'agente e' sincrono (OpenAI + exec): lo eseguo in un thread per non bloccare il server
        result = await run_in_threadpool(agent.analyze, req.question, req.context, ds, cancel)
    except AnalysisCancelled:
        # nessuno leggera' la risposta: niente cache e nessun errore da registrare
        log.info("Analisi interrotta: il backend ha chiuso la richiesta")
        return Response(status_code=499)
    except Exception as e:  # errori OpenAI, rete, ecc.
        # il dettaglio (eccezione e traccia) resta nel log del data agent
        log.exception("Errore durante l'analisi")
        raise HTTPException(500, "Il data agent non è riuscito a completare l'analisi.") from e
    finally:
        watcher.cancel()
    result["elapsed_s"] = round(time.time() - t0, 1)
    log.info("Completata in %ss con %s passi e %s grafici", result["elapsed_s"], len(result["steps"]), len(result["charts"]))
    await run_in_threadpool(ANALYSIS_CACHE.put, key, result)
    return result | {"cached": False}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=int(os.getenv("DATA_AGENT_PORT", "8001")), reload=False)
