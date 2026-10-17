"""API FastAPI del data agent (senza chiamate a OpenAI)."""

import pytest
from fastapi.testclient import TestClient

from test_datasets import DIRTY_CSV


@pytest.fixture(scope="module")
def client():
    from app import app

    with TestClient(app) as c:  # esegue il lifespan: carica e pulisce il dataset partite
        yield c


def test_health(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["dataset_rows"] == 1539
    assert body["llm_ready"] is False


def test_il_dataset_partite_e_sempre_disponibile(client):
    ids = [d["id"] for d in client.get("/datasets").json()]
    assert "partite" in ids


def test_panoramica_partite(client):
    body = client.get("/datasets/partite/overview?rows=5").json()
    assert body["rows_raw"] == 1578 and body["rows_clean"] == 1539
    assert len(body["preview_clean"]) == 5
    assert body["duplicates_raw"] > 0
    assert body["cleaning_report"]["steps"]


def test_carica_analizza_panoramica_e_rimuovi_un_csv(client):
    res = client.post(
        "/datasets",
        data={"id": "test-api-ingaggi", "title": "Ingaggi"},
        files={"file": ("ingaggi.csv", DIRTY_CSV.encode("utf-8"), "text/csv")},
    )
    assert res.status_code == 201
    assert res.json()["rows"] == 3
    assert client.get("/datasets/test-api-ingaggi/overview").json()["rows_clean"] == 3
    assert client.delete("/datasets/test-api-ingaggi").json() == {"deleted": True}
    assert client.get("/datasets/test-api-ingaggi/overview").status_code == 404


def test_file_non_leggibile_rifiutato(client):
    res = client.post(
        "/datasets",
        data={"id": "test-api-exe", "title": "x"},
        files={"file": ("virus.exe", b"MZ", "application/octet-stream")},
    )
    assert res.status_code == 422


def test_analyze_valida_la_domanda_e_richiede_la_chiave(client):
    assert client.post("/analyze", json={"question": "?"}).status_code == 422
    assert client.post("/analyze", json={"question": "Chi ha segnato di più?"}).status_code == 503


def test_dataset_inesistente(client):
    assert client.get("/datasets/non-esiste/overview").status_code == 404
