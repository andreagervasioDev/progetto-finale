"""Limite di caricamento: un file troppo grande non viene mai letto per intero."""

import asyncio
import io
import json

import pytest
from fastapi import HTTPException, UploadFile

from upload_limit import MULTIPART_OVERHEAD, BodySizeLimitMiddleware, read_limited

LIMIT = 1000


def _run(middleware, scope, chunks):
    """Esegue il middleware con un corpo diviso in `chunks`; restituisce status, corpo e blocchi letti."""
    consumed = 0
    sent = []

    async def receive():
        nonlocal consumed
        if consumed < len(chunks):
            consumed += 1
            return {"type": "http.request", "body": chunks[consumed - 1], "more_body": consumed < len(chunks)}
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body, consumed


async def _reading_app(scope, receive, send):
    """App di prova che legge tutto il corpo, come fa il parser multipart."""
    while (await receive()).get("more_body"):
        pass
    await send({"type": "http.response.start", "status": 201, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


def _scope(headers=(), path="/datasets", method="POST"):
    return {"type": "http", "method": method, "path": path, "headers": list(headers)}


def test_content_length_oltre_il_limite_rifiutato_senza_leggere():
    mw = BodySizeLimitMiddleware(_reading_app, LIMIT, ("/datasets",))
    big = str(LIMIT + MULTIPART_OVERHEAD + 1).encode()
    status, body, consumed = _run(mw, _scope([(b"content-length", big)]), [b"x" * 100] * 20)
    assert status == 413
    assert consumed == 0  # nemmeno un blocco letto
    assert "troppo grande" in json.loads(body)["detail"]


def test_corpo_senza_content_length_interrotto_appena_supera_la_soglia():
    mw = BodySizeLimitMiddleware(_reading_app, LIMIT, ("/datasets",))
    chunk = b"x" * 10_000
    status, _, consumed = _run(mw, _scope(), [chunk] * 50)
    assert status == 413
    assert consumed == 7  # 7 x 10.000 > 1.000 + 65.536: si ferma qui, non legge gli altri 43


def test_corpo_nei_limiti_passa():
    mw = BodySizeLimitMiddleware(_reading_app, LIMIT, ("/datasets",))
    status, body, _ = _run(mw, _scope([(b"content-length", b"500")]), [b"x" * 500])
    assert (status, body) == (201, b"ok")


def test_altre_rotte_non_sono_limitate():
    mw = BodySizeLimitMiddleware(_reading_app, LIMIT, ("/datasets",))
    status, _, consumed = _run(mw, _scope(path="/analyze"), [b"x" * 100_000] * 3)
    assert status == 201 and consumed == 3


def test_lettura_a_blocchi_si_ferma_oltre_il_limite():
    source = io.BytesIO(b"x" * (5 * 1024 * 1024))
    upload = UploadFile(source, filename="grande.csv")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(read_limited(upload, 2 * 1024 * 1024))
    assert exc.value.status_code == 413
    assert source.tell() == 3 * 1024 * 1024  # letti 3 blocchi da 1 MB su 5


def test_lettura_a_blocchi_nei_limiti():
    upload = UploadFile(io.BytesIO(b"a,b\n1,2\n"), filename="ok.csv")
    assert asyncio.run(read_limited(upload, LIMIT)) == b"a,b\n1,2\n"


def test_endpoint_rifiuta_un_file_oltre_20_mb():
    from fastapi.testclient import TestClient

    from app import MAX_UPLOAD_BYTES, app

    with TestClient(app) as client:
        res = client.post("/datasets", data={"id": "troppo-grande", "title": "Grande"},
                          files={"file": ("grande.csv", b"a" * (MAX_UPLOAD_BYTES + 1), "text/csv")})
        assert res.status_code == 413
        assert res.json()["detail"] == "File troppo grande (massimo 20 MB)."
        assert "troppo-grande" not in [d["id"] for d in client.get("/datasets").json()]
