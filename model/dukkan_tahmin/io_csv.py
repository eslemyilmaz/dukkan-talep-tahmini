"""Canonical product-day CSV (``tarih;barkod;urun;kategori;birim;miktar;tutar``).

* UTF-8 (BOM tolerated; windows-1254 fallback), ``;`` or ``,`` separator
  auto-detected from the header line, optional ``.gz`` compression.
* All cells are read as text so that barcodes keep their leading zeros.
* Repeated product-day rows are aggregated later by :func:`quality.clean_sales`.
"""

from __future__ import annotations

import gzip
import io
import re
from pathlib import Path

import numpy as np
import pandas as pd

from .config import Config
from .quality import CleanData, clean_sales

CANONICAL_COLUMNS = ("tarih", "barkod", "urun", "kategori", "birim", "miktar", "tutar")
_ALIASES = {
    "tarih": "tarih", "date": "tarih", "gun": "tarih", "gün": "tarih",
    "barkod": "barkod", "barcode": "barkod", "kod": "barkod",
    "urun": "urun", "ürün": "urun", "urun adi": "urun", "ürün adı": "urun", "name": "urun", "ad": "urun",
    "kategori": "kategori", "category": "kategori", "grup": "kategori",
    "birim": "birim", "unit": "birim",
    "miktar": "miktar", "quantity": "miktar", "qty": "miktar", "adet": "miktar",
    "tutar": "tutar", "total": "tutar", "amount": "tutar",
}
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TR_DATE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")


def _tr_lower(s: str) -> str:
    return s.replace("I", "ı").replace("İ", "i").lower().strip()


def parse_number(s: str) -> float:
    """Parse ``1234.5``, ``1234,5`` or Turkish ``1.234,50``; raise ValueError otherwise."""
    t = str(s).strip().replace(" ", "")
    if t == "":
        raise ValueError("boş sayı")
    if "," in t:
        t = t.replace(".", "").replace(",", ".")
    if not re.fullmatch(r"-?\d*\.?\d+", t):
        raise ValueError(f"geçersiz sayı: {s!r}")
    return float(t)


def _read_text(path: Path) -> str:
    raw = path.read_bytes()
    if path.suffix == ".gz" or raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1254")


def detect_separator(header_line: str) -> str:
    return ";" if header_line.count(";") >= header_line.count(",") else ","


def read_canonical_rows(path: str | Path) -> tuple[pd.DataFrame, int, dict[str, str]]:
    """Read the CSV into a rows table; returns (rows, invalid_row_count, column_map)."""
    text = _read_text(Path(path))
    first = text.split("\n", 1)[0]
    sep = detect_separator(first)
    df = pd.read_csv(io.StringIO(text), sep=sep, dtype=str, keep_default_na=False)
    colmap: dict[str, str] = {}
    for c in df.columns:
        key = _ALIASES.get(_tr_lower(c))
        if key and key not in colmap.values():
            colmap[c] = key
    df = df.rename(columns=colmap)
    for need in ("tarih", "barkod", "miktar"):
        if need not in df.columns:
            raise ValueError(f"CSV'de zorunlu '{need}' sütunu yok.")
    for opt in ("urun", "kategori", "birim", "tutar"):
        if opt not in df.columns:
            df[opt] = ""
    df = df[list(CANONICAL_COLUMNS)].copy()

    dates = df["tarih"].str.strip()
    iso = dates.str.match(_ISO)
    trd = dates.str.match(_TR_DATE)
    parsed = pd.Series(pd.NaT, index=df.index, dtype="datetime64[ns]")
    parsed[iso] = pd.to_datetime(dates[iso], format="%Y-%m-%d", errors="coerce")
    parsed[trd] = pd.to_datetime(dates[trd], format="%d.%m.%Y", errors="coerce")

    def num(col: str, allow_empty: bool) -> np.ndarray:
        out = np.full(len(df), np.nan)
        for i, v in enumerate(df[col].to_numpy()):
            if allow_empty and str(v).strip() == "":
                out[i] = 0.0
                continue
            try:
                out[i] = parse_number(v)
            except ValueError:
                pass
        return out

    q = num("miktar", allow_empty=False)
    t = num("tutar", allow_empty=True)
    ok = parsed.notna().to_numpy() & ~np.isnan(q) & ~np.isnan(t)
    rows = df.loc[ok].copy()
    rows["tarih"] = parsed[ok]
    rows["miktar"] = q[ok]
    rows["tutar"] = t[ok]
    return rows.reset_index(drop=True), int((~ok).sum()), {"separator": sep, **{v: k for k, v in colmap.items()}}


def load_canonical(
    path: str | Path, config: Config | None = None, catalog_barcodes: set[str] | None = None
) -> CleanData:
    rows, invalid, cols = read_canonical_rows(path)
    return clean_sales(
        rows, config, invalid_rows=invalid, columns=cols, source=str(Path(path).name),
        catalog_barcodes=catalog_barcodes,
    )


def _fmt_qty(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def write_rows(rows: pd.DataFrame, path: str | Path, sep: str = ";") -> None:
    """Write any table that has the canonical columns (sorted by date, barcode)."""
    df = rows.sort_values(["tarih", "barkod"], kind="stable")
    lines = [sep.join(CANONICAL_COLUMNS)]
    for r in df[list(CANONICAL_COLUMNS)].itertuples(index=False):
        lines.append(
            sep.join(
                [
                    pd.Timestamp(r.tarih).date().isoformat(),
                    str(r.barkod),
                    str(r.urun).replace(sep, " "),
                    str(r.kategori).replace(sep, " "),
                    str(r.birim),
                    _fmt_qty(float(r.miktar)),
                    f"{float(r.tutar):.2f}",
                ]
            )
        )
    data = ("\n".join(lines) + "\n").encode("utf-8")
    p = Path(path)
    if p.suffix == ".gz":
        data = gzip.compress(data, mtime=0)
    p.write_bytes(data)


def write_canonical(
    sales: pd.DataFrame, products: pd.DataFrame, path: str | Path, sep: str = ";"
) -> None:
    """Write cleaned product-day rows (one row per product-day with sales).

    The ``birim`` column carries only a unit that the source *declared*
    (``products["birim_beyan"]``). Inferred units are not written: the model
    re-infers them when it reads the file, from the days before the external
    test area only, so writing a unit inferred from the whole file would let
    test-period sales decide the evaluation setup.
    """
    prod = products[["urun", "kategori"]].assign(
        birim=products["birim_beyan"] if "birim_beyan" in products.columns else products["birim"]
    )
    df = sales.merge(prod, left_on="barkod", right_index=True, how="left")
    write_rows(df, path, sep)
