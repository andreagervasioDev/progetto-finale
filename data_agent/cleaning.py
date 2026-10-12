"""
Pipeline di data cleaning per il dataset delle prestazioni dei giocatori (Management AI).

Ogni passo e' deterministico e tracciato in un report, cosi' l'agente (e l'utente)
sanno esattamente quali correzioni sono state applicate ai dati grezzi.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

POSITION_MAP = {
    "por": "POR", "portiere": "POR", "gk": "POR",
    "dif": "DIF", "difensore": "DIF", "df": "DIF",
    "cen": "CEN", "centrocampista": "CEN", "mf": "CEN",
    "att": "ATT", "attaccante": "ATT", "fw": "ATT",
}
COMPETITION_MAP = {
    "serie a": "Serie A",
    "europa league": "Europa League", "uel": "Europa League",
    "coppa italia": "Coppa Italia",
}
VENUE_MAP = {"casa": "Casa", "h": "Casa", "home": "Casa",
             "trasferta": "Trasferta", "a": "Trasferta", "away": "Trasferta"}

# range plausibili: fuori da questi limiti il valore viene considerato un errore di registrazione
VALID_RANGES = {
    "minutes_played": (0, 120),
    "top_speed_kmh": (15, 40),
    "rating": (1, 10),
    "wellness_score": (1, 10),
    "rpe": (1, 10),
    "pass_accuracy_pct": (0, 100),
    "distance_km": (0, 16),
}

NUMERIC_COLS = [
    "matchday", "goals_for", "goals_against", "age", "starter", "minutes_played", "goals",
    "assists", "shots", "shots_on_target", "xg", "xa", "passes_completed", "pass_accuracy_pct",
    "key_passes", "tackles", "interceptions", "duels_won_pct", "distance_km", "hsr_distance_m",
    "sprints", "top_speed_kmh", "rpe", "wellness_score", "yellow_cards", "red_cards", "rating",
    "injury", "days_out",
]


@dataclass
class CleaningReport:
    rows_raw: int = 0
    rows_clean: int = 0
    steps: list[str] = field(default_factory=list)

    def add(self, msg: str) -> None:
        self.steps.append(msg)

    def to_dict(self) -> dict:
        return {"rows_raw": self.rows_raw, "rows_clean": self.rows_clean, "steps": self.steps}

    def __str__(self) -> str:
        lines = [f"Righe grezze: {self.rows_raw} -> righe pulite: {self.rows_clean}"]
        lines += [f"- {s}" for s in self.steps]
        return "\n".join(lines)


def _parse_date(value) -> pd.Timestamp:
    if pd.isna(value):
        return pd.NaT
    s = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d %b %Y"):
        try:
            return pd.to_datetime(s, format=fmt)
        except ValueError:
            continue
    return pd.to_datetime(s, errors="coerce", dayfirst=True)


def _to_number(value):
    """Converte stringhe come '87%', '0,45', ' 12 ' in float."""
    if pd.isna(value):
        return np.nan
    if isinstance(value, (int, float, np.number)):
        return float(value)
    s = str(value).strip().replace("%", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return np.nan


def clean_dataset(raw: pd.DataFrame) -> tuple[pd.DataFrame, CleaningReport]:
    report = CleaningReport(rows_raw=len(raw))
    df = raw.copy()

    # 1. duplicati esatti
    dups = int(df.duplicated().sum())
    df = df.drop_duplicates().reset_index(drop=True)
    report.add(f"Rimosse {dups} righe duplicate (doppio export dal sistema GPS).")

    # 2. testo: spazi, maiuscole, alias
    before = df["player_name"].copy()
    df["player_name"] = df["player_name"].astype(str).str.strip().str.title()
    df["player_name"] = df["player_name"].str.replace(r"(\w)'(\w)", lambda m: m.group(0).lower(), regex=True)
    # usa il nome canonico piu' frequente per ogni player_id
    canonical = df.groupby("player_id")["player_name"].agg(lambda s: s.mode().iat[0])
    df["player_name"] = df["player_id"].map(canonical)
    report.add(f"Normalizzati {int((before != df['player_name']).sum())} nomi giocatore (spazi/maiuscole).")

    for col, mapping, label in [("position", POSITION_MAP, "valori di ruolo"),
                                ("competition", COMPETITION_MAP, "nomi di competizione"),
                                ("venue", VENUE_MAP, "valori casa/trasferta")]:
        norm = df[col].astype(str).str.strip().str.lower().map(mapping)
        changed = int((norm != df[col]).sum())
        df[col] = norm.fillna(df[col])
        report.add(f"Uniformati {changed} {label} scritti in formati diversi.")

    # 3. date in formati diversi
    non_iso = int((~df["match_date"].astype(str).str.match(r"^\d{4}-\d{2}-\d{2}$")).sum())
    df["match_date"] = df["match_date"].map(_parse_date)
    report.add(f"Convertite {non_iso} date da formati non standard (gg/mm/aaaa, '12 Mar 2025') a datetime.")

    # 4. numeri salvati come stringhe ('87%', '0,45') o in scala sbagliata
    str_nums = 0
    for col in NUMERIC_COLS:
        if not pd.api.types.is_numeric_dtype(df[col]):
            str_nums += int(df[col].map(
                lambda v: isinstance(v, str) and not re.fullmatch(r"-?\d+(\.\d+)?", v.strip())).sum())
        df[col] = df[col].map(_to_number)
    report.add(f"Convertiti {str_nums} valori numerici salvati come testo ('87%', virgola decimale).")

    frac = df["pass_accuracy_pct"].between(0, 1, inclusive="right")
    df.loc[frac, "pass_accuracy_pct"] = df.loc[frac, "pass_accuracy_pct"] * 100
    report.add(f"Riscalate {int(frac.sum())} pass accuracy espresse come frazione (0.87 -> 87%).")

    meters = df["distance_km"] > 100
    df.loc[meters, "distance_km"] = df.loc[meters, "distance_km"] / 1000
    report.add(f"Convertite {int(meters.sum())} distanze registrate in metri anziche' km.")

    # 5. valori fuori range -> NaN (errori di registrazione, non dati reali)
    for col, (lo, hi) in VALID_RANGES.items():
        bad = df[col].notna() & ~df[col].between(lo, hi)
        if bad.any():
            df.loc[bad, col] = np.nan
            report.add(f"{int(bad.sum())} valori fuori range in '{col}' (ammessi {lo}-{hi}) impostati a NaN.")

    # minuti mancanti/errati: ricostruibili solo se titolare con 90'; altrimenti scarto la riga
    bad_min = df["minutes_played"].isna()
    df = df[~bad_min].copy()
    report.add(f"Scartate {int(bad_min.sum())} righe con minuti giocati non validi.")

    # 6. valori mancanti: imputazione mirata
    missing_before = df[NUMERIC_COLS].isna().sum()
    # eta': costante per giocatore/stagione
    df["age"] = df.groupby(["player_id", "season"])["age"].transform(lambda s: s.fillna(s.median()))
    # metriche GPS e di prestazione: mediana del giocatore riscalata sui minuti giocati
    per90_cols = ["distance_km", "hsr_distance_m", "xg"]
    for col in per90_cols:
        rate = df[col] / df["minutes_played"].replace(0, np.nan) * 90
        med_rate = rate.groupby(df["player_id"]).transform("median")
        df[col] = df[col].fillna((med_rate * df["minutes_played"] / 90).round(2))
    for col in ["top_speed_kmh", "pass_accuracy_pct", "wellness_score", "rpe"]:
        df[col] = df[col].fillna(df.groupby("player_id")[col].transform("median"))
    # rating: NON viene imputato (e' un giudizio): resta NaN e va escluso dalle medie
    imputed = (missing_before - df[NUMERIC_COLS].isna().sum())
    imputed = imputed[imputed > 0]
    if not imputed.empty:
        report.add("Imputati valori mancanti (mediana per giocatore, riscalata sui minuti per le metriche GPS): "
                   + ", ".join(f"{c}={int(v)}" for c, v in imputed.items()) + ".")
    left = int(df["rating"].isna().sum())
    report.add(f"Lasciati {left} rating mancanti come NaN (giudizio non imputabile, esclusi dalle medie).")

    # 7. tipi finali e colonne derivate utili
    int_cols = ["matchday", "goals_for", "goals_against", "starter", "minutes_played", "goals", "assists",
                "shots", "shots_on_target", "passes_completed", "key_passes", "tackles", "interceptions",
                "sprints", "yellow_cards", "red_cards", "injury", "days_out"]
    df[int_cols] = df[int_cols].astype(int)
    df["age"] = df["age"].round().astype("Int64")
    df["injury_type"] = df["injury_type"].fillna("")
    df = df.sort_values(["match_date", "match_id", "player_id"]).reset_index(drop=True)

    report.rows_clean = len(df)
    return df, report


def quality_summary(raw: pd.DataFrame) -> str:
    """Descrizione sintetica dei problemi di qualita' nel dataset grezzo."""
    parts = [f"Righe: {len(raw)}, colonne: {raw.shape[1]}",
             f"Duplicati esatti: {int(raw.duplicated().sum())}"]
    nulls = raw.isna().sum()
    nulls = nulls[nulls > 0].sort_values(ascending=False)
    parts.append("Valori mancanti: " + ", ".join(f"{c}={v}" for c, v in nulls.items()))
    parts.append("Formati data distinti: " + str(
        raw["match_date"].astype(str).map(lambda s: re.sub(r"\d", "9", re.sub(r"[A-Za-z]+", "Mmm", s))).value_counts().to_dict()))
    parts.append("Valori 'position': " + str(raw["position"].value_counts().to_dict()))
    return "\n".join(parts)


if __name__ == "__main__":
    from pathlib import Path

    raw = pd.read_csv(Path(__file__).parent / "data" / "player_performance.csv")
    print(quality_summary(raw), "\n")
    clean, rep = clean_dataset(raw)
    print(rep)
    print(clean.dtypes.value_counts())
    print(clean.describe().T[["min", "max"]])
