"""Chronological split, horizon definitions, update rule and metrics (2.5)."""

from __future__ import annotations

import copy

import numpy as np
import pandas as pd
import pytest

from dukkan_tahmin.backtest import choose_pilot, horizon_windows, with_groups
from dukkan_tahmin.combine import fit_weights
from dukkan_tahmin.config import METHODS
from dukkan_tahmin.metrics import block_bootstrap_wape_diff, mae, relative_improvement, spread, wape


def test_horizon_windows_calendar_and_30d():
    w = horizon_windows(pd.Timestamp("2026-10-26"), "calendar")
    assert w["weekly"] == (1, 7)
    assert w["monthly"] == (6, 35)  # 2026-11-01 .. 2026-11-30
    assert horizon_windows(pd.Timestamp("2026-01-31"), "calendar")["monthly"] == (1, 28)  # February
    assert horizon_windows(pd.Timestamp("2024-01-31"), "calendar")["monthly"] == (1, 29)  # leap year
    assert horizon_windows(pd.Timestamp("2026-10-26"), "30d")["monthly"] == (1, 30)


def test_plan_is_chronological(evaluated, cfg):
    panel, res = evaluated
    plan = res.plan
    d = panel.dates
    assert d[plan.test_start] == pd.Timestamp("2025-11-01")  # last 12 of 36 months are external test
    assert len(plan.external) >= 6
    for o in plan.internal:
        end = o + horizon_windows(d[o], cfg.monthly_mode)["monthly"][1]
        assert end < plan.test_start, "internal horizons must end before the external test area"
        assert d[o + 1].day == 1  # month-end origins
    for o in plan.external:
        assert o >= plan.test_start - 1 and d[o + 1].day == 1
    assert set(plan.tune) <= set(plan.internal)
    assert max(plan.internal) < min(plan.external)


def test_pilot_fixed_before_test(evaluated, cfg):
    panel, res = evaluated
    p2 = copy.deepcopy(panel)
    p2.Y[:, res.plan.test_start :] *= 0.0  # destroy the test period
    pilot2, _ = choose_pilot(p2, res.plan, cfg)
    assert pilot2 == res.pilot
    assert all(panel.units[list(panel.barcodes).index(b)] == "adet" for b in res.pilot)


def test_update_uses_only_elapsed_outcomes(evaluated, cfg):
    panel, res = evaluated
    rec = with_groups(res.records, res.thresholds)
    for entry, o in zip(res.per_origin, res.plan.external):
        allowed = rec[rec["h_end"] <= o]
        ws = fit_weights(allowed, res.lam, cfg.scale, groups=res.thresholds.groups)
        assert entry["version"]["weights"] == {h: {g: float(v) for g, v in w.items()} for h, w in ws.weights.items()}
        assert (allowed["origin"] < o).all()  # nothing from the current or a later origin
        # the monthly forecast made one origin earlier has just elapsed and is allowed
    first = res.plan.external[0]
    assert (rec.loc[rec["h_end"] <= first, "phase"] == "internal").all()


def test_records_match_panel_actuals(evaluated):
    panel, res = evaluated
    ext = res.records[res.records["phase"] == "external"]
    r = ext.iloc[len(ext) // 2]
    o = int(r["origin"])
    a, b = res.forecasts[o].windows[r["horizon"]]
    idx = np.arange(o + a, o + b + 1)
    idx = idx[panel.recorded[idx]]
    assert r["y"] == pytest.approx(np.nansum(panel.Y[int(r["p"]), idx]))
    assert r["n_days"] == len(idx)


def test_summary_has_all_methods_and_spread(evaluated):
    _, res = evaluated
    s = res.summary["summary"]
    for h in ("weekly", "monthly"):
        assert set(s[h]["wape_pilot"]) == set(METHODS)
        for m in METHODS:
            sp = s[h]["spread"][m]
            # pooled WAPE is an actual-weighted mean of per-origin WAPEs
            assert sp["min"] - 1e-9 <= s[h]["wape_pilot"][m] <= sp["max"] + 1e-9
        assert s[h]["bootstrap_ci_wape_diff"]["combined_minus_xgboost"] is not None
    # ablation (i) uses one common weight everywhere
    assert len(set(res.fixed["ablation_common_weight"].weights["monthly"].values())) == 1


def test_metrics_definitions():
    assert mae([1, 2, 3], [1, 1, 1]) == pytest.approx(1.0)
    assert wape([10, 10], [8, 13]) == pytest.approx(25.0)
    assert wape([0, 0], [1, 2]) is None  # undefined -> None, report MAE instead
    assert spread([1.0, None, 3.0])["max"] == 3.0
    assert relative_improvement(10.0, 9.0) == pytest.approx(10.0)
    assert block_bootstrap_wape_diff([1] * 5, [1] * 5, [10] * 5) is None  # < 6 origins
    rng = np.random.default_rng(0)
    y = rng.uniform(80, 120, 10)
    ea, eb = rng.uniform(5, 10, 10), rng.uniform(8, 14, 10)
    ci = block_bootstrap_wape_diff(ea, eb, y, n_boot=500)
    assert ci["lo"] <= ci["estimate"] <= ci["hi"]
