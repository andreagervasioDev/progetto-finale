"""
Archivio dei dataset analizzabili dal pandas agent.

- "partite": il dataset delle prestazioni dei giocatori incluso nel progetto, con la sua pipeline
  di pulizia dedicata (cleaning.py) e uno schema descritto a mano.
- dataset caricati dagli utenti (CSV / Excel): salvati in data_agent/datasets/, ripuliti con una
  pipeline generica e descritti automaticamente (colonne, tipi, esempi) per l'LLM.

L'elenco dei dataset caricati e' persistito in datasets/registry.json, cosi' sopravvive ai riavvii.
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from cleaning import CleaningReport, clean_dataset

BASE_DIR = Path(__file__).parent
DATASETS_DIR = Path(os.getenv("DATASETS_DIR", BASE_DIR / "datasets"))
REGISTRY_FILE = DATASETS_DIR / "registry.json"
BUILTIN_ID = "partite"
ID_RE = re.compile(r"^[a-zA-Z0-9-]{3,64}$")
SUPPORTED_EXT = {".csv", ".xlsx", ".xls"}


@dataclass
class Dataset:
    id: str
    title: str
    filename: str
    builtin: bool
    raw: pd.DataFrame
    clean: pd.DataFrame
    report: CleaningReport
    schema: str  # descrizione delle colonne passata all'LLM

    def summary(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "filename": self.filename,
            "builtin": self.builtin,
            "rows_raw": self.report.rows_raw,
            "rows": int(len(self.clean)),
            "columns": [str(c) for c in self.clean.columns],
        }


# --------------------------------------------------------------------------- #
# Lettura dei file
# --------------------------------------------------------------------------- #
def load_table(content: bytes, filename: str) -> pd.DataFrame:
    """Legge CSV (separatore e codifica rilevati automaticamente) o Excel (primo foglio non vuoto)."""
    ext = Path(filename).suffix.lower()
    if ext in (".xlsx", ".xls"):
        sheets = pd.read_excel(io.BytesIO(content), sheet_name=None)
        for df in sheets.values():
            if not df.dropna(how="all").empty:
                return df
        raise ValueError("Il file Excel non contiene dati.")
    last_error: Exception | None = None
    for encoding in ("utf-8-sig", "latin-1"):
        try:
            # sep=None: pandas riconosce da solo virgola, punto e virgola o tabulazione
            return pd.read_csv(io.BytesIO(content), sep=None, engine="python", encoding=encoding)
        except Exception as e:  # noqa: BLE001
            last_error = e
    raise ValueError(f"CSV non leggibile: {last_error}")


# --------------------------------------------------------------------------- #
# Pulizia generica (per i dataset caricati)
# --------------------------------------------------------------------------- #
_NUMERIC_RE = re.compile(r"^\s*[-+]?[€$£]?\s*[\d.,]+\s*%?\s*[€$£]?\s*$")
_DATE_HINT = re.compile(r"data|date|scadenza|nascita|giorno|inizio|fine|dal|al", re.I)


def _to_number(series: pd.Series) -> pd.Series:
    def conv(v):
        if pd.isna(v):
            return np.nan
        if isinstance(v, (int, float, np.number)):
            return float(v)
        s = str(v).strip().replace("€", "").replace("$", "").replace("£", "").replace("%", "").replace(" ", "")
        # formato italiano 1.234,56 -> 1234.56 ; formato 1,234.56 -> 1234.56
        if "," in s and "." in s:
            s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
        elif "," in s:
            s = s.replace(",", ".")
        try:
            return float(s)
        except ValueError:
            return np.nan
    return series.map(conv)


def _n(count: int, singular: str, plural: str) -> str:
    """'1 riga vuota rimossa' / '3 righe vuote rimosse'."""
    return f"{count} {singular if count == 1 else plural}"


def generic_clean(raw: pd.DataFrame) -> tuple[pd.DataFrame, CleaningReport]:
    report = CleaningReport(rows_raw=len(raw))
    df = raw.copy()

    # nomi delle colonne puliti
    old_cols = list(df.columns)
    df.columns = [re.sub(r"\s+", " ", str(c)).strip() or f"colonna_{i + 1}" for i, c in enumerate(df.columns)]
    if old_cols != list(df.columns):
        report.add("Ripuliti i nomi delle colonne (spazi superflui, colonne senza nome).")

    # righe e colonne completamente vuote
    empty_cols = [c for c in df.columns if df[c].isna().all()]
    if empty_cols:
        df = df.drop(columns=empty_cols)
        report.add(f"Rimoss{'a' if len(empty_cols) == 1 else 'e'} {_n(len(empty_cols), 'colonna completamente vuota', 'colonne completamente vuote')}.")
    n = len(df)
    df = df.dropna(how="all")
    if n - len(df):
        report.add(f"Rimoss{'a' if n - len(df) == 1 else 'e'} {_n(n - len(df), 'riga completamente vuota', 'righe completamente vuote')}.")

    # duplicati esatti
    dups = int(df.duplicated().sum())
    if dups:
        df = df.drop_duplicates()
        report.add(f"Rimoss{'a' if dups == 1 else 'e'} {_n(dups, 'riga duplicata', 'righe duplicate')}.")

    for col in df.columns:
        s = df[col]
        if pd.api.types.is_numeric_dtype(s) or pd.api.types.is_datetime64_any_dtype(s):
            continue
        text = s.dropna().astype(str).str.strip()
        if text.empty:
            continue
        # spazi superflui nei testi
        trimmed = s.map(lambda v: v.strip() if isinstance(v, str) else v)
        if not trimmed.equals(s):
            df[col] = s = trimmed
        # numeri salvati come testo ("1.234,50", "15%", "€ 300")
        if text.map(lambda v: bool(_NUMERIC_RE.match(v))).mean() >= 0.9:
            converted = _to_number(s)
            if converted.notna().sum() >= 0.9 * s.notna().sum():
                df[col] = converted
                report.add(f"Colonna '{col}': convertita in numero (testo con virgole, punti, % o valuta).")
                continue
        # date in vari formati
        if _DATE_HINT.search(str(col)) or text.str.match(r"^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}").mean() >= 0.8:
            parsed = pd.to_datetime(s, errors="coerce", dayfirst=True, format="mixed")
            if parsed.notna().sum() >= 0.8 * s.notna().sum() and parsed.notna().any():
                df[col] = parsed
                report.add(f"Colonna '{col}': convertita in data.")

    missing = df.isna().sum()
    missing = missing[missing > 0]
    if not missing.empty:
        report.add("Valori mancanti lasciati come NaN (da gestire nell'analisi): "
                   + ", ".join(f"{c}={int(v)}" for c, v in missing.items()) + ".")
    if not report.steps:
        report.add("Nessuna anomalia evidente: dati usati cosi' come sono.")
    df = df.reset_index(drop=True)
    report.rows_clean = len(df)
    return df, report


def describe_schema(df: pd.DataFrame, title: str) -> str:
    """Descrizione compatta delle colonne per l'LLM: tipo, valori mancanti, range o esempi."""
    lines = [f"Dataset \"{title}\": {len(df)} righe, {df.shape[1]} colonne. Colonne del DataFrame `df`:"]
    for col in df.columns:
        s = df[col]
        nulls = int(s.isna().sum())
        if pd.api.types.is_numeric_dtype(s):
            info = f"numerica, min {s.min():.4g}, max {s.max():.4g}, media {s.mean():.4g}" if s.notna().any() else "numerica (vuota)"
        elif pd.api.types.is_datetime64_any_dtype(s):
            info = f"data, dal {s.min():%d/%m/%Y} al {s.max():%d/%m/%Y}" if s.notna().any() else "data (vuota)"
        else:
            uniq = s.dropna().astype(str).unique()
            sample = ", ".join(f"'{v[:30]}'" for v in uniq[:5])
            info = f"testo, {len(uniq)} valori distinti (es. {sample})"
        lines.append(f"- {col}: {info}" + (f"; {nulls} mancanti" if nulls else ""))
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Archivio
# --------------------------------------------------------------------------- #
class DatasetStore:
    def __init__(self, builtin_path: Path, builtin_schema: str):
        DATASETS_DIR.mkdir(exist_ok=True)
        self._lock = threading.Lock()
        self._items: dict[str, Dataset] = {}

        raw = pd.read_csv(builtin_path)
        clean, report = clean_dataset(raw)
        self._items[BUILTIN_ID] = Dataset(BUILTIN_ID, "Dati partite (prestazioni giocatori)", builtin_path.name,
                                          True, raw, clean, report, builtin_schema)
        for entry in self._read_registry():
            try:
                self._load(entry["id"], entry["title"], entry["filename"])
            except Exception:  # noqa: BLE001 - un file danneggiato non deve bloccare il servizio
                continue

    def _read_registry(self) -> list[dict]:
        try:
            return json.loads(REGISTRY_FILE.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    def _write_registry(self) -> None:
        entries = [{"id": d.id, "title": d.title, "filename": d.filename} for d in self._items.values() if not d.builtin]
        REGISTRY_FILE.write_text(json.dumps(entries, indent=2, ensure_ascii=False))

    def _path(self, dataset_id: str, filename: str) -> Path:
        return DATASETS_DIR / f"{dataset_id}{Path(filename).suffix.lower()}"

    def _load(self, dataset_id: str, title: str, filename: str) -> Dataset:
        raw = load_table(self._path(dataset_id, filename).read_bytes(), filename)
        clean, report = generic_clean(raw)
        ds = Dataset(dataset_id, title, filename, False, raw, clean, report, describe_schema(clean, title))
        self._items[dataset_id] = ds
        return ds

    def add(self, dataset_id: str, title: str, filename: str, content: bytes) -> Dataset:
        if not ID_RE.match(dataset_id) or dataset_id == BUILTIN_ID:
            raise ValueError("Identificativo del dataset non valido.")
        if Path(filename).suffix.lower() not in SUPPORTED_EXT:
            raise ValueError("Formato non supportato: carica un file CSV o Excel.")
        raw = load_table(content, filename)  # verifica che sia leggibile prima di salvarlo
        if raw.dropna(how="all").empty:
            raise ValueError("Il file non contiene dati.")
        with self._lock:
            self._path(dataset_id, filename).write_bytes(content)
            ds = self._load(dataset_id, title, filename)
            self._write_registry()
        return ds

    def remove(self, dataset_id: str) -> bool:
        with self._lock:
            ds = self._items.get(dataset_id)
            if not ds or ds.builtin:
                return False
            self._path(ds.id, ds.filename).unlink(missing_ok=True)
            del self._items[dataset_id]
            self._write_registry()
        return True

    def get(self, dataset_id: str) -> Dataset | None:
        return self._items.get(dataset_id)

    def list(self) -> list[Dataset]:
        return list(self._items.values())
