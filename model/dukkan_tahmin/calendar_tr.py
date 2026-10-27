"""Turkish public-holiday calendar used as a *known-in-advance* feature.

Fixed-date national holidays are generated for any year. Religious holidays
(Ramazan and Kurban Bayramı) move with the lunar calendar and are hard-coded
for 2023-2027 below.

IMPORTANT: the religious-holiday dates in ``_RELIGIOUS`` were entered from the
published Diyanet calendars as known at the time of writing and MUST be
verified against the official Diyanet İşleri Başkanlığı calendar before the
results are reported. Years outside the table get no religious holidays and a
warning is returned by :func:`coverage_warning`.
"""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

import numpy as np
import pandas as pd

# (month, day) of fixed national holidays.
_FIXED = [(1, 1), (4, 23), (5, 1), (5, 19), (7, 15), (8, 30), (10, 29)]
# Half-day eves of fixed holidays.
_FIXED_EVE = [(10, 28)]

# year -> list of (first_day, n_days) for Ramazan and Kurban Bayramı.
# TODO(verify): check against the official Diyanet calendar.
_RELIGIOUS: dict[int, list[tuple[date, int]]] = {
    2023: [(date(2023, 4, 21), 3), (date(2023, 6, 28), 4)],
    2024: [(date(2024, 4, 10), 3), (date(2024, 6, 16), 4)],
    2025: [(date(2025, 3, 30), 3), (date(2025, 6, 6), 4)],
    2026: [(date(2026, 3, 20), 3), (date(2026, 5, 27), 4)],
    2027: [(date(2027, 3, 9), 3), (date(2027, 5, 16), 4)],
}

COVERED_YEARS = tuple(sorted(_RELIGIOUS))


@lru_cache(maxsize=64)
def holidays_for_year(year: int) -> tuple[frozenset[date], frozenset[date]]:
    """Return (holiday_days, eve_days) for one calendar year."""
    hol = {date(year, m, d) for m, d in _FIXED}
    eve = {date(year, m, d) for m, d in _FIXED_EVE}
    for first, n in _RELIGIOUS.get(year, []):
        hol.update(first + timedelta(days=k) for k in range(n))
        eve.add(first - timedelta(days=1))
    eve -= hol
    return frozenset(hol), frozenset(eve)


def holiday_flags(dates: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray]:
    """Vectorised (is_holiday, is_eve) indicators as float arrays."""
    hol = np.zeros(len(dates), dtype=float)
    eve = np.zeros(len(dates), dtype=float)
    for i, ts in enumerate(dates):
        d = ts.date()
        h, e = holidays_for_year(d.year)
        if d in h:
            hol[i] = 1.0
        elif d in e:
            eve[i] = 1.0
    return hol, eve


def coverage_warning(start: pd.Timestamp, end: pd.Timestamp) -> str | None:
    """Turkish warning if the data range leaves the hard-coded bayram table."""
    years = set(range(start.year, end.year + 2))  # +1 for forecast horizon
    missing = sorted(y for y in years if y not in _RELIGIOUS)
    if missing:
        return (
            "Bayram tarihleri şu yıllar için tanımlı değil: "
            + ", ".join(map(str, missing))
            + "; tatil göstergesi eksik olabilir."
        )
    return None
