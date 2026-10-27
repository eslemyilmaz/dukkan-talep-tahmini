"""Error measures (proposal 2.5, Eq. 5) and across-origin uncertainty.

MAE  = (1/n) sum |y - yhat|                (per product)
WAPE = sum |y - yhat| / sum y  (x 100)     (within unit-homogeneous groups)

WAPE is ``None`` when sum y = 0 (report MAE instead). MAPE is deliberately
not provided.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np


def mae(y: Sequence[float], yhat: Sequence[float]) -> float | None:
    y, yhat = np.asarray(y, float), np.asarray(yhat, float)
    if len(y) == 0:
        return None
    return float(np.mean(np.abs(y - yhat)))


def wape(y: Sequence[float], yhat: Sequence[float], percent: bool = True) -> float | None:
    y, yhat = np.asarray(y, float), np.asarray(yhat, float)
    den = float(np.sum(y))
    if len(y) == 0 or den <= 0:
        return None
    v = float(np.sum(np.abs(y - yhat)) / den)
    return v * 100.0 if percent else v


def spread(values: Sequence[float | None]) -> dict[str, float | None]:
    v = np.array([x for x in values if x is not None], dtype=float)
    if len(v) == 0:
        return {"min": None, "max": None, "std": None, "mean": None}
    return {
        "min": float(v.min()),
        "max": float(v.max()),
        "std": float(v.std(ddof=1)) if len(v) > 1 else 0.0,
        "mean": float(v.mean()),
    }


def block_bootstrap_wape_diff(
    abs_err_a: Sequence[float],
    abs_err_b: Sequence[float],
    actual: Sequence[float],
    *,
    block_length: int | None = None,
    n_boot: int = 2000,
    seed: int = 7,
    level: float = 0.95,
) -> dict[str, float | int] | None:
    """Moving-block (circular) bootstrap over origins for WAPE_a - WAPE_b.

    Inputs are per-origin sums: sum |y - yhat_a|, sum |y - yhat_b| and sum y.
    Blocks of consecutive origins are resampled so that serial dependence
    between neighbouring origins is kept. Returns ``None`` with < 6 origins.
    Result is in WAPE percentage points.
    """
    ea, eb, yy = (np.asarray(v, float) for v in (abs_err_a, abs_err_b, actual))
    n = len(yy)
    if n < 6 or yy.sum() <= 0:
        return None
    b = block_length or max(1, int(round(n ** (1 / 3))))
    rng = np.random.default_rng(seed)
    n_blocks = int(np.ceil(n / b))
    diffs = np.empty(n_boot)
    for k in range(n_boot):
        starts = rng.integers(0, n, n_blocks)
        idx = ((starts[:, None] + np.arange(b)[None, :]) % n).ravel()[:n]
        den = yy[idx].sum()
        diffs[k] = np.nan if den <= 0 else 100.0 * (ea[idx].sum() - eb[idx].sum()) / den
    diffs = diffs[np.isfinite(diffs)]
    alpha = (1 - level) / 2
    return {
        "estimate": float(100.0 * (ea.sum() - eb.sum()) / yy.sum()),
        "lo": float(np.quantile(diffs, alpha)),
        "hi": float(np.quantile(diffs, 1 - alpha)),
        "level": level,
        "block_length": b,
        "n_boot": int(len(diffs)),
        "n_origins": n,
    }


def relative_improvement(base: float | None, new: float | None) -> float | None:
    """(base - new) / base x 100; positive means ``new`` has lower error."""
    if base is None or new is None or base == 0:
        return None
    return float((base - new) / base * 100.0)
