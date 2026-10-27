"""Assembly of ``tahmin.json`` / ``degerlendirme.json`` (output contract for
the tablet app; JSON Schema in ``model/schema/tahmin.schema.json``)."""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

from .backtest import BacktestResult
from .calendar_tr import coverage_warning
from .config import Config
from .forecast import FinalForecast
from .panel import Panel
from .quality import CleanData, quality_warnings

BASE_WARNINGS = [
    "Tahmin edilen değişken gözlenen satıştır; stok tükenmesi nedeniyle karşılanamayan talep ölçülmemiştir.",
    "Sonuçlar tek bir işletmenin verisine dayanır; başka işletmelere genellenemez.",
    "Yıllık ufuk keşifsel; raporlanmadı.",
    "Değerlendirme sonuçları bir başarı iddiası değildir; yalnızca ölçülen hataları gösterir.",
    "Ramazan ve Kurban Bayramı tarihleri koda elle girilmiştir; resmî takvimle doğrulanmalıdır.",
    "Stok önerisi mevcut stoğu bilmez; 'eldeki stok' ve 'önerilen sipariş' uygulamada doldurulmalıdır.",
]


def sanitize(obj: Any) -> Any:
    """Convert numpy scalars / NaN / inf into JSON-safe values."""
    if isinstance(obj, dict):
        return {str(k): sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        return None if not math.isfinite(f) else f
    return obj


def _round_floats(obj: Any, nd: int = 4) -> Any:
    if isinstance(obj, dict):
        return {k: _round_floats(v, nd) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round_floats(v, nd) for v in obj]
    if isinstance(obj, float):
        return round(obj, nd)
    return obj


def now_istanbul() -> str:
    return datetime.now(ZoneInfo("Europe/Istanbul")).replace(microsecond=0).isoformat()


def method_block(res: BacktestResult, cfg: Config, weights: dict[str, Any] | None = None, a0: dict[str, float] | None = None) -> dict[str, Any]:
    ws = res.weights_iv(max(res.plan.external))
    return {
        "name": "grouped_regularized_combination",
        "lambda": float(res.lam),
        "a0": a0 or {h: float(v) for h, v in ws.a0.items()},
        "group_thresholds": res.thresholds.to_dict(),
        "weights": weights or {h: {g: float(v) for g, v in w.items()} for h, w in ws.weights.items()},
        "xgboost_params": {**res.best_params, "tree_method": "hist", "random_state": cfg.random_state},
        "features": {"lags": list(cfg.lags), "ma_windows": list(cfg.ma_windows)},
        "monthly_mode": cfg.monthly_mode,
        "scale": res.scale,
        "selection": {
            "plan": res.plan_dict,
            "xgboost_grid": res.tuning,
            "threshold_lambda_grid": res.selection,
            "criterion": "pilot ürünlerde iç doğrulama WAPE toplamı (" + ", ".join(cfg.selection_horizons) + ")",
        },
        "fixed_weights": {k: v.to_dict() for k, v in res.fixed.items()},
    }


def evaluation_block(res: BacktestResult, panel: Panel) -> dict[str, Any]:
    return {
        "origins": [panel.dates[o].date().isoformat() for o in res.plan.external],
        "internal_origins": [panel.dates[o].date().isoformat() for o in res.plan.internal],
        "pilot_products": list(res.pilot),
        "summary": res.summary["summary"],
        "relative_improvement_vs_xgboost_pct": res.summary["relative_improvement_vs_xgboost_pct"],
        "per_origin": res.per_origin,
        "stock_simulation": res.simulation or None,
        "note": "Göreli iyileşme yalnızca ölçüm olarak raporlanır; başarı iddiası değildir.",
    }


def data_range(data: CleanData) -> dict[str, Any]:
    q = data.quality
    return {
        "start": q["date_range"]["start"],
        "end": q["date_range"]["end"],
        "recorded_days": int(q["recorded_days"]),
        "missing_days": len(q["missing_days"]),
    }


def collect_warnings(data: CleanData, res: BacktestResult, extra: list[str] | None = None) -> list[str]:
    w = list(BASE_WARNINGS)
    cw = coverage_warning(data.start, data.end)
    if cw:
        w.append(cw)
    w += quality_warnings(data.quality)
    w += res.warnings
    w += extra or []
    return list(dict.fromkeys(w))


def build_tahmin(
    data: CleanData, panel: Panel, res: BacktestResult, final: FinalForecast, cfg: Config, extra_warnings: list[str] | None = None
) -> dict[str, Any]:
    o = final.fc.origin
    horizons = {}
    for h, (a, b) in final.fc.windows.items():
        horizons[h] = {
            "days": int(b - a + 1),
            "start": (panel.dates[o] + np.timedelta64(a, "D")).date().isoformat(),
            "end": (panel.dates[o] + np.timedelta64(b, "D")).date().isoformat(),
        }
    ws = final.weights
    out = {
        "version": 1,
        "generated_at": now_istanbul(),
        "origin": panel.dates[o].date().isoformat(),
        "data_range": data_range(data),
        "method": method_block(
            res, cfg,
            weights={h: {g: float(v) for g, v in w.items()} for h, w in ws.weights.items()},
            a0={h: float(v) for h, v in ws.a0.items()},
        ),
        "horizons": horizons,
        "products": final.products,
        "evaluation": evaluation_block(res, panel),
        "quality": data.quality,
        "warnings": collect_warnings(data, res, extra_warnings),
    }
    return _round_floats(sanitize(out))


def build_degerlendirme(data: CleanData, panel: Panel, res: BacktestResult, cfg: Config) -> dict[str, Any]:
    out = {
        "version": 1,
        "generated_at": now_istanbul(),
        "data_range": data_range(data),
        "method": method_block(res, cfg),
        "evaluation": evaluation_block(res, panel),
        "quality": data.quality,
        "config": cfg.to_dict(),
        "warnings": collect_warnings(data, res),
    }
    return _round_floats(sanitize(out))


def write_json(obj: dict[str, Any], path: str | Path) -> None:
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=1, allow_nan=False) + "\n", encoding="utf-8")
