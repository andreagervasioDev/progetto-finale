"""
Generatore del dataset sintetico "Management AI - Performance giocatori".

Produce un CSV a livello giocatore-partita (una riga per ogni giocatore sceso in
campo in una partita) per due stagioni complete (2024-25 e 2025-26).

Il dataset contiene volutamente anomalie ("dati sporchi") per mettere alla prova
la pulizia dati del pandas agent:
  - righe duplicate
  - valori mancanti (GPS non registrato, rating assente, xG mancante...)
  - date in formati diversi (ISO, gg/mm/aaaa, "12 Mar 2025")
  - nomi con maiuscole/spazi incoerenti
  - ruoli e competizioni scritti in modi diversi
  - pass accuracy a volte come stringa "87%" o come frazione 0.87
  - distanza a volte in metri invece che in km
  - xG con la virgola decimale ("0,45")
  - valori fuori range (minuti negativi o > 120, velocita' 350 km/h, rating 0 o 15)

Uso:  python generate_dataset.py   (il seed fisso garantisce riproducibilita')
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 42
rng = np.random.default_rng(SEED)
random.seed(SEED)

OUT_PATH = Path(__file__).parent / "player_performance.csv"

# --------------------------------------------------------------------------- #
# Rosa (fittizia)
# --------------------------------------------------------------------------- #
# (id, nome, ruolo, eta' a inizio 2024-25, qualita' 0-1, propensione infortuni 0-1)
SQUAD = [
    ("P01", "Marco Bellandi", "POR", 29, 0.80, 0.05),
    ("P02", "Tommaso Rinaldi", "POR", 22, 0.60, 0.05),
    ("P03", "Jakub Novak", "POR", 34, 0.55, 0.08),
    ("P04", "Luca Ferraresi", "DIF", 27, 0.78, 0.25),
    ("P05", "Andrea Colombo", "DIF", 31, 0.72, 0.40),
    ("P06", "Samuel Adeyemi", "DIF", 24, 0.80, 0.20),
    ("P07", "Riccardo Vitale", "DIF", 26, 0.70, 0.30),
    ("P08", "Mathias Lindqvist", "DIF", 29, 0.74, 0.25),
    ("P09", "Giorgio Pellegrini", "DIF", 21, 0.62, 0.20),
    ("P10", "Diego Moreno", "DIF", 33, 0.66, 0.55),
    ("P11", "Federico Sala", "DIF", 23, 0.64, 0.25),
    ("P12", "Nicolo' Gatti", "CEN", 25, 0.82, 0.25),
    ("P13", "Kevin Duarte", "CEN", 28, 0.85, 0.35),
    ("P14", "Alessio Marchetti", "CEN", 30, 0.73, 0.45),
    ("P15", "Youssef El Amrani", "CEN", 22, 0.76, 0.20),
    ("P16", "Stefano Greco", "CEN", 32, 0.68, 0.50),
    ("P17", "Emil Hansen", "CEN", 26, 0.71, 0.25),
    ("P18", "Filippo Carrara", "CEN", 19, 0.60, 0.15),
    ("P19", "Matteo Longo", "CEN", 27, 0.69, 0.30),
    ("P20", "Victor Okafor", "ATT", 26, 0.88, 0.35),
    ("P21", "Lorenzo De Santis", "ATT", 24, 0.80, 0.30),
    ("P22", "Rafael Costa", "ATT", 29, 0.78, 0.45),
    ("P23", "Simone Fontana", "ATT", 21, 0.65, 0.20),
    ("P24", "Ivan Petrovic", "ATT", 31, 0.72, 0.50),
    ("P25", "Gabriele Russo", "ATT", 23, 0.67, 0.25),
    ("P26", "Daniele Moretti", "ATT", 20, 0.58, 0.15),
]

OPPONENTS_SERIE_A = [
    "Inter", "Milan", "Juventus", "Napoli", "Roma", "Lazio", "Atalanta",
    "Fiorentina", "Bologna", "Torino", "Genoa", "Udinese", "Monza", "Lecce",
    "Cagliari", "Empoli", "Verona", "Parma", "Como",
]
OPPONENTS_EUROPA = [
    "Ajax", "Porto", "Olympiacos", "Braga", "Rangers", "Fenerbahce",
    "Lione", "Real Sociedad", "Slavia Praga", "AZ Alkmaar", "Midtjylland",
    "Ferencvaros",
]
OPPONENTS_COPPA = ["Sampdoria", "Palermo", "Bari", "Spezia", "Cremonese", "Pisa"]

INJURY_TYPES = {
    "Muscolare - flessori": (14, 35),
    "Muscolare - polpaccio": (10, 25),
    "Muscolare - adduttori": (10, 30),
    "Distorsione caviglia": (7, 28),
    "Trauma contusivo": (3, 10),
    "Lesione legamento ginocchio": (60, 180),
    "Commozione cerebrale": (7, 14),
}
INJURY_WEIGHTS = [0.28, 0.18, 0.16, 0.14, 0.14, 0.04, 0.06]

POSITION_PROFILE = {
    # distanza km (media), HSR metri, sprint, top speed, goal weight, assist weight
    "POR": dict(dist=5.6, hsr=120, sprints=2, speed=26.0, gw=0.0, aw=0.02),
    "DIF": dict(dist=10.2, hsr=650, sprints=18, speed=32.0, gw=0.10, aw=0.15),
    "CEN": dict(dist=11.3, hsr=820, sprints=22, speed=31.5, gw=0.30, aw=0.45),
    "ATT": dict(dist=10.1, hsr=900, sprints=30, speed=33.5, gw=0.60, aw=0.38),
}


def build_calendar(season_start_year: int) -> list[dict]:
    """Costruisce il calendario di una stagione (Serie A + Coppa Italia + Europa League)."""
    matches = []
    start = date(season_start_year, 8, 18)

    # Serie A: 38 giornate, una a settimana circa (con sosta invernale)
    opps = OPPONENTS_SERIE_A * 2
    random.shuffle(opps)
    d = start
    for md in range(1, 39):
        if md == 20:
            d += timedelta(days=14)  # sosta
        venue = "Casa" if md % 2 else "Trasferta"
        matches.append(dict(date=d, competition="Serie A", matchday=md, opponent=opps[md - 1], venue=venue))
        d += timedelta(days=7 + (7 if md in (3, 7, 11, 28) else 0))  # soste nazionali

    # Europa League: 8 giornate fase campionato + 2 playoff, il giovedi'
    eu_opps = random.sample(OPPONENTS_EUROPA, 10)
    eu_dates = [date(season_start_year, 9, 25) + timedelta(days=14 * i + (21 if i >= 6 else 0)) for i in range(10)]
    for i, (dd, opp) in enumerate(zip(eu_dates, eu_opps), start=1):
        matches.append(dict(date=dd, competition="Europa League", matchday=i, opponent=opp,
                            venue="Casa" if i % 2 == 0 else "Trasferta"))

    # Coppa Italia: 3 turni
    for i, (dd, opp) in enumerate(zip(
            [date(season_start_year, 12, 4), date(season_start_year + 1, 1, 15), date(season_start_year + 1, 2, 5)],
            random.sample(OPPONENTS_COPPA, 3)), start=1):
        matches.append(dict(date=dd, competition="Coppa Italia", matchday=i, opponent=opp, venue="Casa"))

    matches.sort(key=lambda m: m["date"])
    # evita due partite nello stesso giorno spostando di 1 giorno
    for a, b in zip(matches, matches[1:]):
        if b["date"] <= a["date"]:
            b["date"] = a["date"] + timedelta(days=2)
    return matches


def opponent_strength(opp: str) -> float:
    top = {"Inter": 0.85, "Napoli": 0.8, "Juventus": 0.78, "Milan": 0.76, "Atalanta": 0.75,
           "Roma": 0.7, "Lazio": 0.68, "Porto": 0.72, "Ajax": 0.66, "Real Sociedad": 0.68,
           "Fenerbahce": 0.64, "Lione": 0.66}
    return top.get(opp, 0.55 if opp in OPPONENTS_SERIE_A or opp in OPPONENTS_EUROPA else 0.4)


def generate() -> pd.DataFrame:
    rows = []
    match_counter = 0

    for season_year in (2024, 2025):
        season = f"{season_year}-{str(season_year + 1)[-2:]}"
        calendar = build_calendar(season_year)
        # stato per giocatore all'interno della stagione
        unavailable_until = {p[0]: date(1900, 1, 1) for p in SQUAD}
        recent_minutes = {p[0]: [] for p in SQUAD}  # (data, minuti) per stimare il carico
        age_offset = season_year - 2024

        for m in calendar:
            match_counter += 1
            match_id = f"M{match_counter:03d}"
            mdate = m["date"]
            strength = opponent_strength(m["opponent"])
            home_bonus = 0.25 if m["venue"] == "Casa" else 0.0
            exp_for = max(0.4, 1.7 - 1.4 * (strength - 0.5) + home_bonus)
            exp_against = max(0.3, 0.9 + 1.6 * (strength - 0.5) - home_bonus / 2)
            goals_for = int(rng.poisson(exp_for))
            goals_against = int(rng.poisson(exp_against))
            result = "V" if goals_for > goals_against else ("N" if goals_for == goals_against else "P")

            available = [p for p in SQUAD if unavailable_until[p[0]] < mdate]
            # turnover in coppa: piu' spazio ai giovani/secondi
            cup = m["competition"] != "Serie A"

            def pick(role, n):
                cands = [p for p in available if p[2] == role]
                weights = np.array([(p[4] if not cup else (1.1 - p[4]) * 0.6 + p[4] * 0.4) for p in cands])
                weights = weights ** 4
                weights = weights / weights.sum()
                n = min(n, len(cands))
                idx = rng.choice(len(cands), size=n, replace=False, p=weights)
                return [cands[i] for i in idx]

            starters = pick("POR", 1) + pick("DIF", 4) + pick("CEN", 3) + pick("ATT", 3)
            bench = [p for p in available if p not in starters and p[2] != "POR"]
            n_subs = int(rng.choice([3, 4, 5], p=[0.2, 0.35, 0.45]))
            subs = list(rng.choice(len(bench), size=min(n_subs, len(bench)), replace=False))
            subs = [bench[i] for i in subs]

            # minuti
            minutes = {}
            for p in starters:
                minutes[p[0]] = 90 if p[2] == "POR" else int(rng.choice([90, 90, 90, rng.integers(55, 89)]))
            subbed_out = [p for p in starters if minutes[p[0]] < 90]
            for i, p in enumerate(subs):
                if i < len(subbed_out):
                    minutes[p[0]] = 90 - minutes[subbed_out[i][0]]
                else:
                    minutes[p[0]] = int(rng.integers(5, 25))
            players = starters + subs

            # distribuzione gol/assist
            gw = np.array([POSITION_PROFILE[p[2]]["gw"] * p[4] * minutes[p[0]] / 90 for p in players]) + 1e-6
            aw = np.array([POSITION_PROFILE[p[2]]["aw"] * p[4] * minutes[p[0]] / 90 for p in players]) + 1e-6
            scorers = rng.choice(len(players), size=goals_for, p=gw / gw.sum()) if goals_for else []
            assisters = [rng.choice(len(players), p=aw / aw.sum()) if rng.random() < 0.75 else None for _ in scorers]
            goals = {p[0]: 0 for p in players}
            assists = {p[0]: 0 for p in players}
            for s, a in zip(scorers, assisters):
                goals[players[s][0]] += 1
                if a is not None and a != s:
                    assists[players[a][0]] += 1

            for p in players:
                pid, name, role, age0, quality, inj_prone = p
                mins = minutes[pid]
                frac = mins / 90
                prof = POSITION_PROFILE[role]

                # carico recente (ultimi 7 e 28 giorni) -> ACWR approssimato
                hist = recent_minutes[pid]
                acute = sum(mm for dd, mm in hist if (mdate - dd).days <= 7) + mins
                chronic = sum(mm for dd, mm in hist if (mdate - dd).days <= 28) / 4 + 1
                acwr = acute / chronic if chronic > 1 else 1.0
                hist.append((mdate, mins))

                fatigue = max(0.0, acwr - 1.2)
                distance = max(0.5, rng.normal(prof["dist"], 0.6) * frac * (1 - 0.05 * fatigue))
                hsr = max(0, rng.normal(prof["hsr"], prof["hsr"] * 0.15) * frac)
                sprints = max(0, int(rng.normal(prof["sprints"], 4) * frac))
                top_speed = round(float(rng.normal(prof["speed"] - 0.08 * max(0, age0 + age_offset - 28), 1.0)), 1)

                shots = int(rng.poisson((prof["gw"] * 4.5 + 0.2) * quality * frac)) + goals[pid]
                sot = min(shots, goals[pid] + int(rng.binomial(max(0, shots - goals[pid]), 0.35)))
                xg = round(float(max(0.0, rng.normal(0.11 * shots, 0.05))) if shots else 0.0, 2)
                xa = round(float(max(0.0, rng.normal(0.08 * (assists[pid] + prof["aw"] * 2 * frac), 0.04))), 2)
                passes = max(0, int(rng.normal({"POR": 28, "DIF": 55, "CEN": 62, "ATT": 30}[role] * frac, 6)))
                pass_acc = round(float(np.clip(rng.normal(78 + 12 * quality, 4), 55, 97)), 1)
                key_passes = int(rng.poisson((prof["aw"] * 3 + 0.1) * quality * frac))
                tackles = int(rng.poisson({"POR": 0.1, "DIF": 2.4, "CEN": 2.0, "ATT": 0.7}[role] * frac))
                interceptions = int(rng.poisson({"POR": 0.2, "DIF": 1.8, "CEN": 1.2, "ATT": 0.3}[role] * frac))
                duels_won = round(float(np.clip(rng.normal(48 + 10 * quality, 8), 20, 85)), 1)
                yellow = int(rng.random() < {"POR": 0.04, "DIF": 0.2, "CEN": 0.18, "ATT": 0.1}[role] * frac)
                red = int(rng.random() < 0.012 * frac)
                rpe = int(np.clip(round(rng.normal(6 + 1.5 * frac + fatigue, 1.0)), 1, 10))
                wellness = round(float(np.clip(rng.normal(7.4 - 1.8 * fatigue - 0.5 * inj_prone, 0.9), 1, 10)), 1)

                rating = 6.0 + 0.9 * goals[pid] + 0.5 * assists[pid] + (quality - 0.7) * 2 \
                    + (0.3 if result == "V" else -0.3 if result == "P" else 0) + rng.normal(0, 0.45)
                if role in ("POR", "DIF"):
                    rating -= 0.25 * goals_against
                rating = round(float(np.clip(rating, 4.0, 10.0)), 1)

                # infortunio: dipende da propensione, eta', carico (ACWR) e wellness
                p_inj = 0.006 + 0.025 * inj_prone + 0.035 * max(0, acwr - 1.5) + 0.01 * max(0, 6 - wellness) \
                    + 0.002 * max(0, age0 + age_offset - 30)
                p_inj *= frac
                injury = int(rng.random() < p_inj)
                injury_type, days_out = "", 0
                if injury:
                    injury_type = str(rng.choice(list(INJURY_TYPES), p=INJURY_WEIGHTS))
                    lo, hi = INJURY_TYPES[injury_type]
                    days_out = int(rng.integers(lo, hi + 1))
                    unavailable_until[pid] = mdate + timedelta(days=days_out)

                rows.append({
                    "match_id": match_id,
                    "match_date": mdate.isoformat(),
                    "season": season,
                    "competition": m["competition"],
                    "matchday": m["matchday"],
                    "opponent": m["opponent"],
                    "venue": m["venue"],
                    "goals_for": goals_for,
                    "goals_against": goals_against,
                    "result": result,
                    "player_id": pid,
                    "player_name": name,
                    "position": role,
                    "age": age0 + age_offset,
                    "starter": int(p in starters),
                    "minutes_played": mins,
                    "goals": goals[pid],
                    "assists": assists[pid],
                    "shots": shots,
                    "shots_on_target": sot,
                    "xg": xg,
                    "xa": xa,
                    "passes_completed": passes,
                    "pass_accuracy_pct": pass_acc,
                    "key_passes": key_passes,
                    "tackles": tackles,
                    "interceptions": interceptions,
                    "duels_won_pct": duels_won,
                    "distance_km": round(float(distance), 2),
                    "hsr_distance_m": int(hsr),
                    "sprints": sprints,
                    "top_speed_kmh": top_speed,
                    "rpe": rpe,
                    "wellness_score": wellness,
                    "yellow_cards": yellow,
                    "red_cards": red,
                    "rating": rating,
                    "injury": injury,
                    "injury_type": injury_type,
                    "days_out": days_out,
                })
    return pd.DataFrame(rows)


def inject_anomalies(df: pd.DataFrame) -> pd.DataFrame:
    """Sporca il dataset in modo controllato e realistico."""
    df = df.copy().astype(object)
    n = len(df)

    def sample(frac):
        return rng.choice(n, size=int(n * frac), replace=False)

    # valori mancanti (GPS non registrato, rating non assegnato, ecc.)
    for col, frac in [("distance_km", 0.04), ("hsr_distance_m", 0.04), ("top_speed_kmh", 0.035),
                      ("xg", 0.03), ("rating", 0.03), ("wellness_score", 0.05), ("pass_accuracy_pct", 0.02),
                      ("rpe", 0.03), ("age", 0.01)]:
        df.loc[sample(frac), col] = np.nan

    # formati data incoerenti
    for i in sample(0.08):
        d = date.fromisoformat(df.at[i, "match_date"])
        df.at[i, "match_date"] = d.strftime("%d/%m/%Y")
    for i in sample(0.04):
        d = df.at[i, "match_date"]
        if "-" in d:
            df.at[i, "match_date"] = date.fromisoformat(d).strftime("%d %b %Y")

    # nomi con maiuscole/spazi incoerenti
    for i in sample(0.05):
        df.at[i, "player_name"] = rng.choice([
            df.at[i, "player_name"].upper(), f"  {df.at[i, 'player_name']} ", df.at[i, "player_name"].lower()])

    # ruoli scritti in modi diversi
    role_alias = {"POR": ["Portiere", "GK", "por"], "DIF": ["Difensore", "DF", "dif"],
                  "CEN": ["Centrocampista", "MF", "cen"], "ATT": ["Attaccante", "FW", "att"]}
    for i in sample(0.06):
        df.at[i, "position"] = str(rng.choice(role_alias[df.at[i, "position"]]))

    # competizioni scritte in modi diversi
    comp_alias = {"Serie A": ["serie a", "SERIE A", "Serie A "], "Europa League": ["UEL", "europa league"],
                  "Coppa Italia": ["coppa italia", "Coppa Italia "]}
    for i in sample(0.04):
        df.at[i, "competition"] = str(rng.choice(comp_alias[df.at[i, "competition"]]))

    # venue abbreviato
    for i in sample(0.03):
        df.at[i, "venue"] = {"Casa": "H", "Trasferta": "A"}[df.at[i, "venue"]]

    # pass accuracy come stringa "87%" o frazione 0.87
    for i in sample(0.05):
        v = df.at[i, "pass_accuracy_pct"]
        if pd.notna(v):
            df.at[i, "pass_accuracy_pct"] = f"{v}%" if rng.random() < 0.6 else round(float(v) / 100, 3)

    # xG con virgola decimale
    for i in sample(0.03):
        v = df.at[i, "xg"]
        if pd.notna(v):
            df.at[i, "xg"] = str(v).replace(".", ",")

    # distanza registrata in metri invece che km
    for i in sample(0.02):
        v = df.at[i, "distance_km"]
        if pd.notna(v):
            df.at[i, "distance_km"] = round(float(v) * 1000)

    # outlier / valori fuori range
    for i in sample(0.006):
        df.at[i, "minutes_played"] = int(rng.choice([-15, -1, 135, 180, 999]))
    for i in sample(0.006):
        df.at[i, "top_speed_kmh"] = float(rng.choice([0.0, 88.0, 350.0]))
    for i in sample(0.006):
        df.at[i, "rating"] = float(rng.choice([0.0, 11.5, 15.0, -1.0]))
    for i in sample(0.005):
        df.at[i, "wellness_score"] = float(rng.choice([0.0, 12.0, 45.0]))

    # righe duplicate (doppio export dal sistema GPS)
    dup_idx = sample(0.02)
    df = pd.concat([df, df.iloc[dup_idx]], ignore_index=True)
    df = df.sample(frac=1, random_state=SEED).reset_index(drop=True)
    return df


if __name__ == "__main__":
    clean = generate()
    dirty = inject_anomalies(clean)
    dirty.to_csv(OUT_PATH, index=False)
    print(f"Righe pulite generate: {len(clean)}")
    print(f"Righe nel CSV finale (con duplicati): {len(dirty)}")
    print(f"Partite: {clean['match_id'].nunique()} | Infortuni: {int(clean['injury'].sum())}")
    print(f"Salvato in: {OUT_PATH}")
