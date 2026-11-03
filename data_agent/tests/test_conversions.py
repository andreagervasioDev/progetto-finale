"""
Conversioni prudenti dei file caricati: formati misti, date ambigue, colonne eterogenee.
Regola: si converte solo se ogni valore e' interpretabile senza indovinare; altrimenti la colonna resta
testo, nessun valore cambia e il report spiega perche'.
"""

import numpy as np
import pandas as pd
import pytest

from conversions import convert_dates, convert_numbers
from datasets import generic_clean, load_table


def numbers(values):
    return convert_numbers(pd.Series(values, dtype=object), "col")


def dates(values):
    return convert_dates(pd.Series(values, dtype=object), "col")


# --------------------------------------------------------------------------- #
# Numeri: formati misti e ambigui
# --------------------------------------------------------------------------- #
def test_numero_ambiguo_senza_indizi_resta_testo():
    r = numbers(["1.200", "3.500", "12.000"])  # mille e duecento o uno virgola due?
    assert r.values is None
    assert "numeri ambigui" in r.message and "'1.200'" in r.message


def test_numero_ambiguo_risolto_dal_resto_della_colonna_e_segnalato():
    r = numbers(["1.200", "850,50", "2.400.000"])  # virgola decimale e gruppi di migliaia: formato italiano
    assert r.values.tolist() == [1200.0, 850.5, 2400000.0]
    assert "formato italiano" in r.message
    assert "1 valori ambigui letti con il formato del resto della colonna (es. '1.200' -> 1200)" in r.message


def test_stesso_testo_formato_inglese():
    r = numbers(["1,200", "0.5", "2,400,000"])
    assert r.values.tolist() == [1200.0, 0.5, 2400000.0]
    assert "formato inglese" in r.message


def test_formati_italiano_e_inglese_mescolati_resta_testo():
    r = numbers(["1.234,56", "1,234.56", "10"])
    assert r.values is None
    assert "formati numerici misti" in r.message


def test_valute_diverse_resta_testo():
    r = numbers(["€ 100", "$ 200", "300"])
    assert r.values is None and "valute diverse" in r.message


def test_percentuali_mescolate_a_numeri_senza_percento_resta_testo():
    r = numbers(["15%", "0,15", "20%"])
    assert r.values is None and "scala non certa" in r.message


def test_percentuali_tutte_con_simbolo():
    r = numbers(["15%", "7,5%", "100%"])
    assert r.values.tolist() == [15.0, 7.5, 100.0]
    assert "percentuali come numeri da 0 a 100" in r.message


@pytest.mark.parametrize("bad", ["1.2.3", "1,23,4", "12..5"])
def test_separatori_non_validi_non_diventano_numeri(bad):
    r = numbers(["10", "20", bad])
    assert r.values is None and f"'{bad}'" in r.message


# --------------------------------------------------------------------------- #
# Colonne eterogenee e segnaposti di dato mancante
# --------------------------------------------------------------------------- #
def test_colonna_eterogenea_non_perde_i_testi():
    values = ["1.200,00", "850,50", "in prestito", "300,00", "da definire"]
    r = numbers(values)
    assert r.values is None  # prima "in prestito" e "da definire" diventavano NaN in silenzio
    assert "valori eterogenei, 2 su 5 non sono numeri ('in prestito', 'da definire')" in r.message


def test_segnaposti_di_dato_mancante_diventano_vuoti_e_vengono_contati():
    r = numbers(["1.200,00", "n.d.", "-", "N/A", "850,50"])
    assert r.values.tolist()[0] == 1200.0 and r.values.tolist()[4] == 850.5
    assert np.isnan(r.values.tolist()[1:4]).all()
    assert "3 segnaposti di dato mancante ('n.d.', '-', 'N/A') lasciati vuoti" in r.message


def test_celle_excel_numeriche_e_testuali_mescolate():
    r = numbers([1200, 850.5, "1.000,00", None])
    assert r.values.tolist()[:3] == [1200.0, 850.5, 1000.0]


def test_colonna_di_testo_non_viene_segnalata():
    assert numbers(["Okafor", "Rossi", "Bianchi"]) is None
    assert numbers(["Rossi", "Bianchi", "10"]) is None  # in prevalenza testo: e' una colonna di testo


def test_valori_booleani_non_sono_numeri():
    assert numbers([True, False, True]) is None


# --------------------------------------------------------------------------- #
# Date ambigue e formati misti
# --------------------------------------------------------------------------- #
def test_date_tutte_ambigue_restano_testo():
    r = dates(["03/04/2025", "05/06/2025", "01/02/2025"])  # 3 aprile o 4 marzo?
    assert r.values is None and "date ambigue" in r.message


def test_ordine_giorno_mese_provato_da_un_valore():
    r = dates(["03/04/2025", "25/12/2025"])  # 25 non puo' essere un mese: giorno/mese
    assert r.values.tolist() == [pd.Timestamp(2025, 4, 3), pd.Timestamp(2025, 12, 25)]
    assert "gg/mm/aaaa" in r.message


def test_ordine_americano_provato_da_un_valore():
    r = dates(["03/04/2025", "12/25/2025"])
    assert r.values.tolist() == [pd.Timestamp(2025, 3, 4), pd.Timestamp(2025, 12, 25)]
    assert "mm/gg/aaaa" in r.message


def test_ordine_incoerente_resta_testo():
    r = dates(["25/03/2025", "03/25/2025"])
    assert r.values is None and "incoerente" in r.message


def test_formati_misti_iso_e_italiano():
    r = dates(["2025-03-12", "15/01/2024", "01.07.2025", "2025-07-01 18:30"])
    assert r.values.tolist() == [pd.Timestamp(2025, 3, 12), pd.Timestamp(2024, 1, 15),
                                 pd.Timestamp(2025, 7, 1), pd.Timestamp(2025, 7, 1, 18, 30)]
    assert "aaaa-mm-gg e gg/mm/aaaa" in r.message


def test_anni_a_due_cifre_segnalati():
    r = dates(["15/01/24", "30/06/99"])
    assert r.values.tolist() == [pd.Timestamp(2024, 1, 15), pd.Timestamp(1999, 6, 30)]
    assert "2 anni a due cifre" in r.message


def test_data_inesistente_resta_testo():
    r = dates(["31/02/2025", "15/03/2025"])
    assert r.values is None and "1 date inesistenti ('31/02/2025')" in r.message


def test_date_eterogenee_restano_testo():
    r = dates(["15/03/2025", "inizio stagione", "20/04/2025"])
    assert r.values is None and "'inizio stagione'" in r.message


def test_segnaposti_nelle_date():
    r = dates(["15/03/2025", "n.d.", "20/04/2025"])
    assert r.values.isna().tolist() == [False, True, False]
    assert "1 segnaposti di dato mancante" in r.message


# --------------------------------------------------------------------------- #
# Pulizia completa di un file: tracciabilita' nel report e dati originali intatti
# --------------------------------------------------------------------------- #
MESSY_CSV = """Calciatore;Valore;Ingaggio;Data firma;Note scadenza;Rinnovo
Okafor;1.200;€ 2.400.000,00;25/03/2024;30/06/2027;03/04/2025
Rossi;3.500;n.d.;03/04/2024;in trattativa;05/06/2025
Bianchi;12.000;€ 850.000,50;2024-07-01;30/06/2026;01/02/2025
"""


def test_file_misto_report_completo_e_nessun_dato_perso():
    raw = load_table(MESSY_CSV.encode(), "contratti.csv")
    df, report = generic_clean(raw)
    steps = "\n".join(report.steps)
    # "Calciatore" e "Valore" non sono piu' scambiati per date per via di "al" dentro la parola
    assert df["Calciatore"].tolist() == ["Okafor", "Rossi", "Bianchi"]
    # 1.200 / 3.500 / 12.000 senza indizi: restano testo, con il motivo
    assert df["Valore"].tolist() == ["1.200", "3.500", "12.000"]
    assert "Colonna 'Valore': lasciata come testo: numeri ambigui" in steps
    # importi italiani con un segnaposto
    assert df["Ingaggio"].iloc[0] == 2400000.0 and np.isnan(df["Ingaggio"].iloc[1])
    assert "1 segnaposti di dato mancante ('n.d.')" in steps
    # date miste ma con l'ordine provato da 25/03
    assert df["Data firma"].tolist() == [pd.Timestamp(2024, 3, 25), pd.Timestamp(2024, 4, 3), pd.Timestamp(2024, 7, 1)]
    # una colonna con testo libero resta testo
    assert df["Note scadenza"].iloc[1] == "in trattativa"
    assert "Colonna 'Note scadenza': lasciata come testo: valori eterogenei" in steps
    # date tutte ambigue: testo
    assert df["Rinnovo"].tolist() == ["03/04/2025", "05/06/2025", "01/02/2025"]
    assert "Colonna 'Rinnovo': lasciata come testo: date ambigue" in steps


def test_lo_schema_per_l_llm_riporta_le_colonne_lasciate_come_testo():
    from datasets import DatasetStore

    from agent import SCHEMA_DESCRIPTION
    from conftest import CSV_PATH

    store = DatasetStore(CSV_PATH, SCHEMA_DESCRIPTION)
    ds = store.add("test-contratti-01", "Contratti", "contratti.csv", MESSY_CSV.encode())
    try:
        assert "Pulizia automatica applicata:" in ds.schema
        assert "Colonna 'Valore': lasciata come testo: numeri ambigui" in ds.schema
    finally:
        store.remove("test-contratti-01")
