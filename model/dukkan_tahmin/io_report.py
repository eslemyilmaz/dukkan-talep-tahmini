"""Streaming parser for the shop's POS export ("HTML-based .xls", optionally
inside a ZIP) -> sale-line table -> :func:`quality.clean_sales`.

This is a port of ``sales-worker.js`` in the repository root; the two must give
the same rows, totals and counts (``tests/test_parser_parity.py`` runs both on
the repository fixture). Rules taken over from the worker:

* one ``<tr>`` per sale line; cells are ``<td>``/``<th>``, tags stripped and a
  small fixed set of entities decoded (:func:`cell_text`);
* the header row is any row with a cell containing ``BARKOD`` and one
  containing ``MIKTAR`` after Turkish upper-casing and diacritic folding
  (``MİKTAR``/``MIKTAR``/``miktar`` alike, :func:`fold`). Columns are located by
  :func:`map_columns`; when a required column is missing and the header has 13
  cells the fixed indexes (0 date, 4 barcode, 5 name, 6 group, 7 quantity,
  8 unit price, 9 total) are used, otherwise the file is rejected;
* rows before the header are ignored; a data row needs at least as many cells
  as the highest mapped column index + 1 and a ``dd.mm.yyyy`` date;
* numbers follow :func:`numeric` (Turkish ``1.234,50`` and dotted ``95.12``);
* any row with an impossible date (``31.02.2024``) or an unreadable quantity,
  unit price or total makes the whole import fail, unless ``allow_invalid``
  (CLI ``--devam``) is given, in which case those rows are counted and left out;
* the file is read in chunks and split on ``</tr>`` so memory stays bounded;
* encoding: BOM, then ``<meta charset>`` (UTF-8 only if the bytes are valid
  UTF-8), then valid multibyte UTF-8, else windows-1254.

Customer / personnel / payment columns are never stored. Exact-duplicate
detection uses a short hash of the row's cell texts, not the row itself.
"""

from __future__ import annotations

import codecs
import hashlib
import re
import zipfile
from pathlib import Path
from typing import IO, Any, Iterator

import pandas as pd

from .config import Config
from .quality import CleanData, clean_sales, tr_upper

CHUNK = 1 << 20
MAX_BUFFER = 5_000_000
MAX_UNPACKED = 500_000_000
SNIFF_MAX = 65536
FIXED_CELLS = 13
FIXED_INDEX = {"tarih": 0, "barkod": 4, "urun": 5, "kategori": 6, "miktar": 7, "fiyat": 8, "tutar": 9}
# (field, header patterns in priority order, required) -- same order as FIELDS in sales-worker.js:
# category before name so that "ÜRÜN GRUBU" is not taken as the product name; TOPLAM before TUTAR.
FIELDS: tuple[tuple[str, tuple[str, ...], bool], ...] = (
    ("tarih", ("TARIH",), True),
    ("barkod", ("BARKOD",), True),
    ("kategori", ("KATEGORI", "GRUP", "GRUB"), False),
    ("miktar", ("MIKTAR", "ADET"), True),
    ("fiyat", ("BIRIM FIYAT", "FIYAT"), False),
    ("tutar", ("TOPLAM", "TUTAR"), True),
    ("urun", ("URUN ADI", "URUN", "STOK ADI", "MAL ADI", "ADI", "AD"), True),
)
_LABEL = {"tarih": "TARİH", "barkod": "BARKOD", "miktar": "MİKTAR", "tutar": "TOPLAM", "urun": "ÜRÜN ADI"}
_NOT_NAME = re.compile(r"MUSTERI|PERSONEL|KASIYER|CARI|SATICI|PLASIYER")
_FOLD = str.maketrans({"İ": "I", "Ü": "U", "Ö": "O", "Ç": "C", "Ş": "S", "Ğ": "G"})
_WS = re.compile(r"\s+")
# String.prototype.trim() whitespace (WhiteSpace + LineTerminator in ECMAScript)
_JS_TRIM = "\t\n\x0b\x0c\r \xa0                　﻿"
_TR_END = re.compile(r"</tr\s*>", re.I)
_CELL = re.compile(r"<t([dh])\b[^>]*>(.*?)</t\1\s*>", re.I | re.S)
_TAG = re.compile(r"<[^>]*>")
_ENTITY = re.compile(r"&(#x[0-9a-f]+|#\d+|[a-z]+);", re.I)
_NAMED = {"nbsp": " ", "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}
_DATE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$", re.A)
_META = re.compile(rb"<meta\b[^>]*?charset\s*=\s*[\"']?\s*([\w.:-]+)", re.I)
_DIGITS = re.compile(r"\d+", re.A)
_INT_GROUPED = re.compile(r"\d*|\d{1,3}(\.\d{3})+", re.A)
_DOT_DECIMAL = re.compile(r"\d*\.\d{1,2}", re.A)
_DOT_THOUSANDS = re.compile(r"\d{1,3}(\.\d{3})+", re.A)
# WHATWG Encoding labels that TextDecoder resolves to utf-8 / windows-1254
_UTF8_LABELS = {"unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8", "utf-8", "utf8", "x-unicode20utf8"}
_CP1254_LABELS = {
    "cp1254", "csisolatin5", "iso-8859-9", "iso-ir-148", "iso8859-9", "iso88599", "iso_8859-9",
    "iso_8859-9:1989", "l5", "latin5", "windows-1254", "x-cp1254",
}


class ReportError(ValueError):
    """Raised with a Turkish message when the report cannot be used."""


# --------------------------------------------------------------------------- cells, numbers, headers
def js_trim(s: str) -> str:
    return s.strip(_JS_TRIM)


def _entity(m: re.Match[str]) -> str:
    e = m.group(1)
    if e[0] != "#":
        return _NAMED.get(e.lower(), m.group(0))
    n = int(e[2:], 16) if e[1] in "xX" else int(e[1:])
    return chr(n) if 0 < n <= 0x10FFFF else m.group(0)


def cell_text(s: str) -> str:
    """``text()`` of the worker: strip tags, decode entities once, trim."""
    return js_trim(_ENTITY.sub(_entity, _TAG.sub("", s)))


def numeric(s: str) -> float:
    """``numeric()`` of the worker. Raises ValueError for anything else.

    * with a comma: exactly one comma, the decimal mark; the integer part is
      plain digits or dot-separated 3-digit groups (``1.234,50``, ``,5``);
    * no comma, one dot followed by 1-2 digits: decimal dot (``95.12``, ``0.75``);
    * no comma, dots only between 3-digit groups: thousands (``1.234.567``);
    * plain digits: integer. An optional leading ``-`` is allowed.
    """
    s = js_trim(str(s))
    sign, body = ("-", s[1:]) if s.startswith("-") else ("", s)
    if "," in body:
        parts = body.split(",")
        if len(parts) != 2 or not _DIGITS.fullmatch(parts[1]) or not _INT_GROUPED.fullmatch(parts[0]):
            raise ValueError(f"Geçersiz sayı: {s!r}")
        out = (parts[0].replace(".", "") or "0") + "." + parts[1]
    elif _DOT_DECIMAL.fullmatch(body):
        out = ("0" if body.startswith(".") else "") + body
    elif _DOT_THOUSANDS.fullmatch(body):
        out = body.replace(".", "")
    elif _DIGITS.fullmatch(body):
        out = body
    else:
        raise ValueError(f"Geçersiz sayı: {s!r}")
    return float(sign + out)


parse_tr_number = numeric  # backwards-compatible name


def fold(s: str) -> str:
    """Turkish upper-case, then İ/Ü/Ö/Ç/Ş/Ğ -> I/U/O/C/S/G, whitespace collapsed."""
    return _WS.sub(" ", tr_upper(s).translate(_FOLD)).strip()


def is_header(cells: list[str]) -> bool:
    up = [fold(c) for c in cells]
    return any("BARKOD" in u for u in up) and any("MIKTAR" in u for u in up)


def map_columns(cells: list[str]) -> tuple[str, dict[str, int]]:
    """``mapColumns()`` of the worker: ("başlık" | "sabit sıra", field -> index).

    Per field, exact matches first, then substring matches (patterns of 3+
    characters only), patterns in priority order; each column is used once.
    """
    f = [fold(c) for c in cells]
    used: set[int] = set()
    found: dict[str, int] = {}
    for exact in (True, False):
        for field, patterns, _ in FIELDS:
            if field in found:
                continue
            hit = next(
                (
                    i
                    for p in patterns
                    for i in range(len(f))
                    if i not in used
                    and (f[i] == p if exact else p in f[i])
                    and not (field == "urun" and _NOT_NAME.search(f[i]))
                    and (exact or len(p) >= 3)
                ),
                None,
            )
            if hit is not None:
                found[field] = hit
                used.add(hit)
    missing = [field for field, _, req in FIELDS if req and field not in found]
    if not missing:
        return "başlık", found
    if len(cells) == FIXED_CELLS:
        return "sabit sıra", dict(FIXED_INDEX)
    raise ReportError(
        "Başlık satırında gerekli sütunlar bulunamadı: " + ", ".join(_LABEL[k] for k in missing) + "."
    )


# --------------------------------------------------------------------------- bytes -> text
def _zip_candidate(name: str) -> bool:
    """A report inside a ZIP: .xls/.htm/.html, not macOS metadata (``__MACOSX/``, ``._*``)."""
    if name.startswith("__MACOSX/") or name.split("/")[-1].startswith("._"):
        return False
    return re.search(r"\.(xls|html?)$", name, re.I) is not None


def _open_binary(path: Path) -> tuple[IO[bytes], str]:
    with open(path, "rb") as fh:
        magic = fh.read(4)
    if path.suffix.lower() == ".zip" or magic == b"PK\x03\x04":
        try:
            zf = zipfile.ZipFile(path)
        except zipfile.BadZipFile as e:
            raise ReportError("ZIP dizini okunamadı.") from e
        members = [i for i in zf.infolist() if _zip_candidate(i.filename)]
        if len(members) != 1:
            raise ReportError("ZIP içinde tek bir XLS/HTML satış raporu bulunmalı.")
        m = members[0]
        if m.flag_bits & 0x1:
            raise ReportError("Şifreli ZIP desteklenmiyor.")
        if m.file_size > MAX_UNPACKED:
            raise ReportError("Açılmış rapor en fazla 500 MB olabilir.")
        if m.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise ReportError("Bu ZIP sıkıştırma yöntemi desteklenmiyor.")
        return zf.open(m), m.filename
    return open(path, "rb"), path.name


def _valid_utf8_prefix(head: bytes) -> bool:
    try:
        codecs.getincrementaldecoder("utf-8")("strict").decode(head, final=False)
        return True
    except UnicodeDecodeError:
        return False


def sniff_encoding(head: bytes) -> str:
    """``detectEncoding()`` of the worker; returns a Python codec name."""
    if head.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    if head.startswith(codecs.BOM_UTF16_LE) or head.startswith(codecs.BOM_UTF16_BE):
        return "utf-16"
    valid = _valid_utf8_prefix(head)
    m = _META.search(head[:SNIFF_MAX])
    if m:
        label = m.group(1).decode("latin-1").strip().lower()
        if label in _CP1254_LABELS:
            return "cp1254"
        if label in _UTF8_LABELS and valid:
            return "utf-8"
    return "utf-8" if valid and any(b > 0x7F for b in head) else "cp1254"


_sniff_encoding = sniff_encoding  # backwards-compatible name


def iter_rows(fh: IO[bytes]) -> Iterator[list[str]]:
    """Yield the cell texts of each ``<tr>`` while reading the stream in chunks."""
    head = fh.read(CHUNK)
    enc = sniff_encoding(head)
    dec = codecs.getincrementaldecoder(enc)(errors="replace")
    buf = dec.decode(head)
    while True:
        pos = 0
        for m in _TR_END.finditer(buf):
            segment = buf[pos : m.end()]
            pos = m.end()
            yield [cell_text(c.group(2)) for c in _CELL.finditer(segment)]
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


# --------------------------------------------------------------------------- report -> rows
def _valid_date(d: str, m: str, y: str) -> pd.Timestamp | None:
    try:
        return pd.Timestamp(year=int(y), month=int(m), day=int(d))
    except (ValueError, OverflowError):
        return None


def parse_report(path: str | Path, *, allow_invalid: bool = False) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Parse the raw report into sale lines. Returns (rows, stats).

    Raises :class:`ReportError` when a row has an impossible date or an
    unreadable number, unless ``allow_invalid`` is true (then those rows are
    counted in ``stats["invalid_rows"]`` and left out).
    """
    path = Path(path)
    fh, member = _open_binary(path)
    cols: dict[str, int] | None = None
    columns: dict[str, Any] = {}
    need = header_cells = 0
    recs: dict[str, list[Any]] = {k: [] for k in ("tarih", "barkod", "urun", "kategori", "miktar", "tutar", "_anahtar")}
    invalid = skipped = mismatch = 0
    try:
        for cells in iter_rows(fh):
            if is_header(cells):
                source, cols = map_columns(cells)
                need = max(cols.values()) + 1
                header_cells = len(cells)
                columns = {
                    "source": source,
                    **cols,
                    "cells": header_cells,
                    "fields": {k: {"index": i, "header": cells[i] if i < len(cells) else ""} for k, i in cols.items()},
                }
                continue
            if cols is None or len(cells) < need:
                skipped += 1
                continue
            dm = _DATE.match(cells[cols["tarih"]])
            if not dm:
                skipped += 1
                continue
            ts = _valid_date(*dm.groups())
            try:
                if ts is None:
                    raise ValueError("tarih")
                q = numeric(cells[cols["miktar"]])
                if "fiyat" in cols:
                    numeric(cells[cols["fiyat"]])  # validated only; not stored
                tot = numeric(cells[cols["tutar"]])
            except ValueError:
                invalid += 1
                continue
            if len(cells) != header_cells:
                mismatch += 1
            recs["tarih"].append(ts)
            recs["barkod"].append(cells[cols["barkod"]])
            recs["urun"].append(cells[cols["urun"]])
            recs["kategori"].append(cells[cols["kategori"]] if "kategori" in cols else "")
            recs["miktar"].append(q)
            recs["tutar"].append(tot)
            recs["_anahtar"].append(hashlib.blake2b("\x1f".join(cells).encode("utf-8", "surrogatepass"), digest_size=12).hexdigest())
    finally:
        fh.close()
    if cols is None or not recs["tarih"]:
        raise ReportError("Beklenen satış sütunları bulunamadı.")
    if invalid and not allow_invalid:
        raise ReportError(
            f"{invalid} satırda tarih veya sayı okunamadı; eksik veriyle aktarım yapılmadı. "
            "Bu satırları dışarıda bırakıp sürdürmek için --devam seçeneğini kullanın."
        )
    rows = pd.DataFrame(recs)
    rows["birim"] = ""
    stats = {
        "file": member,
        "invalid_rows": invalid,
        "skipped_non_data_rows": skipped,
        "cell_count_mismatch_rows": mismatch,
        "columns": columns,
    }
    return rows, stats


def convert_report(
    path: str | Path,
    config: Config | None = None,
    catalog_barcodes: set[str] | None = None,
    *,
    allow_invalid: bool = False,
) -> CleanData:
    """Raw POS report -> cleaned product-day data with quality report."""
    rows, stats = parse_report(path, allow_invalid=allow_invalid)
    data = clean_sales(
        rows,
        config,
        invalid_rows=stats["invalid_rows"],
        columns=stats["columns"],
        source=stats["file"],
        catalog_barcodes=catalog_barcodes,
        evaluation_cutoff=False,
    )
    data.quality["skipped_non_data_rows"] = stats["skipped_non_data_rows"]
    data.quality["cell_count_mismatch_rows"] = stats["cell_count_mismatch_rows"]
    return data
