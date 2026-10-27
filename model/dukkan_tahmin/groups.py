"""Product grouping for the proposed module (proposal 2.4).

Statistics are computed from the history up to the (re)training origin only:

* ``obs``        number of known product-days since the first sale;
* ``zero_ratio`` share of those days with zero sales;
* ``cv``         std / mean over positive-sales days (variability).

Assignment with frozen thresholds:

* ``sparse``        obs < min_obs (always uses the common weight a0);
* ``intermittent``  zero_ratio > zero_ratio_intermittent;
* ``steady``        cv <= cv_split[0];
* ``variable``      otherwise (and ``erratic`` above cv_split[1] if a second
                    cut-point is given).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .panel import Panel

GROUPS = ("steady", "variable", "erratic", "intermittent", "sparse")


@dataclass(frozen=True)
class GroupThresholds:
    zero_ratio_intermittent: float = 0.5
    cv_split: tuple[float, ...] = (0.5,)
    min_obs: int = 56

    @property
    def groups(self) -> tuple[str, ...]:
        """Groups that this threshold set can produce."""
        return tuple(g for g in GROUPS if g != "erratic" or len(self.cv_split) > 1)

    def to_dict(self) -> dict[str, object]:
        return {
            "zero_ratio_intermittent": float(self.zero_ratio_intermittent),
            "cv_split": [float(c) for c in self.cv_split],
            "min_obs": int(self.min_obs),
        }


def group_stats(panel: Panel, origin: int) -> pd.DataFrame:
    """Per-product statistics from data up to and including ``origin``."""
    Y = panel.Y[:, : origin + 1]
    known = ~np.isnan(Y)
    obs = known.sum(axis=1)
    z = np.where(known, Y, 0.0)
    zeros = (known & (z == 0)).sum(axis=1)
    pos = known & (z > 0)
    npos = pos.sum(axis=1)
    sum_pos = np.where(pos, z, 0.0).sum(axis=1)
    mean_pos = np.where(npos > 0, sum_pos / np.maximum(npos, 1), np.nan)
    sq = np.where(pos, (z - np.nan_to_num(mean_pos)[:, None]) ** 2, 0.0).sum(axis=1)
    std_pos = np.where(npos > 1, np.sqrt(sq / np.maximum(npos - 1, 1)), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        cv = std_pos / mean_pos
        zero_ratio = np.where(obs > 0, zeros / np.maximum(obs, 1), np.nan)
        mean_daily = np.where(obs > 0, z.sum(axis=1) / np.maximum(obs, 1), np.nan)
    return pd.DataFrame(
        {
            "obs": obs.astype(int),
            "zero_ratio": zero_ratio,
            "cv": cv,
            "mean_daily": mean_daily,
            "active": panel.active(origin),
        },
        index=pd.Index(panel.barcodes, name="barkod"),
    )


def assign_groups(stats: pd.DataFrame, th: GroupThresholds) -> pd.Series:
    out = np.full(len(stats), "variable", dtype=object)
    cv = stats["cv"].to_numpy()
    zr = stats["zero_ratio"].to_numpy()
    obs = stats["obs"].to_numpy()
    cut = list(th.cv_split)
    with np.errstate(invalid="ignore"):
        out[np.nan_to_num(cv, nan=np.inf) <= cut[0]] = "steady"
        if len(cut) > 1:
            out[np.nan_to_num(cv, nan=-np.inf) > cut[1]] = "erratic"
        out[np.nan_to_num(zr, nan=0.0) > th.zero_ratio_intermittent] = "intermittent"
    out[obs < th.min_obs] = "sparse"
    out[~stats["active"].to_numpy(dtype=bool)] = "sparse"
    return pd.Series(out, index=stats.index, name="group")


def candidate_cv_splits(stats_list: list[pd.DataFrame], zero_ratio: float, quantiles: tuple[float, ...], min_obs: int) -> list[float]:
    """Cut-point candidates: CV quantiles of non-intermittent, non-sparse products."""
    vals: list[float] = []
    for st in stats_list:
        m = (st["obs"] >= min_obs) & (st["zero_ratio"] <= zero_ratio) & st["cv"].notna()
        vals.extend(st.loc[m, "cv"].tolist())
    if not vals:
        return [0.5]
    return sorted({round(float(np.quantile(vals, q)), 4) for q in quantiles})
