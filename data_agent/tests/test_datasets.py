"""Pulizia generica dei file CSV / Excel caricati dagli utenti (formati italiani) e archivio dei dataset."""

import io

import pandas as pd
import pytest

from datasets import BUILTIN_ID, DatasetStore, generic_clean, load_table

# CSV "sporco" come lo esporterebbe un ufficio amministrativo: punto e virgola, formati italiani,
# spazi, una riga duplicata e una riga vuota
DIRTY_CSV = """Giocatore ;Ingaggio lordo;Bonus %;Data firma;Scadenza
 Victor Okafor ;€ 2.400.000,00;15%;01/07/2025;30/06/2028
Marco Rossi;€ 850.000,50;10%;15/01/2024;30/06/2026
Luca Bianchi;1.200.000;5%;02/09/2023;30/06/2027
Luca Bianchi;1.200.000;5%;02/09/2023;30/06/2027
;;;;
"""


@pytest.fixture
def cleaned():
    raw = load_table(DIRTY_CSV.encode("utf-8"), "ingaggi.csv")
    return raw, *generic_clean(raw)


def test_separatore_punto_e_virgola_riconosciuto(cleaned):
    raw, _, _ = cleaned
    assert raw.shape[1] == 5


def test_nomi_colonne_e_testi_ripuliti(cleaned):
    _, df, _ = cleaned
    assert "Giocatore" in df.columns
    assert "Victor Okafor" in set(df["Giocatore"])


def test_righe_vuote_e_duplicate_rimosse(cleaned):
    _, df, report = cleaned
    assert len(df) == 3
    assert report.rows_raw == 5 and report.rows_clean == 3
    assert any("1 riga duplicata" in s for s in report.steps)


def test_importi_e_percentuali_in_formato_italiano(cleaned):
    _, df, _ = cleaned
    assert df["Ingaggio lordo"].tolist() == [2400000.0, 850000.5, 1200000.0]
    assert df["Bonus %"].tolist() == [15.0, 10.0, 5.0]


def test_date_gg_mm_aaaa(cleaned):
    _, df, _ = cleaned
    assert pd.api.types.is_datetime64_any_dtype(df["Scadenza"])
    assert df["Scadenza"].iloc[0] == pd.Timestamp(2028, 6, 30)
    assert df["Data firma"].iloc[1] == pd.Timestamp(2024, 1, 15)


def test_excel_letto_dal_primo_foglio_con_dati():
    buf = io.BytesIO()
    with pd.ExcelWriter(buf) as writer:
        pd.DataFrame().to_excel(writer, sheet_name="Copertina", index=False)
        pd.DataFrame({"Sponsor": ["Alfa", "Beta"], "Importo": [500000, 250000]}).to_excel(writer, sheet_name="Dati", index=False)
    df = load_table(buf.getvalue(), "sponsor.xlsx")
    assert list(df.columns) == ["Sponsor", "Importo"]


def test_archivio_aggiunge_e_rimuove_e_protegge_il_dataset_partite():
    from agent import SCHEMA_DESCRIPTION
    from conftest import CSV_PATH

    store = DatasetStore(CSV_PATH, SCHEMA_DESCRIPTION)
    ds = store.add("test-ingaggi-01", "Ingaggi", "ingaggi.csv", DIRTY_CSV.encode("utf-8"))
    assert ds.summary()["rows"] == 3
    # un nuovo archivio rilegge il registro dal disco (dataset conservati dopo il riavvio)
    assert DatasetStore(CSV_PATH, SCHEMA_DESCRIPTION).get("test-ingaggi-01") is not None
    assert store.remove("test-ingaggi-01") is True
    assert store.remove(BUILTIN_ID) is False
    with pytest.raises(ValueError):
        store.add("../../etc", "x", "x.csv", DIRTY_CSV.encode())
    with pytest.raises(ValueError):
        store.add("test-exe-01", "x", "x.exe", b"MZ")


@pytest.mark.parametrize(
    "values, expected",
    [
        (["1.200.000", "850.000,50", "1.200"], [1200000.0, 850000.5, 1200.0]),  # italiano
        (["0,45", "1,5", "2"], [0.45, 1.5, 2.0]),  # virgola decimale
        (["1,234.56", "0.45", "12"], [1234.56, 0.45, 12.0]),  # inglese
        (["€ 300", "15%", "-2"], [300.0, 15.0, -2.0]),  # simboli
    ],
)
def test_conversione_numeri_per_colonna(values, expected):
    from datasets import _to_number

    assert _to_number(pd.Series(values)).tolist() == expected
