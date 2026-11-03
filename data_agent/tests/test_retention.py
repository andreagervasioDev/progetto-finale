"""Retention dei grafici: si eliminano solo i PNG di chart() piu' vecchi della soglia."""

import asyncio
import os
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
