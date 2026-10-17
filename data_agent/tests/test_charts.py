"""Grafici e tabelle dell'analisi: specifica JSON per il frontend React e PNG con matplotlib."""

import json

import numpy as np
import pandas as pd
import pytest

from charts import MAX_SERIES, PALETTE, ChartError, build_chart_spec, build_table, make_helpers, render_png


@pytest.fixture
def marcatori():
    return pd.Series([12, 9, 7], index=pd.Index(["Okafor", "Rossi", "Bianchi"], name="Giocatore"), name="Gol")


def test_una_series_di_groupby_diventa_un_grafico(marcatori):
    spec = build_chart_spec(marcatori, kind="barh", title="Migliori marcatori")
    assert spec["type"] == "barh"
    assert spec["xLabel"] == "Giocatore" and spec["yLabel"] == "Gol"
    assert spec["series"] == [{"key": "s0", "label": "Gol", "color": PALETTE[0]}]
    assert spec["data"][0] == {"x": "Okafor", "s0": 12}


def test_piu_serie_con_colori_in_ordine_fisso():
    df = pd.DataFrame({"mese": ["2025-01", "2025-02"], "Gol": [3, 5], "xG": [2.5, 4.25]})
    spec = build_chart_spec(df, kind="line", x="mese", y=["Gol", "xG"])
    assert [s["color"] for s in spec["series"]] == PALETTE[:2]
    assert spec["data"][1] == {"x": "2025-02", "s0": 5, "s1": 4.25}


def test_la_specifica_e_json_valido_con_nan_date_e_tipi_numpy():
    df = pd.DataFrame(
        {"data": pd.to_datetime(["2025-03-12", "2025-03-19"]), "valore": [np.float64(1.23456), np.nan]}
    )
    spec = build_chart_spec(df, kind="line", x="data", y="valore")
    json.dumps(spec)  # non deve sollevare eccezioni
    assert spec["data"][0] == {"x": "2025-03-12", "s0": 1.2346}
    assert spec["data"][1]["s0"] is None


@pytest.mark.parametrize(
    "kwargs, messaggio",
    [
        ({"kind": "torta"}, "non supportato"),
        ({"kind": "bar", "x": "inesistente"}, "non trovata"),
        ({"kind": "bar", "x": "nome", "y": "nome"}, "non è numerica"),
        ({"kind": "scatter", "x": "nome", "y": "a"}, "deve essere numerica"),
    ],
)
def test_errori_comprensibili_per_l_llm(kwargs, messaggio):
    df = pd.DataFrame({"nome": ["a", "b"], "a": [1, 2]})
    with pytest.raises(ChartError, match=messaggio):
        build_chart_spec(df, **kwargs)


def test_troppi_punti_o_troppe_serie_vengono_rifiutati():
    with pytest.raises(ChartError, match="Troppi punti"):
        build_chart_spec(pd.DataFrame({"x": range(100), "y": range(100)}), kind="bar", x="x", y="y")
    df = pd.DataFrame({"x": [1], **{f"c{i}": [i] for i in range(MAX_SERIES + 1)}})
    with pytest.raises(ChartError, match="Massimo"):
        build_chart_spec(df, kind="bar", x="x")


def test_render_png_salva_l_immagine(tmp_path, marcatori):
    for kind in ("bar", "barh", "line"):
        path = tmp_path / f"{kind}.png"
        render_png(build_chart_spec(marcatori, kind=kind, title="Prova"), path)
        assert path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    scatter = build_chart_spec(pd.DataFrame({"xg": [0.5, 1.2], "gol": [1, 2]}), kind="scatter", x="xg", y="gol")
    render_png(scatter, tmp_path / "scatter.png")
    assert (tmp_path / "scatter.png").exists()


def test_tabella_con_colonne_numeriche_e_limite_di_righe():
    df = pd.DataFrame({"Ruolo": ["ATT"] * 60, "Minuti": np.arange(60, dtype=float)})
    t = build_table(df, title="Minuti")
    assert t["columns"] == [
        {"key": "c0", "label": "Ruolo", "numeric": False},
        {"key": "c1", "label": "Minuti", "numeric": True},
    ]
    assert len(t["rows"]) == 50 and t["totalRows"] == 60
    assert t["rows"][1] == {"c0": "ATT", "c1": 1.0}


def test_make_helpers_raccoglie_grafici_e_tabelle(tmp_path, marcatori):
    charts, tables = [], []
    chart, table = make_helpers(tmp_path, charts, tables)
    assert "creato" in chart(marcatori, kind="bar", title="Gol")
    assert "creata" in table(marcatori.reset_index(), title="Classifica")
    assert charts[0]["spec"]["title"] == "Gol" and (tmp_path / charts[0]["filename"]).exists()
    assert tables[0]["title"] == "Classifica"


def test_le_istruzioni_del_pandas_agent_si_costruiscono_e_citano_chart_e_table():
    """Le istruzioni sono una f-string: un esempio con parentesi graffe non raddoppiate le romperebbe."""
    from pathlib import Path

    from agent import SCHEMA_DESCRIPTION, build_system_prompt
    from datasets import DatasetStore

    ds = DatasetStore(Path(__file__).parent.parent / "data" / "player_performance.csv", SCHEMA_DESCRIPTION).get("partite")
    prompt = build_system_prompt(ds)
    assert "chart(" in prompt and "table(" in prompt
    assert "rename(columns={'goals': 'Gol'" in prompt
