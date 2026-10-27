"""No future leakage: features, training rows, baselines and the recursive
XGBoost forecast at an origin must not change when the future is altered."""

from __future__ import annotations

import copy

import numpy as np
import pytest

from dukkan_tahmin.backtest import forecast_at
from dukkan_tahmin.baselines import seasonal_naive, training_matrix
from dukkan_tahmin.features import feature_tensor
from dukkan_tahmin.groups import group_stats
from dukkan_tahmin.panel import build_panel


@pytest.fixture(scope="module")
def panel(clean, cfg):
    return build_panel(clean, cfg)


def _scrambled(panel, origin, seed=0):
    """Copy of the panel whose values after ``origin`` are replaced by noise."""
    p2 = copy.deepcopy(panel)
    rng = np.random.default_rng(seed)
    fut = p2.Y[:, origin + 1 :]
    known = ~np.isnan(fut)
    fut[known] = rng.poisson(50, known.sum()).astype(float)
    return p2


def test_feature_tensor_ignores_current_and_future(panel, cfg):
    t = len(panel.dates) - 200
    hol, eve = panel.calendar_arrays(panel.dates)
    f0 = feature_tensor(panel.Y, panel.dates, np.array([t]), cfg.lags, cfg.ma_windows, hol, eve)
    Y2 = panel.Y.copy()
    rng = np.random.default_rng(1)
    Y2[:, t:] = rng.normal(100, 30, Y2[:, t:].shape)  # day t itself (the target) and later
    f1 = feature_tensor(Y2, panel.dates, np.array([t]), cfg.lags, cfg.ma_windows, hol, eve)
    np.testing.assert_array_equal(f0, f1)


def test_lags_and_moving_average_match_eq1(panel, cfg):
    hol, eve = panel.calendar_arrays(panel.dates)
    Y = np.nan_to_num(panel.Y.copy(), nan=0.0)  # complete series -> Eq. 1 exactly
    t = 400
    f = feature_tensor(Y, panel.dates, np.array([t]), cfg.lags, cfg.ma_windows, hol, eve)[:, 0, :]
    for j, k in enumerate(cfg.lags):
        np.testing.assert_allclose(f[:, j], Y[:, t - k])
    for j, w in enumerate(cfg.ma_windows):
        expected = Y[:, t - w : t].mean(axis=1)  # (1/w) * sum_{k=1..w} y_{t-k}
        np.testing.assert_allclose(f[:, len(cfg.lags) + j], expected, rtol=1e-9, atol=1e-9)


def test_training_matrix_uses_only_past(panel, cfg):
    o = len(panel.dates) - 120
    X0, y0 = training_matrix(panel, o, cfg)
    X1, y1 = training_matrix(_scrambled(panel, o), o, cfg)
    np.testing.assert_array_equal(X0, X1)
    np.testing.assert_array_equal(y0, y1)


def test_group_stats_use_only_past(panel):
    o = len(panel.dates) - 120
    a = group_stats(panel, o)
    b = group_stats(_scrambled(panel, o), o)
    assert a.equals(b)


def test_seasonal_naive_uses_only_past(panel):
    o = len(panel.dates) - 120
    np.testing.assert_array_equal(seasonal_naive(panel, o, 40), seasonal_naive(_scrambled(panel, o), o, 40))


def test_seasonal_naive_repeats_last_same_weekday(panel):
    o = len(panel.dates) - 100
    s = seasonal_naive(panel, o, 14)
    p = 0
    for h in range(14):
        day = panel.dates[o + 1 + h]
        if panel.is_closed(panel.dates[[o + 1 + h]])[0]:
            continue
        cands = [d for d in range(o, o - 60, -1) if panel.dates[d].weekday() == day.weekday() and not np.isnan(panel.Y[p, d])]
        assert s[p, h] == panel.Y[p, cands[0]]


def test_recursive_xgboost_forecast_uses_only_past(panel, cfg):
    o = len(panel.dates) - 120
    gp = {"max_depth": 3, "eta": 0.1, "n_estimators": 30, "min_child_weight": 1}
    a = forecast_at(panel, o, gp, cfg, "external")
    b = forecast_at(_scrambled(panel, o, seed=3), o, gp, cfg, "external")
    np.testing.assert_array_equal(a.X, b.X)
    np.testing.assert_array_equal(a.S, b.S)
    assert np.all(a.X[~np.isnan(a.X)] >= 0)
    assert a.X.shape[1] >= a.windows["monthly"][1]
