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
eliminati dalla retention dei grafici non viene piu' usata.

Due archivi con le stesse regole:
- Redis (RedisAnalysisCache), se e' impostato REDIS_URL: pensato per la produzione. Le voci non occupano la
  memoria del processo, sono condivise tra piu' istanze del data agent, e Redis le fa scadere da solo (EX)
  e libera memoria se serve (politica allkeys-lru). Se Redis non risponde, l'analisi si fa comunque:
  la cache non deve mai bloccare una risposta.
- file JSON locale (AnalysisCache), senza REDIS_URL: niente da installare per l'uso in locale. Tiene le
  voci in memoria e le salva in ANALYZE_CACHE_DIR/analyze_cache.json, cosi' sopravvivono ai riavvii.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import threading
import time
import unicodedata
from pathlib import Path

log = logging.getLogger(__name__)

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


class _CacheRules:
    """Regole comuni ai due archivi: cosa si salva, quando una voce e' ancora valida."""

    backend = ""

    def __init__(self, ttl_hours: float, max_entries: int):
        self.ttl_s = ttl_hours * 3600
        self.max_entries = max_entries

    @property
    def enabled(self) -> bool:
        return self.ttl_s > 0

    def _new_entry(self, result: dict, now: float) -> dict | None:
        """Voce da salvare, oppure None se il risultato non va in cache (risposta vuota)."""
        if not (result.get("answer") or "").strip():
            return None
        stored = {k: v for k, v in result.items() if k not in _NOT_STORED}
        return {"result": stored, "created_at": now, "last_hit_at": now, "hits": 0}

    def _is_valid(self, entry: dict | None, charts_dir: Path, now: float) -> bool:
        return (
            entry is not None
            and now - entry["created_at"] <= self.ttl_s
            and all((charts_dir / c["filename"]).is_file() for c in entry["result"].get("charts", []))
        )


class AnalysisCache(_CacheRules):
    """Archivio su file JSON locale (default, senza REDIS_URL)."""

    backend = "file"

    def __init__(self, directory: Path, ttl_hours: float, max_entries: int):
        super().__init__(ttl_hours, max_entries)
        self.file = directory / "analyze_cache.json"
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

    def get(self, key: str, charts_dir: Path, now: float | None = None) -> dict | None:
        """Risultato salvato, oppure None se manca, e' scaduto o uno dei suoi PNG non esiste piu'."""
        if not self.enabled:
            return None
        now = time.time() if now is None else now
        with self._lock:
            entry = self._entries.get(key)
            if not self._is_valid(entry, charts_dir, now):
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
        now = time.time() if now is None else now
        entry = self._new_entry(result, now) if self.enabled else None
        if entry is None:
            return False
        with self._lock:
            self._entries[key] = entry
            self._prune(now)
            self._save()
        return True

    def status(self) -> dict:
        with self._lock:
            return {"backend": self.backend, "entries": len(self._entries), "hits": self.hits,
                    "misses": self.misses, "ttl_hours": self.ttl_s / 3600}

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


class RedisAnalysisCache(_CacheRules):
    """
    Archivio su Redis. Chiavi (con un prefisso comune):
      entry:<chiave>  la voce in JSON, con scadenza EX = ANALYZE_CACHE_TTL_HOURS
      lru             sorted set chiave -> ultimo utilizzo: serve a rispettare il limite di voci
      stats           hash con utilizzi e analisi non trovate, condivisi tra le istanze
    """

    backend = "redis"

    def __init__(self, client, ttl_hours: float, max_entries: int, prefix: str = "management-ai:analysis:"):
        super().__init__(ttl_hours, max_entries)
        self.redis = client
        self.prefix = prefix
        self._unavailable = False  # per non ripetere l'avviso a ogni richiesta

    @classmethod
    def from_url(cls, url: str, ttl_hours: float, max_entries: int) -> RedisAnalysisCache:
        import redis

        # timeout brevi: se Redis non risponde, l'analisi non deve restare ferma ad aspettarlo
        client = redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2)
        return cls(client, ttl_hours, max_entries)

    def _key(self, name: str) -> str:
        return self.prefix + name

    def _entry_key(self, key: str) -> str:
        return self._key(f"entry:{key}")

    def _call(self, action):
        """Esegue un'operazione su Redis; se Redis non risponde restituisce None invece di fallire."""
        import redis

        try:
            result = action()
        except redis.RedisError as e:
            if not self._unavailable:
                log.warning("Cache delle analisi su Redis non disponibile (%s): le analisi si fanno senza cache", e)
            self._unavailable = True
            return None
        if self._unavailable:
            log.info("Cache delle analisi su Redis di nuovo disponibile")
            self._unavailable = False
        return result

    def get(self, key: str, charts_dir: Path, now: float | None = None) -> dict | None:
        if not self.enabled:
            return None
        now = time.time() if now is None else now
        raw = self._call(lambda: self.redis.get(self._entry_key(key)))
        entry = json.loads(raw) if raw else None
        if not self._is_valid(entry, charts_dir, now):
            def miss():
                pipe = self.redis.pipeline()
                if entry is not None:
                    pipe.delete(self._entry_key(key))
                # anche una voce gia' scaduta in Redis lascia il suo riferimento nell'indice: lo tolgo
                pipe.zrem(self._key("lru"), key)
                pipe.hincrby(self._key("stats"), "misses", 1)
                pipe.execute()
            self._call(miss)
            return None
        entry["last_hit_at"] = now
        entry["hits"] = entry.get("hits", 0) + 1

        def hit():
            pipe = self.redis.pipeline()
            pipe.set(self._entry_key(key), json.dumps(entry, ensure_ascii=False), keepttl=True)
            pipe.zadd(self._key("lru"), {key: now})
            pipe.hincrby(self._key("stats"), "hits", 1)
            pipe.execute()
        self._call(hit)
        return entry["result"]  # gia' una copia: arriva da json.loads

    def put(self, key: str, result: dict, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        entry = self._new_entry(result, now) if self.enabled else None
        if entry is None:
            return False

        def store():
            pipe = self.redis.pipeline()
            pipe.set(self._entry_key(key), json.dumps(entry, ensure_ascii=False), ex=math.ceil(self.ttl_s))
            pipe.zadd(self._key("lru"), {key: now})
            pipe.execute()
            self._prune(now)
            return True
        return bool(self._call(store))

    def status(self) -> dict:
        def read():
            now = time.time()
            pipe = self.redis.pipeline()
            pipe.zcount(self._key("lru"), now - self.ttl_s, "+inf")
            pipe.hgetall(self._key("stats"))
            return pipe.execute()
        res = self._call(read)
        base = {"backend": self.backend, "ttl_hours": self.ttl_s / 3600}
        if res is None:
            return base | {"available": False}
        entries, stats = res
        return base | {"available": True, "entries": entries, "hits": int(stats.get(b"hits", 0)),
                       "misses": int(stats.get(b"misses", 0))}

    def _prune(self, now: float) -> None:
        lru = self._key("lru")
        # le voci scadute le elimina Redis (EX); qui si toglie solo il loro riferimento nell'indice
        self.redis.zremrangebyscore(lru, "-inf", now - self.ttl_s)
        excess = self.redis.zcard(lru) - self.max_entries
        if excess > 0:
            oldest = [k.decode() for k in self.redis.zrange(lru, 0, excess - 1)]
            pipe = self.redis.pipeline()
            pipe.delete(*[self._entry_key(k) for k in oldest])
            pipe.zrem(lru, *oldest)
            pipe.execute()


def analysis_cache_from_env() -> AnalysisCache | RedisAnalysisCache:
    """Redis se REDIS_URL e' impostato, altrimenti il file JSON in ANALYZE_CACHE_DIR."""
    ttl_hours = float(os.getenv("ANALYZE_CACHE_TTL_HOURS", "24"))
    max_entries = int(os.getenv("ANALYZE_CACHE_MAX_ENTRIES", "200"))
    url = os.getenv("REDIS_URL", "").strip()
    if url:
        return RedisAnalysisCache.from_url(url, ttl_hours, max_entries)
    return AnalysisCache(Path(os.getenv("ANALYZE_CACHE_DIR", BASE_DIR / "cache")), ttl_hours, max_entries)
