"""
Conversioni prudenti per i file CSV / Excel caricati: testo -> numero e testo -> data.

Regola generale: una colonna si converte solo se OGNI valore e' interpretabile senza indovinare.
Se anche un solo valore non lo e', la colonna resta testo (nessun dato perso) e il report dice perche',
con conteggi ed esempi. L'unica eccezione sono i segnaposto espliciti di dato mancante ("n.d.", "-",
"N/A"...), che diventano vuoti e vengono contati.

Numeri
- Il formato (italiano 1.234,56 o inglese 1,234.56) si decide sulla colonna intera, dagli indizi certi:
  virgola decimale o piu' gruppi di migliaia. "1.234" o "1,234" da soli sono ambigui (mille o uno virgola
  due?): se la colonna non contiene indizi, resta testo.
- Indizi italiani e inglesi nella stessa colonna, valute diverse o percentuali mescolate a numeri senza %
  -> la colonna resta testo.

Date
- Sono accettati AAAA-MM-GG (con ora facoltativa) e G/M/A con /, - o . (anno a 2 o 4 cifre).
- L'ordine giorno/mese si decide sulla colonna: un valore come 25/03 dimostra giorno/mese, 03/25 mese/giorno.
  Se nessun valore lo dimostra (tutti i giorni <= 12) le date sono ambigue e la colonna resta testo;
  se ci sono prove di entrambi gli ordini, la colonna e' incoerente e resta testo.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

MISSING_MARKERS = {"", "-", "–", "—", "n.d.", "n.d", "nd", "n/d", "n/a", "na", "null", "none", "nan", "?", "/"}
CURRENCIES = {"€": "€", "eur": "€", "$": "$", "usd": "$", "£": "£", "gbp": "£"}

_NUMBER = re.compile(r"^[-+]?\d[\d.,]*$")
_ISO_DATE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$")
_DMY_DATE = re.compile(r"^(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})$")


@dataclass
class Conversion:
    """Esito della conversione di una colonna: `values` None = colonna lasciata com'e'."""

    values: pd.Series | None = None
    message: str | None = None  # riga per il report (None = niente da segnalare)
    notes: list[str] = field(default_factory=list)


def is_missing_marker(value) -> bool:
    return isinstance(value, str) and value.strip().lower() in MISSING_MARKERS


def _examples(values, n: int = 3) -> str:
    uniq = list(dict.fromkeys(str(v) for v in values))
    return ", ".join(f"'{v}'" for v in uniq[:n]) + (" ..." if len(uniq) > n else "")


# --------------------------------------------------------------------------- #
# Numeri
# --------------------------------------------------------------------------- #
def _split_number(text: str) -> tuple[str, str | None, bool] | None:
    """'€ 1.234,50' -> ('1.234,50', '€', False); '15%' -> ('15', None, True); testo -> None."""
    s = text.strip().replace(" ", " ")
    currency = None
    for sym, name in CURRENCIES.items():
        pattern = re.escape(sym) if not sym.isalpha() else rf"\b{sym}\b"
        if re.search(pattern, s, re.I):
            if currency and currency != name:
                return None
            currency = name
            s = re.sub(pattern, "", s, flags=re.I)
    percent = s.rstrip().endswith("%")
    s = s.replace("%", "").replace(" ", "")
    if s.startswith("+"):
        s = s[1:]
    return (s, currency, percent) if _NUMBER.match(s) else None


def _number_style(token: str) -> str | None:
    """Indizio sul formato: 'it', 'en', 'ambiguous', 'plain', oppure None se il numero non e' valido."""
    body = token.lstrip("-")
    dots, commas = body.count("."), body.count(",")
    if not dots and not commas:
        return "plain"
    if dots and commas:
        decimal, thousands = (",", ".") if body.rfind(",") > body.rfind(".") else (".", ",")
        int_part = body.rsplit(decimal, 1)[0]
        if not re.fullmatch(r"\d{1,3}(" + re.escape(thousands) + r"\d{3})+", int_part):
            return None
        return "it" if decimal == "," else "en"
    sep = "." if dots else ","
    count = dots or commas
    if count > 1:  # solo separatori delle migliaia: 1.200.000 (it) o 1,200,000 (en)
        if not re.fullmatch(r"\d{1,3}(" + re.escape(sep) + r"\d{3})+", body):
            return None
        return "it" if sep == "." else "en"
    after = body.split(sep)[1]
    if len(after) == 3 and len(body.split(sep)[0]) <= 3 and body.split(sep)[0] != "0":
        return "ambiguous"  # 1.234 / 1,234: migliaia o decimali?
    return "it" if sep == "," else "en"  # 0,45 / 2.5: separatore decimale


def _parse_number(token: str, style: str) -> float:
    if style == "it":
        token = token.replace(".", "").replace(",", ".")
    else:
        token = token.replace(",", "")
    return float(token)


def convert_numbers(series: pd.Series, col: str) -> Conversion | None:
    """Conversione in numero, oppure None se la colonna non e' (in prevalenza) numerica."""
    present = [v for v in series if not (pd.isna(v) if not isinstance(v, str) else False)]
    markers = [v for v in present if is_missing_marker(v)]
    values = [v for v in present if not is_missing_marker(v)]
    if not values:
        return None

    bad, styles, currencies, percents = [], set(), set(), 0
    with_separators = 0  # valori con migliaia o virgola decimale: conversioni da segnalare
    ambiguous = []
    for v in values:
        if isinstance(v, (bool, np.bool_)):
            bad.append(v)
            continue
        if isinstance(v, (int, float, np.number)):
            continue  # gia' un numero (celle Excel): nessun formato da indovinare
        split = _split_number(str(v))
        style = _number_style(split[0]) if split else None
        if style is None:
            bad.append(v)
            continue
        token, currency, percent = split
        with_separators += "," in token or token.count(".") > 1
        if currency:
            currencies.add(currency)
        percents += percent
        if style == "ambiguous":
            ambiguous.append(v)
        elif style != "plain":
            styles.add(style)

    numeric_share = 1 - len(bad) / len(values)
    if numeric_share < 0.5:
        return None  # colonna di testo: niente da segnalare
    text_kept = f"Colonna '{col}': lasciata come testo"
    if bad:
        return Conversion(message=f"{text_kept}: valori eterogenei, {len(bad)} su {len(values)} non sono numeri "
                                  f"({_examples(bad)}). Nessun valore modificato.")
    if len(currencies) > 1:
        return Conversion(message=f"{text_kept}: valute diverse nella stessa colonna ({', '.join(sorted(currencies))}).")
    if percents and percents < len(values):
        return Conversion(message=f"{text_kept}: {percents} valori con % e {len(values) - percents} senza "
                                  "(scala non certa: 15% e 0,15 sono la stessa cosa?).")
    if styles == {"it", "en"}:
        return Conversion(message=f"{text_kept}: formati numerici misti, italiano (1.234,56) e inglese (1,234.56).")
    if ambiguous and not styles:
        return Conversion(message=f"{text_kept}: numeri ambigui ({_examples(ambiguous)}): senza altri valori nella "
                                  "colonna non si può sapere se il punto o la virgola indichi le migliaia o i decimali.")

    style = styles.pop() if styles else "plain"

    def conv(v):
        if isinstance(v, str):
            if is_missing_marker(v):
                return np.nan
            token = _split_number(v)[0]
            return _parse_number(token, style if style != "plain" else "en")
        if v is None or (isinstance(v, float) and np.isnan(v)):
            return np.nan
        return float(v)

    out = series.map(conv).astype(float)
    if out.notna().all() and (out == out.round()).all() and not percents:
        out = out.astype("int64")  # come pandas: interi se tutti i valori sono interi e non ne manca nessuno
    texts = sum(isinstance(v, str) for v in values)
    if not (with_separators or currencies or percents or ambiguous or markers):
        # numeri semplici ("42", "2.5") o celle gia' numeriche: nessuna scelta da tracciare
        return Conversion(values=out)
    label = {"it": "formato italiano", "en": "formato inglese", "plain": "numeri interi"}[style]
    parts = [f"Colonna '{col}': convertita in numero ({texts} valori di testo, {label}"]
    if currencies:
        parts[0] += f", valuta {currencies.pop()}"
    if percents:
        parts[0] += ", percentuali come numeri da 0 a 100"
    parts[0] += ")"
    if ambiguous:
        parts.append(f"{len(ambiguous)} valori ambigui letti con il formato del resto della colonna "
                     f"(es. '{ambiguous[0]}' -> {conv(ambiguous[0]):g})")
    if markers:
        parts.append(f"{len(markers)} segnaposti di dato mancante ({_examples(markers)}) lasciati vuoti")
    return Conversion(values=out, message="; ".join(parts) + ".")


# --------------------------------------------------------------------------- #
# Date
# --------------------------------------------------------------------------- #
def _year(text: str) -> int:
    y = int(text)
    return y if len(text) == 4 else 2000 + y if y < 70 else 1900 + y


def _date_order(values) -> tuple[str | None, list]:
    """Ordine giorno/mese provato dai valori G/M/A: 'dmy', 'mdy', 'ambiguous' o 'mixed'."""
    dmy = mdy = False
    for v in values:
        m = _DMY_DATE.match(v)
        if not m:
            continue
        a, b = int(m.group(1)), int(m.group(3))
        dmy |= a > 12 and b <= 12
        mdy |= b > 12 and a <= 12
    if dmy and mdy:
        return "mixed", []
    if dmy:
        return "dmy", []
    if mdy:
        return "mdy", []
    return "ambiguous", [v for v in values if _DMY_DATE.match(v)]


def _parse_date(text: str, order: str) -> pd.Timestamp | None:
    m = _ISO_DATE.match(text)
    try:
        if m:
            y, mo, d, hh, mm, ss = (int(g) if g else 0 for g in m.groups())
            return pd.Timestamp(y, mo, d, hh, mm, ss)
        m = _DMY_DATE.match(text)
        if m:
            a, b, y = int(m.group(1)), int(m.group(3)), _year(m.group(4))
            day, month = (a, b) if order == "dmy" else (b, a)
            return pd.Timestamp(y, month, day)
    except ValueError:  # 31/02/2025, mese 13...
        return None
    return None


def looks_like_dates(series: pd.Series) -> bool:
    text = series.dropna().astype(str).str.strip()
    text = text[~text.map(is_missing_marker)]
    return not text.empty and text.map(lambda v: bool(_ISO_DATE.match(v) or _DMY_DATE.match(v))).mean() >= 0.8


def convert_dates(series: pd.Series, col: str) -> Conversion | None:
    """Conversione in data, oppure None se la colonna non contiene (in prevalenza) date."""
    present = [v for v in series if isinstance(v, str) or not pd.isna(v)]
    markers = [v for v in present if is_missing_marker(v)]
    values = [str(v).strip() for v in present if not is_missing_marker(v)]
    if not values:
        return None
    others = [v for v in values if not (_ISO_DATE.match(v) or _DMY_DATE.match(v))]
    if len(others) > 0.5 * len(values):
        return None
    text_kept = f"Colonna '{col}': lasciata come testo"
    if others:
        return Conversion(message=f"{text_kept}: valori eterogenei, {len(others)} su {len(values)} non sono date "
                                  f"riconoscibili ({_examples(others)}). Nessun valore modificato.")
    order, ambiguous = _date_order(values)
    if order == "mixed":
        return Conversion(message=f"{text_kept}: ordine di giorno e mese incoerente (alcune date sono giorno/mese, "
                                  "altre mese/giorno).")
    if order == "ambiguous" and ambiguous:
        return Conversion(message=f"{text_kept}: date ambigue ({_examples(ambiguous)}): nessun valore permette di "
                                  "capire se il primo numero sia il giorno o il mese.")
    parsed = {v: _parse_date(v, order if order != "ambiguous" else "dmy") for v in set(values)}
    invalid = [v for v in values if parsed[v] is None]
    if invalid:
        return Conversion(message=f"{text_kept}: {len(invalid)} date inesistenti ({_examples(invalid)}). "
                                  "Nessun valore modificato.")

    def conv(v):
        if isinstance(v, str) and not is_missing_marker(v):
            return parsed[v.strip()]
        return pd.NaT

    out = pd.to_datetime(series.map(conv))
    formats = []
    if any(_ISO_DATE.match(v) for v in values):
        formats.append("aaaa-mm-gg")
    if order in ("dmy", "mdy"):
        formats.append("gg/mm/aaaa" if order == "dmy" else "mm/gg/aaaa (ordine americano, provato dai valori)")
    msg = f"Colonna '{col}': convertita in data ({len(values)} valori, {' e '.join(formats)})"
    short_years = [v for v in values if (m := _DMY_DATE.match(v)) and len(m.group(4)) == 2]
    if short_years:
        msg += f"; {len(short_years)} anni a due cifre letti come 19xx/20xx (es. '{short_years[0]}' -> {parsed[short_years[0]]:%Y})"
    if markers:
        msg += f"; {len(markers)} segnaposti di dato mancante ({_examples(markers)}) lasciati vuoti"
    return Conversion(values=out, message=msg + ".")
