"""Pulizia del dataset delle partite: ogni anomalia introdotta in generate_dataset.py deve essere corretta."""

import pandas as pd

from cleaning import COMPETITION_MAP, POSITION_MAP, VALID_RANGES, VENUE_MAP


def test_il_csv_ha_almeno_1000_righe_e_contiene_anomalie(raw_matches):
    assert len(raw_matches) >= 1000
    assert raw_matches.duplicated().sum() > 0, "attesi duplicati"
    assert raw_matches.isna().sum().sum() > 0, "attesi valori mancanti"
    assert not raw_matches["match_date"].astype(str).str.match(r"^\d{4}-\d{2}-\d{2}$").all(), "attese date in più formati"


def test_righe_grezze_e_pulite(cleaned_matches):
    df, report = cleaned_matches
    assert report.rows_raw == 1578
    assert report.rows_clean == len(df) == 1539
    assert report.steps, "il report deve descrivere i passaggi"


def test_nessun_duplicato(cleaned_matches):
    df, _ = cleaned_matches
    assert df.duplicated().sum() == 0


def test_date_convertite(cleaned_matches):
    df, _ = cleaned_matches
    assert pd.api.types.is_datetime64_any_dtype(df["match_date"])
    assert df["match_date"].notna().all()


def test_valori_categorici_uniformati(cleaned_matches):
    df, _ = cleaned_matches
    assert set(df["position"]) <= set(POSITION_MAP.values())
    assert set(df["competition"]) <= set(COMPETITION_MAP.values())
    assert set(df["venue"]) <= set(VENUE_MAP.values())


def test_un_solo_nome_per_giocatore(cleaned_matches):
    df, _ = cleaned_matches
    assert (df.groupby("player_id")["player_name"].nunique() == 1).all()
    assert not df["player_name"].str.contains(r"^\s|\s$").any()


def test_numeri_e_range_plausibili(cleaned_matches):
    df, _ = cleaned_matches
    for col, (lo, hi) in VALID_RANGES.items():
        assert pd.api.types.is_numeric_dtype(df[col]), col
        values = df[col].dropna()
        assert values.between(lo, hi).all(), f"{col} fuori range {lo}-{hi}"


def test_rating_non_imputato(cleaned_matches):
    """Il rating è un giudizio: i mancanti restano NaN invece di essere inventati."""
    df, report = cleaned_matches
    assert df["rating"].isna().sum() > 0
    assert any("rating" in step for step in report.steps)
