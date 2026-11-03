"""
Limite effettivo sulla dimensione dei file caricati.

Due livelli, cosi' un file troppo grande non viene mai letto per intero:
1. BodySizeLimitMiddleware (ASGI) sulle rotte di caricamento: rifiuta subito la richiesta se l'header
   Content-Length supera il limite, altrimenti conta i byte del corpo mentre arrivano e interrompe la
   lettura appena si supera la soglia (anche per i caricamenti senza Content-Length). Risposta: 413.
2. read_limited(): legge il file ricevuto a blocchi e si ferma al primo blocco oltre il limite.
"""

from __future__ import annotations

import json

from fastapi import HTTPException, UploadFile

CHUNK_SIZE = 1024 * 1024
# il corpo multipart contiene, oltre al file, i campi id e title e i separatori
MULTIPART_OVERHEAD = 64 * 1024


class BodyTooLarge(Exception):
    pass


def too_large_message(max_bytes: int) -> str:
    return f"File troppo grande (massimo {max_bytes // (1024 * 1024)} MB)."


class BodySizeLimitMiddleware:
    def __init__(self, app, max_bytes: int, paths: tuple[str, ...], methods: tuple[str, ...] = ("POST",)):
        self.app = app
        self.max_bytes = max_bytes
        self.max_body = max_bytes + MULTIPART_OVERHEAD
        self.paths = paths
        self.methods = methods

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in self.methods or scope["path"] not in self.paths:
            return await self.app(scope, receive, send)

        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > self.max_body:
            # nemmeno un byte del corpo viene letto
            return await self._reject(send)

        received = 0
        started = False
        rejected = False

        async def limited_receive():
            nonlocal received, rejected
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body and not rejected:
                    # rispondo subito con 413 e chiudo: FastAPI trasformerebbe l'errore di lettura in un 400
                    rejected = True
                    if not started:
                        await self._reject(send)
                    raise BodyTooLarge
            return message

        async def tracking_send(message):
            nonlocal started
            if rejected:
                return  # la risposta 413 e' gia' partita: scarto quella dell'app
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except BodyTooLarge:
            pass

    async def _reject(self, send):
        body = json.dumps({"detail": too_large_message(self.max_bytes)}).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                                (b"connection", b"close")]})
        await send({"type": "http.response.body", "body": body})


async def read_limited(file: UploadFile, max_bytes: int) -> bytes:
    """Legge il file a blocchi da 1 MB; oltre `max_bytes` si ferma e risponde 413."""
    data = bytearray()
    while chunk := await file.read(CHUNK_SIZE):
        data += chunk
        if len(data) > max_bytes:
            raise HTTPException(413, too_large_message(max_bytes))
    return bytes(data)
