"""Baseline forecasters (proposal 2.3).

* Seasonal naive ``S``: for a future day, the last known value of the same
  weekday on or before the origin; the weekly pattern is repeated across the
  horizon.
* Global XGBoost ``X``: one model for all products (product id categorical),
  forecast recursively day by day: each prediction is written back into the
  working series so later lags / moving averages use *predictions*, never the
  actual future values. The working series is a fresh copy truncated at the
  origin, so future actuals are not even present in memory for the forecast.

Both forecasts are clipped at 0. Closed future days are forecast as 0.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import xgboost as xgb

from .config import Config
from .features import feature_names, feature_tensor, feature_types
from .panel import Panel


def seasonal_naive(panel: Panel, origin: int, horizon: int, max_weeks: int = 8) -> np.ndarray:
    """(P, horizon) seasonal-naive path; NaN rows for products not yet listed."""
    Y = panel.Y[:, : origin + 1]
    P = panel.n_products
    out = np.full((P, horizon), np.nan)
    active = panel.active(origin)
    days = panel.dates_until(origin, horizon)[origin + 1 :]
    closed = panel.is_closed(days)
    wd_hist = panel.dates[: origin + 1].weekday.to_numpy()
    recent = Y[:, max(0, origin - 27) : origin + 1]
    n_known = (~np.isnan(recent)).sum(axis=1)
    fallback = np.where(n_known > 0, np.nansum(recent, axis=1) / np.maximum(n_known, 1), 0.0)
    by_wd: dict[int, np.ndarray] = {}
    for w in range(7):
        idx = np.flatnonzero(wd_hist == w)[::-1][:max_weeks]
        vals = Y[:, idx] if len(idx) else np.full((P, 1), np.nan)
        known = ~np.isnan(vals)
        first = known.argmax(axis=1)
        v = vals[np.arange(P), first]
        by_wd[w] = np.where(known.any(axis=1), v, fallback)
    for h, d in enumerate(days):
        out[:, h] = 0.0 if closed[h] else by_wd[d.weekday()]
    out[~active] = np.nan
    return np.clip(out, 0.0, None)


def training_matrix(panel: Panel, origin: int, cfg: Config) -> tuple[np.ndarray, np.ndarray]:
    """Rows (p, t) with known target, t <= origin and t after the first sale."""
    Y = panel.Y[:, : origin + 1]
    dates = panel.dates[: origin + 1]
    hol, eve = panel.calendar_arrays(dates)
    cols = np.arange(1, origin + 1)
    F = feature_tensor(Y, dates, cols, cfg.lags, cfg.ma_windows, hol, eve)
    target = Y[:, cols]
    after_first = cols[None, :] > np.where(panel.first_sale < 0, origin + 1, panel.first_sale)[:, None]
    mask = ~np.isnan(target) & after_first
    return F[mask].astype(np.float32), target[mask].astype(np.float32)


def xgb_params(grid_point: dict[str, Any], cfg: Config) -> dict[str, Any]:
    return {
        "objective": "reg:squarederror",
        "tree_method": "hist",
        "max_depth": int(grid_point["max_depth"]),
        "eta": float(grid_point["eta"]),
        "min_child_weight": float(grid_point["min_child_weight"]),
        "max_cat_to_onehot": 1,
        "nthread": cfg.n_jobs,
        "seed": cfg.random_state,
        "verbosity": 0,
    }


def fit_xgb(panel: Panel, origin: int, grid_point: dict[str, Any], cfg: Config) -> xgb.Booster:
    X, y = training_matrix(panel, origin, cfg)
    dtrain = xgb.DMatrix(
        X,
        label=y,
        feature_names=feature_names(cfg.lags, cfg.ma_windows),
        feature_types=feature_types(cfg.lags, cfg.ma_windows),
        enable_categorical=True,
    )
    return xgb.train(xgb_params(grid_point, cfg), dtrain, num_boost_round=int(grid_point["n_estimators"]))


def xgb_recursive(booster: xgb.Booster, panel: Panel, origin: int, horizon: int, cfg: Config) -> np.ndarray:
    """(P, horizon) recursive XGBoost path using only data up to ``origin``."""
    P = panel.n_products
    days = panel.dates_until(origin, horizon)
    hol, eve = panel.calendar_arrays(days)
    work = np.full((P, origin + 1 + horizon), np.nan)
    work[:, : origin + 1] = panel.Y[:, : origin + 1]
    closed = panel.is_closed(days[origin + 1 :])
    active = panel.active(origin)
    out = np.full((P, horizon), np.nan)
    for h in range(horizon):
        t = origin + 1 + h
        if closed[h]:
            out[active, h] = 0.0
            continue  # closed day stays unknown (NaN) in the working series, as in history
        F = feature_tensor(work, days, np.array([t]), cfg.lags, cfg.ma_windows, hol, eve)[:, 0, :]
        pred = np.clip(booster.inplace_predict(F[active].astype(np.float32)), 0.0, None)
        out[active, h] = pred
        work[active, t] = pred
    return out
