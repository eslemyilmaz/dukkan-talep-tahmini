"""Shared fixtures: one small synthetic data set, built once per session."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

MODEL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MODEL_DIR))

from dukkan_tahmin.config import fast_config  # noqa: E402
from dukkan_tahmin.forecast import final_forecast  # noqa: E402
from dukkan_tahmin.output import build_tahmin  # noqa: E402
from dukkan_tahmin.pipeline import evaluate  # noqa: E402
from dukkan_tahmin.quality import clean_sales  # noqa: E402
from dukkan_tahmin.synthetic import generate  # noqa: E402

N_PRODUCTS = 14


@pytest.fixture(scope="session")
def synth():
    return generate(months=36, n_products=N_PRODUCTS, seed=11)


@pytest.fixture(scope="session")
def cfg():
    return fast_config()


@pytest.fixture(scope="session")
def clean(synth, cfg):
    return clean_sales(synth.canonical_rows(), cfg)


@pytest.fixture(scope="session")
def evaluated(clean, cfg):
    panel, res = evaluate(clean, cfg)
    return panel, res


@pytest.fixture(scope="session")
def tahmin(clean, evaluated, cfg):
    panel, res = evaluated
    final = final_forecast(panel, res, cfg)
    return build_tahmin(clean, panel, res, final, cfg)
