"""Production forecast at the last observed day + stock block (Eq. 6).

Uses the settings frozen by the backtest (XGBoost parameters, thresholds,
lambda, a0) and the (iv) group weights refitted from every outcome observed so
far. ``order_up_to`` is not rounded; the app rounds the final order to the pack.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from .backtest import BacktestResult, OriginForecast, _method_weight_arrays, forecast_at
from .combine import WeightSet
from .config import Config
from .groups import assign_groups
from .panel import Panel
from .stock import daily_path, order_up_to_level, pack_size_for, safety_stocks, window_errors


@dataclass
class StockParams:
    lead_time_days: int
    review_days: int
    pack_size: float


def read_stock_params(path: str) -> dict[str, StockParams]:
    """Optional per-product CSV: ``barkod;tedarik_gun;gozden_gecirme_gun;paket``."""
    from .io_csv import detect_separator

    with open(path, encoding="utf-8-sig") as fh:
        sep = detect_separator(fh.readline())
    df = pd.read_csv(path, sep=sep, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    out = {}
    for r in df.itertuples(index=False):
        d = r._asdict()
        out[str(d["barkod"]).strip()] = StockParams(
            int(d.get("tedarik_gun") or 0), int(d.get("gozden_gecirme_gun") or 0),
            float(str(d.get("paket") or "1").replace(",", ".")),
        )
    return out


@dataclass
class FinalForecast:
    fc: OriginForecast
    weights: WeightSet
    products: list[dict[str, Any]]


def _r(v: float | None, nd: int = 3) -> float | None:
    if v is None or not np.isfinite(v):
        return None
    return round(float(v), nd)


def final_forecast(
    panel: Panel, res: BacktestResult, cfg: Config, stock_params: dict[str, StockParams] | None = None
) -> FinalForecast:
    o = len(panel.dates) - 1
    sp = stock_params or {}
    windows_needed = [cfg.lead_time_days + cfg.review_days] + [s.lead_time_days + s.review_days for s in sp.values()]
    fc = forecast_at(panel, o, res.best_params, cfg, "final", min_days=max(windows_needed) + 7)
    fc.groups = assign_groups(fc.stats, res.thresholds)
    ws = res.weights_iv(o)
    fc.method_weights = _method_weight_arrays(fc.groups, res.fixed, ws)

    past = [res.forecasts[k] for k in sorted(res.forecasts)]
    ss_cache: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    mean_daily = fc.stats["mean_daily"].to_numpy()

    def ss_for(win: int) -> tuple[np.ndarray, np.ndarray]:
        if win not in ss_cache:
            errs, scales = window_errors(panel, past, "combined", win, upto=o)
            ss_cache[win] = safety_stocks(
                panel, errs, scales, mean_daily * win, cfg.service_level, cfg.ss_min_errors, units=panel.units_full
            )
        return ss_cache[win]

    Y = panel.Y
    products = []
    for p in np.flatnonzero(panel.active(o)):
        b = str(panel.barcodes[p])
        g = str(fc.groups.iloc[p])
        unit = str(panel.units_full[p])  # whole-history unit for the operational output
        flags: list[str] = []
        st = fc.stats.iloc[p]
        if st["obs"] < res.thresholds.min_obs:
            flags.append("new_product")
        if g == "sparse" or ws.fallback["weekly"].get(g, True) or ws.fallback["monthly"].get(g, True):
            flags.append("fallback_a0")
        sales_idx = np.flatnonzero(np.nan_to_num(Y[p, : o + 1]) > 0)
        last_sale = panel.dates[sales_idx[-1]].date().isoformat() if len(sales_idx) else None
        if len(sales_idx) and o - sales_idx[-1] >= 56:
            flags.append("inactive")
        recent = Y[p, max(0, o - 89) : o + 1]
        mean90 = float(np.nanmean(recent)) if np.isfinite(recent).any() else None

        fcast: dict[str, Any] = {}
        for h, (a, bb) in fc.windows.items():
            w = float(fc.method_weights["combined"][h][p])
            x = float(fc.X[p, a - 1 : bb].sum())
            s = float(fc.S[p, a - 1 : bb].sum())
            fcast[h] = {
                "combined": _r(w * x + (1 - w) * s),
                "xgboost": _r(x),
                "seasonal_naive": _r(s),
                "weight": _r(w, 4),
            }
            if h == "weekly":
                fcast[h]["daily"] = [_r(v) for v in (w * fc.X[p, a - 1 : bb] + (1 - w) * fc.S[p, a - 1 : bb])]

        prm = sp.get(b, StockParams(cfg.lead_time_days, cfg.review_days, pack_size_for(unit, cfg)))
        win = prm.lead_time_days + prm.review_days
        D = float(np.nan_to_num(daily_path(fc, "combined", win)[p, :win]).sum())
        ss_arr, pooled = ss_for(win)
        ss = float(ss_arr[p])
        if pooled[p]:
            flags.append("ss_pooled")
        if b not in res.per_product:
            flags.append("not_in_backtest")
        products.append(
            {
                "barcode": b,
                "name": str(panel.names[p]),
                "category": str(panel.categories[p]),
                "unit": unit,
                "group": g,
                "history": {"observations": int(st["obs"]), "last_sale": last_sale, "mean_daily_90d": _r(mean90)},
                "forecast": fcast,
                "backtest": _clean_backtest(res.per_product.get(b)),
                "stock": {
                    "lead_time_days": int(prm.lead_time_days),
                    "review_days": int(prm.review_days),
                    "demand_over_lead_and_review": _r(D),
                    "safety_stock": _r(ss),
                    "order_up_to": _r(order_up_to_level(D, ss)),  # unrounded; the app rounds the order
                    "pack_size": float(prm.pack_size),
                    "service_level": float(cfg.service_level),
                    "on_hand": None,
                    "suggested_order": None,
                },
                "flags": flags,
            }
        )
    return FinalForecast(fc=fc, weights=ws, products=products)


def _clean_backtest(d: dict[str, Any] | None) -> dict[str, Any] | None:
    if d is None:
        return None
    return {
        h: {
            "mae": {m: _r(v) for m, v in d[h]["mae"].items()},
            "wape": {m: _r(v) for m, v in d[h]["wape"].items()},
            "n_origins": d[h]["n_origins"],
        }
        for h in d
    }
