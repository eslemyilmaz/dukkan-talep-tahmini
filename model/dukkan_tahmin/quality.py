"""Data rules of proposal section 2.2 and the data-quality report.

Input is a table of *sale lines* (raw report) or *product-day rows*
(canonical CSV) with columns::

    tarih (datetime64), barkod (str), urun (str), kategori (str),
    birim (str, may be empty), miktar (float), tutar (float)

and optionally ``_anahtar`` (a string identifying the original raw line, used
for exact-duplicate detection).

Rules implemented here (all counts go to the quality report):

* barcodes stay strings (leading zeros kept);
* ``HESAP`` lines (Turkish-aware upper-casing of the product name) are unpriced
  account sales: excluded from quantity series, amount tracked;
* negative quantity/total lines are returns: excluded, counted;
* exact duplicates are counted, *not* dropped unless ``drop_duplicates``;
* lines without a barcode are counted as unmatched and excluded;
* days with no record at all are *missing days*, never zero sales;
  closed weekdays/dates are excluded from the missing-day list;
* unit = ``adet`` unless quantities are fractional (then ``kg``); a ``birim``
  column, when present, wins and conflicts are reported.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .config import Config

WEEKDAY_TR = ("Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar")
REQUIRED = ("tarih", "barkod", "urun", "kategori", "birim", "miktar", "tutar")


def tr_upper(s: str) -> str:
    """Upper-case with Turkish dotted/dotless i rules (i->İ, ı->I)."""
    return s.replace("i", "İ").replace("ı", "I").upper()


def is_hesap(name: str) -> bool:
    return "HESAP" in tr_upper(name or "")


def normalize_unit(u: Any) -> str:
    s = tr_upper(str(u or "").strip())
    if s in {"KG", "KİLO", "KİLOGRAM", "KGM", "GR", "GRAM"}:
        return "kg"
    if s in {"ADET", "AD", "ADT", "PCS", "ADEDİ"}:
        return "adet"
    return ""


def _is_fractional(q: np.ndarray) -> np.ndarray:
    return np.abs(q - np.round(q)) > 1e-9


@dataclass
class CleanData:
    """Cleaned product-day sales plus everything the panel builder needs."""

    sales: pd.DataFrame  # tarih, barkod, miktar, tutar (positive, non-HESAP)
    products: pd.DataFrame  # index barkod: urun, kategori, birim
    recorded_days: pd.DatetimeIndex
    closed_weekdays: tuple[int, ...]
    closed_dates: tuple[pd.Timestamp, ...]
    start: pd.Timestamp
    end: pd.Timestamp
    quality: dict[str, Any] = field(default_factory=dict)


def detect_closed_weekdays(
    recorded: pd.DatetimeIndex, start: pd.Timestamp, end: pd.Timestamp, max_share: float
) -> tuple[int, ...]:
    """A weekday is 'closed' if fewer than ``max_share`` of its dates were recorded."""
    cal = pd.date_range(start, end, freq="D")
    rec = set(recorded)
    closed = []
    for wd in range(7):
        days = [d for d in cal if d.weekday() == wd]
        if len(days) < 4:
            continue
        share = sum(d in rec for d in days) / len(days)
        if share < max_share:
            closed.append(wd)
    return tuple(closed)


def _infer_units(lines: pd.DataFrame) -> tuple[pd.Series, dict[str, dict[str, Any]], list[str]]:
    units: dict[str, str] = {}
    detail: dict[str, dict[str, Any]] = {}
    conflicts: list[str] = []
    for bc, g in lines.groupby("barkod", sort=True):
        q = g["miktar"].to_numpy(dtype=float)
        frac = bool(_is_fractional(q).any())
        declared = {normalize_unit(u) for u in g["birim"]} - {""}
        if len(declared) == 1:
            unit = declared.pop()
            source = "sütun"
            if unit == "adet" and frac:
                conflicts.append(str(bc))
        else:
            unit = "kg" if frac else "adet"
            source = "kesirli miktar" if frac else "tam sayı miktar"
        units[str(bc)] = unit
        detail[str(bc)] = {"unit": unit, "source": source, "fractional_lines": int(_is_fractional(q).sum())}
    return pd.Series(units, dtype=object), detail, conflicts


def clean_sales(
    rows: pd.DataFrame,
    config: Config | None = None,
    *,
    invalid_rows: int = 0,
    columns: dict[str, Any] | None = None,
    source: str = "",
    catalog_barcodes: set[str] | None = None,
) -> CleanData:
    """Apply the 2.2 rules and build the data-quality report."""
    cfg = config or Config()
    missing_cols = [c for c in REQUIRED if c not in rows.columns]
    if missing_cols:
        raise ValueError("Eksik sütun(lar): " + ", ".join(missing_cols))
    if rows.empty:
        raise ValueError("Geçerli satış satırı bulunamadı.")
    df = rows.copy()
    df["barkod"] = df["barkod"].fillna("").astype(str).str.strip()
    df["urun"] = df["urun"].fillna("").astype(str).str.strip()
    df["kategori"] = df["kategori"].fillna("").astype(str).str.strip()
    df["birim"] = df["birim"].fillna("").astype(str).str.strip()
    df["tarih"] = pd.to_datetime(df["tarih"]).dt.normalize().astype("datetime64[ns]")

    key_cols = ["_anahtar"] if "_anahtar" in df.columns else list(REQUIRED)
    dup = df.duplicated(subset=key_cols, keep="first").to_numpy()
    hesap = df["urun"].map(is_hesap).to_numpy(dtype=bool)
    negative = ((df["miktar"] < 0) | (df["tutar"] < 0)).to_numpy()
    no_barcode = (df["barkod"] == "").to_numpy() & ~hesap
    zero_qty = (df["miktar"] == 0).to_numpy() & ~hesap & ~negative

    recorded = pd.DatetimeIndex(sorted(df["tarih"].unique()))
    start, end = recorded.min(), recorded.max()

    keep = ~hesap & ~negative & ~no_barcode & ~zero_qty
    if cfg.drop_duplicates:
        keep &= ~dup
    lines = df.loc[keep]
    if lines.empty:
        raise ValueError("Ürün miktar serisine girecek satır kalmadı.")

    units, unit_detail, unit_conflicts = _infer_units(lines)
    last = lines.groupby("barkod", sort=True)[["urun", "kategori"]].last()
    products = last.assign(birim=units.reindex(last.index).to_numpy())
    products.index = products.index.astype(str)
    products.index.name = "barkod"

    sales = (
        lines.groupby(["tarih", "barkod"], sort=True, as_index=False)[["miktar", "tutar"]].sum()
    )

    if cfg.closed_weekdays is None:
        closed_wd = detect_closed_weekdays(recorded, start, end, cfg.closed_weekday_max_share)
        closed_source = "otomatik"
    else:
        closed_wd = tuple(sorted(cfg.closed_weekdays))
        closed_source = "ayar"
    closed_dates = tuple(pd.Timestamp(d).normalize() for d in cfg.closed_dates)
    cal = pd.date_range(start, end, freq="D")
    rec_set = set(recorded)
    closed_set = set(closed_dates)
    missing = [
        d for d in cal if d not in rec_set and d.weekday() not in closed_wd and d not in closed_set
    ]

    names = lines.groupby("barkod")["urun"].nunique()
    name_conflicts = sorted(names[names > 1].index.astype(str))
    unmatched = (
        sorted(set(products.index) - set(catalog_barcodes)) if catalog_barcodes is not None else []
    )
    quality: dict[str, Any] = {
        "source": source,
        "rows": int(len(df)),
        "hesap_rows": int(hesap.sum()),
        "hesap_amount": round(float(df.loc[hesap, "tutar"].sum()), 2),
        "negative_rows": int(negative.sum()),
        "negative_amount": round(float(df.loc[negative, "tutar"].sum()), 2),
        "duplicate_rows": int(dup.sum()),
        "duplicates_dropped": bool(cfg.drop_duplicates),
        "invalid_rows": int(invalid_rows),
        "no_barcode_rows": int(no_barcode.sum()),
        "zero_quantity_rows": int(zero_qty.sum()),
        "rows_in_quantity_series": int(keep.sum()),
        "date_range": {"start": start.date().isoformat(), "end": end.date().isoformat()},
        "calendar_days": int(len(cal)),
        "recorded_days": int(len(recorded)),
        "missing_days": [d.date().isoformat() for d in missing],
        "closed_weekdays": list(closed_wd),
        "closed_weekdays_names": [WEEKDAY_TR[w] for w in closed_wd],
        "closed_weekdays_source": closed_source,
        "closed_dates": [d.date().isoformat() for d in closed_dates],
        "assume_complete": bool(cfg.assume_complete),
        "products": int(len(products)),
        "units": {u: int((products["birim"] == u).sum()) for u in ("adet", "kg")},
        "unit_inference": unit_detail,
        "unit_conflicts": unit_conflicts,
        "name_conflicts": name_conflicts,
        "unmatched_barcodes": unmatched,
        "catalog_checked": catalog_barcodes is not None,
        "columns": columns or {},
    }
    return CleanData(
        sales=sales,
        products=products,
        recorded_days=recorded,
        closed_weekdays=closed_wd,
        closed_dates=closed_dates,
        start=start,
        end=end,
        quality=quality,
    )


def quality_warnings(q: dict[str, Any]) -> list[str]:
    """Turkish user-facing warnings derived from the quality report."""
    out: list[str] = []
    if q.get("missing_days"):
        out.append(
            f"{len(q['missing_days'])} gün için hiç kayıt yok; bu günler sıfır satış sayılmadı (eksik gün)."
        )
    if q.get("hesap_rows"):
        out.append(
            f"{q['hesap_rows']} HESAP satırı (tutar {q['hesap_amount']:.2f}) ürün miktar serisine katılmadı."
        )
    if q.get("negative_rows"):
        out.append(f"{q['negative_rows']} negatif (iade) satırı miktar serisinden çıkarıldı.")
    if q.get("duplicate_rows"):
        verb = "silindi" if q.get("duplicates_dropped") else "silinmedi, yalnızca sayıldı"
        out.append(f"{q['duplicate_rows']} birebir yinelenen satır bulundu; {verb}.")
    if q.get("invalid_rows"):
        out.append(f"{q['invalid_rows']} satırda tarih veya sayı okunamadı; bu satırlar dışarıda kaldı.")
    if q.get("no_barcode_rows"):
        out.append(f"{q['no_barcode_rows']} satırda barkod yok; ürün serisine eşleştirilemedi.")
    if q.get("unit_conflicts"):
        out.append(f"{len(q['unit_conflicts'])} üründe 'adet' birimi ile kesirli miktar çelişiyor.")
    if q.get("name_conflicts"):
        out.append(f"{len(q['name_conflicts'])} barkod birden fazla ürün adıyla görünüyor.")
    if q.get("unmatched_barcodes"):
        out.append(f"{len(q['unmatched_barcodes'])} barkod ürün kataloğunda bulunamadı.")
    return out
