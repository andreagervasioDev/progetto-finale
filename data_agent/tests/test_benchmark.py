"""Benchmark: i dataset ingranditi restano realistici e il report si genera."""

import json

from benchmark import PANDAS_ANALYSES, main, scaled_raw
from cleaning import clean_dataset


def test_il_dataset_ingrandito_ha_la_dimensione_chiesta_e_le_stesse_anomalie(raw_matches):
    big = scaled_raw(raw_matches, 4000)
    assert len(big) == 4000
    # ogni copia ha match_id diversi: i soli duplicati sono quelli gia' presenti nel file vero
    copies = -(-4000 // len(raw_matches))
    assert 0 < big.duplicated().sum() <= raw_matches.duplicated().sum() * copies
    clean, report = clean_dataset(big)
    assert report.rows_clean == len(clean) > 3800


def test_le_analisi_funzionano_sui_dati_puliti(cleaned_matches):
    clean, _ = cleaned_matches
    for name, fn in PANDAS_ANALYSES.items():
        assert len(fn(clean)) > 0, name


def test_il_report_viene_scritto(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.argv", ["benchmark.py", "--sizes", "1578", "--repeat", "1", "--out", str(tmp_path)])
    main()
    report = json.loads((tmp_path / "results.json").read_text())
    assert report["results"][0]["rows"] == 1578
    assert report["results"][0]["startup_peak_mb"] > 0
    assert "Quando cambiare strumento" in (tmp_path / "results.md").read_text()
