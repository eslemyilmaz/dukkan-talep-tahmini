"""Rolling-origin evaluation, internal selection and ablation (proposal 2.5).

Time line (no random splits, everything chronological)::

    |---- internal area (train / validation) ----|---- external test ----|
     min_train   internal origins (month ends)     external origins (month ends)
                 - XGBoost grid on the last n_tune  - retrain on data <= origin
                 - thresholds + lambda chosen by      with frozen settings
                   rolling (iv)-style updates       - group weights a_g (iv)
                 - a0 fitted on all internal          refitted from outcomes
                   records, then frozen               already observed; a0 and
                                                      lambda stay frozen

Origin = last observed day. Weekly horizon = the 7 days after the origin;
monthly horizon = the next calendar month (``monthly_mode="calendar"``) or the
30 days after the origin (``"30d"``). Weekly test origins coincide with the
monthly ones.

Only forecasts whose horizon has fully elapsed (horizon end <= current
origin) enter the weight update, so no outcome is used before it is known.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import product as iproduct
from typing import Any

import numpy as np
import pandas as pd
from sklearn.model_selection import ParameterGrid

from .baselines import fit_xgb, seasonal_naive, xgb_recursive
from .combine import WeightSet, fit_a0, fit_weights
from .config import HORIZONS, METHODS, Config
from .groups import GroupThresholds, assign_groups, candidate_cv_splits, group_stats
from .metrics import block_bootstrap_wape_diff, mae, relative_improvement, spread, wape
from .panel import Panel
from .quality import internal_cutoff

Progress = Callable[[str], None]


def _quiet(_: str) -> None:
    pass


# --------------------------------------------------------------------------- plan
def horizon_windows(origin_date: pd.Timestamp, monthly_mode: str) -> dict[str, tuple[int, int]]:
    """1-based day offsets (first, last) after the origin for each horizon."""
    if monthly_mode == "calendar":
        start = (origin_date + pd.offsets.MonthBegin(1)).normalize()
        end = start + pd.offsets.MonthEnd(0)
        monthly = ((start - origin_date).days, (end - origin_date).days)
    elif monthly_mode == "30d":
        monthly = (1, 30)
    else:
        raise ValueError(f"monthly_mode must be 'calendar' or '30d', got {monthly_mode!r}")
    return {"weekly": (1, 7), "monthly": monthly}


def path_length(windows: dict[str, tuple[int, int]], cfg: Config) -> int:
    return max(b for _, b in windows.values()) + cfg.lead_time_days + cfg.review_days


@dataclass
class Plan:
    test_start: int
    internal: list[int]
    tune: list[int]
    external: list[int]
    warnings: list[str] = field(default_factory=list)

    def to_dict(self, panel: Panel) -> dict[str, Any]:
        iso = lambda ix: [panel.dates[i].date().isoformat() for i in ix]  # noqa: E731
        return {
            "test_start": panel.dates[self.test_start].date().isoformat(),
            "internal_origins": iso(self.internal),
            "tune_origins": iso(self.tune),
            "external_origins": iso(self.external),
        }


def _test_months(n_months: int, cfg: Config) -> int:
    return cfg.test_months if n_months >= 30 else max(1, n_months // 3)


def min_months_required(cfg: Config) -> int:
    """Smallest number of calendar months touched by the data (partial first
    and last months count) for which :func:`make_plan` succeeds when the data
    starts on the 1st of a month: two internal origins (end of month
    ``min_train_months`` and the next one) whose next calendar month ends
    before the test area, and one external origin whose next month is inside
    the data. A start on the 2nd or later needs two more calendar months (the
    first eligible origin moves one month later and the partial first month
    still counts). Default settings: 20 and 22."""
    n = 2
    while n - _test_months(n, cfg) < cfg.min_train_months + 2 or _test_months(n, cfg) < 1:
        n += 1
    return n


def make_plan(panel: Panel, cfg: Config) -> Plan:
    dates = panel.dates
    T = len(dates)
    n_months = len(dates.to_period("M").unique())
    warns: list[str] = []
    test_months = _test_months(n_months, cfg)
    if test_months != cfg.test_months:
        warns.append(
            f"Veri {n_months} ay; dış test alanı {test_months} aya düşürüldü (aynı ayrım ilkesi korundu)."
        )
    test_start = int(dates.get_loc(internal_cutoff(dates[0], dates[-1], cfg)))
    month_ends = [i for i in range(T - 1) if dates[i + 1].day == 1]

    def end_idx(i: int) -> int:
        return i + max(b for _, b in horizon_windows(dates[i], cfg.monthly_mode).values())

    min_train_date = dates[0] + pd.DateOffset(months=cfg.min_train_months) - pd.Timedelta(days=1)
    internal = [i for i in month_ends if dates[i] >= min_train_date and end_idx(i) < test_start]
    internal = internal[-cfg.n_internal_origins :] if cfg.n_internal_origins else internal
    external = [i for i in month_ends if i >= test_start - 1 and end_idx(i) <= T - 1]
    if cfg.n_external_origins:
        external = external[: cfg.n_external_origins]
    need = min_months_required(cfg)
    rule = (
        f"Kural: en az {cfg.min_train_months} aylık ilk eğitimden sonra 2 iç başlangıç ve dış testte 1 başlangıç "
        f"gerekir. Verinin dokunduğu takvim ayı sayısı (yarım ilk/son ay dahil) ayın 1'inde başlayan veride "
        f"en az {need}, ayın 2'si veya sonrasında başlayan veride en az {need + 2} olmalıdır."
    )
    if len(internal) < 2:
        raise ValueError(
            f"İç doğrulama için en az 2 başlangıç gerekli; veri süresi yetersiz ({n_months} takvim ayı, "
            f"{len(internal)} iç başlangıç). {rule} Daha uzun geçmiş kullanın ya da --en-az-egitim-ay ile "
            f"ilk eğitim süresini kısaltın (şu an {cfg.min_train_months})."
        )
    if not external:
        raise ValueError(f"Dış test için tamamlanmış bir aylık ufuk yok. {rule}")
    if len(external) < 6:
        warns.append(f"Dış test başlangıç sayısı {len(external)}; önerideki en az 6 başlangıç sağlanamadı.")
    tune = internal[-max(1, min(cfg.n_tune_origins, len(internal))) :]
    return Plan(test_start=test_start, internal=internal, tune=tune, external=external, warnings=warns)


def choose_pilot(panel: Panel, plan: Plan, cfg: Config) -> tuple[list[str], list[str]]:
    """Pre-specified pilot set (adet products), fixed from the internal area only."""
    warns: list[str] = []
    bc = list(panel.barcodes)
    if cfg.pilot_products:
        chosen = [b for b in cfg.pilot_products if b in bc]
        missing = [b for b in cfg.pilot_products if b not in bc]
        if missing:
            warns.append(f"Pilot listesindeki {len(missing)} barkod veride yok; dışarıda bırakıldı.")
        if not chosen:
            raise ValueError(
                "Pilot küme boş: --pilot ile verilen barkodların hiçbiri veride yok. "
                "Barkodları (baştaki sıfırlarla birlikte) kontrol edin."
            )
        kg = [b for b in chosen if panel.units[bc.index(b)] != "adet"]
        if kg:
            warns.append(f"Pilot listesinde {len(kg)} adet dışı ürün var; birincil ölçüt adet ürünleri içindir.")
        return chosen, warns
    cut = plan.test_start
    vol = np.nansum(panel.Y[:, :cut], axis=1)
    ok = (panel.units == "adet") & (panel.first_sale >= 0) & (panel.first_sale < cut)
    order = [i for i in np.argsort(-vol, kind="stable") if ok[i] and vol[i] > 0]
    if not order:
        n_kg = int((panel.units == "kg").sum())
        raise ValueError(
            "Pilot küme boş: dış test alanından önce satışı olan 'adet' birimli ürün yok "
            f"({panel.n_products} ürünün {n_kg} tanesi kesirli miktar nedeniyle 'kg' sayıldı). "
            "Pilot ürünleri --pilot ile barkod olarak verin ya da CSV'deki 'birim' sütununa "
            "adetle satılan ürünler için 'adet' yazın."
        )
    return [bc[i] for i in order[: cfg.pilot_n]], warns


# --------------------------------------------------------------------------- forecasts
@dataclass
class OriginForecast:
    origin: int
    phase: str
    windows: dict[str, tuple[int, int]]
    X: np.ndarray
    S: np.ndarray
    stats: pd.DataFrame
    groups: pd.Series | None = None
    method_weights: dict[str, dict[str, np.ndarray]] = field(default_factory=dict)
    version: dict[str, Any] = field(default_factory=dict)


def forecast_at(
    panel: Panel, origin: int, grid_point: dict[str, Any], cfg: Config, phase: str, min_days: int = 0
) -> OriginForecast:
    windows = horizon_windows(panel.dates[origin], cfg.monthly_mode)
    H = max(path_length(windows, cfg), min_days)
    booster = fit_xgb(panel, origin, grid_point, cfg)
    return OriginForecast(
        origin=origin,
        phase=phase,
        windows=windows,
        X=xgb_recursive(booster, panel, origin, H, cfg),
        S=seasonal_naive(panel, origin, H),
        stats=group_stats(panel, origin),
    )


def make_records(panel: Panel, fc: OriginForecast) -> pd.DataFrame:
    """Horizon totals (x, s, y) for every listed product whose horizon is complete.

    Days without any record inside the horizon are excluded from *both* the
    actual and the forecast totals (they are unknown, not zero).
    """
    o, T = fc.origin, len(panel.dates)
    active = np.flatnonzero(panel.active(o))
    frames = []
    for h, (a, b) in fc.windows.items():
        if o + b > T - 1:
            continue
        idx = np.arange(o + a, o + b + 1)
        mask = panel.recorded[idx]
        if not mask.any():
            continue
        A = panel.Y[np.ix_(active, idx[mask])]
        x = fc.X[np.ix_(active, np.arange(a - 1, b)[mask])].sum(axis=1)
        s = fc.S[np.ix_(active, np.arange(a - 1, b)[mask])].sum(axis=1)
        st = fc.stats.iloc[active]
        n_days = int(mask.sum())
        frames.append(
            pd.DataFrame(
                {
                    "origin": o,
                    "origin_date": panel.dates[o],
                    "phase": fc.phase,
                    "p": active,
                    "barkod": panel.barcodes[active],
                    "unit": panel.units[active],
                    "horizon": h,
                    "x": x,
                    "s": s,
                    "y": np.nansum(A, axis=1),
                    "n_days": n_days,
                    "m": st["mean_daily"].to_numpy() * n_days,
                    "h_end": o + b,
                    "obs": st["obs"].to_numpy(),
                    "zero_ratio": st["zero_ratio"].to_numpy(),
                    "cv": st["cv"].to_numpy(),
                }
            )
        )
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def with_groups(rec: pd.DataFrame, th: GroupThresholds) -> pd.DataFrame:
    st = rec[["obs", "zero_ratio", "cv"]].assign(active=True)
    return rec.assign(group=assign_groups(st, th).to_numpy())


def _wape_pooled(rec: pd.DataFrame, fcol: str) -> float | None:
    return wape(rec["y"].to_numpy(), rec[fcol].to_numpy())


# --------------------------------------------------------------------------- selection
def selection_score(scores: dict[str, float | None]) -> float | None:
    """Sum of the valid (non-None) selection WAPEs; None when no horizon is valid.

    A horizon whose pilot actuals sum to 0 has no WAPE; it is left out of the
    sum, not counted as 0, and a candidate with no valid horizon cannot win.
    Within one selection every candidate shares the same records and actuals,
    so the set of valid horizons is the same for all candidates.
    """
    valid = [v for v in scores.values() if v is not None]
    return float(sum(valid)) if valid else None


def tune_xgboost(
    panel: Panel, plan: Plan, pilot: list[str], cfg: Config, progress: Progress, warns: list[str] | None = None
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[int, OriginForecast]]:
    warns = warns if warns is not None else []
    grid = list(ParameterGrid({k: list(v) for k, v in cfg.xgb_grid.items()}))
    first_cache: dict[int, OriginForecast] = {}
    table: list[dict[str, Any]] = []
    best: tuple[float, int] | None = None
    best_cache: dict[int, OriginForecast] = {}
    for gi, gp in enumerate(grid):
        recs = []
        cache: dict[int, OriginForecast] = {}
        for o in plan.tune:
            fc = forecast_at(panel, o, gp, cfg, "internal")
            cache[o] = fc
            recs.append(make_records(panel, fc))
        rec = pd.concat(recs, ignore_index=True)
        rec = rec[rec["barkod"].isin(pilot)]
        scores = {h: _wape_pooled(rec[rec["horizon"] == h], "x") for h in cfg.selection_horizons}
        score = selection_score(scores)
        table.append({"params": {k: (float(v) if isinstance(v, float) else int(v)) for k, v in gp.items()}, "wape_pilot": scores, "score": score})
        progress(f"  XGBoost aday {gi + 1}/{len(grid)}: {gp} -> {'—' if score is None else f'{score:.2f}'}")
        if score is not None and (best is None or score < best[0] - 1e-12):
            best, best_cache = (score, gi), cache
        if gi == 0:
            first_cache = cache
    if best is None:
        warns.append(
            "XGBoost araması için geçerli WAPE yok (pilot ürünlerde ayar başlangıçlarında Σy = 0); "
            "ızgaranın ilk adayı kullanıldı."
        )
        return dict(grid[0]), table, first_cache
    return dict(grid[best[1]]), table, best_cache


def select_thresholds_lambda(
    records: pd.DataFrame,
    stats_by_origin: dict[int, pd.DataFrame],
    internal: list[int],
    pilot: list[str],
    cfg: Config,
    warns: list[str] | None = None,
) -> tuple[GroupThresholds, float, list[dict[str, Any]]]:
    """Rolling selection on internal origins with the (iv) update rule.

    Inside the internal area a0 is refitted from the outcomes elapsed at each
    internal origin (it is itself determined in internal validation); in the
    external test it is frozen, see :func:`run_backtest`.
    """
    warns = warns if warns is not None else []
    table: list[dict[str, Any]] = []
    best: tuple[float, float, GroupThresholds] | None = None
    stats_list = [stats_by_origin[o] for o in internal]
    for zr in cfg.zero_ratio_grid:
        cuts = candidate_cv_splits(stats_list, zr, cfg.cv_quantile_grid, cfg.min_obs)
        for cut, lam in iproduct(cuts, cfg.lambda_grid):
            th = GroupThresholds(zr, (cut,), cfg.min_obs)
            rec = with_groups(records, th)
            err = {h: 0.0 for h in cfg.selection_horizons}
            act = {h: 0.0 for h in cfg.selection_horizons}
            for k in range(1, len(internal)):
                o = internal[k]
                train = rec[rec["h_end"] <= o]
                ws = fit_weights(train, lam, cfg.scale, groups=th.groups)
                test = rec[(rec["origin"] == o) & rec["barkod"].isin(pilot)]
                for h in cfg.selection_horizons:
                    t = test[test["horizon"] == h]
                    a = np.array([ws.weight(g, h) for g in t["group"]])
                    f = a * t["x"].to_numpy() + (1 - a) * t["s"].to_numpy()
                    err[h] += float(np.abs(t["y"].to_numpy() - f).sum())
                    act[h] += float(t["y"].sum())
            scores = {h: (100 * err[h] / act[h] if act[h] > 0 else None) for h in err}
            score = selection_score(scores)
            table.append({"zero_ratio_intermittent": zr, "cv_split": cut, "lambda": lam, "wape_pilot": scores, "score": score})
            if score is None:
                continue
            key = (round(score, 9), -lam)
            if best is None or key < (round(best[0], 9), -best[1]):
                best = (score, lam, th)
    if best is None:
        zr = cfg.zero_ratio_grid[0]
        cut = candidate_cv_splits(stats_list, zr, cfg.cv_quantile_grid, cfg.min_obs)[0]
        lam = float(max(cfg.lambda_grid))  # same as the tie-break rule: most shrinkage towards a0
        warns.append(
            "Grup eşiği ve λ seçimi için geçerli WAPE yok (pilot ürünlerde iç başlangıçlarda Σy = 0); "
            f"ilk eşik adayı ve en büyük λ = {lam} (a0'a en çok büzülme) kullanıldı."
        )
        return GroupThresholds(zr, (cut,), cfg.min_obs), lam, table
    return best[2], best[1], table


# --------------------------------------------------------------------------- main loop
@dataclass
class BacktestResult:
    plan: Plan
    pilot: list[str]
    best_params: dict[str, Any]
    tuning: list[dict[str, Any]]
    thresholds: GroupThresholds
    lam: float
    selection: list[dict[str, Any]]
    fixed: dict[str, WeightSet]
    scale: str
    records: pd.DataFrame
    forecasts: dict[int, OriginForecast]
    warnings: list[str]
    a0: dict[str, float] = field(default_factory=dict)  # frozen after internal validation
    plan_dict: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)
    per_origin: list[dict[str, Any]] = field(default_factory=list)
    per_product: dict[str, Any] = field(default_factory=dict)
    simulation: dict[str, Any] = field(default_factory=dict)

    def weights_iv(self, upto: int) -> WeightSet:
        """(iv) group weights refitted from every outcome observed by ``upto``;
        lambda and a0 stay at the values fixed in internal validation."""
        rec = with_groups(self.records, self.thresholds)
        return fit_weights(
            rec[rec["h_end"] <= upto], self.lam, self.scale, a0=self.a0, groups=self.thresholds.groups
        )


def _method_weight_arrays(
    groups: pd.Series, fixed: dict[str, WeightSet], ws_iv: WeightSet
) -> dict[str, dict[str, np.ndarray]]:
    g = groups.to_numpy()
    out: dict[str, dict[str, np.ndarray]] = {}
    for m in METHODS:
        out[m] = {}
        for h in HORIZONS:
            if m == "xgboost":
                w = np.ones(len(g))
            elif m == "seasonal_naive":
                w = np.zeros(len(g))
            elif m == "ablation_common_weight":
                w = np.full(len(g), fixed[m].a0[h])
            elif m == "combined":
                w = np.array([ws_iv.weight(x, h) for x in g])
            else:
                w = np.array([fixed[m].weight(x, h) for x in g])
            out[m][h] = w
    return out


def _version(panel: Panel, fc: OriginForecast, res_lam: float, th: GroupThresholds, ws: WeightSet, cfg: Config, params: dict[str, Any]) -> dict[str, Any]:
    assert fc.groups is not None
    act = panel.active(fc.origin)
    return {
        "lambda": float(res_lam),
        "a0": {h: float(v) for h, v in ws.a0.items()},
        "weights": {h: {g: float(v) for g, v in w.items()} for h, w in ws.weights.items()},
        "n_validation_obs": ws.n_obs,
        "group_thresholds": th.to_dict(),
        "features": {"lags": list(cfg.lags), "ma_windows": list(cfg.ma_windows)},
        "xgboost_params": params,
        "group_counts": {g: int(c) for g, c in fc.groups[act].value_counts().items()},
        "groups": {str(b): str(g) for b, g in fc.groups[act].items()},
    }


def run_backtest(panel: Panel, cfg: Config, progress: Progress = _quiet) -> BacktestResult:
    plan = make_plan(panel, cfg)
    warns = list(plan.warnings)
    pilot, pw = choose_pilot(panel, plan, cfg)
    warns += pw
    progress(f"İç başlangıçlar: {len(plan.internal)}, dış test başlangıçları: {len(plan.external)}, pilot ürün: {len(pilot)}")

    progress("XGBoost hiperparametre araması (yalnızca iç doğrulama)...")
    best, tuning, cached = tune_xgboost(panel, plan, pilot, cfg, progress, warns)

    forecasts: dict[int, OriginForecast] = {}
    for o in plan.internal:
        forecasts[o] = cached.get(o) or forecast_at(panel, o, best, cfg, "internal")
    records = pd.concat([make_records(panel, forecasts[o]) for o in plan.internal], ignore_index=True)
    stats_by_origin = {o: forecasts[o].stats for o in plan.internal}

    progress("Grup eşikleri ve lambda seçimi (iç doğrulama, ilerleyen başlangıç)...")
    th, lam, selection = select_thresholds_lambda(records, stats_by_origin, plan.internal, pilot, cfg, warns)
    rec_int = with_groups(records, th)
    # proposal 2.4: lambda and the reference weight a0 are set in internal validation only;
    # in the external test only the group weights a_g are updated.
    a0_fixed = fit_a0(rec_int, cfg.scale)
    fixed = {
        "ablation_common_weight": fit_weights(rec_int, 0.0, cfg.scale, a0=a0_fixed, mode="common", groups=th.groups),
        "ablation_group_no_reg": fit_weights(rec_int, 0.0, cfg.scale, a0=a0_fixed, groups=th.groups),
        "ablation_group_reg_fixed": fit_weights(rec_int, lam, cfg.scale, a0=a0_fixed, groups=th.groups),
    }
    for o in plan.internal:
        fc = forecasts[o]
        fc.groups = assign_groups(fc.stats, th)
        fc.method_weights = _method_weight_arrays(fc.groups, fixed, fixed["ablation_group_reg_fixed"])

    progress("Dış test: her başlangıçta yeniden eğitim, sabit ayarlar...")
    records["group_at_origin"] = [forecasts[o].groups.iloc[p] for o, p in zip(records["origin"], records["p"])]
    all_rec = [records.assign(**{f"f_{m}": np.nan for m in METHODS})]
    for k, o in enumerate(plan.external):
        fc = forecast_at(panel, o, best, cfg, "external")
        fc.groups = assign_groups(fc.stats, th)
        prev = with_groups(pd.concat(all_rec, ignore_index=True), th)
        ws_iv = fit_weights(prev[prev["h_end"] <= o], lam, cfg.scale, a0=a0_fixed, groups=th.groups)
        fc.method_weights = _method_weight_arrays(fc.groups, fixed, ws_iv)
        fc.version = _version(panel, fc, lam, th, ws_iv, cfg, best)
        rec = make_records(panel, fc)
        g_at = fc.groups.to_numpy()[rec["p"].to_numpy()]
        rec["group_at_origin"] = g_at
        for m in METHODS:
            a = np.array([fc.method_weights[m][h][p] for h, p in zip(rec["horizon"], rec["p"])])
            rec[f"f_{m}"] = a * rec["x"].to_numpy() + (1 - a) * rec["s"].to_numpy()
        all_rec.append(rec)
        forecasts[o] = fc
        progress(f"  başlangıç {k + 1}/{len(plan.external)}: {panel.dates[o].date()}")
    records_all = pd.concat(all_rec, ignore_index=True)
    res = BacktestResult(
        plan=plan, pilot=pilot, best_params=best, tuning=tuning, thresholds=th, lam=lam,
        selection=selection, fixed=fixed, scale=cfg.scale, records=records_all, forecasts=forecasts, warnings=warns,
        a0=dict(a0_fixed), plan_dict=plan.to_dict(panel),
    )
    summarize(res, panel, cfg)
    return res


# --------------------------------------------------------------------------- summary
def _method_block(rec: pd.DataFrame, fn: Callable[[pd.DataFrame, str], float | None]) -> dict[str, float | None]:
    return {m: fn(rec, f"f_{m}") for m in METHODS}


def _per_product_mae_mean(rec: pd.DataFrame, fcol: str) -> float | None:
    if rec.empty:
        return None
    v = rec.groupby("barkod").apply(lambda g: mae(g["y"], g[fcol]), include_groups=False)
    return float(v.mean())


def pilot_wape_block(p_h: pd.DataFrame) -> dict[str, Any]:
    """Pooled pilot WAPE, its across-origin spread and the per-origin sums for
    the bootstrap, all on the *same* origin set: origins whose pilot actuals
    sum to more than 0. An origin with Σy = 0 has no WAPE of its own, so it is
    left out of the pooled value as well (its errors would otherwise enter the
    pooled numerator but not the spread)."""
    per_origin_w: dict[str, list[float | None]] = {m: [] for m in METHODS}
    sums: dict[str, list[float]] = {m: [] for m in METHODS}
    act: list[float] = []
    keep: list[Any] = []
    zero = 0
    for o, g in p_h.groupby("origin", sort=True):
        a = float(g["y"].sum())
        if not a > 0:
            zero += 1
            continue
        keep.append(o)
        act.append(a)
        for m in METHODS:
            per_origin_w[m].append(wape(g["y"], g[f"f_{m}"]))
            sums[m].append(float(np.abs(g["y"] - g[f"f_{m}"]).sum()))
    valid = p_h[p_h["origin"].isin(keep)]
    return {
        "wape_pilot": _method_block(valid, _wape_pooled),
        "spread": {m: spread(per_origin_w[m]) for m in METHODS},
        "abs_error_sums": sums,
        "actual_sums": act,
        "n_origins": len(keep),
        "n_origins_zero_actual": zero,
    }


def summarize(res: BacktestResult, panel: Panel, cfg: Config) -> None:
    ext = res.records[res.records["phase"] == "external"]
    pil = ext[ext["barkod"].isin(res.pilot)]
    summary: dict[str, Any] = {}
    rel: dict[str, float | None] = {}
    for h in HORIZONS:
        e_h, p_h = ext[ext["horizon"] == h], pil[pil["horizon"] == h]
        pw = pilot_wape_block(p_h)
        if pw["n_origins"] == 0:
            res.warnings.append(
                f"{'Haftalık' if h == 'weekly' else 'Aylık'} ufukta geçerli dış test başlangıcı yok "
                "(ufuk tamamlanmadı ya da pilot ürünlerde Σy = 0); pilot WAPE hesaplanamadı."
            )
        elif pw["n_origins_zero_actual"]:
            res.warnings.append(
                f"{'Haftalık' if h == 'weekly' else 'Aylık'} ufukta {pw['n_origins_zero_actual']} dış test "
                "başlangıcında pilot ürünlerin gerçekleşen toplamı 0; bu başlangıçlar pilot WAPE, dağılım ve "
                "bootstrap hesabına girmedi."
            )
        by_unit = {
            u: _method_block(e_h[e_h["unit"] == u], _wape_pooled) for u in ("adet", "kg") if (e_h["unit"] == u).any()
        }
        adet = e_h[e_h["unit"] == "adet"]
        by_group = {
            str(g): _method_block(r, _wape_pooled) | {"n": int(len(r))}
            for g, r in adet.groupby("group_at_origin", sort=True)
        }
        wp, sums, act = pw["wape_pilot"], pw["abs_error_sums"], pw["actual_sums"]
        summary[h] = {
            "wape_pilot": wp,
            "mae_mean": _method_block(p_h, _per_product_mae_mean),
            "spread": pw["spread"],
            "wape_by_unit": by_unit,
            "wape_by_group_adet": by_group,
            "bootstrap_ci_wape_diff": {
                "combined_minus_xgboost": block_bootstrap_wape_diff(
                    sums["combined"], sums["xgboost"], act, n_boot=cfg.n_bootstrap, seed=cfg.random_state
                ),
                "combined_minus_seasonal_naive": block_bootstrap_wape_diff(
                    sums["combined"], sums["seasonal_naive"], act, n_boot=cfg.n_bootstrap, seed=cfg.random_state
                ),
            },
            "n_origins": pw["n_origins"],
            "n_origins_zero_actual": pw["n_origins_zero_actual"],
            "n_pilot_products": int(p_h["barkod"].nunique()),
        }
        rel[h] = relative_improvement(wp["xgboost"], wp["combined"])
    res.summary = {"summary": summary, "relative_improvement_vs_xgboost_pct": rel}

    per_origin = []
    for o in res.plan.external:
        fc = res.forecasts[o]
        r = pil[pil["origin"] == o]
        entry: dict[str, Any] = {"origin": panel.dates[o].date().isoformat()}
        for h in HORIZONS:
            rh = r[r["horizon"] == h]
            a, b = fc.windows[h]
            entry[h] = {
                "start": panel.dates[o + a].date().isoformat(),
                "end": panel.dates[o + b].date().isoformat(),
                "evaluated_days": int(rh["n_days"].iloc[0]) if len(rh) else 0,
                "wape_pilot": _method_block(rh, _wape_pooled),
                "actual_pilot": float(rh["y"].sum()),
            }
        entry["version"] = fc.version
        per_origin.append(entry)
    res.per_origin = per_origin

    per_product: dict[str, Any] = {}
    for b, g in ext.groupby("barkod", sort=True):
        d: dict[str, Any] = {}
        for h in HORIZONS:
            gh = g[g["horizon"] == h]
            d[h] = {
                "mae": {m: mae(gh["y"], gh[f"f_{m}"]) for m in ("combined", "xgboost", "seasonal_naive")},
                "wape": {m: wape(gh["y"], gh[f"f_{m}"]) for m in ("combined", "xgboost", "seasonal_naive")},
                "n_origins": int(len(gh)),
            }
        per_product[str(b)] = d
    res.per_product = per_product
