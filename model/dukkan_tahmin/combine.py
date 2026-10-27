"""Regularised group-weighted forecast combination (proposal 2.4, Eq. 2-4).

Eq. 2   F_{i,h} = a_{g(i),h} X_{i,h} + (1 - a_{g(i),h}) S_{i,h}

Eq. 3   J_g(a) = (1/N_g) sum_{j in V_g} (y_j - (a x_j + (1-a) s_j))^2 + lambda (a - a0)^2,
        a in [0, 1]

Eq. 4   with d_j = x_j - s_j and r_j = y_j - s_j:
        a_g = Pi_[0,1]( ((1/N_g) sum r_j d_j + lambda a0) / ((1/N_g) sum d_j^2 + lambda) )

J_g is a quadratic in a with second derivative (2/N_g) sum d_j^2 + 2 lambda,
strictly positive for lambda > 0, so the constrained minimiser on [0, 1] is
unique and equals the projection of the stationary point (a 1-D convex
quadratic is monotone on each side of its vertex). Edge cases: N_g = 0, or
lambda = 0 with sum d_j^2 = 0 (denominator zero) -> a0.

a0 is the common weight: the same formula with lambda = 0 on the pooled
validation set of all products (0.5 if that is degenerate too).

Scaling: with ``scale="product_mean"`` every observation j is divided by
m_j = (product mean daily sales up to the forecast origin) x (number of
evaluated horizon days) before Eq. 3/4 are applied, so that high-volume
products do not dominate the squared loss and lambda has the same meaning
in every group. ``scale="none"`` applies Eq. 3/4 to raw quantities.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .config import HORIZONS
from .groups import GROUPS


def combine(x: np.ndarray | float, s: np.ndarray | float, a: np.ndarray | float) -> np.ndarray:
    """Eq. 2 (convex combination)."""
    return np.asarray(a) * np.asarray(x) + (1.0 - np.asarray(a)) * np.asarray(s)


def objective(a: float, x: np.ndarray, s: np.ndarray, y: np.ndarray, lam: float, a0: float) -> float:
    """Eq. 3."""
    x, s, y = map(np.asarray, (x, s, y))
    return float(np.mean((y - combine(x, s, a)) ** 2) + lam * (a - a0) ** 2)


def closed_form_weight(
    x: np.ndarray, s: np.ndarray, y: np.ndarray, lam: float, a0: float
) -> tuple[float, bool]:
    """Eq. 4. Returns (weight, used_fallback_a0)."""
    x, s, y = (np.asarray(v, dtype=float) for v in (x, s, y))
    n = len(x)
    if n == 0:
        return float(a0), True
    d = x - s
    r = y - s
    den = float(np.mean(d * d)) + lam
    if den <= 1e-15:
        return float(a0), True
    num = float(np.mean(r * d)) + lam * a0
    return float(np.clip(num / den, 0.0, 1.0)), False


def common_weight(x: np.ndarray, s: np.ndarray, y: np.ndarray) -> float:
    """a0: pooled lambda = 0 solution projected to [0, 1] (0.5 if degenerate)."""
    a, fb = closed_form_weight(x, s, y, 0.0, 0.5)
    return 0.5 if fb else a


def scaled_xsy(rec: pd.DataFrame, scale: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x, s, y = (rec[c].to_numpy(dtype=float) for c in ("x", "s", "y"))
    if scale == "product_mean":
        m = rec["m"].to_numpy(dtype=float)
        ok = np.isfinite(m) & (m > 0)
        return x[ok] / m[ok], s[ok] / m[ok], y[ok] / m[ok]
    if scale == "none":
        return x, s, y
    raise ValueError(f"unknown scale {scale!r}")


@dataclass
class WeightSet:
    """Fitted weights for one configuration at one (re)training origin."""

    lam: float
    a0: dict[str, float]
    weights: dict[str, dict[str, float]] = field(default_factory=dict)
    n_obs: dict[str, dict[str, int]] = field(default_factory=dict)
    fallback: dict[str, dict[str, bool]] = field(default_factory=dict)

    def weight(self, group: str, horizon: str) -> float:
        return self.weights.get(horizon, {}).get(group, self.a0[horizon])

    def to_dict(self) -> dict[str, Any]:
        return {
            "lambda": float(self.lam),
            "a0": {h: float(v) for h, v in self.a0.items()},
            "weights": {h: {g: float(v) for g, v in w.items()} for h, w in self.weights.items()},
            "n_obs": self.n_obs,
            "fallback_a0": self.fallback,
        }


def fit_a0(records: pd.DataFrame, scale: str) -> dict[str, float]:
    out = {}
    for h in HORIZONS:
        rec = records[records["horizon"] == h]
        out[h] = common_weight(*scaled_xsy(rec, scale)) if len(rec) else 0.5
    return out


def fit_weights(
    records: pd.DataFrame,
    lam: float,
    scale: str,
    *,
    a0: dict[str, float] | None = None,
    mode: str = "group",
    groups: tuple[str, ...] = GROUPS,
) -> WeightSet:
    """Fit a0 and per-group weights on validation records.

    ``records`` needs columns horizon, group, x, s, y, m. ``mode="common"``
    gives ablation (i): every group uses a0.
    """
    a0 = a0 or fit_a0(records, scale)
    ws = WeightSet(lam=lam, a0=dict(a0))
    for h in HORIZONS:
        ws.weights[h], ws.n_obs[h], ws.fallback[h] = {}, {}, {}
        rec_h = records[records["horizon"] == h]
        for g in groups:
            rec = rec_h[rec_h["group"] == g]
            x, s, y = scaled_xsy(rec, scale)
            ws.n_obs[h][g] = int(len(x))
            if mode == "common" or g == "sparse":
                ws.weights[h][g], ws.fallback[h][g] = a0[h], True
                continue
            ws.weights[h][g], ws.fallback[h][g] = closed_form_weight(x, s, y, lam, a0[h])
    return ws
