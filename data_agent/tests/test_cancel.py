"""
Annullamento delle analisi: se il backend chiude la richiesta (l'utente ha annullato la domanda),
il pandas agent si ferma prima della chiamata a OpenAI o del blocco di codice successivo.
Nessun test chiama OpenAI: si usano un client finto e, nel test completo, un finto server OpenAI.
"""

import asyncio
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

import agent as agent_module
from agent import AnalysisCancelled, PandasAgent
from conftest import AGENT_DIR, CSV_PATH
from datasets import DatasetStore


def _tool_call_message():
    call = SimpleNamespace(id="call_1", function=SimpleNamespace(arguments=json.dumps({"code": "print(len(df))", "thought": ""})))
    msg = SimpleNamespace(content=None, tool_calls=[call])
    msg.model_dump = lambda exclude_none=True: {"role": "assistant", "content": None}
    return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=None, model="finto")


class FakeClient:
    """Client OpenAI finto: conta le chiamate e puo' 'annullare' la richiesta durante una chiamata."""

    def __init__(self, cancel_during_call: threading.Event | None = None):
        self.calls = 0
        self.cancel_during_call = cancel_during_call
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **_):
        self.calls += 1
        if self.cancel_during_call is not None:
            self.cancel_during_call.set()  # il backend chiude mentre OpenAI sta rispondendo
        return _tool_call_message()


@pytest.fixture(scope="module")
def store():
    from agent import SCHEMA_DESCRIPTION

    return DatasetStore(CSV_PATH, SCHEMA_DESCRIPTION)


def make_agent(store, client):
    agent = PandasAgent.__new__(PandasAgent)  # senza costruire il client OpenAI vero
    agent.store, agent.client, agent.model = store, client, "finto"
    return agent


def test_richiesta_gia_annullata_nessuna_chiamata_a_openai(store):
    cancel = threading.Event()
    cancel.set()
    client = FakeClient()
    with pytest.raises(AnalysisCancelled):
        make_agent(store, client).analyze("Chi ha segnato di piu'?", None, store.get("partite"), cancel)
    assert client.calls == 0


def test_annullata_durante_la_chiamata_niente_codice_e_niente_passo_successivo(store, monkeypatch):
    cancel = threading.Event()
    client = FakeClient(cancel_during_call=cancel)
    ran = []
    monkeypatch.setattr(agent_module.PythonExecutor, "run", lambda self, code: ran.append(code) or "")
    with pytest.raises(AnalysisCancelled):
        make_agent(store, client).analyze("Chi ha segnato di piu'?", None, store.get("partite"), cancel)
    assert client.calls == 1
    assert ran == []


def test_senza_annullamento_il_ciclo_prosegue(store, monkeypatch):
    monkeypatch.setattr(agent_module, "MAX_STEPS", 2)
    client = FakeClient()
    client.chat.completions.create = lambda **kw: (FakeClient.create(client, **kw) if client.calls < 2 else _final())
    result = make_agent(store, client).analyze("Chi ha segnato di piu'?", None, store.get("partite"), threading.Event())
    assert client.calls == 2 and result["answer"] == "Fatto."


def _final():
    msg = SimpleNamespace(content="Fatto.", tool_calls=None)
    msg.model_dump = lambda exclude_none=True: {"role": "assistant", "content": "Fatto."}
    return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=None, model="finto")


def test_il_client_openai_ha_un_timeout_esplicito(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-non-usata")
    client = PandasAgent(store=None).client
    assert client.timeout == agent_module.OPENAI_TIMEOUT_S == 60
    assert client.max_retries == agent_module.OPENAI_MAX_RETRIES == 1


def test_watch_disconnect_imposta_l_evento(monkeypatch):
    from app import watch_disconnect

    monkeypatch.setattr("app.DISCONNECT_POLL_S", 0.01)
    answers = iter([False, False, True])

    class FakeRequest:
        async def is_disconnected(self):
            return next(answers)

    cancel = threading.Event()
    asyncio.run(watch_disconnect(FakeRequest(), cancel))
    assert cancel.is_set()


# --------------------------------------------------------------------------- #
# Test completo: uvicorn vero, finto OpenAI lento, il "backend" chiude a meta'
# --------------------------------------------------------------------------- #
def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_backend_che_chiude_la_richiesta_ferma_l_analisi(tmp_path):
    calls = []

    class FakeOpenAI(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            calls.append(time.time())
            time.sleep(1.5)  # nel frattempo il backend chiude la connessione
            body = json.dumps({
                "id": "x", "object": "chat.completion", "created": 0, "model": "finto",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None,
                             "tool_calls": [{"id": "c1", "type": "function",
                                             "function": {"name": "run_python", "arguments": "{\"code\": \"print(1)\"}"}}]}}],
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    fake = ThreadingHTTPServer(("127.0.0.1", 0), FakeOpenAI)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    port = _free_port()
    env = os.environ | {"OPENAI_API_KEY": "sk-test-non-usata", "OPENAI_BASE_URL": f"http://127.0.0.1:{fake.server_port}/v1",
                        "OPENAI_MAX_RETRIES": "0"}
    log_file = tmp_path / "uvicorn.log"
    with open(log_file, "w") as log:
        proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--port", str(port)],
                                cwd=AGENT_DIR, env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        body = json.dumps({"question": "Chi ha corso di piu' in assoluto?"}).encode()
        with socket.create_connection(("127.0.0.1", port)) as conn:
            conn.sendall(b"POST /analyze HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                         + f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
            time.sleep(0.5)  # la prima chiamata a OpenAI e' in corso
        # connessione chiusa: come fa il backend quando l'utente annulla
        deadline = time.time() + 5
        while "Analisi interrotta" not in log_file.read_text() and time.time() < deadline:
            time.sleep(0.1)
        time.sleep(0.5)
        assert "Analisi interrotta" in log_file.read_text()
        assert len(calls) == 1  # senza annullamento seguirebbero il codice e una seconda chiamata
    finally:
        proc.terminate()
        proc.wait(5)
        fake.shutdown()
