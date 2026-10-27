"""Eq. 6 stock rule and the policy simulation (2.6)."""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest

from dukkan_tahmin.stock import ceil_to_pack, compute_order, order_up_to_level, safety_stocks, simulate_policy


def test_order_rounding_and_clipping():
    assert ceil_to_pack(305.2, 1) == 306
    assert ceil_to_pack(12.0, 6) == 12  # exact multiple not bumped
    assert order_up_to_level(370.5, 35.0) == 405.5  # S is not rounded (L6) ...
    assert compute_order(405.5, on_hand=100, on_order=0, reserved=0, pack_size=12) == 312  # ... only the order is
    # S = 10.2, IP = 1, pack 5: rounded once -> ceil5(9.2) = 10; rounding S first (15) would give ceil5(14) = 15
    assert compute_order(order_up_to_level(8.2, 2.0), on_hand=1.0, pack_size=5) == 10
    assert compute_order(406, on_hand=300, on_order=150, reserved=10) == 0  # IP above S -> no order
    assert compute_order(50, on_hand=10, on_order=5, reserved=5) == 40  # IP = 10 + 5 - 5
    assert compute_order(2.0, on_hand=0.35, pack_size=0.5) == pytest.approx(2.0)


def test_safety_stock_uses_only_under_forecast_errors(evaluated):
    panel, _ = evaluated
    P = panel.n_products
    mixed = [-40.0, -30.0, -20.0, -10.0, 1.0, 2.0, 3.0, 4.0, 5.0]
    errs = {0: [-5.0, -3.0, -1.0, -2.0, -4.0], 1: list(np.arange(1.0, 11.0)), 3: mixed, 4: [-9.0, -8.0, -7.0, 6.0, 8.0]}
    scales = {k: [10.0] * len(v) for k, v in errs.items()}
    ss, pooled = safety_stocks(panel, errs, scales, np.full(P, 10.0), 0.9, 4)
    assert ss[0] == 0.0 and not pooled[0]  # never under-forecast -> no safety stock
    assert ss[1] == pytest.approx(np.quantile(np.arange(1.0, 11.0), 0.9))
    # L9 regression: the quantile is taken over the positive errors only, not over all signed errors
    assert ss[3] == pytest.approx(np.quantile([1.0, 2.0, 3.0, 4.0, 5.0], 0.9))
    assert ss[3] > max(0.0, np.quantile(mixed, 0.9))
    # 2 positive errors (< 4): pooled scaled positive errors of the same unit x own scale
    assert pooled[4] and pooled[2] and not pooled[1] and not pooled[3]
    same_unit = [k for k in errs if panel.units[k] == panel.units[4]]
    pool = [v / 10.0 for k in same_unit for v in errs[k] if v > 0]
    assert ss[4] == pytest.approx(np.quantile(pool, 0.9) * 10.0)


def test_tahmin_stock_block(tahmin):
    for p in tahmin["products"]:
        st = p["stock"]
        assert st["on_hand"] is None and st["suggested_order"] is None
        # L6: order_up_to is D + SS, unrounded (the app rounds the final order once)
        assert st["order_up_to"] == pytest.approx(st["demand_over_lead_and_review"] + st["safety_stock"], abs=2e-3)
        assert st["pack_size"] > 0


def test_simulation_same_rule_and_monotone_in_service_level(evaluated, cfg):
    panel, res = evaluated
    sim = res.simulation
    assert set(sim["methods"]) == {"seasonal_naive", "xgboost", "combined"}
    tot = {m["observed_sales"] for m in sim["methods"].values()}
    assert len(tot) == 1  # identical observed sales for all methods
    for m in sim["methods"].values():
        assert 0 <= m["unmet_observed_sales"] <= m["observed_sales"]
        assert 0 <= m["fill_rate"] <= 1
    lo = simulate_policy(panel, res, replace(cfg, service_level=0.5))
    hi = simulate_policy(panel, res, replace(cfg, service_level=0.99))
    for m in lo["methods"]:
        assert hi["methods"][m]["unmet_observed_sales"] <= lo["methods"][m]["unmet_observed_sales"]
        assert hi["methods"][m]["avg_on_hand"] >= lo["methods"][m]["avg_on_hand"]
    assert any("Gözlenen satış" in a for a in sim["assumptions"])
