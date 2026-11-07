"""
Cache delle analisi: chiave (domanda, contesto, dataset, versione dei dati, modello), scadenza, PNG, limite.

Le regole valgono per tutti gli archivi, quindi gli stessi test girano su:
- "file":  file JSON locale (default senza REDIS_URL);
- "fakeredis": Redis in memoria (fakeredis), sempre disponibile;
- "redis": un Redis vero, se REDIS_TEST_URL e' impostato (in GitHub Actions c'e' un container Redis).
"""

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
        yield lambda ttl_hours=24, max_entries=10: AnalysisCache(tmp_path / "cache", ttl_hours, max_entries)
        return
    if request.param == "fakeredis":
        client = fakeredis.FakeRedis(server=fakeredis.FakeServer())
    else:
        import redis

        client = redis.Redis.from_url(REDIS_TEST_URL)
    prefix = f"test:{uuid.uuid4().hex}:"  # chiavi separate per ogni test
    yield lambda ttl_hours=24, max_entries=10: RedisAnalysisCache(client, ttl_hours, max_entries, prefix=prefix)
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
# Solo file e solo Redis
# --------------------------------------------------------------------------- #
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
    assert a.status() == b.status() == {"backend": "redis", "ttl_hours": 24, "available": True,
                                        "entries": 1, "hits": 2, "misses": 0}


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
    assert isinstance(analysis_cache_from_env(), AnalysisCache)
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
