"""Eq. 3-4: the closed form equals the constrained minimiser of J_g on [0, 1]."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from dukkan_tahmin.combine import closed_form_weight, combine, common_weight, fit_weights, objective

GRID = np.linspace(0.0, 1.0, 100_001)


def _grid_min(x, s, y, lam, a0):
    d, r = x - s, y - s
    # J(a) expanded for speed: mean((r - a d)^2) + lam (a - a0)^2
    J = np.mean(r * r) - 2 * GRID * np.mean(r * d) + GRID**2 * np.mean(d * d) + lam * (GRID - a0) ** 2
    k = int(np.argmin(J))
    return GRID[k], J[k]


@pytest.mark.parametrize("seed", range(25))
@pytest.mark.parametrize("lam", [0.01, 0.1, 1.0, 10.0])
def test_closed_form_matches_grid_search(seed, lam):
    rng = np.random.default_rng(seed)
    n = int(rng.integers(3, 60))
    y = rng.gamma(2.0, 10.0, n)
    bias = rng.normal(0, 8)  # sometimes pushes the optimum outside [0, 1]
    x = y + rng.normal(bias, rng.uniform(1, 10), n)
    s = y + rng.normal(-bias, rng.uniform(1, 10), n)
    a0 = float(rng.uniform(0, 1))
    a, fb = closed_form_weight(x, s, y, lam, a0)
    ag, Jg = _grid_min(x, s, y, lam, a0)
    assert not fb
    assert 0.0 <= a <= 1.0
    assert abs(a - ag) <= 2e-5
    assert objective(a, x, s, y, lam, a0) <= Jg + 1e-9


def test_strict_convexity_second_derivative():
    rng = np.random.default_rng(0)
    x, s, y = rng.normal(10, 3, (3, 40))
    lam, a0, h = 0.3, 0.4, 1e-3
    for a in (0.1, 0.5, 0.9):
        num = (objective(a + h, x, s, y, lam, a0) - 2 * objective(a, x, s, y, lam, a0) + objective(a - h, x, s, y, lam, a0)) / h**2
        theory = 2 * np.mean((x - s) ** 2) + 2 * lam
        assert num == pytest.approx(theory, rel=1e-5)
        assert theory > 0


def test_projection_at_bounds():
    y = np.array([10.0, 20.0, 30.0])
    assert closed_form_weight(y + 5, y, y, 0.0, 0.5)[0] == 0.0  # S perfect -> all weight on S
    assert closed_form_weight(y, y - 5, y, 0.0, 0.5)[0] == 1.0  # X perfect -> all weight on X
    # d = 9, r = -1 -> stationary point -1/9 < 0 -> projected to 0
    assert closed_form_weight(y + 10, y + 1, y, 0.0, 0.5)[0] == 0.0
    # d = 9, r = 10 -> stationary point 10/9 > 1 -> projected to 1
    assert closed_form_weight(y - 1, y - 10, y, 0.0, 0.5)[0] == 1.0


def test_edge_cases_fall_back_to_a0():
    assert closed_form_weight(np.array([]), np.array([]), np.array([]), 0.1, 0.37) == (0.37, True)
    x = np.array([1.0, 2.0, 3.0])
    assert closed_form_weight(x, x, x + 1, 0.0, 0.42) == (0.42, True)  # lambda = 0 and sum d^2 = 0
    a, fb = closed_form_weight(x, x, x + 1, 0.5, 0.42)  # lambda > 0: well defined, equals a0
    assert not fb and a == pytest.approx(0.42)
    assert common_weight(x, x, x) == 0.5


def test_large_lambda_shrinks_to_a0():
    rng = np.random.default_rng(2)
    y = rng.gamma(2, 5, 50)
    x, s = y + rng.normal(0, 1, 50), y + rng.normal(0, 5, 50)
    a_small, _ = closed_form_weight(x, s, y, 1e-6, 0.2)
    a_big, _ = closed_form_weight(x, s, y, 1e6, 0.2)
    assert a_small > 0.7 and a_big == pytest.approx(0.2, abs=1e-4)


def test_combine_is_convex_combination():
    assert combine(10.0, 2.0, 0.25) == pytest.approx(4.0)


def _records(rng, groups, n=30):
    rows = []
    for h in ("weekly", "monthly"):
        for g in groups:
            y = rng.gamma(3, 20, n)
            m = rng.uniform(10, 100, n)
            rows.append(pd.DataFrame({"horizon": h, "group": g, "y": y, "x": y + rng.normal(0, 5, n), "s": y + rng.normal(0, 15, n), "m": m}))
    return pd.concat(rows, ignore_index=True)


def test_fit_weights_group_rules():
    rng = np.random.default_rng(4)
    rec = _records(rng, ["steady", "variable", "sparse"])
    ws = fit_weights(rec, 0.1, "product_mean")
    for h in ("weekly", "monthly"):
        assert ws.weights[h]["sparse"] == ws.a0[h] and ws.fallback[h]["sparse"]
        assert ws.fallback[h]["intermittent"] and ws.weights[h]["intermittent"] == ws.a0[h]  # N_g = 0
        assert not ws.fallback[h]["steady"] and 0 <= ws.weights[h]["steady"] <= 1
    common = fit_weights(rec, 0.1, "product_mean", mode="common")
    assert all(v == common.a0[h] for h in common.weights for v in common.weights[h].values())


def test_product_mean_scaling_is_scale_invariant():
    rng = np.random.default_rng(5)
    rec = _records(rng, ["steady"])
    big = rec.copy()
    big.loc[::2, ["x", "s", "y", "m"]] *= 1000.0  # some products 1000x larger
    a = fit_weights(rec, 0.1, "product_mean").weights["weekly"]["steady"]
    b = fit_weights(big, 0.1, "product_mean").weights["weekly"]["steady"]
    assert a == pytest.approx(b, rel=1e-12)
