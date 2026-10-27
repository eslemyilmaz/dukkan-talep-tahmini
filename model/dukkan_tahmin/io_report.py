"""Streaming parser for the shop's POS export ("HTML-based .xls", optionally
inside a ZIP) -> sale-line table -> :func:`quality.clean_sales`.

Mirrors ``sales-worker.js`` in the repository root:

* one ``<tr>`` per sale line, 13 ``<td>`` cells; index 0 date ``dd.mm.yyyy``,
  4 barcode, 5 product name, 6 group, 7 quantity, 8 unit price, 9 line total
  (Turkish number format ``1.234,50``);
* a header row containing ``BARKOD`` and ``MİKTAR``; columns are located by
  header text when possible, otherwise the fixed indexes above are used;
* the file is read in chunks and split on ``</tr>`` so memory stays bounded;
* windows-1254 by default, UTF-8 when the bytes say so.

Customer / personnel / payment columns are never stored. Exact-duplicate
detection uses a short hash of the full raw line, not the line itself.
"""

from __future__ import annotations

import codecs
import hashlib
import html
import re
import zipfile
from pathlib import Path
from typing import IO, Any, Iterator

import pandas as pd

from .config import Config
from .quality import CleanData, clean_sales, tr_upper

CHUNK = 1 << 20
MAX_BUFFER = 5_000_000
FALLBACK_INDEX = {"tarih": 0, "barkod": 4, "urun": 5, "kategori": 6, "miktar": 7, "fiyat": 8, "tutar": 9}
EXPECTED_CELLS = 13
_TR_END = re.compile(r"</tr\s*>", re.I)
_CELL = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]\s*>", re.I | re.S)
_TAG = re.compile(r"<[^>]*>")
_DATE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")
_CHARSET = re.compile(rb"charset\s*=\s*[\"']?([A-Za-z0-9_\-]+)", re.I)
# header text candidates, checked in order (exact match first, then substring)
_HEADER_KEYS: dict[str, tuple[str, ...]] = {
    "tarih": ("TARİH", "İŞLEM TARİHİ", "TARIH"),
    "barkod": ("BARKOD", "BARKODU"),
    "urun": ("ÜRÜN ADI", "STOK ADI", "MAL ADI", "ÜRÜN", "STOK"),
    "kategori": ("GRUP", "GRUBU", "KATEGORİ", "ÜRÜN GRUBU"),
    "miktar": ("MİKTAR", "MIKTAR"),
    "fiyat": ("BİRİM FİYAT", "FİYAT", "FİYATI"),
    "tutar": ("TUTAR", "TOPLAM", "SATIŞ TUTARI"),
}


class ReportError(ValueError):
    """Raised with a Turkish message when the report cannot be used."""


def cell_text(s: str) -> str:
    return html.unescape(_TAG.sub("", s)).replace("\xa0", " ").strip()


def parse_tr_number(s: str) -> float:
    """Turkish number: dots are thousands separators, comma is the decimal mark."""
    t = s.strip().replace(".", "").replace(",", ".").replace(" ", "")
    if t.startswith("."):
        t = "0" + t
    if t.startswith("-."):
        t = "-0" + t[1:]
    if not re.fullmatch(r"-?\d+(\.\d+)?", t):
        raise ValueError(f"Geçersiz sayı: {s!r}")
    return float(t)


def _open_binary(path: Path) -> tuple[IO[bytes], str]:
    with open(path, "rb") as fh:
        magic = fh.read(4)
    if path.suffix.lower() == ".zip" or magic == b"PK\x03\x04":
        zf = zipfile.ZipFile(path)
        members = [i for i in zf.infolist() if re.search(r"\.(xls|html?)$", i.filename, re.I)]
        if len(members) != 1:
            raise ReportError("ZIP içinde tek bir XLS/HTML satış raporu bulunmalı.")
        if members[0].flag_bits & 0x1:
            raise ReportError("Şifreli ZIP desteklenmiyor.")
        return zf.open(members[0]), members[0].filename
    return open(path, "rb"), path.name


def _sniff_encoding(head: bytes) -> str:
    if head.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    m = _CHARSET.search(head[:4096])
    if m:
        name = m.group(1).decode("ascii").lower()
        if name in {"utf-8", "utf8"}:
            return "utf-8"
        if name in {"windows-1254", "cp1254", "iso-8859-9", "latin5"}:
            return "cp1254"
    try:
        codecs.getincrementaldecoder("utf-8")("strict").decode(head, final=False)
        if any(b > 127 for b in head):
            return "utf-8"
    except UnicodeDecodeError:
        pass
    return "cp1254"


def iter_rows(fh: IO[bytes]) -> Iterator[list[str]]:
    """Yield the cell texts of each ``<tr>`` while reading the stream in chunks."""
    head = fh.read(CHUNK)
    enc = _sniff_encoding(head)
    dec = codecs.getincrementaldecoder(enc)(errors="replace")
    buf = dec.decode(head)
    while True:
        pos = 0
        for m in _TR_END.finditer(buf):
            segment = buf[pos : m.end()]
            pos = m.end()
            yield [cell_text(c) for c in _CELL.findall(segment)]
        buf = buf[pos:]
        if len(buf) > MAX_BUFFER:
            raise ReportError(
                "Tablo biçimi desteklenmiyor. XLSX veya ikili XLS yerine bu market programının "
                "HTML tabanlı XLS raporunu seçin."
            )
        chunk = fh.read(CHUNK)
        if not chunk:
            buf += dec.decode(b"", final=True)
            if _TR_END.search(buf):
                continue
            break
        buf += dec.decode(chunk)


def _locate_columns(header: list[str]) -> dict[str, int]:
    up = [tr_upper(c) for c in header]
    found: dict[str, int] = {}
    for key, cands in _HEADER_KEYS.items():
        idx = next((up.index(c) for c in cands if c in up), None)
        if idx is None:
            idx = next((i for c in cands for i, u in enumerate(up) if c in u and i not in found.values()), None)
        if idx is not None:
            found[key] = idx
    return found


def parse_report(path: str | Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Parse the raw report into sale lines. Returns (rows, stats)."""
    path = Path(path)
    fh, member = _open_binary(path)
    cols = dict(FALLBACK_INDEX)
    col_source = "sabit sıra"
    header_seen = False
    n_cells = EXPECTED_CELLS
    recs: dict[str, list[Any]] = {k: [] for k in ("tarih", "barkod", "urun", "kategori", "miktar", "tutar", "_anahtar")}
    invalid = skipped = 0
    try:
        for cells in iter_rows(fh):
            up = [tr_upper(c) for c in cells]
            if not header_seen and "BARKOD" in up and "MİKTAR" in up:
                header_seen = True
                located = _locate_columns(cells)
                if all(k in located for k in ("tarih", "barkod", "urun", "miktar", "tutar")):
                    cols.update(located)
                    col_source = "başlık"
                n_cells = len(cells)
                continue
            if len(cells) != n_cells or not _DATE.match(cells[cols["tarih"]] if len(cells) > cols["tarih"] else ""):
                skipped += 1
                continue
            d, mth, y = _DATE.match(cells[cols["tarih"]]).groups()  # type: ignore[union-attr]
            try:
                ts = pd.Timestamp(year=int(y), month=int(mth), day=int(d))
                q = parse_tr_number(cells[cols["miktar"]])
                tot = parse_tr_number(cells[cols["tutar"]])
            except ValueError:
                invalid += 1
                continue
            recs["tarih"].append(ts)
            recs["barkod"].append(cells[cols["barkod"]])
            recs["urun"].append(cells[cols["urun"]])
            recs["kategori"].append(cells[cols["kategori"]] if "kategori" in cols else "")
            recs["miktar"].append(q)
            recs["tutar"].append(tot)
            recs["_anahtar"].append(hashlib.blake2b("\x1f".join(cells).encode(), digest_size=12).hexdigest())
    finally:
        fh.close()
    if not header_seen or not recs["tarih"]:
        raise ReportError("Beklenen satış sütunları bulunamadı.")
    rows = pd.DataFrame(recs)
    rows["birim"] = ""
    stats = {
        "file": member,
        "invalid_rows": invalid,
        "skipped_non_data_rows": skipped,
        "columns": {"source": col_source, **{k: int(v) for k, v in cols.items()}, "cells": n_cells},
    }
    return rows, stats


def convert_report(
    path: str | Path, config: Config | None = None, catalog_barcodes: set[str] | None = None
) -> CleanData:
    """Raw POS report -> cleaned product-day data with quality report."""
    rows, stats = parse_report(path)
    data = clean_sales(
        rows,
        config,
        invalid_rows=stats["invalid_rows"],
        columns=stats["columns"],
        source=stats["file"],
        catalog_barcodes=catalog_barcodes,
    )
    data.quality["skipped_non_data_rows"] = stats["skipped_non_data_rows"]
    return data
