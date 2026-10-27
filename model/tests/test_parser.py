"""Raw POS report (HTML-XLS / ZIP) and canonical CSV ingestion (proposal 2.2)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from dukkan_tahmin.config import Config
from dukkan_tahmin.io_csv import load_canonical, parse_number, write_canonical, write_rows
from dukkan_tahmin.io_report import ReportError, _locate_columns, convert_report, parse_report, parse_tr_number
from dukkan_tahmin.quality import clean_sales, is_hesap, tr_upper
from dukkan_tahmin.synthetic import HEADER, generate, write_report


@pytest.fixture(scope="module")
def small():
    return generate(months=3, n_products=14, seed=3, end="2026-03-31")


def _truth_matrix(daily: pd.DataFrame) -> pd.Series:
    return daily.groupby(["tarih", "barkod"])["miktar"].sum().round(6)


def _parsed_matrix(data) -> pd.Series:
    return data.sales.set_index(["tarih", "barkod"])["miktar"].round(6)


@pytest.mark.parametrize("encoding,zipped", [("cp1254", False), ("cp1254", True), ("utf-8", False)])
def test_report_roundtrip_matches_generator(tmp_path, small, encoding, zipped):
    xls = tmp_path / "rapor.xls"
    zp = tmp_path / "rapor.zip" if zipped else None
    truth = write_report(small, xls, encoding=encoding, zip_path=zp, n_duplicates=0)
    data = convert_report(zp or xls, Config(drop_duplicates=False))
    pd.testing.assert_series_equal(_parsed_matrix(data), _truth_matrix(small.daily), check_names=False)
    q = data.quality
    assert q["rows"] == truth["lines"]
    assert q["hesap_rows"] == truth["hesap_lines"]
    hesap_total = small.extra_rows.loc[small.extra_rows["urun"] == "HESAP", "tutar"].sum()
    assert q["hesap_amount"] == pytest.approx(hesap_total, abs=0.05)
    assert q["negative_rows"] == int((small.extra_rows["miktar"] < 0).sum())
    assert q["columns"]["source"] == "başlık"
    # Turkish characters survive the windows-1254 / utf-8 decoding
    assert {"Enerji İçeceği", "Cips Büyük", "Çikolata & Gofret"} <= set(data.products["urun"])


def test_duplicates_counted_not_dropped(tmp_path, small):
    xls = tmp_path / "r.xls"
    write_report(small, xls, n_duplicates=3)
    kept = convert_report(xls, Config())
    dropped = convert_report(xls, Config(drop_duplicates=True))
    assert kept.quality["duplicate_rows"] == 3 and dropped.quality["duplicate_rows"] == 3
    assert kept.sales["miktar"].sum() > dropped.sales["miktar"].sum()
    pd.testing.assert_series_equal(_parsed_matrix(dropped), _truth_matrix(small.daily), check_names=False)


def test_invalid_rows_counted(tmp_path, small):
    xls = tmp_path / "r.xls"
    write_report(small, xls, n_duplicates=0, n_invalid=2)
    data = convert_report(xls)
    assert data.quality["invalid_rows"] == 2


def test_leading_zero_barcodes_and_no_personal_data(tmp_path, small):
    xls = tmp_path / "r.xls"
    write_report(small, xls)
    data = convert_report(xls)
    assert any(b.startswith("00") for b in data.products.index)
    out = tmp_path / "urun_gun.csv"
    write_canonical(data.sales, data.products, out)
    text = out.read_text(encoding="utf-8")
    assert text.splitlines()[0] == "tarih;barkod;urun;kategori;birim;miktar;tutar"
    for secret in ("Ayşe", "Mehmet", "0555", "VERESİYE", "Kasa 1"):
        assert secret not in text
    back = load_canonical(out)
    assert set(back.products.index) == set(data.products.index)
    pd.testing.assert_series_equal(_parsed_matrix(back), _parsed_matrix(data), check_names=False)


def test_zip_with_two_reports_rejected(tmp_path, small):
    import zipfile

    p = tmp_path / "iki.zip"
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("a.xls", "<table></table>")
        zf.writestr("b.xls", "<table></table>")
    with pytest.raises(ReportError):
        parse_report(p)


def test_missing_header_rejected(tmp_path):
    p = tmp_path / "bos.xls"
    p.write_text("<html><table><tr><td>x</td></tr></table></html>", encoding="cp1254")
    with pytest.raises(ReportError):
        parse_report(p)


def test_header_located_by_text_with_fallback():
    shuffled = ["MÜŞTERİ", "TUTAR", "BARKOD", "TARİH", "ÜRÜN ADI", "MİKTAR", "GRUP"]
    m = _locate_columns(shuffled)
    assert m["tutar"] == 1 and m["barkod"] == 2 and m["tarih"] == 3 and m["urun"] == 4 and m["miktar"] == 5
    assert _locate_columns(HEADER)["tutar"] == 9


def test_turkish_numbers_and_upper():
    assert parse_tr_number("1.234,50") == 1234.5
    assert parse_tr_number("-0,5") == -0.5
    assert parse_tr_number(",5") == 0.5
    assert parse_number("12.5") == 12.5 and parse_number("1.234,5") == 1234.5
    with pytest.raises(ValueError):
        parse_tr_number("abc")
    assert tr_upper("hesap içi") == "HESAP İÇİ"
    assert is_hesap("Hesap Satışı") and is_hesap("MANAV HESAP") and not is_hesap("Şampuan")


def _rows(records):
    return pd.DataFrame(records, columns=["tarih", "barkod", "urun", "kategori", "birim", "miktar", "tutar"]).assign(
        tarih=lambda d: pd.to_datetime(d["tarih"])
    )


def test_rules_hesap_returns_units_missing_days():
    rows = _rows(
        [
            ("2024-01-02", "0012", "Peynir", "Şarküteri", "", 0.35, 100),
            ("2024-01-02", "0012", "Peynir", "Şarküteri", "", 1.2, 300),
            ("2024-01-02", "", "HESAP", "", "", 1, 55.5),
            ("2024-01-03", "869", "Ekmek", "Ekmek", "", 3, 30),
            ("2024-01-03", "869", "Ekmek", "Ekmek", "", -1, -10),
            ("2024-01-05", "869", "Ekmek", "Ekmek", "", 2, 20),
            ("2024-01-05", "777", "Pil", "Diğer", "adet", 1, 80),
        ]
    )
    d = clean_sales(rows, Config(closed_weekdays=()))
    q = d.quality
    assert q["hesap_rows"] == 1 and q["hesap_amount"] == 55.5
    assert q["negative_rows"] == 1
    assert q["missing_days"] == ["2024-01-04"]  # no record at all -> missing, not zero
    assert d.products.loc["0012", "birim"] == "kg"
    assert d.products.loc["869", "birim"] == "adet"
    assert q["unit_inference"]["777"]["source"] == "sütun"
    s = d.sales.set_index(["tarih", "barkod"])["miktar"]
    assert s[(pd.Timestamp("2024-01-02"), "0012")] == pytest.approx(1.55)
    assert s[(pd.Timestamp("2024-01-03"), "869")] == 3  # return excluded, not netted


def test_closed_sundays_detected_and_not_missing():
    g = generate(months=6, n_products=4, seed=5, end="2026-06-30", sundays_closed=True, n_gap_days=3)
    d = clean_sales(g.canonical_rows())
    assert d.quality["closed_weekdays"] == [6]
    missing = pd.DatetimeIndex(d.quality["missing_days"])
    assert (missing.weekday != 6).all()
    assert set(g.gap_days).issubset(set(missing))


@pytest.mark.parametrize("sep", [";", ","])
def test_canonical_separator_autodetect(tmp_path, small, sep):
    p = tmp_path / "c.csv"
    write_rows(small.canonical_rows(), p, sep=sep)
    d = load_canonical(p)
    pd.testing.assert_series_equal(_parsed_matrix(d), _truth_matrix(small.daily), check_names=False)
    assert d.quality["hesap_rows"] == int((small.extra_rows["urun"] == "HESAP").sum())
    assert np.isclose(d.quality["negative_amount"], small.extra_rows.loc[small.extra_rows["miktar"] < 0, "tutar"].sum())
