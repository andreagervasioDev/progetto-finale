"""
Validazione del dataset delle partite all'avvio del data agent.

Due controlli:
- sul CSV grezzo: devono esserci tutte le colonne attese (senza, la pulizia non puo' funzionare);
- sui dati puliti: ogni colonna deve avere il tipo atteso (numero intero, decimale, data o testo).

Il CSV e' "sporco" di proposito (numeri salvati come testo, date in piu' formati), quindi i tipi
si controllano dopo la pulizia: un tipo sbagliato li' significa che la pulizia non e' riuscita a
correggere un dato, e va segnalato.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

# colonna -> tipo atteso dopo la pulizia
EXPECTED_SCHEMA: dict[str, str] = {
    "match_id": "testo", "match_date": "data", "season": "testo", "competition": "testo",
    "matchday": "intero", "opponent": "testo", "venue": "testo", "goals_for": "intero",
    "goals_against": "intero", "result": "testo", "player_id": "testo", "player_name": "testo",
    "position": "testo", "age": "intero", "starter": "intero", "minutes_played": "intero",
    "goals": "intero", "assists": "intero", "shots": "intero", "shots_on_target": "intero",
    "xg": "decimale", "xa": "decimale", "passes_completed": "intero", "pass_accuracy_pct": "decimale",
    "key_passes": "intero", "tackles": "intero", "interceptions": "intero", "duels_won_pct": "decimale",
    "distance_km": "decimale", "hsr_distance_m": "decimale", "sprints": "intero", "top_speed_kmh": "decimale",
    "rpe": "decimale", "wellness_score": "decimale", "yellow_cards": "intero", "red_cards": "intero",
    "rating": "decimale", "injury": "intero", "injury_type": "testo", "days_out": "intero",
}

# valori ammessi per le categorie, dopo la pulizia
EXPECTED_VALUES: dict[str, set[str]] = {
    "position": {"POR", "DIF", "CEN", "ATT"},
    "competition": {"Serie A", "Europa League", "Coppa Italia"},
    "venue": {"Casa", "Trasferta"},
}

MIN_ROWS = 1000


class SchemaError(ValueError):
    """Il CSV non ha la struttura minima per essere pulito e analizzato."""


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings}


def _kind(series: pd.Series) -> str:
    if pd.api.types.is_datetime64_any_dtype(series):
        return "data"
    if pd.api.types.is_bool_dtype(series):
        return "testo"
    if pd.api.types.is_integer_dtype(series):
        return "intero"
    if pd.api.types.is_float_dtype(series):
        return "decimale"
    return "testo"


def check_columns(raw: pd.DataFrame) -> ValidationResult:
    """Colonne del CSV grezzo: quelle mancanti sono errori bloccanti, quelle in piu' solo avvisi."""
    result = ValidationResult()
    missing = [c for c in EXPECTED_SCHEMA if c not in raw.columns]
    extra = [c for c in raw.columns if c not in EXPECTED_SCHEMA]
    if missing:
        result.errors.append(f"Colonne mancanti nel CSV: {', '.join(missing)}.")
    if extra:
        result.warnings.append(f"Colonne non previste (ignorate dalla pulizia): {', '.join(map(str, extra))}.")
    if len(raw) < MIN_ROWS:
        result.warnings.append(f"Il CSV ha {len(raw)} righe, meno delle {MIN_ROWS} attese.")
    return result


def check_types(clean: pd.DataFrame) -> ValidationResult:
    """Tipi e categorie dei dati puliti: ogni differenza e' segnalata come errore."""
    result = ValidationResult()
    for col, expected in EXPECTED_SCHEMA.items():
        if col not in clean.columns:
            continue
        actual = _kind(clean[col])
        # un intero con valori mancanti diventa decimale: per le colonne intere va bene solo se ha NaN
        if expected == "intero" and actual == "decimale":
            values = clean[col].dropna()
            if (values == values.round()).all():
                continue
        if actual != expected:
            result.errors.append(f"Colonna '{col}': tipo atteso {expected}, trovato {actual}.")
    for col, allowed in EXPECTED_VALUES.items():
        if col in clean.columns:
            unknown = sorted(set(clean[col].dropna().astype(str)) - allowed)
            if unknown:
                result.errors.append(f"Colonna '{col}': valori non riconosciuti dopo la pulizia: {', '.join(unknown[:5])}.")
    if "match_date" in clean.columns and _kind(clean["match_date"]) == "data":
        bad_dates = int(clean["match_date"].isna().sum())
        if bad_dates:
            result.errors.append(f"Colonna 'match_date': {bad_dates} date non interpretabili.")
    return result


def validate(raw: pd.DataFrame, clean_fn) -> tuple[pd.DataFrame, object, ValidationResult]:
    """
    Controlla le colonne, esegue la pulizia e controlla i tipi.
    Solleva SchemaError se il CSV non si puo' pulire (colonne mancanti o pulizia fallita).
    """
    result = check_columns(raw)
    if not result.ok:
        raise SchemaError(" ".join(result.errors))
    try:
        clean, report = clean_fn(raw)
    except Exception as e:  # noqa: BLE001 - un dato imprevisto fa fallire la pulizia: messaggio chiaro
        raise SchemaError(f"La pulizia del CSV non e' riuscita ({type(e).__name__}: {e}).") from e
    types = check_types(clean)
    result.errors += types.errors
    result.warnings += types.warnings
    return clean, report, result
