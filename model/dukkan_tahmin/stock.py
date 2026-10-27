"""Order-up-to stock rule with a review period (proposal 2.6, Eq. 6) and a
simple, loudly-assumption-laden policy simulation.

Eq. 6   S_i = D_i(L_i + R_i) + SS_i
        suggested order = ceil_pack( max(0, S_i - IP_i) ),
        IP_i = on hand + on order - reserved

* D_i(L+R): sum of the daily *combined* forecasts over the L + R days after
  the origin (from the recursive daily paths);
* SS_i: the ``service_level`` quantile of past under-forecast errors
  (actual - forecast over the same L + R window, validation origins only),
  clipped at 0: SS = max(0, Q_q(e)) = Q_q(max(e, 0)). With fewer than
  ``ss_min_errors`` errors for a product, the product-scaled errors of all
  products of the same unit are pooled.

The Python layer does not know current stock: :func:`stock_block` returns D,
SS and the order-up-to level with ``on_hand``/``suggested_order`` = null for
the tablet app to fill; :func:`compute_order` does the last step when the
stock position is known.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from typing import Any

import numpy as np

from .backtest import BacktestResult, OriginForecast
from .config import Config
from .panel import Panel

SIM_ASSUMPTIONS = [
    "Gözlenen satış talep yerine kullanıldı; geçmişte stok tükenmesi varsa gerçek talep daha yüksek olabilir.",
    "Tüm yöntemler aynı başlangıç stoğu, aynı tedarik süresi, aynı gözden geçirme aralığı ve aynı sipariş kuralıyla çalıştırıldı.",
    "Tedarik süresi sabit ve kesin kabul edildi; sipariş eksiksiz ve zamanında geldi.",
    "Bozulma, fire, raf ömrü, depo kapasitesi ve minimum sipariş kısıtı modellenmedi.",
    "Kayıt bulunmayan günlerde satış sıfır kabul edildi.",
    "Karşılanamayan miktar kaybedildi (sonraya ertelenmedi); kayıp satış veya kâr iddiası değildir.",
    "Alış maliyeti olmadığından maliyet veya kârlılık hesaplanmadı.",
]


def ceil_to_pack(q: float, pack: float) -> float:
    if pack <= 0:
        return float(q)
    return float(math.ceil(q / pack - 1e-9) * pack)


def order_up_to_level(demand_lr: float, safety_stock: float, pack: float = 1.0) -> float:
    """Eq. 6 left-hand side, rounded up to the pack size."""
    return ceil_to_pack(max(0.0, demand_lr) + max(0.0, safety_stock), pack)


def compute_order(
    order_up_to: float, on_hand: float, on_order: float = 0.0, reserved: float = 0.0, pack_size: float = 1.0
) -> float:
    """Suggested order = ceil_pack(max(0, S - IP)), IP = on hand + on order - reserved."""
    ip = on_hand + on_order - reserved
    return ceil_to_pack(max(0.0, order_up_to - ip), pack_size)


def weight_horizon(window: int) -> str:
    return "weekly" if window <= 14 else "monthly"


def daily_path(fc: OriginForecast, method: str, window: int) -> np.ndarray:
    a = fc.method_weights[method][weight_horizon(window)][:, None]
    return a * fc.X + (1 - a) * fc.S


def window_errors(
    panel: Panel, forecasts: Iterable[OriginForecast], method: str, window: int, upto: int
) -> tuple[dict[int, list[float]], dict[int, list[float]]]:
    """Per product: errors (actual - forecast) over days origin+1..origin+window and their scales."""
    errs: dict[int, list[float]] = {}
    scales: dict[int, list[float]] = {}
    T = len(panel.dates)
    for fc in forecasts:
        o = fc.origin
        if o + window > min(upto, T - 1):
            continue
        idx = np.arange(o + 1, o + window + 1)
        mask = panel.recorded[idx]
        if not mask.any():
            continue
        F = daily_path(fc, method, window)[:, :window][:, mask].sum(axis=1)
        A = np.nansum(panel.Y[:, idx[mask]], axis=1)
        m = fc.stats["mean_daily"].to_numpy() * mask.sum()
        for p in np.flatnonzero(panel.active(o)):
            errs.setdefault(p, []).append(float(A[p] - F[p]))
            scales.setdefault(p, []).append(float(m[p]))
    return errs, scales


def safety_stocks(
    panel: Panel,
    errs: dict[int, list[float]],
    scales: dict[int, list[float]],
    current_scale: np.ndarray,
    q: float,
    min_errors: int,
) -> tuple[np.ndarray, np.ndarray]:
    """SS per product and a flag telling whether pooled errors were used."""
    P = panel.n_products
    ss = np.zeros(P)
    pooled_flag = np.zeros(P, bool)
    pooled: dict[str, list[float]] = {}
    for p, e in errs.items():
        for v, m in zip(e, scales[p]):
            if m > 0:
                pooled.setdefault(str(panel.units[p]), []).append(v / m)
    for p in range(P):
        e = errs.get(p, [])
        if len(e) >= min_errors:
            ss[p] = max(0.0, float(np.quantile(e, q)))
        else:
            pool = pooled.get(str(panel.units[p]), [])
            if pool and current_scale[p] > 0:
                ss[p] = max(0.0, float(np.quantile(pool, q)) * float(current_scale[p]))
            pooled_flag[p] = True
    return ss, pooled_flag


def pack_size_for(unit: str, cfg: Config, overrides: dict[str, float] | None = None, barcode: str = "") -> float:
    if overrides and barcode in overrides:
        return float(overrides[barcode])
    return cfg.pack_size_kg if unit == "kg" else cfg.pack_size_adet


def simulate_policy(
    panel: Panel,
    res: BacktestResult,
    cfg: Config,
    methods: Sequence[str] = ("seasonal_naive", "xgboost", "combined"),
    products: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Periodic-review order-up-to simulation over the external test period.

    Every method gets the same starting stock, lead time, review interval,
    pack sizes and rule; only D (its own forecast) and SS (its own internal
    validation errors) differ.
    """
    L, R = cfg.lead_time_days, cfg.review_days
    win = L + R
    ext = sorted(res.plan.external)
    internal = [res.forecasts[o] for o in res.plan.internal]
    o1 = ext[0]
    sim_end = max(o + res.forecasts[o].windows["monthly"][1] for o in ext)
    sim_end = min(sim_end, len(panel.dates) - 1)
    bc = list(panel.barcodes)
    pidx = [bc.index(b) for b in (products if products is not None else res.pilot)]
    pidx = [p for p in pidx if panel.active(o1)[p]]
    actual = np.nan_to_num(panel.Y[:, o1 + 1 : sim_end + 1], nan=0.0)
    mean_daily = res.forecasts[o1].stats["mean_daily"].to_numpy()
    packs = np.array([pack_size_for(str(panel.units[p]), cfg) for p in range(panel.n_products)])
    start_stock = np.array([ceil_to_pack(mean_daily[p] * win, packs[p]) for p in range(panel.n_products)])
    out: dict[str, Any] = {
        "period": {"start": panel.dates[o1 + 1].date().isoformat(), "end": panel.dates[sim_end].date().isoformat()},
        "products": [bc[p] for p in pidx],
        "lead_time_days": L,
        "review_days": R,
        "service_level": cfg.service_level,
        "assumptions": SIM_ASSUMPTIONS,
        "methods": {},
    }
    for m in methods:
        errs, scales = window_errors(panel, internal, m, win, upto=o1)
        ss, _ = safety_stocks(panel, errs, scales, mean_daily * win, cfg.service_level, cfg.ss_min_errors)
        on_hand = start_stock.copy()
        pipeline: dict[int, np.ndarray] = {}
        unmet = np.zeros(panel.n_products)
        hold = np.zeros(panel.n_products)
        n_orders = 0
        ordered = 0.0
        days = range(o1 + 1, sim_end + 1)
        reviews = set(range(o1, sim_end - win + 1, R))
        if o1 in reviews:
            on_hand, n_orders, ordered = _review(o1, res, ext, m, win, ss, packs, on_hand, pipeline, pidx, n_orders, ordered, L)
        for t in days:
            if t in pipeline:
                on_hand = on_hand + pipeline.pop(t)
            dem = actual[:, t - o1 - 1]
            sold = np.minimum(on_hand, dem)
            unmet += dem - sold
            on_hand = on_hand - sold
            hold += on_hand
            if t in reviews:
                on_hand, n_orders, ordered = _review(t, res, ext, m, win, ss, packs, on_hand, pipeline, pidx, n_orders, ordered, L)
        n_days = len(days)
        tot = float(actual[pidx].sum())
        out["methods"][m] = {
            "unmet_observed_sales": float(unmet[pidx].sum()),
            "observed_sales": tot,
            "fill_rate": float(1 - unmet[pidx].sum() / tot) if tot > 0 else None,
            "avg_on_hand": float(hold[pidx].sum() / max(n_days, 1)),
            "n_orders": int(n_orders),
            "ordered_quantity": float(ordered),
        }
    return out


def _review(
    r: int,
    res: BacktestResult,
    ext: list[int],
    method: str,
    win: int,
    ss: np.ndarray,
    packs: np.ndarray,
    on_hand: np.ndarray,
    pipeline: dict[int, np.ndarray],
    pidx: list[int],
    n_orders: int,
    ordered: float,
    L: int,
) -> tuple[np.ndarray, int, float]:
    o = max(x for x in ext if x <= r)
    fc = res.forecasts[o]
    path = daily_path(fc, method, win)
    lo = r - o
    D = np.nan_to_num(path[:, lo : lo + win]).sum(axis=1)
    on_order = sum(pipeline.values()) if pipeline else np.zeros_like(on_hand)
    q = np.zeros_like(on_hand)
    for p in pidx:
        S = order_up_to_level(D[p], ss[p], packs[p])
        q[p] = compute_order(S, on_hand[p], float(on_order[p]), 0.0, packs[p])
    if q.any():
        arrive = r + max(L, 1)
        pipeline[arrive] = pipeline.get(arrive, np.zeros_like(on_hand)) + q
        n_orders += int((q[pidx] > 0).sum())
        ordered += float(q[pidx].sum())
    return on_hand, n_orders, ordered
