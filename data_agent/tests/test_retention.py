"""Retention dei grafici: si eliminano solo i PNG di chart() piu' vecchi della soglia."""

import asyncio
import os
import time
from pathlib import Path

from retention import DAY, RetentionPolicy, charts_status, cleanup_charts, retention_loop

NOW = 2_000_000_000.0


def _file(folder: Path, name: str, age_days: float, size: int = 100) -> Path:
    path = folder / name
    path.write_bytes(b"x" * size)
    ts = NOW - age_days * DAY
    os.utime(path, (ts, ts))
    return path


def test_elimina_solo_i_grafici_oltre_la_soglia(tmp_path):
    old = _file(tmp_path, "chart_aaaa000001.png", 31)
    recent = _file(tmp_path, "chart_bbbb000002.png", 29)
    result = cleanup_charts(tmp_path, 30, now=NOW)
    assert result == {"removed": 1, "freed_mb": 0.0, "kept": 1}
    assert not old.exists() and recent.exists()


def test_non_tocca_file_con_altri_nomi_o_link(tmp_path):
    others = [
        _file(tmp_path, ".gitkeep", 400),
        _file(tmp_path, "report.png", 400),
        _file(tmp_path, "chart_ZZZ.png", 400),  # non esadecimale
        _file(tmp_path, "chart_abc.png.bak", 400),
    ]
    target = _file(tmp_path, "chart_cccc000003.png", 400)
    link = tmp_path / "chart_dddd000004.png"
    link.symlink_to(target)
    os.utime(link, (NOW - 400 * DAY,) * 2, follow_symlinks=False)
    cleanup_charts(tmp_path, 30, now=NOW)
    assert all(p.exists() for p in others)
    assert not target.exists()
    assert link.is_symlink()  # il link resta (punta a un file eliminato, ma non e' un nostro PNG)


def test_soglia_zero_disattiva_la_pulizia(tmp_path):
    old = _file(tmp_path, "chart_eeee000005.png", 1000)
    assert cleanup_charts(tmp_path, 0, now=NOW)["removed"] == 0
    assert old.exists()
    assert RetentionPolicy(days=0, interval_hours=6).enabled is False


def test_cartella_mancante(tmp_path):
    assert cleanup_charts(tmp_path / "non-esiste", 30, now=NOW) == {"removed": 0, "freed_mb": 0.0, "kept": 0}


def test_stato_per_health(tmp_path):
    _file(tmp_path, "chart_ffff000006.png", 1, size=2**20)
    _file(tmp_path, "altro.txt", 1)
    status = charts_status(tmp_path, RetentionPolicy(days=30, interval_hours=6))
    assert status == {"files": 1, "size_mb": 1.0, "retention_days": 30}


def test_configurazione_da_ambiente(monkeypatch):
    monkeypatch.setenv("CHARTS_RETENTION_DAYS", "7")
    monkeypatch.setenv("CHARTS_CLEANUP_INTERVAL_HOURS", "1")
    assert RetentionPolicy.from_env() == RetentionPolicy(days=7, interval_hours=1)
    monkeypatch.delenv("CHARTS_RETENTION_DAYS")
    monkeypatch.delenv("CHARTS_CLEANUP_INTERVAL_HOURS")
    assert RetentionPolicy.from_env() == RetentionPolicy(days=30, interval_hours=6)


def test_il_ciclo_pulisce_subito_all_avvio(tmp_path):
    old = _file(tmp_path, "chart_abab000007.png", 0)
    os.utime(old, (0, 0))  # 1970: sicuramente oltre la soglia

    async def run():
        task = asyncio.create_task(retention_loop(tmp_path, RetentionPolicy(days=30, interval_hours=6)))
        for _ in range(100):
            await asyncio.sleep(0.01)
            if not old.exists():
                break
        task.cancel()

    asyncio.run(run())
    assert not old.exists()


# --------------------------------------------------------------------------- #
# Ciclo periodico: il vero retention_loop, con un intervallo di 0,1 secondi
# --------------------------------------------------------------------------- #
INTERVAL_S = 0.1
FAST = RetentionPolicy(days=30, interval_hours=INTERVAL_S / 3600)


def _old_chart(folder: Path, name: str) -> Path:
    path = folder / name
    path.write_bytes(b"x")
    os.utime(path, (0, 0))  # 1970: oltre qualsiasi soglia
    return path


async def _wait_until(condition, timeout: float = 2.0) -> bool:
    for _ in range(int(timeout / 0.01)):
        if condition():
            return True
        await asyncio.sleep(0.01)
    return False


def test_il_ciclo_ripete_la_pulizia_a_ogni_intervallo(tmp_path, monkeypatch):
    import retention

    monkeypatch.setattr(retention, "MIN_INTERVAL_S", 0)
    runs = []
    real_cleanup = retention.cleanup_charts
    monkeypatch.setattr(retention, "cleanup_charts", lambda *a: runs.append(1) or real_cleanup(*a))

    async def run():
        task = asyncio.create_task(retention_loop(tmp_path, FAST))
        assert await _wait_until(lambda: len(runs) == 1)  # pulizia all'avvio
        # grafici scaduti DOPO l'avvio: li elimina solo un giro successivo del ciclo
        for i in range(1, 4):
            old = _old_chart(tmp_path, f"chart_cafe00000{i}.png")
            assert await _wait_until(lambda: not old.exists()), f"giro {i}: il PNG scaduto non è stato eliminato"
        recent = tmp_path / "chart_beef000001.png"
        recent.write_bytes(b"x")  # appena creato: deve restare anche dopo altri giri
        before = len(runs)
        assert await _wait_until(lambda: len(runs) >= before + 2)
        task.cancel()
        return recent.exists()

    assert asyncio.run(run()) is True
    assert len(runs) >= 5  # avvio + almeno 4 giri periodici


def test_tra_due_pulizie_il_ciclo_aspetta_l_intervallo(tmp_path, monkeypatch):
    import retention

    monkeypatch.setattr(retention, "MIN_INTERVAL_S", 0)
    times = []
    monkeypatch.setattr(retention, "cleanup_charts", lambda *a: times.append(time.monotonic()) or {"removed": 0})

    async def run():
        task = asyncio.create_task(retention_loop(tmp_path, FAST))
        await _wait_until(lambda: len(times) >= 4)
        task.cancel()

    asyncio.run(run())
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert gaps and all(g >= INTERVAL_S * 0.9 for g in gaps), gaps  # non gira a vuoto


def test_un_errore_non_ferma_il_ciclo(tmp_path, monkeypatch):
    import retention

    monkeypatch.setattr(retention, "MIN_INTERVAL_S", 0)
    calls = []
    real_cleanup = retention.cleanup_charts

    def flaky(*args):
        calls.append(1)
        if len(calls) == 1:
            raise PermissionError("disco non disponibile")  # primo giro fallito
        return real_cleanup(*args)

    monkeypatch.setattr(retention, "cleanup_charts", flaky)
    old = _old_chart(tmp_path, "chart_dead000001.png")

    async def run():
        task = asyncio.create_task(retention_loop(tmp_path, FAST))
        ok = await _wait_until(lambda: not old.exists())
        task.cancel()
        return ok

    assert asyncio.run(run()) is True  # il giro successivo ha fatto la pulizia
    assert len(calls) >= 2


def test_intervallo_minimo_tra_le_pulizie(tmp_path, monkeypatch):
    import retention

    monkeypatch.setattr(retention, "MIN_INTERVAL_S", 0.2)
    calls = []
    monkeypatch.setattr(retention, "cleanup_charts", lambda *a: calls.append(1) or {"removed": 0})

    async def run():
        # CHARTS_CLEANUP_INTERVAL_HOURS=0: senza minimo il ciclo girerebbe di continuo
        task = asyncio.create_task(retention_loop(tmp_path, RetentionPolicy(days=30, interval_hours=0)))
        await asyncio.sleep(0.5)
        task.cancel()

    asyncio.run(run())
    assert 1 <= len(calls) <= 3


def test_health_e_cartella_dei_test_isolata():
    from fastapi.testclient import TestClient

    import agent
    from app import app

    # i test non lavorano mai sulla cartella vera data_agent/charts
    assert agent.CHARTS_DIR != Path(agent.__file__).parent / "charts"
    with TestClient(app) as client:
        charts = client.get("/health").json()["charts"]
        assert charts["retention_days"] == 30
        assert charts["files"] >= 0
