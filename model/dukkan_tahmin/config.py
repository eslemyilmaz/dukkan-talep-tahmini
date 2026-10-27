"""Run configuration. Every tunable knob lives here so that a run can be
versioned (written to the output) and reproduced exactly."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from typing import Any

METHODS = (
    "combined",  # (iv) regularised group weights, updated at each origin (proposed)
    "xgboost",  # X
    "seasonal_naive",  # S
    "ablation_common_weight",  # (i) common fixed weight a0
    "ablation_group_no_reg",  # (ii) group weights, lambda = 0, fitted once
    "ablation_group_reg_fixed",  # (iii) regularised group weights, fitted once
)
HORIZONS = ("weekly", "monthly")


@dataclass(frozen=True)
class Config:
    # --- data rules (2.2) ---
    assume_complete: bool = True
    closed_weekdays: tuple[int, ...] | None = None  # None -> auto-detect; 0=Mon
    closed_dates: tuple[str, ...] = ()
    closed_weekday_max_share: float = 0.10  # auto: weekday recorded < 10 % -> closed
    drop_duplicates: bool = False

    # --- features (2.2, Eq. 1) ---
    lags: tuple[int, ...] = (1, 7, 14, 28)
    ma_windows: tuple[int, ...] = (7, 28)

    # --- baselines (2.3) ---
    xgb_grid: dict[str, tuple[Any, ...]] = field(
        default_factory=lambda: {
            "max_depth": (3, 5),
            "eta": (0.05, 0.1),
            "n_estimators": (200, 400),
            "min_child_weight": (1, 5),
        }
    )
    n_jobs: int = 2
    random_state: int = 7
    monthly_mode: str = "calendar"  # "calendar" | "30d"

    # --- proposed module (2.4) ---
    lambda_grid: tuple[float, ...] = (0.0, 0.01, 0.03, 0.1, 0.3, 1.0)
    zero_ratio_grid: tuple[float, ...] = (0.3, 0.5)
    cv_quantile_grid: tuple[float, ...] = (1 / 3, 1 / 2, 2 / 3)
    min_obs: int = 56
    scale: str = "product_mean"  # "product_mean" | "none"
    selection_horizons: tuple[str, ...] = ("monthly", "weekly")

    # --- evaluation (2.5) ---
    test_months: int = 12
    min_train_months: int = 12
    n_internal_origins: int = 6
    n_tune_origins: int = 3
    n_external_origins: int | None = None  # None -> every available monthly origin
    pilot_products: tuple[str, ...] | None = None
    pilot_n: int = 20
    n_bootstrap: int = 2000

    # --- stock (2.6) ---
    lead_time_days: int = 2
    review_days: int = 7
    service_level: float = 0.9
    pack_size_adet: float = 1.0
    pack_size_kg: float = 0.1
    ss_min_errors: int = 4

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["xgb_grid"] = {k: list(v) for k, v in self.xgb_grid.items()}
        return d


def fast_config(base: Config | None = None, **overrides: Any) -> Config:
    """Tiny-grid preset used by ``--hizli`` and the test-suite."""
    base = base or Config()
    fast = replace(
        base,
        xgb_grid={
            "max_depth": (3, 4),
            "eta": (0.1,),
            "n_estimators": (80,),
            "min_child_weight": (1,),
        },
        lambda_grid=(0.0, 0.1, 1.0),
        zero_ratio_grid=(0.5,),
        cv_quantile_grid=(1 / 3, 2 / 3),
        n_internal_origins=4,
        n_tune_origins=2,
        n_bootstrap=500,
    )
    return replace(fast, **overrides)
