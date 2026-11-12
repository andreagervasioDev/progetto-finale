"""
Cache delle analisi del data agent: se arriva di nuovo la stessa richiesta sugli stessi dati, il risultato
torna subito, senza chiamare OpenAI ne' rieseguire codice.

La chiave combina:
- la domanda e il contesto, normalizzati (maiuscole, spazi e punteggiatura finale non contano);
- il dataset e la sua versione (impronta del file e del codice di pulizia): se il file o la pulizia
  cambiano, le analisi vecchie non vengono piu' trovate;
- il modello: cambiando DATA_AGENT_MODEL / OPENAI_MODEL le analisi si rifanno.

Limiti:
- durata: le voci scadono dopo ANALYZE_CACHE_TTL_HOURS ore (0 = cache disattivata);
- numero: ne restano al massimo ANALYZE_CACHE_MAX_ENTRIES;
- dimensione di una voce: un'analisi che da sola supera ANALYZE_CACHE_MAX_ENTRY_KB kilobyte (default 512)
  non viene salvata. Anche una sola risposta molto grande (molti grafici fitti, tabelle) occuperebbe molta
  memoria e spazio su disco;
- spazio totale: in tutto le voci occupano al massimo ANALYZE_CACHE_MAX_MB megabyte. Un'analisi con
  grafici e tabelle pesa molto piu' di una risposta di una riga, quindi contare solo le voci non basta.
Per i due limiti di spazio 0 = nessun limite.
Oltre un limite si eliminano le voci usate meno di recente. Una voce i cui PNG sono stati eliminati
dalla retention dei grafici non viene piu' usata. Lo spazio occupato e' in /health (analysis_cache).

Due archivi con le stesse regole:
- Redis (RedisAnalysisCache), se e' impostato REDIS_URL: pensato per la produzione. Le voci non occupano la
  memoria del processo, sono condivise tra piu' istanze del data agent, e Redis le fa scadere da solo (EX).
  /health riporta anche la memoria usata da Redis rispetto al suo massimo e le chiavi che Redis ha dovuto
  eliminare da solo: con ANALYZE_CACHE_MAX_MB sotto il massimo di Redis non dovrebbe succedere. Se Redis
  non risponde, l'analisi si fa comunque: la cache non deve mai bloccare una risposta.
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
MB = 1024 * 1024
# soglia di avviso sulla memoria di Redis (frazione del suo maxmemory)
REDIS_MEMORY_WARNING = 0.8

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


def _encode(entry: dict) -> str:
    return json.dumps(entry, ensure_ascii=False)


def _mb(size: float) -> float:
    return round(size / MB, 2)


class _CacheRules:
    """Regole comuni ai due archivi: cosa si salva, quando una voce e' ancora valida, quanto spazio occupa."""

    backend = ""

    def __init__(self, ttl_hours: float, max_entries: int, max_mb: float = 20, max_entry_kb: float = 512):
        self.ttl_s = ttl_hours * 3600
        self.max_entries = max_entries
        self.max_mb = max_mb
        self.max_entry_kb = max_entry_kb
        self.max_bytes = int(max_mb * MB) if max_mb > 0 else None  # None = nessun limite di spazio
        # una voce non puo' superare il suo limite ne' lo spazio dell'intera cache
        limits = [b for b in (int(max_entry_kb * 1024) if max_entry_kb > 0 else None, self.max_bytes) if b]
        self.max_entry_bytes = min(limits) if limits else None

    @property
    def enabled(self) -> bool:
        return self.ttl_s > 0

    def _new_entry(self, result: dict, now: float) -> dict | None:
        """Voce da salvare, oppure None se il risultato non va in cache (risposta vuota)."""
        if not (result.get("answer") or "").strip():
            return None
        stored = {k: v for k, v in result.items() if k not in _NOT_STORED}
        entry = {"result": stored, "created_at": now, "last_hit_at": now, "hits": 0}
        # spazio occupato: i byte del JSON salvato, misurati una volta al salvataggio
        entry["size"] = len(_encode(entry).encode())
        return entry

    def _too_large(self, entry: dict) -> bool:
        if self.max_entry_bytes is not None and entry["size"] > self.max_entry_bytes:
            log.warning("Analisi non salvata in cache: %s KB, oltre il limite di %s KB per voce",
                        round(entry["size"] / 1024), round(self.max_entry_bytes / 1024))
            return True
        return False

    def _is_valid(self, entry: dict | None, charts_dir: Path, now: float) -> bool:
        return (
            entry is not None
            and now - entry["created_at"] <= self.ttl_s
            and all((charts_dir / c["filename"]).is_file() for c in entry["result"].get("charts", []))
        )

    def _over_limits(self, count: int, total_bytes: int) -> bool:
        return count > self.max_entries or (self.max_bytes is not None and total_bytes > self.max_bytes)

    def _space(self, total_bytes: int) -> dict:
        return {"size_mb": _mb(total_bytes), "max_mb": self.max_mb, "max_entry_kb": self.max_entry_kb}


class AnalysisCache(_CacheRules):
    """Archivio su file JSON locale (default, senza REDIS_URL)."""

    backend = "file"

    def __init__(self, directory: Path, ttl_hours: float, max_entries: int, max_mb: float = 20,
                 max_entry_kb: float = 512):
        super().__init__(ttl_hours, max_entries, max_mb, max_entry_kb)
        self.file = directory / "analyze_cache.json"
        self.hits = 0
        self.misses = 0
        self.too_large = 0
        self._lock = threading.Lock()
        self._entries: dict[str, dict] = {}
        if self.enabled:
            directory.mkdir(parents=True, exist_ok=True)
            try:
                self._entries = json.loads(self.file.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                self._entries = {}
            for entry in self._entries.values():  # voci salvate prima che si misurasse lo spazio
                entry.setdefault("size", len(_encode(entry).encode()))

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
            if self._too_large(entry):
                self.too_large += 1
                return False
            self._entries[key] = entry
            self._prune(now)
            self._save()
        return True

    def status(self) -> dict:
        with self._lock:
            total = sum(e["size"] for e in self._entries.values())
            return {"backend": self.backend, "entries": len(self._entries), "hits": self.hits,
                    "misses": self.misses, "too_large": self.too_large, "ttl_hours": self.ttl_s / 3600,
                    **self._space(total)}

    # --- interni (chiamati con il lock acquisito) ---
    def _prune(self, now: float) -> None:
        expired = [k for k, e in self._entries.items() if now - e["created_at"] > self.ttl_s]
        for k in expired:
            del self._entries[k]
        # oltre il numero di voci o lo spazio: via le voci usate meno di recente
        by_use = sorted(self._entries, key=lambda k: self._entries[k]["last_hit_at"])
        total = sum(e["size"] for e in self._entries.values())
        for k in by_use:
            if not self._over_limits(len(self._entries), total):
                break
            total -= self._entries.pop(k)["size"]

    def _save(self) -> None:
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(_encode(self._entries))
        tmp.replace(self.file)


class RedisAnalysisCache(_CacheRules):
    """
    Archivio su Redis. Chiavi (con un prefisso comune):
      entry:<chiave>  la voce in JSON, con scadenza EX = ANALYZE_CACHE_TTL_HOURS
      lru             sorted set chiave -> ultimo utilizzo: decide quali voci eliminare oltre i limiti
      sizes           hash chiave -> byte della voce: lo spazio occupato dalla cache
      stats           hash con utilizzi, analisi non trovate e voci troppo grandi, condivisi tra le istanze
    """

    backend = "redis"

    def __init__(self, client, ttl_hours: float, max_entries: int, max_mb: float = 20, max_entry_kb: float = 512,
                 prefix: str = "management-ai:analysis:"):
        super().__init__(ttl_hours, max_entries, max_mb, max_entry_kb)
        self.redis = client
        self.prefix = prefix
        self._unavailable = False  # per non ripetere l'avviso a ogni richiesta
        self._memory_warned = False

    @classmethod
    def from_url(cls, url: str, ttl_hours: float, max_entries: int, max_mb: float = 20,
                 max_entry_kb: float = 512) -> RedisAnalysisCache:
        import redis

        # timeout brevi: se Redis non risponde, l'analisi non deve restare ferma ad aspettarlo
        client = redis.Redis.from_url(url, socket_timeout=2, socket_connect_timeout=2)
        return cls(client, ttl_hours, max_entries, max_mb, max_entry_kb)

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
                # anche una voce gia' scaduta in Redis lascia i suoi riferimenti negli indici: li tolgo
                pipe.zrem(self._key("lru"), key)
                pipe.hdel(self._key("sizes"), key)
                pipe.hincrby(self._key("stats"), "misses", 1)
                pipe.execute()
            self._call(miss)
            return None
        entry["last_hit_at"] = now
        entry["hits"] = entry.get("hits", 0) + 1

        def hit():
            pipe = self.redis.pipeline()
            pipe.set(self._entry_key(key), _encode(entry), keepttl=True)
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
        if self._too_large(entry):
            self._call(lambda: self.redis.hincrby(self._key("stats"), "too_large", 1))
            return False

        def store():
            pipe = self.redis.pipeline()
            pipe.set(self._entry_key(key), _encode(entry), ex=math.ceil(self.ttl_s))
            pipe.zadd(self._key("lru"), {key: now})
            pipe.hset(self._key("sizes"), key, entry["size"])
            pipe.execute()
            self._prune()
            self._check_memory()
            return True
        return bool(self._call(store))

    def status(self) -> dict:
        def read():
            sizes = self._live_sizes()
            stats = self.redis.hgetall(self._key("stats"))
            return sizes, stats
        res = self._call(read)
        base = {"backend": self.backend, "ttl_hours": self.ttl_s / 3600}
        if res is None:
            return base | {"available": False}
        sizes, stats = res
        return base | {
            "available": True,
            "entries": len(sizes),
            "hits": int(stats.get(b"hits", 0)),
            "misses": int(stats.get(b"misses", 0)),
            "too_large": int(stats.get(b"too_large", 0)),
            **self._space(sum(sizes.values())),
            "redis": self._call(self.redis_memory),
        }

    def redis_memory(self) -> dict | None:
        """Memoria di Redis (tutto il server, non solo la cache) e chiavi eliminate da Redis per mancanza di memoria."""
        import redis

        try:
            memory = self.redis.info("memory")
            stats = self.redis.info("stats")
        except redis.ResponseError:  # INFO disattivato dal provider: niente dati sulla memoria
            return None
        used, maximum = int(memory.get("used_memory", 0)), int(memory.get("maxmemory", 0))
        return {
            "used_mb": _mb(used),
            "maxmemory_mb": _mb(maximum) if maximum else None,  # 0 = Redis senza un massimo
            "used_pct": round(100 * used / maximum, 1) if maximum else None,
            "policy": memory.get("maxmemory_policy"),
            "evicted_keys": int(stats.get("evicted_keys", 0)),
        }

    # --- interni ---
    def _live_sizes(self) -> dict[str, int]:
        """Byte delle voci ancora presenti: quelle scadute (EX) non contano piu', anche se sono negli indici."""
        sizes = {k.decode(): int(v) for k, v in self.redis.hgetall(self._key("sizes")).items()}
        if not sizes:
            return {}
        pipe = self.redis.pipeline()
        for k in sizes:
            pipe.exists(self._entry_key(k))
        return {k: size for k, size, alive in zip(sizes, sizes.values(), pipe.execute()) if alive}

    def _prune(self) -> None:
        lru, sizes_key = self._key("lru"), self._key("sizes")
        live = self._live_sizes()
        # riferimenti di voci gia' scadute in Redis: li tolgo dagli indici
        stale = [k.decode() for k in self.redis.zrange(lru, 0, -1) if k.decode() not in live]
        stale += [k for k in self.redis.hkeys(sizes_key) if k.decode() not in live]
        if stale:
            pipe = self.redis.pipeline()
            pipe.zrem(lru, *stale)
            pipe.hdel(sizes_key, *stale)
            pipe.execute()
        # oltre il numero di voci o lo spazio: via le voci usate meno di recente
        total = sum(live.values())
        victims = []
        for k in (k.decode() for k in self.redis.zrange(lru, 0, -1)):
            if not self._over_limits(len(live) - len(victims), total):
                break
            victims.append(k)
            total -= live.get(k, 0)
        if victims:
            pipe = self.redis.pipeline()
            pipe.delete(*[self._entry_key(k) for k in victims])
            pipe.zrem(lru, *victims)
            pipe.hdel(sizes_key, *victims)
            pipe.execute()

    def _check_memory(self) -> None:
        """Avviso nel log quando Redis si avvicina al suo massimo di memoria (una volta, finche' non scende)."""
        memory = self._call(self.redis_memory)
        pct = memory and memory["used_pct"]
        if pct is not None and pct >= REDIS_MEMORY_WARNING * 100:
            if not self._memory_warned:
                log.warning("Redis al %s%% della memoria (%s di %s MB): abbassa ANALYZE_CACHE_MAX_MB",
                            pct, memory["used_mb"], memory["maxmemory_mb"])
            self._memory_warned = True
        else:
            self._memory_warned = False


def analysis_cache_from_env() -> AnalysisCache | RedisAnalysisCache:
    """Redis se REDIS_URL e' impostato, altrimenti il file JSON in ANALYZE_CACHE_DIR."""
    ttl_hours = float(os.getenv("ANALYZE_CACHE_TTL_HOURS", "24"))
    max_entries = int(os.getenv("ANALYZE_CACHE_MAX_ENTRIES", "200"))
    max_mb = float(os.getenv("ANALYZE_CACHE_MAX_MB", "20"))
    max_entry_kb = float(os.getenv("ANALYZE_CACHE_MAX_ENTRY_KB", "512"))
    url = os.getenv("REDIS_URL", "").strip()
    if url:
        return RedisAnalysisCache.from_url(url, ttl_hours, max_entries, max_mb, max_entry_kb)
    return AnalysisCache(Path(os.getenv("ANALYZE_CACHE_DIR", BASE_DIR / "cache")), ttl_hours, max_entries, max_mb,
                         max_entry_kb)
