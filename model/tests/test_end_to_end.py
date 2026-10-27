"""CLI end to end on synthetic data, determinism and the committed sample."""

from __future__ import annotations

import json
import subprocess
import sys

import pandas as pd

from dukkan_tahmin.config import fast_config
from dukkan_tahmin.io_csv import load_canonical
from dukkan_tahmin.pipeline import forecast_data
from dukkan_tahmin.quality import clean_sales
from dukkan_tahmin.schema_check import load_schema, validate
from dukkan_tahmin.synthetic import generate

from .conftest import MODEL_DIR


def _cli(*args: str) -> subprocess.CompletedProcess:
    r = subprocess.run([sys.executable, "-m", "dukkan_tahmin", *args], cwd=MODEL_DIR, capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stderr + r.stdout
    return r


def test_cli_pipeline(tmp_path):
    csv, zp = tmp_path / "urun_gun.csv", tmp_path / "rapor.zip"
    _cli("sentetik", "--cikti", str(csv), "--urun", "10", "--tohum", "5", "--zip", str(zp), "--html-baslangic", "2026-09-01")
    conv, kal = tmp_path / "donusen.csv", tmp_path / "kalite.json"
    r = _cli("donustur", "--girdi", str(zp), "--cikti", str(conv), "--kalite", str(kal), "--yinelenenleri-sil")
    assert "HESAP" in r.stdout
    q = json.loads(kal.read_text(encoding="utf-8"))
    assert q["hesap_rows"] > 0 and q["date_range"]["start"] == "2026-09-01"
    assert q["duplicate_rows"] == 3 and q["duplicates_dropped"]
    # without the duplicated lines, converted rows equal the generator's canonical file
    a = load_canonical(conv).sales.set_index(["tarih", "barkod"])["miktar"]
    b = load_canonical(csv).sales
    b = b[b["tarih"] >= "2026-09-01"].set_index(["tarih", "barkod"])["miktar"]
    pd.testing.assert_series_equal(a.round(6), b.round(6), check_names=False)

    out = tmp_path / "tahmin.json"
    r = _cli("tahmin", "--girdi", str(csv), "--cikti", str(out), "--hizli", "--sessiz")
    assert "Önerilen birleşim" in r.stdout and "başarı iddiası değildir" in r.stdout
    t = json.loads(out.read_text(encoding="utf-8"))
    assert validate(t, load_schema()) == []

    ev = tmp_path / "degerlendirme.json"
    r = _cli("degerlendir", "--girdi", str(csv), "--cikti", str(ev), "--hizli", "--sessiz", "--baslangic-sayisi", "6")
    d = json.loads(ev.read_text(encoding="utf-8"))
    assert len(d["evaluation"]["origins"]) == 6
    assert d["evaluation"]["summary"]["monthly"]["n_origins"] == 6


def test_deterministic(cfg):
    data = clean_sales(generate(months=30, n_products=8, seed=2).canonical_rows(), cfg)
    small = fast_config(n_internal_origins=3, n_external_origins=6)
    a = forecast_data(data, small)
    b = forecast_data(data, small)
    a.pop("generated_at"), b.pop("generated_at")
    assert a == b


def test_committed_sample_is_reproducible(tmp_path):
    sample = MODEL_DIR / "ornek" / "urun_gun.csv.gz"
    regen = tmp_path / "urun_gun.csv.gz"
    generate(n_products=20, seed=7).to_canonical(regen)
    assert sample.read_bytes() == regen.read_bytes(), "ornek/uret.sh ile yeniden üretin"
    d = load_canonical(sample)
    assert d.quality["products"] == 20 and d.quality["date_range"] == {"start": "2023-11-01", "end": "2026-10-26"}
    assert sample.stat().st_size + (MODEL_DIR / "ornek" / "rapor.zip").stat().st_size < 200_000
