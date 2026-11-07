"""
Retention dei grafici: i PNG salvati da chart() hanno nomi univoci e senza pulizia si accumulano.

All'avvio e poi a intervalli regolari si eliminano i PNG piu' vecchi di CHARTS_RETENTION_DAYS giorni
(default 30; 0 = nessuna eliminazione). Si toccano solo i file con il nome generato da chart()
("chart_<esadecimale>.png"): qualsiasi altro file nella cartella resta dov'e'.

Effetto sulle conversazioni: i grafici disegnati in React dai dati (spec JSON) restano visibili, perche'
i dati sono salvati nella conversazione; manca solo il download del PNG. I grafici "solo immagine"
delle prime versioni mostrano "Grafico non piu' disponibile".
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

CHART_FILE = re.compile(r"^chart_[a-f0-9]+\.png$")
DAY = 24 * 60 * 60
# pausa minima tra due pulizie: con un intervallo 0 o negativo il ciclo non gira a vuoto
MIN_INTERVAL_S = 60.0


@dataclass
class RetentionPolicy:
    days: float  # eta' massima di un PNG; 0 = nessuna eliminazione
    interval_hours: float  # ogni quanto ripetere la pulizia

    @classmethod
    def from_env(cls) -> RetentionPolicy:
        return cls(
            days=float(os.getenv("CHARTS_RETENTION_DAYS", "30")),
            interval_hours=float(os.getenv("CHARTS_CLEANUP_INTERVAL_HOURS", "6")),
        )

    @property
    def enabled(self) -> bool:
        return self.days > 0


def chart_files(charts_dir: Path) -> list[Path]:
    """PNG generati da chart(): file normali (non link) con il nome previsto."""
    if not charts_dir.is_dir():
        return []
    return [p for p in charts_dir.iterdir() if CHART_FILE.match(p.name) and p.is_file() and not p.is_symlink()]


def cleanup_charts(charts_dir: Path, days: float, now: float | None = None) -> dict:
    """Elimina i PNG piu' vecchi di `days` giorni. Restituisce quanti file ha eliminato e quanti restano."""
    if days <= 0:
        return {"removed": 0, "freed_mb": 0.0, "kept": len(chart_files(charts_dir))}
    limit = (now if now is not None else time.time()) - days * DAY
    removed, freed, kept = 0, 0, 0
    for path in chart_files(charts_dir):
        try:
            stat = path.stat()
            if stat.st_mtime < limit:
                path.unlink()
                removed += 1
                freed += stat.st_size
            else:
                kept += 1
        except FileNotFoundError:  # eliminato nel frattempo: niente da fare
            continue
    return {"removed": removed, "freed_mb": round(freed / 2**20, 2), "kept": kept}


def charts_status(charts_dir: Path, policy: RetentionPolicy) -> dict:
    """Stato per /health: quanti PNG ci sono e quanto spazio occupano."""
    files = chart_files(charts_dir)
    size = 0
    for p in files:
        try:
            size += p.stat().st_size
        except FileNotFoundError:
            continue
    return {"files": len(files), "size_mb": round(size / 2**20, 2), "retention_days": policy.days}


async def retention_loop(charts_dir: Path, policy: RetentionPolicy) -> None:
    """Pulizia all'avvio e poi ogni `interval_hours` ore, in un thread per non bloccare il server."""
    if not policy.enabled:
        log.info("Retention dei grafici disattivata (CHARTS_RETENTION_DAYS=0)")
        return
    log.info("Retention dei grafici: PNG eliminati dopo %s giorni, controllo ogni %s ore",
             f"{policy.days:g}", f"{policy.interval_hours:g}")
    while True:
        try:
            result = await asyncio.to_thread(cleanup_charts, charts_dir, policy.days)
            if result["removed"]:
                log.info("Retention dei grafici: eliminati %s PNG (%s MB), ne restano %s",
                         result["removed"], result["freed_mb"], result["kept"])
        except Exception:  # noqa: BLE001 - un errore di disco non deve fermare il servizio
            log.exception("Retention dei grafici non riuscita")
        await asyncio.sleep(max(policy.interval_hours * 3600, MIN_INTERVAL_S))
