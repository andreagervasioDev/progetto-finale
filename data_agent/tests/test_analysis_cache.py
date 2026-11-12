"""
Cache delle analisi: chiave (domanda, contesto, dataset, versione dei dati, modello), scadenza, PNG, limite.

Le regole valgono per tutti gli archivi, quindi gli stessi test girano su:
- "file":  file JSON locale (default senza REDIS_URL);
- "fakeredis": Redis in memoria (fakeredis), sempre disponibile;
- "redis": un Redis vero, se REDIS_TEST_URL e' impostato (in GitHub Actions c'e' un container Redis).
"""

import json
import os
import uuid

import fakeredis
import pytest

from analysis_cache import AnalysisCache, RedisAnalysisCache, analysis_cache_from_env, cache_key, normalize
from datasets import data_version

KEY_ARGS = dict(question="Chi sono i migliori marcatori?", context=None, dataset_id="partite", data_version="v1", model="m")
REDIS_TEST_URL = os.getenv("REDIS_TEST_URL", "")


def _result(answer="Okafor con 12 gol.", charts=()):
    return {"answer": answer, "charts": list(charts), "tables": [], "steps": [{"code": "df.head()"}],
            "dataset": {"id": "partite"}, "cleaning_report": {}, "usage": [{"model": "m", "calls": 3}], "elapsed_s": 9.1}


@pytest.fixture(params=["file", "fakeredis", pytest.param("redis", marks=pytest.mark.skipif(
    not REDIS_TEST_URL, reason="REDIS_TEST_URL non impostato: Redis vero solo in CI"))])
def make_cache(request, tmp_path):
    """Crea cache dello stesso archivio: due chiamate = due istanze sugli stessi dati (riavvio o altra istanza)."""
    if request.param == "file":
        yield lambda ttl_hours=24, max_entries=10, max_mb=20, max_entry_kb=512: AnalysisCache(
            tmp_path / "cache", ttl_hours, max_entries, max_mb, max_entry_kb)
        return
    if request.param == "fakeredis":
        client = fakeredis.FakeRedis(server=fakeredis.FakeServer())
    else:
        import redis

        client = redis.Redis.from_url(REDIS_TEST_URL)
    prefix = f"test:{uuid.uuid4().hex}:"  # chiavi separate per ogni test
    yield lambda ttl_hours=24, max_entries=10, max_mb=20, max_entry_kb=512: RedisAnalysisCache(
        client, ttl_hours, max_entries, max_mb, max_entry_kb, prefix=prefix)
    keys = list(client.scan_iter(f"{prefix}*"))
    if keys:
        client.delete(*keys)


# --------------------------------------------------------------------------- #
# Chiave
# --------------------------------------------------------------------------- #
def test_normalizzazione_della_domanda():
    assert normalize("  Chi sono i MIGLIORI   marcatori?? ") == "chi sono i migliori marcatori"
    assert normalize(None) == ""


def test_la_chiave_cambia_con_ogni_componente():
    base = cache_key(**KEY_ARGS)
    assert base == cache_key(**{**KEY_ARGS, "question": "chi sono i migliori marcatori"})
    for change in ({"question": "Chi ha più assist?"}, {"context": "soglia wellness < 5"}, {"dataset_id": "altro"},
                   {"data_version": "v2"}, {"model": "gpt-4.1"}):
        assert cache_key(**{**KEY_ARGS, **change}) != base, change


def test_la_versione_dei_dati_cambia_con_il_file():
    assert data_version(b"a,b\n1,2\n", "cleaning.py") != data_version(b"a,b\n1,3\n", "cleaning.py")
    assert data_version(b"a,b\n1,2\n", "cleaning.py") == data_version(b"a,b\n1,2\n", "cleaning.py")


# --------------------------------------------------------------------------- #
# Regole comuni: stessi test su file, fakeredis e (in CI) Redis vero
# --------------------------------------------------------------------------- #
def test_salva_e_ritrova_senza_token_ne_tempi(make_cache, tmp_path):
    cache = make_cache()
    key = cache_key(**KEY_ARGS)
    assert cache.get(key, tmp_path) is None
    assert cache.put(key, _result())
    hit = cache.get(key, tmp_path)
    assert hit["answer"] == "Okafor con 12 gol."
    assert "usage" not in hit and "elapsed_s" not in hit
    status = cache.status()
    assert (status["entries"], status["hits"], status["misses"], status["ttl_hours"]) == (1, 1, 1, 24)


def test_il_risultato_restituito_e_una_copia(make_cache, tmp_path):
    cache = make_cache()
    key = cache_key(**KEY_ARGS)
    cache.put(key, _result())
    cache.get(key, tmp_path)["answer"] = "modificata da chi la usa"
    assert cache.get(key, tmp_path)["answer"] == "Okafor con 12 gol."


def test_scadenza(make_cache, tmp_path):
    cache = make_cache(ttl_hours=1)
    key = cache_key(**KEY_ARGS)
    cache.put(key, _result(), now=1000)
    assert cache.get(key, tmp_path, now=1000 + 3599)
    assert cache.get(key, tmp_path, now=1000 + 3601) is None


def test_se_il_png_e_stato_eliminato_l_analisi_si_rifa(make_cache, tmp_path):
    cache = make_cache()
    png = tmp_path / "chart_abc123.png"
    png.write_bytes(b"x")
    key = cache_key(**KEY_ARGS)
    cache.put(key, _result(charts=[{"filename": png.name, "title": "Gol"}]))
    assert cache.get(key, tmp_path)
    png.unlink()  # eliminato dalla retention dei grafici
    assert cache.get(key, tmp_path) is None
    assert cache.status()["entries"] == 0


def test_risposte_vuote_non_si_salvano(make_cache):
    assert not make_cache().put(cache_key(**KEY_ARGS), _result(answer="  "))


def test_limite_di_voci(make_cache, tmp_path):
    cache = make_cache(max_entries=2)
    keys = [cache_key(**{**KEY_ARGS, "question": q}) for q in ("uno", "due", "tre")]
    cache.put(keys[0], _result(), now=1)
    cache.put(keys[1], _result(), now=2)
    cache.get(keys[0], tmp_path, now=3)  # la prima diventa la più recente
    cache.put(keys[2], _result(), now=4)
    assert cache.get(keys[1], tmp_path, now=5) is None
    assert cache.get(keys[0], tmp_path, now=5) and cache.get(keys[2], tmp_path, now=5)


def test_durata_zero_disattiva(make_cache, tmp_path):
    cache = make_cache(ttl_hours=0)
    key = cache_key(**KEY_ARGS)
    assert not cache.put(key, _result())
    assert cache.get(key, tmp_path) is None


def test_condivisa_tra_istanze_e_riavvii(make_cache, tmp_path):
    # file: un riavvio del data agent; Redis: anche un'altra istanza del data agent
    key = cache_key(**KEY_ARGS)
    make_cache().put(key, _result())
    assert make_cache().get(key, tmp_path)["answer"] == "Okafor con 12 gol."


# --------------------------------------------------------------------------- #
# Spazio occupato: limite in MB oltre al numero di voci
# --------------------------------------------------------------------------- #
def _sized(kb: int, name: str = "x") -> dict:
    """Analisi che occupa circa `kb` KB (per esempio una tabella grande)."""
    return _result(answer=name + "a" * (kb * 1024))


def _keys(n: int) -> list[str]:
    return [cache_key(**{**KEY_ARGS, "question": f"domanda {i}"}) for i in range(n)]


def test_il_limite_in_mb_conta_la_dimensione_non_il_numero(make_cache, tmp_path):
    # 100 voci ammesse, ma solo 1 MB: con analisi da 300 KB ne stanno 3, non 100
    cache = make_cache(max_entries=100, max_mb=1)
    keys = _keys(5)
    for i, key in enumerate(keys):
        assert cache.put(key, _sized(300, str(i)), now=i + 1)
    status = cache.status()
    assert status["entries"] == 3
    assert 0.85 <= status["size_mb"] <= 1 and status["max_mb"] == 1
    # restano le più recenti, sono uscite le usate meno di recente
    assert [cache.get(k, tmp_path, now=10) is not None for k in keys] == [False, False, True, True, True]


def test_oltre_lo_spazio_esce_la_voce_usata_meno_di_recente(make_cache, tmp_path):
    cache = make_cache(max_entries=100, max_mb=1)
    a, b, c, d = _keys(4)
    for i, key in enumerate((a, b, c)):
        cache.put(key, _sized(300, str(i)), now=i + 1)
    cache.get(a, tmp_path, now=5)  # la prima torna la più recente
    cache.put(d, _sized(300, "d"), now=6)
    assert cache.get(b, tmp_path, now=7) is None  # esce b, non a
    assert all(cache.get(k, tmp_path, now=7) for k in (a, c, d))


def test_una_voce_piu_grande_dell_intera_cache_non_si_salva(make_cache, tmp_path):
    cache = make_cache(max_mb=1, max_entry_kb=0)  # solo il limite totale
    small, big = _keys(2)
    cache.put(small, _sized(10))
    assert cache.put(big, _sized(1100)) is False  # da sola supera 1 MB
    status = cache.status()
    assert status["too_large"] == 1 and status["entries"] == 1  # le altre voci restano
    assert cache.get(small, tmp_path) is not None


def test_limite_per_singola_voce(make_cache, tmp_path):
    # 20 MB di spazio totale non bastano a far entrare una sola risposta enorme: il limite è per voce
    cache = make_cache(max_mb=20, max_entry_kb=512)
    ok, big = _keys(2)
    assert cache.put(ok, _sized(400))  # sotto 512 KB
    assert cache.put(big, _sized(600)) is False  # 600 KB: nessuna eccezione, l'analisi semplicemente non va in cache
    assert cache.get(big, tmp_path) is None
    status = cache.status()
    assert (status["entries"], status["too_large"], status["max_entry_kb"]) == (1, 1, 512)
    assert status["size_mb"] < 0.5  # la voce rifiutata non occupa spazio


def test_limite_per_voce_predefinito_512_kb(make_cache):
    cache = make_cache()
    assert cache.put(_keys(1)[0], _sized(600)) is False
    assert cache.status()["max_entry_kb"] == 512


def test_limite_per_voce_zero_vuol_dire_solo_il_limite_totale(make_cache):
    cache = make_cache(max_mb=20, max_entry_kb=0)
    assert cache.put(_keys(1)[0], _sized(600))


def test_rifiutata_anche_dopo_un_riavvio_non_compare(make_cache, tmp_path):
    big = _keys(1)[0]
    make_cache().put(big, _sized(600))
    assert make_cache().get(big, tmp_path) is None  # niente su disco o in Redis


def test_limite_zero_in_mb_vuol_dire_nessun_limite_di_spazio(make_cache):
    cache = make_cache(max_entries=100, max_mb=0)
    for key in _keys(5):
        assert cache.put(key, _sized(300))
    assert cache.status()["entries"] == 5


def test_lo_spazio_riportato_corrisponde_ai_byte_salvati(make_cache):
    cache = make_cache()
    cache.put(_keys(1)[0], _sized(500))
    assert 0.48 <= cache.status()["size_mb"] <= 0.5  # circa 500 KB


# --------------------------------------------------------------------------- #
# Solo file e solo Redis
# --------------------------------------------------------------------------- #
def test_file_voci_salvate_prima_della_misura_dello_spazio(tmp_path):
    # file scritto dalla versione precedente: le voci non hanno il campo "size"
    key = cache_key(**KEY_ARGS)
    (tmp_path / "analyze_cache.json").write_text(json.dumps(
        {key: {"result": _sized(200), "created_at": 1e12, "last_hit_at": 1e12, "hits": 0}}))
    status = AnalysisCache(tmp_path, ttl_hours=24, max_entries=10).status()
    assert status["entries"] == 1 and status["size_mb"] >= 0.19


def test_redis_una_voce_scaduta_non_occupa_piu_spazio():
    client, cache = _fake_cache(ttl_hours=1)
    first, second = _keys(2)
    cache.put(first, _sized(300))
    client.delete(cache._entry_key(first))  # come se Redis l'avesse fatta scadere (EX)
    assert cache.status()["entries"] == 0 and cache.status()["size_mb"] == 0
    cache.put(second, _sized(10))  # al salvataggio successivo gli indici vengono ripuliti
    assert client.hkeys(cache._key("sizes")) == [second.encode()]
    assert client.zrange(cache._key("lru"), 0, -1) == [second.encode()]


class _RedisWithInfo:
    """fakeredis non implementa INFO: questo client restituisce valori di memoria scelti dal test."""

    def __init__(self, used_mb: float, max_mb: float, evicted: int = 0):
        self._real = fakeredis.FakeRedis(server=fakeredis.FakeServer())
        self.memory = {"used_memory": int(used_mb * 1024 * 1024), "maxmemory": int(max_mb * 1024 * 1024),
                       "maxmemory_policy": "allkeys-lru"}
        self.stats = {"evicted_keys": evicted}

    def info(self, section):
        return self.memory if section == "memory" else self.stats

    def __getattr__(self, name):
        return getattr(self._real, name)


def test_redis_stato_della_memoria_del_server():
    cache = RedisAnalysisCache(_RedisWithInfo(used_mb=10, max_mb=25, evicted=3), 24, 10, max_mb=15)
    assert cache.status()["redis"] == {"used_mb": 10.0, "maxmemory_mb": 25.0, "used_pct": 40.0,
                                       "policy": "allkeys-lru", "evicted_keys": 3}


def test_redis_avviso_quando_la_memoria_e_quasi_piena(caplog):
    client = _RedisWithInfo(used_mb=21, max_mb=25)  # 84%
    cache = RedisAnalysisCache(client, 24, 10, max_mb=15)
    a, b, c = _keys(3)
    with caplog.at_level("WARNING"):
        cache.put(a, _result())
        cache.put(b, _result())  # ancora sopra la soglia: nessun secondo avviso
    assert [r.getMessage() for r in caplog.records].count(
        "Redis al 84.0% della memoria (21.0 di 25.0 MB): abbassa ANALYZE_CACHE_MAX_MB") == 1
    client.memory["used_memory"] = 5 * 1024 * 1024  # la memoria scende: l'avviso si potrà ripetere
    cache.put(c, _result())
    assert cache._memory_warned is False


def test_redis_senza_info_lo_stato_resta_disponibile():
    _, cache = _fake_cache()  # fakeredis risponde "comando sconosciuto", come un provider che disattiva INFO
    status = cache.status()
    assert status["available"] is True and status["redis"] is None


@pytest.mark.skipif(not REDIS_TEST_URL, reason="REDIS_TEST_URL non impostato: Redis vero solo in CI")
def test_redis_vero_riporta_la_memoria():
    import redis

    cache = RedisAnalysisCache(redis.Redis.from_url(REDIS_TEST_URL), 24, 10, prefix=f"test:{uuid.uuid4().hex}:")
    memory = cache.status()["redis"]
    assert memory["used_mb"] > 0 and memory["evicted_keys"] >= 0
    assert memory["policy"]
def test_file_durata_zero_non_crea_la_cartella(tmp_path):
    AnalysisCache(tmp_path / "cache", ttl_hours=0, max_entries=10)
    assert not (tmp_path / "cache").exists()


def _fake_cache(**kwargs):
    client = fakeredis.FakeRedis(server=fakeredis.FakeServer())
    return client, RedisAnalysisCache(client, kwargs.get("ttl_hours", 1), kwargs.get("max_entries", 10))


def test_redis_fa_scadere_le_voci_da_solo(tmp_path):
    client, cache = _fake_cache(ttl_hours=1)
    key = cache_key(**KEY_ARGS)
    cache.put(key, _result())
    entry_key = cache._entry_key(key)
    assert 3590 <= client.ttl(entry_key) <= 3600  # EX: niente pulizia manuale delle voci scadute
    cache.get(key, tmp_path)
    assert client.ttl(entry_key) <= 3600  # un utilizzo non allunga la scadenza (conta dalla creazione)


def test_redis_statistiche_condivise_tra_istanze(tmp_path):
    client = fakeredis.FakeRedis(server=fakeredis.FakeServer())
    a = RedisAnalysisCache(client, 24, 10)
    b = RedisAnalysisCache(client, 24, 10)
    key = cache_key(**KEY_ARGS)
    a.put(key, _result())
    b.get(key, tmp_path)
    a.get(key, tmp_path)
    sa, sb = a.status(), b.status()
    assert sa == sb
    assert (sa["entries"], sa["hits"], sa["misses"], sa["too_large"]) == (1, 2, 0, 0)
    assert sa["size_mb"] == sb["size_mb"] and sa["max_mb"] == 20


def test_redis_non_raggiungibile_l_analisi_si_fa_comunque(tmp_path):
    # porta chiusa: ogni operazione fallisce, ma la cache non deve mai bloccare /analyze
    cache = RedisAnalysisCache.from_url("redis://127.0.0.1:1", ttl_hours=24, max_entries=10)
    key = cache_key(**KEY_ARGS)
    assert cache.get(key, tmp_path) is None
    assert cache.put(key, _result()) is False
    assert cache.status() == {"backend": "redis", "ttl_hours": 24, "available": False}


def test_scelta_dell_archivio_da_ambiente(monkeypatch, tmp_path):
    monkeypatch.setenv("ANALYZE_CACHE_DIR", str(tmp_path))
    monkeypatch.setenv("REDIS_URL", "")
    monkeypatch.setenv("ANALYZE_CACHE_MAX_ENTRY_KB", "256")
    monkeypatch.setenv("ANALYZE_CACHE_MAX_MB", "5")
    file_cache = analysis_cache_from_env()
    assert isinstance(file_cache, AnalysisCache)
    assert (file_cache.max_entry_kb, file_cache.max_mb, file_cache.max_entry_bytes) == (256, 5, 256 * 1024)
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:6379/0")
    monkeypatch.setenv("ANALYZE_CACHE_TTL_HOURS", "12")
    cache = analysis_cache_from_env()
    assert isinstance(cache, RedisAnalysisCache) and cache.ttl_s == 12 * 3600


# --------------------------------------------------------------------------- #
# /analyze
# --------------------------------------------------------------------------- #
def test_analyze_risponde_dalla_cache_senza_openai():
    from fastapi.testclient import TestClient

    import app as app_module
    from agent import data_agent_model

    with TestClient(app_module.app) as client:
        ds = app_module.state["store"].get("partite")
        question = "Quanti gol ha segnato la squadra?"
        key = cache_key(question, None, ds.id, ds.version, data_agent_model())
        app_module.ANALYSIS_CACHE.put(key, _result(answer="162 gol."))

        # nei test non c'e' la chiave OpenAI: senza cache /analyze risponderebbe 503
        body = client.post("/analyze", json={"question": "quanti gol ha segnato la squadra"}).json()
        assert body["answer"] == "162 gol."
        assert body["cached"] is True
        assert body["usage"] == []  # nessun token da contare di nuovo
        assert client.post("/analyze", json={"question": "Una domanda mai fatta"}).status_code == 503
        health = client.get("/health").json()["analysis_cache"]
        assert health["backend"] == "file" and health["hits"] >= 1


def test_analyze_con_redis_non_raggiungibile_risponde_lo_stesso(monkeypatch):
    from fastapi.testclient import TestClient

    import app as app_module

    monkeypatch.setattr(app_module, "ANALYSIS_CACHE", RedisAnalysisCache.from_url("redis://127.0.0.1:1", 24, 10))
    with TestClient(app_module.app) as client:
        # senza chiave OpenAI arriva al 503 dell'agente: la cache irraggiungibile non ha causato un 500
        assert client.post("/analyze", json={"question": "Chi ha segnato di più?"}).status_code == 503
        assert client.get("/health").json()["analysis_cache"]["available"] is False
