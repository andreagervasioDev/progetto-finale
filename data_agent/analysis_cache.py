"""
Cache delle analisi del data agent: se arriva di nuovo la stessa richiesta sugli stessi dati, il risultato
torna subito, senza chiamare OpenAI ne' rieseguire codice.

La chiave combina:
- la domanda e il contesto, normalizzati (maiuscole, spazi e punteggiatura finale non contano);
- il dataset e la sua versione (impronta del file e del codice di pulizia): se il file o la pulizia
  cambiano, le analisi vecchie non vengono piu' trovate;
- il modello: cambiando DATA_AGENT_MODEL / OPENAI_MODEL le analisi si rifanno.

Le voci scadono dopo ANALYZE_CACHE_TTL_HOURS ore (0 = cache disattivata) e ne restano al massimo
ANALYZE_CACHE_MAX_ENTRIES (si eliminano quelle usate meno di recente). Una voce i cui PNG sono stati
eliminati dalla retention dei grafici non viene piu' usata. Le voci sono salvate su disco in
ANALYZE_CACHE_DIR/analyze_cache.json, cosi' sopravvivono ai riavvii.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import unicodedata
from pathlib import Path

BASE_DIR = Path(__file__).parent

# campi del risultato da non salvare: i token vanno contati solo la prima volta, il tempo e' della singola richiesta
_NOT_STORED = ("usage", "elapsed_s", "cached")


def normalize(text: str | None) -> str:
    """'  Quali sono i MIGLIORI marcatori?? ' -> 'quali sono i migliori marcatori'"""
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = re.sub(r"\s+", " ", text)
    return re.sub(r"[\s?!.…]+$", "", text).strip()


def cache_key(question: str, context: str | None, dataset_id: str, data_version: str, model: str) -> str:
    payload = {"q": normalize(question), "ctx": normalize(context), "ds": dataset_id, "v": data_version, "m": model}
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


class AnalysisCache:
    def __init__(self, directory: Path, ttl_hours: float, max_entries: int):
        self.file = directory / "analyze_cache.json"
        self.ttl_s = ttl_hours * 3600
        self.max_entries = max_entries
        self.hits = 0
        self.misses = 0
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = {}
        if self.enabled:
            directory.mkdir(parents=True, exist_ok=True)
            try:
                self._entries = json.loads(self.file.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                self._entries = {}

    @classmethod
    def from_env(cls) -> AnalysisCache:
        return cls(
            Path(os.getenv("ANALYZE_CACHE_DIR", BASE_DIR / "cache")),
            ttl_hours=float(os.getenv("ANALYZE_CACHE_TTL_HOURS", "24")),
            max_entries=int(os.getenv("ANALYZE_CACHE_MAX_ENTRIES", "200")),
        )

    @property
    def enabled(self) -> bool:
        return self.ttl_s > 0

    def get(self, key: str, charts_dir: Path, now: float | None = None) -> dict | None:
        """Risultato salvato, oppure None se manca, e' scaduto o uno dei suoi PNG non esiste piu'."""
        if not self.enabled:
            return None
        now = time.time() if now is None else now
        with self._lock:
            entry = self._entries.get(key)
            valid = (
                entry is not None
                and now - entry["created_at"] <= self.ttl_s
                and all((charts_dir / c["filename"]).is_file() for c in entry["result"].get("charts", []))
            )
            if not valid:
                if entry is not None:
                    del self._entries[key]
                    self._save()
                self.misses += 1
                return None
            entry["last_hit_at"] = now
            entry["hits"] = entry.get("hits", 0) + 1
            self.hits += 1
            self._save()
            return json.loads(json.dumps(entry["result"]))  # copia: chi la riceve puo' modificarla

    def put(self, key: str, result: dict, now: float | None = None) -> bool:
        """Salva un'analisi completa (con una risposta); restituisce False se non e' stata salvata."""
        if not self.enabled or not (result.get("answer") or "").strip():
            return False
        now = time.time() if now is None else now
        stored = {k: v for k, v in result.items() if k not in _NOT_STORED}
        with self._lock:
            self._entries[key] = {"result": stored, "created_at": now, "last_hit_at": now, "hits": 0}
            self._prune(now)
            self._save()
        return True

    def status(self) -> dict:
        with self._lock:
            return {"entries": len(self._entries), "hits": self.hits, "misses": self.misses,
                    "ttl_hours": self.ttl_s / 3600}

    # --- interni (chiamati con il lock acquisito) ---
    def _prune(self, now: float) -> None:
        expired = [k for k, e in self._entries.items() if now - e["created_at"] > self.ttl_s]
        for k in expired:
            del self._entries[k]
        if len(self._entries) > self.max_entries:
            by_use = sorted(self._entries, key=lambda k: self._entries[k]["last_hit_at"])
            for k in by_use[: len(self._entries) - self.max_entries]:
                del self._entries[k]

    def _save(self) -> None:
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._entries, ensure_ascii=False))
        tmp.replace(self.file)
