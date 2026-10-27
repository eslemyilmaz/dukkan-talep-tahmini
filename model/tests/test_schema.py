"""tahmin.json conforms to model/schema/tahmin.schema.json (draft 2020-12)."""

from __future__ import annotations

import copy
import json

import pytest

from dukkan_tahmin.schema_check import SCHEMA_PATH, load_schema, validate


@pytest.fixture(scope="module")
def schema():
    s = load_schema()
    assert s is not None, f"schema not found at {SCHEMA_PATH}"
    return s


def test_output_valid_with_builtin_validator(tahmin, schema):
    assert validate(tahmin, schema) == []


def test_output_valid_with_jsonschema(tahmin, schema):
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.Draft202012Validator.check_schema(schema)
    errors = sorted(jsonschema.Draft202012Validator(schema).iter_errors(tahmin), key=str)
    assert not errors, [e.message for e in errors[:5]]


def test_output_is_strict_json(tahmin):
    text = json.dumps(tahmin, allow_nan=False, ensure_ascii=False)  # raises on NaN/inf
    assert json.loads(text) == tahmin


def test_validator_rejects_broken_documents(tahmin, schema):
    bad = copy.deepcopy(tahmin)
    del bad["products"][0]["stock"]["order_up_to"]
    bad["products"][0]["unit"] = "litre"
    bad["origin"] = "26.10.2026"
    errs = validate(bad, schema)
    assert any("order_up_to" in e for e in errs)
    assert any("unit" in e for e in errs)
    assert any("origin" in e for e in errs)


def test_contract_details(tahmin):
    assert tahmin["version"] == 1
    assert tahmin["origin"] == tahmin["data_range"]["end"]
    assert tahmin["generated_at"].endswith("+03:00")
    hz = tahmin["horizons"]
    assert hz["weekly"]["days"] == 7
    assert hz["monthly"]["start"].endswith("-01")
    p = tahmin["products"][0]
    assert len(p["forecast"]["weekly"]["daily"]) == 7
    assert p["forecast"]["weekly"]["combined"] == pytest.approx(sum(p["forecast"]["weekly"]["daily"]), abs=0.01)
    assert all(isinstance(b["barcode"], str) for b in tahmin["products"])
    assert any(b["barcode"].startswith("0") for b in tahmin["products"])
    assert "Yıllık ufuk keşifsel; raporlanmadı." in tahmin["warnings"]
    ev = tahmin["evaluation"]
    assert len(ev["origins"]) >= 6 and len(ev["per_origin"]) == len(ev["origins"])
    assert set(ev["per_origin"][0]["version"]) >= {"lambda", "a0", "weights", "group_thresholds", "groups", "features"}
