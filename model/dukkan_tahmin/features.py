"""Feature generation (proposal 2.2, Eq. 1).

For product ``p`` and day ``t`` the features use only columns ``< t``:

* lags ``y[t-k]`` for k in ``lags`` (default 1, 7, 14, 28);
* trailing moving averages ``MA_w(t) = mean(y[t-1], ..., y[t-w])`` (Eq. 1).
  Unknown days (missing/closed) are skipped, i.e. the mean is taken over the
  known days in the window; NaN if none is known. With a complete calendar
  this is exactly Eq. 1;
* calendar features known in advance: day of week, month, public holiday,
  holiday eve;
* the product id as a categorical feature.

The same function is used for training (many columns at once) and for the
recursive forecast (one future column at a time), so the two cannot diverge.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
import pandas as pd


def feature_names(lags: Sequence[int], windows: Sequence[int]) -> list[str]:
    return [f"lag_{k}" for k in lags] + [f"ma_{w}" for w in windows] + ["dow", "month", "tatil", "arife", "urun"]


def feature_types(lags: Sequence[int], windows: Sequence[int]) -> list[str]:
    return ["q"] * (len(lags) + len(windows) + 4) + ["c"]


def feature_tensor(
    Y: np.ndarray,
    dates: pd.DatetimeIndex,
    cols: np.ndarray,
    lags: Sequence[int],
    windows: Sequence[int],
    hol: np.ndarray,
    eve: np.ndarray,
) -> np.ndarray:
    """Features for every product at the day indexes ``cols``.

    ``Y`` has shape (P, T) and may contain NaN. ``dates``, ``hol`` and ``eve``
    must cover at least ``max(cols) + 1`` days. Returns (P, len(cols), F).
    Only ``Y[:, :t]`` is read for column ``t`` (no leakage).
    """
    cols = np.asarray(cols, dtype=int)
    P = Y.shape[0]
    known = ~np.isnan(Y)
    z = np.where(known, Y, 0.0)
    cs = np.concatenate([np.zeros((P, 1)), np.cumsum(z, axis=1)], axis=1)  # cs[:, t] = sum Y[:, :t]
    cn = np.concatenate([np.zeros((P, 1)), np.cumsum(known, axis=1)], axis=1)
    feats: list[np.ndarray] = []
    for k in lags:
        src = cols - k
        f = np.full((P, len(cols)), np.nan)
        ok = src >= 0
        f[:, ok] = Y[:, src[ok]]
        feats.append(f)
    for w in windows:
        lo = np.maximum(cols - w, 0)
        s = cs[:, cols] - cs[:, lo]
        n = cn[:, cols] - cn[:, lo]
        with np.errstate(invalid="ignore", divide="ignore"):
            feats.append(np.where(n > 0, s / np.maximum(n, 1), np.nan))
    d = dates[cols]
    for v in (d.weekday.to_numpy(float), d.month.to_numpy(float), hol[cols], eve[cols]):
        feats.append(np.broadcast_to(v, (P, len(cols))))
    feats.append(np.broadcast_to(np.arange(P, dtype=float)[:, None], (P, len(cols))))
    return np.stack(feats, axis=-1)
