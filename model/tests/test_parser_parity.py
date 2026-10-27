"""Python report parser (io_report) against the app's parser (sales-worker.js).

The worker is run in Node through ``tests/tools/run_worker.mjs``; the tests are
skipped (not failed) when ``node`` is not installed.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import zipfile

import pandas as pd
import pytest

from dukkan_tahmin.config import Config
from dukkan_tahmin.io_report import ReportError, convert_report, parse_report

from .conftest import MODEL_DIR

REPO = MODEL_DIR.parent
WORKER = REPO / "sales-worker.js"
HARNESS = MODEL_DIR / "tests" / "tools" / "run_worker.mjs"
FIXTURE = REPO / "test" / "fixtures" / "satis-raporu-ornek.xls"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None or not WORKER.exists(), reason="node veya sales-worker.js yok")


def run_worker(path) -> dict:
    r = subprocess.run([NODE, str(HARNESS), str(path), str(WORKER)], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def python_side(path) -> dict:
    rows, stats = parse_report(path)
    data = convert_report(path, Config())
    q = data.quality
    sales = data.sales
    return {
        "rows": q["rows"],
        "hesap": q["hesap_rows"],
        "negative": q["negative_rows"],
        "duplicate": q["duplicate_rows"],
        "invalid": q["invalid_rows"],
        "day_total": rows.groupby(rows["tarih"].dt.strftime("%Y-%m-%d"))["tutar"].sum(),
        "day_qty": sales.groupby(sales["tarih"].dt.strftime("%Y-%m-%d"))["miktar"].sum(),
        "product_qty": sales.groupby("barkod")["miktar"].sum(),
        "product_day": sales.assign(d=sales["tarih"].dt.strftime("%Y-%m-%d")).set_index(["barkod", "d"])["miktar"],
        "columns": {k: v["index"] for k, v in stats["columns"]["fields"].items()},
    }


JS_FIELD = {"date": "tarih", "barcode": "barkod", "name": "urun", "category": "kategori", "qty": "miktar", "price": "fiyat", "total": "tutar"}


def compare(path) -> None:
    js = run_worker(path)
    assert "result" in js, js
    res = js["result"]
    st = res["stats"]
    py = python_side(path)
    assert (py["rows"], py["hesap"], py["negative"], py["duplicate"], py["invalid"]) == (
        st["rows"], st["hesap"], st["negative"], st["duplicate"], st["invalid"]
    )
    assert py["columns"] == {JS_FIELD[k]: v["index"] for k, v in st["columns"]["fields"].items()}

    days = res["days"]
    js_total = pd.Series({d: v["total"] for d, v in days.items()}).sort_index()
    pd.testing.assert_series_equal(py["day_total"].sort_index(), js_total, check_names=False, check_dtype=False, rtol=0, atol=1e-6)
    js_qty = pd.Series({d: v["qty"] for d, v in days.items() if v["qty"] > 0}).sort_index()
    pd.testing.assert_series_equal(py["day_qty"].sort_index(), js_qty, check_names=False, check_dtype=False, rtol=0, atol=1e-9)

    prods = res["products"]
    js_prod = pd.Series({b: p["qty"] for b, p in prods.items()}).sort_index()
    pd.testing.assert_series_equal(py["product_qty"].sort_index(), js_prod, check_names=False, check_dtype=False, rtol=0, atol=1e-9)
    js_pd = pd.Series({(b, d): q for b, p in prods.items() for d, q in p["daily"].items()}).sort_index()
    pd.testing.assert_series_equal(py["product_day"].sort_index(), js_pd, check_names=False, check_dtype=False, rtol=0, atol=1e-9)


@pytest.mark.skipif(not FIXTURE.exists(), reason="test/fixtures/satis-raporu-ornek.xls yok")
def test_repo_fixture_matches_worker():
    compare(FIXTURE)
    # regression for the reported discrepancy: dotted decimals like "95.12" in the fixture
    rows, _ = parse_report(FIXTURE)
    assert rows["tutar"].sum() == pytest.approx(1_148_091.68, abs=0.005)


def _tricky_html() -> str:
    header = ["Tarih", "Saat", "Kasiyer Adı", "barkod", "Ürün Grubu", "Urun Adi", "MIKTAR", "Birim Fiyat", "Tutar", "Toplam"]
    rows = [
        ["01.03.2026", "08:00", "Ayşe", "0012", "Şarküteri", "Peynir &amp; Zeytin", "0.75", "200,00", "1.000", "150,00"],
        ["01.03.2026", "08:05", "Ayşe", "0012", "Şarküteri", "Peynir &amp; Zeytin", "1,250", "200,00", "0", "250,00"],
        ["01.03.2026", "08:06", "Ayşe", "869", "Ekmek", "EKMEK", "3", "10", "0", "30"],
        ["01.03.2026", "08:06", "Ayşe", "869", "Ekmek", "EKMEK", "3", "10", "0", "30"],  # duplicate
        ["02.03.2026", "09:00", "Ayşe", "869", "Ekmek", "EKMEK", "-1", "10", "0", "-10"],  # return
        ["02.03.2026", "09:10", "Ayşe", "", "", "Hesap satışı", "1", "95.12", "0", "95.12"],  # HESAP
        ["02.03.2026", "09:20", "Ayşe", "777", "Diğer", "Pil &#x27;AA&#39;", "2", "1.234,50", "0", "2.469,00"],
        ["02.03.2026", "09:30", "Ayşe", "777", "Diğer", "Pil &#x27;AA&#39;", "1", "1.234,50", "0", "1.234,50", "fazla"],
        ["03.03.2026", "10:00", "Ayşe", "869", "Ekmek", "EKMEK", "4", "10", "0"],  # one cell short of Toplam: skipped
    ]
    th = "<tr>" + "".join(f"<th>{h}</th>" for h in header) + "</TR>\n"
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr >\n" for r in rows)
    return '<html><head><meta charset="utf-8"></head><table><tr><td colspan=10>RAPOR</td></tr>' + th + body + "</table>"


def test_tricky_report_matches_worker(tmp_path):
    """ASCII/lower-case headers, TOPLAM vs TUTAR, dotted decimals, entities, uneven rows."""
    p = tmp_path / "zor.xls"
    p.write_text(_tricky_html(), encoding="utf-8")
    compare(p)
    data = convert_report(p)
    assert data.quality["cell_count_mismatch_rows"] == 1
    assert data.sales.set_index("barkod").loc["0012", "miktar"] == pytest.approx(2.0)


def test_zip_with_macos_metadata_matches_worker(tmp_path):
    p = tmp_path / "rapor.zip"
    with zipfile.ZipFile(p, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("__MACOSX/._zor.xls", b"\x00\x05\x16\x07junk")
        zf.writestr("._zor.xls", b"\x00\x05\x16\x07junk")
        zf.writestr("zor.xls", _tricky_html().encode("utf-8"))
    compare(p)


def test_invalid_date_aborts_in_both(tmp_path):
    html = _tricky_html().replace("02.03.2026", "31.02.2026", 1)
    p = tmp_path / "bozuk.xls"
    p.write_text(html, encoding="utf-8")
    assert "error" in run_worker(p)
    with pytest.raises(ReportError, match="satırda tarih veya sayı okunamadı"):
        parse_report(p)
    rows, stats = parse_report(p, allow_invalid=True)
    assert stats["invalid_rows"] == 1
