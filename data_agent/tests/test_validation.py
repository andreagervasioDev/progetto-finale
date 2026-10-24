"""Validazione all'avvio: colonne e tipi del CSV delle partite."""

import pandas as pd
import pytest

from cleaning import clean_dataset
from validation import EXPECTED_SCHEMA, SchemaError, check_columns, check_types, validate


def test_il_csv_del_progetto_e_valido(raw_matches):
    clean, report, result = validate(raw_matches, clean_dataset)
    assert result.ok, result.errors
    assert result.warnings == []
    assert report.rows_clean == len(clean) == 1539


def test_lo_schema_atteso_copre_tutte_le_colonne(raw_matches):
    assert set(EXPECTED_SCHEMA) == set(raw_matches.columns)


def test_colonna_mancante_blocca_l_avvio(raw_matches):
    with pytest.raises(SchemaError, match="Colonne mancanti nel CSV: xg, wellness_score"):
        validate(raw_matches.drop(columns=["xg", "wellness_score"]), clean_dataset)


def test_colonna_in_piu_e_righe_poche_sono_avvisi(raw_matches):
    df = raw_matches.head(200).assign(note="x")
    result = check_columns(df)
    assert result.ok
    assert any("note" in w for w in result.warnings)
    assert any("200 righe" in w for w in result.warnings)


def test_pulizia_fallita_diventa_messaggio_chiaro(raw_matches):
    df = raw_matches.copy()
    df["goals"] = df["goals"].astype(object)
    df.loc[0, "goals"] = "due"  # non convertibile: la pulizia non riesce a renderla intera
    with pytest.raises(SchemaError, match="La pulizia del CSV non e' riuscita"):
        validate(df, clean_dataset)


def test_tipo_sbagliato_dopo_la_pulizia(cleaned_matches):
    clean, _ = cleaned_matches
    df = clean.copy()
    df["xg"] = df["xg"].astype(str)
    df["match_date"] = df["match_date"].dt.strftime("%d/%m/%Y")
    errors = check_types(df).errors
    assert "Colonna 'xg': tipo atteso decimale, trovato testo." in errors
    assert "Colonna 'match_date': tipo atteso data, trovato testo." in errors


def test_categoria_non_riconosciuta(cleaned_matches):
    clean, _ = cleaned_matches
    df = clean.copy()
    df.loc[df.index[0], "position"] = "Ala"
    assert any("'position'" in e and "Ala" in e for e in check_types(df).errors)


def test_intero_con_valori_mancanti_e_accettato(cleaned_matches):
    clean, _ = cleaned_matches
    df = clean.copy()
    df["days_out"] = df["days_out"].astype(float)
    df.loc[df.index[0], "days_out"] = float("nan")
    assert check_types(df).ok


def test_health_espone_la_validazione():
    from fastapi.testclient import TestClient

    from app import app

    with TestClient(app) as client:
        body = client.get("/health").json()
        assert body["validation"] == {"ok": True, "errors": [], "warnings": []}
        assert client.get("/datasets/partite/overview?rows=1").json()["validation"]["ok"] is True


def test_dataframe_vuoto_segnala_tutte_le_colonne():
    result = check_columns(pd.DataFrame())
    assert not result.ok
    assert "match_id" in result.errors[0]
