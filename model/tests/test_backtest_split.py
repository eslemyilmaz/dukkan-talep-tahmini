"""Chronological split, horizon definitions, update rule and metrics (2.5)."""

from __future__ import annotations

import copy
from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from dukkan_tahmin.backtest import (
    choose_pilot,
    horizon_windows,
    make_plan,
    min_months_required,
    pilot_wape_block,
    select_thresholds_lambda,
    selection_score,
    with_groups,
)
from dukkan_tahmin.combine import fit_a0, fit_weights
from dukkan_tahmin.config import METHODS, Config
from dukkan_tahmin.metrics import block_bootstrap_wape_diff, mae, relative_improvement, spread, wape
from dukkan_tahmin.panel import build_panel
from dukkan_tahmin.quality import clean_sales, quality_warnings
from dukkan_tahmin.synthetic import generate


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


def _setup(rows, cfg):
    data = clean_sales(rows, cfg)
    panel = build_panel(data, cfg)
    plan = make_plan(panel, cfg)
    pilot, _ = choose_pilot(panel, plan, cfg)
    return data, panel, plan, pilot


def test_pilot_fixed_before_test(synth, evaluated, cfg):
    """M2 regression: test-period changes in the *raw rows* (before cleaning) must not change the
    pilot set, the units used for evaluation or the auto-detected closed weekdays."""
    panel, res = evaluated
    assert all(panel.units[list(panel.barcodes).index(b)] == "adet" for b in res.pilot)

    rows = synth.canonical_rows().assign(birim="")  # raw-report situation: units must be inferred
    data0, panel0, plan0, pilot0 = _setup(rows, cfg)
    cut = panel0.dates[plan0.test_start]
    assert data0.quality["inference_cutoff"] == cut.date().isoformat()
    test = rows["tarih"] >= cut
    top = pilot0[0]

    frac = rows.copy()  # one fractional sale of the top pilot product inside the test period
    i = frac.index[(frac["barkod"] == top) & test & (frac["miktar"] > 0)][0]
    frac.loc[i, "miktar"] = 1.5
    closed = rows[~(test & (rows["tarih"].dt.weekday == 0))]  # shop closes on Mondays in the test period
    wiped = rows.assign(miktar=np.where(test & (rows["urun"] != "HESAP"), 0.0, rows["miktar"]))
    scaled = rows.assign(miktar=np.where(test & (rows["miktar"] > 0), rows["miktar"] * 50, rows["miktar"]))
    for label, r in (("frac", frac), ("closed", closed), ("wiped", wiped), ("x50", scaled)):
        data, panel1, plan1, pilot1 = _setup(r, cfg)
        assert plan1.test_start == plan0.test_start, label
        assert pilot1 == pilot0, label
        assert data.closed_weekdays == data0.closed_weekdays, label
        before = [b for b in data0.products.index if panel0.first_sale[list(panel0.barcodes).index(b)] < plan0.test_start]
        assert (data.products.loc[before, "birim"] == data0.products.loc[before, "birim"]).all(), label
    # closed-weekday detection: Sundays closed before the test area; opening on Sundays inside the
    # test area must not change the detected closure (full-history detection gave 33 % -> "open")
    sunday = rows["tarih"].dt.weekday == 6
    sun_closed = rows[~(~test & sunday)]
    assert clean_sales(sun_closed, cfg).closed_weekdays == (6,)
    assert clean_sales(rows[~sunday], cfg).closed_weekdays == (6,)
    # the whole-history unit is still reported (for the final forecast) and flagged
    d_frac = clean_sales(frac, cfg)
    assert d_frac.products.loc[top, "birim"] == "adet" and d_frac.products.loc[top, "birim_tum"] == "kg"
    assert top in d_frac.quality["units_changed_in_test_area"]
    assert any("test alanındaki kesirli" in w for w in quality_warnings(d_frac.quality))


def test_empty_pilot_set_is_an_error(synth, cfg):
    """M4: an all-kg data set must not run silently with an empty pilot set."""
    rows = synth.canonical_rows().assign(birim="kg")
    data = clean_sales(rows, cfg)
    panel = build_panel(data, cfg)
    with pytest.raises(ValueError, match="Pilot küme boş.*--pilot"):
        choose_pilot(panel, make_plan(panel, cfg), cfg)
    with pytest.raises(ValueError, match="Pilot küme boş"):
        choose_pilot(panel, make_plan(panel, cfg), replace(cfg, pilot_products=("yok-1", "yok-2")))


def test_selection_score_skips_undefined_wape():
    assert selection_score({"monthly": 10.0, "weekly": None}) == 10.0
    assert selection_score({"monthly": None, "weekly": None}) is None  # cannot win the selection
    assert selection_score({"monthly": 3.0, "weekly": 4.0}) == 7.0


def test_min_data_length_rule(cfg):
    """L4: the documented minimum (20 calendar months from the 1st, 22 otherwise) is the real one."""
    assert min_months_required(Config()) == 20
    for months, trim, ok in ((19, 0, False), (20, 0, True), (21, 5, False), (22, 5, True)):
        rows = generate(months=months, n_products=3, seed=1, end="2026-09-30", n_gap_days=0).canonical_rows()
        rows = rows[rows["tarih"] >= rows["tarih"].min() + pd.Timedelta(days=trim)]
        panel = build_panel(clean_sales(rows, Config()), Config())
        if ok:
            assert len(make_plan(panel, Config()).internal) >= 2
        else:
            with pytest.raises(ValueError, match="--en-az-egitim-ay"):
                make_plan(panel, Config())
            assert len(make_plan(panel, Config(min_train_months=10)).internal) >= 2


def test_a0_fixed_from_internal_validation(evaluated, cfg):
    """M3: a0 (and lambda) are set in internal validation only; external origins update a_g only."""
    panel, res = evaluated
    rec = with_groups(res.records, res.thresholds)
    internal = rec[rec["phase"] == "internal"]
    assert res.a0 == fit_a0(internal, cfg.scale)
    for entry in res.per_origin:
        assert entry["version"]["a0"] == res.a0
        assert entry["version"]["lambda"] == res.lam
    T = len(panel.dates) - 1
    assert res.weights_iv(T).a0 == res.a0
    # external outcomes that would move a re-estimated a0 (the old behaviour) leave it unchanged
    res2 = copy.copy(res)
    ext = res.records["phase"] == "external"
    res2.records = res.records.assign(y=np.where(ext, res.records["s"], res.records["y"]))
    moved = fit_a0(with_groups(res2.records, res.thresholds).query("h_end <= @T"), cfg.scale)
    assert moved != res.a0
    assert res2.weights_iv(T).a0 == res.a0


def test_pilot_wape_and_spread_use_same_origins():
    """L7: an origin whose pilot actuals sum to 0 is left out of the pooled WAPE as well as the spread."""
    recs = []
    for o, ys, fs in ((1, [10, 10], [8, 13]), (2, [0, 0], [50, 50]), (3, [20, 0], [10, 5])):
        for y, f in zip(ys, fs):
            recs.append({"origin": o, "y": float(y), **{f"f_{m}": float(f) for m in METHODS}})
    blk = pilot_wape_block(pd.DataFrame(recs))
    assert blk["n_origins"] == 2 and blk["n_origins_zero_actual"] == 1
    expected = 100 * (2 + 3 + 10 + 5) / 40  # origins 1 and 3 only
    for m in METHODS:
        assert blk["wape_pilot"][m] == pytest.approx(expected)
        assert blk["spread"][m]["min"] <= blk["wape_pilot"][m] <= blk["spread"][m]["max"]
    assert blk["actual_sums"] == [20.0, 20.0]


def test_update_uses_only_elapsed_outcomes(evaluated, cfg):
    panel, res = evaluated
    rec = with_groups(res.records, res.thresholds)
    for entry, o in zip(res.per_origin, res.plan.external):
        allowed = rec[rec["h_end"] <= o]
        ws = fit_weights(allowed, res.lam, cfg.scale, a0=res.a0, groups=res.thresholds.groups)
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


def test_selection_with_no_valid_wape_warns(evaluated, cfg):
    """M4: all-zero pilot actuals in the internal area -> no silent 'best = 0' pick, a warning instead."""
    _, res = evaluated
    internal = res.plan.internal
    rec = res.records[res.records["phase"] == "internal"].assign(y=0.0)
    stats = {o: res.forecasts[o].stats for o in internal}
    warns: list[str] = []
    th, lam, table = select_thresholds_lambda(rec, stats, internal, res.pilot, cfg, warns)
    assert all(row["score"] is None for row in table)
    assert lam == max(cfg.lambda_grid) and any("geçerli WAPE yok" in w for w in warns)
