"""High-level entry points used by the CLI and the tests."""

from __future__ import annotations

from pathlib import Path

from .backtest import BacktestResult, Progress, _quiet, run_backtest
from .config import Config
from .forecast import StockParams, final_forecast
from .io_csv import load_canonical
from .output import build_degerlendirme, build_tahmin
from .panel import Panel, build_panel
from .quality import CleanData
from .stock import simulate_policy


def evaluate(data: CleanData, cfg: Config, progress: Progress = _quiet) -> tuple[Panel, BacktestResult]:
    panel = build_panel(data, cfg)
    res = run_backtest(panel, cfg, progress)
    progress("Stok politikası simülasyonu (varsayımlı senaryo)...")
    res.simulation = simulate_policy(panel, res, cfg)
    return panel, res


def evaluate_file(path: str | Path, cfg: Config, progress: Progress = _quiet) -> dict:
    data = load_canonical(path, cfg)
    panel, res = evaluate(data, cfg, progress)
    return build_degerlendirme(data, panel, res, cfg)


def forecast_data(
    data: CleanData, cfg: Config, progress: Progress = _quiet, stock_params: dict[str, StockParams] | None = None
) -> dict:
    panel, res = evaluate(data, cfg, progress)
    progress("Son gözlem gününde tüm veriyle yeniden eğitim ve tahmin...")
    final = final_forecast(panel, res, cfg, stock_params)
    return build_tahmin(data, panel, res, final, cfg)
