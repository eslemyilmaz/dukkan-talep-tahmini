"""Product x calendar-day matrix built from cleaned data.

``Y[p, t]`` is the observed quantity sold of product ``p`` on calendar day
``t`` (observed *sales*, not demand). It is ``NaN`` when the value is unknown:

* the day has no record at all (missing day or closed day);
* the day is before the product's first sale (product not yet listed);
* ``assume_complete=False`` and the product has no sale that day.

With ``assume_complete=True`` (default) a recorded day on which a listed
product sold nothing is a genuine ``0``.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .calendar_tr import holiday_flags
from .config import Config
from .quality import CleanData


@dataclass
class Panel:
    dates: pd.DatetimeIndex
    barcodes: np.ndarray
    names: np.ndarray
    categories: np.ndarray
    units: np.ndarray
    Y: np.ndarray
    recorded: np.ndarray
    first_sale: np.ndarray  # index of first positive sale, -1 if none
    closed_weekdays: tuple[int, ...]
    closed_dates: frozenset[pd.Timestamp]

    @property
    def n_products(self) -> int:
        return len(self.barcodes)

    def index_of(self, day: pd.Timestamp | str) -> int:
        return int(self.dates.get_loc(pd.Timestamp(day)))

    def is_closed(self, days: pd.DatetimeIndex) -> np.ndarray:
        wd = np.isin(days.weekday, self.closed_weekdays)
        cd = np.array([d in self.closed_dates for d in days], dtype=bool)
        return wd | cd

    def dates_until(self, origin: int, horizon: int) -> pd.DatetimeIndex:
        """Calendar from the first data day to ``origin + horizon`` (may exceed data)."""
        return pd.date_range(self.dates[0], self.dates[origin] + pd.Timedelta(days=horizon), freq="D")

    def calendar_arrays(self, days: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray]:
        return holiday_flags(days)

    def active(self, origin: int) -> np.ndarray:
        """Products already listed (first sale on or before the origin)."""
        return (self.first_sale >= 0) & (self.first_sale <= origin)


def build_panel(data: CleanData, config: Config | None = None) -> Panel:
    cfg = config or Config()
    dates = pd.date_range(data.start, data.end, freq="D")
    barcodes = np.array(sorted(data.products.index), dtype=object)
    pos = {b: i for i, b in enumerate(barcodes)}
    P, T = len(barcodes), len(dates)
    recorded = dates.isin(data.recorded_days)
    q = np.zeros((P, T))
    s = data.sales
    pi = s["barkod"].map(pos).to_numpy()
    ti = dates.get_indexer(pd.DatetimeIndex(s["tarih"]))
    np.add.at(q, (pi, ti), s["miktar"].to_numpy(dtype=float))

    has_sale = q > 0
    first = np.where(has_sale.any(axis=1), has_sale.argmax(axis=1), -1)
    Y = np.full((P, T), np.nan)
    listed = np.arange(T)[None, :] >= np.where(first < 0, T, first)[:, None]
    if cfg.assume_complete:
        known = listed & recorded[None, :]
        Y[known] = q[known]
    else:
        Y[has_sale] = q[has_sale]
    prod = data.products.reindex(barcodes)
    return Panel(
        dates=dates,
        barcodes=barcodes,
        names=prod["urun"].to_numpy(dtype=object),
        categories=prod["kategori"].to_numpy(dtype=object),
        units=prod["birim"].to_numpy(dtype=object),
        Y=Y,
        recorded=np.asarray(recorded, dtype=bool),
        first_sale=first.astype(int),
        closed_weekdays=tuple(data.closed_weekdays),
        closed_dates=frozenset(data.closed_dates),
    )
