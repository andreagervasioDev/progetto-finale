"""Cache delle analisi: chiave (domanda, contesto, dataset, versione dei dati, modello), scadenza, PNG, limite."""

from analysis_cache import AnalysisCache, cache_key, normalize
from datasets import data_version

KEY_ARGS = dict(question="Chi sono i migliori marcatori?", context=None, dataset_id="partite", data_version="v1", model="m")


def _result(answer="Okafor con 12 gol.", charts=()):
    return {"answer": answer, "charts": list(charts), "tables": [], "steps": [{"code": "df.head()"}],
            "dataset": {"id": "partite"}, "cleaning_report": {}, "usage": [{"model": "m", "calls": 3}], "elapsed_s": 9.1}


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


def test_salva_e_ritrova_senza_token_ne_tempi(tmp_path):
    cache = AnalysisCache(tmp_path, ttl_hours=24, max_entries=10)
    key = cache_key(**KEY_ARGS)
    assert cache.get(key, tmp_path) is None
    assert cache.put(key, _result())
    hit = cache.get(key, tmp_path)
    assert hit["answer"] == "Okafor con 12 gol."
    assert "usage" not in hit and "elapsed_s" not in hit
    assert cache.status() == {"entries": 1, "hits": 1, "misses": 1, "ttl_hours": 24}


def test_scadenza(tmp_path):
    cache = AnalysisCache(tmp_path, ttl_hours=1, max_entries=10)
    key = cache_key(**KEY_ARGS)
    cache.put(key, _result(), now=1000)
    assert cache.get(key, tmp_path, now=1000 + 3599)
    assert cache.get(key, tmp_path, now=1000 + 3601) is None


def test_se_il_png_e_stato_eliminato_l_analisi_si_rifa(tmp_path):
    cache = AnalysisCache(tmp_path / "cache", ttl_hours=24, max_entries=10)
    png = tmp_path / "chart_abc123.png"
    png.write_bytes(b"x")
    key = cache_key(**KEY_ARGS)
    cache.put(key, _result(charts=[{"filename": png.name, "title": "Gol"}]))
    assert cache.get(key, tmp_path)
    png.unlink()  # eliminato dalla retention dei grafici
    assert cache.get(key, tmp_path) is None
    assert cache.status()["entries"] == 0


def test_risposte_vuote_non_si_salvano(tmp_path):
    cache = AnalysisCache(tmp_path, ttl_hours=24, max_entries=10)
    assert not cache.put(cache_key(**KEY_ARGS), _result(answer="  "))


def test_limite_di_voci(tmp_path):
    cache = AnalysisCache(tmp_path, ttl_hours=24, max_entries=2)
    keys = [cache_key(**{**KEY_ARGS, "question": q}) for q in ("uno", "due", "tre")]
    cache.put(keys[0], _result(), now=1)
    cache.put(keys[1], _result(), now=2)
    cache.get(keys[0], tmp_path, now=3)  # la prima diventa la più recente
    cache.put(keys[2], _result(), now=4)
    assert cache.get(keys[1], tmp_path, now=5) is None
    assert cache.get(keys[0], tmp_path, now=5) and cache.get(keys[2], tmp_path, now=5)


def test_durata_zero_disattiva(tmp_path):
    cache = AnalysisCache(tmp_path / "cache", ttl_hours=0, max_entries=10)
    key = cache_key(**KEY_ARGS)
    assert not cache.put(key, _result())
    assert cache.get(key, tmp_path) is None
    assert not (tmp_path / "cache").exists()


def test_sopravvive_al_riavvio(tmp_path):
    key = cache_key(**KEY_ARGS)
    AnalysisCache(tmp_path, ttl_hours=24, max_entries=10).put(key, _result())
    assert AnalysisCache(tmp_path, ttl_hours=24, max_entries=10).get(key, tmp_path)["answer"]


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
        assert client.get("/health").json()["analysis_cache"]["hits"] >= 1
