"""Seed-controlled synthetic grocery-store sales (no real data exists yet).

The generator produces ~36 months of daily sales for ~40 products with
deliberately different regimes so that every code path is exercised:

steady daily, weekly-seasonal (weekend peaks), over-dispersed variable,
intermittent / sparse, trending up / down, promotion spikes (not announced to
the model), yearly seasonal, holiday-sensitive, a kg product with fractional
quantities, a product introduced mid-way and a discontinued product.

Store calendar: optional closed Sundays, closures on 1 January and on the
first day of each bayram (no records -> reported as missing days unless
configured as closed), a few random export gaps (missing days), HESAP lines
and a few return (negative) lines.

Outputs: canonical product-day CSV, and the POS "HTML-based .xls" report in
windows-1254 or UTF-8, optionally zipped, so the parser can be tested end to
end. All numbers are synthetic; they are not findings about any real shop.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from .calendar_tr import _RELIGIOUS, holiday_flags
from .io_csv import write_rows

# name, category, unit, regime, base daily level, unit price (TL, start)
_CATALOG: list[tuple[str, str, str, str, float, float]] = [
    ("Ekmek", "Ekmek & unlu mamuller", "adet", "steady", 42, 10),
    ("Süt 1 L", "Süt ürünleri", "adet", "steady", 14, 32),
    ("Sigara A", "Tütün", "adet", "steady", 22, 95),
    ("Su 0,5 L", "İçecek", "adet", "yearly", 30, 7),
    ("Kola 2,5 L", "İçecek", "adet", "weekly", 7, 60),
    ("Cips Büyük", "Atıştırmalık", "adet", "weekly", 6, 45),
    ("Yumurta 10'lu", "Temel gıda", "adet", "variable", 5, 75),
    ("Beyaz Peynir", "Şarküteri", "kg", "kg", 2.5, 260),
    ("Ayran 300 ml", "Süt ürünleri", "adet", "yearly", 12, 15),
    ("Sigara B", "Tütün", "adet", "steady", 15, 90),
    ("Dondurma Kornet", "Atıştırmalık", "adet", "yearly_strong", 4, 35),
    ("Enerji İçeceği", "İçecek", "adet", "trend_up", 2, 55),
    ("Gazete", "Diğer", "adet", "trend_down", 9, 15),
    ("Çikolata & Gofret", "Atıştırmalık", "adet", "promo", 9, 20),
    ("Lokum 500 g", "Temel gıda", "adet", "holiday", 0.6, 120),
    ("Pil AA", "Diğer", "adet", "intermittent", 0.35, 80),
    ("Ampul", "Diğer", "adet", "intermittent", 0.2, 65),
    ("Kibrit", "Diğer", "adet", "intermittent", 0.45, 5),
    ("Şampuan", "Temizlik", "adet", "intermittent", 0.5, 110),
    ("Yeni Soğuk Çay", "İçecek", "adet", "new", 5, 30),
    ("Eski Meyve Suyu", "İçecek", "adet", "discontinued", 4, 25),
    ("Domates", "Manav", "kg", "kg", 4.0, 35),
    ("Simit", "Ekmek & unlu mamuller", "adet", "weekly", 12, 15),
    ("Makarna", "Temel gıda", "adet", "variable", 4, 25),
    ("Ekmek Arası Sucuk", "Şarküteri", "adet", "weekly", 3, 70),
    ("Maden Suyu", "İçecek", "adet", "yearly", 8, 12),
    ("Çay 1 kg", "Temel gıda", "adet", "variable", 1.2, 210),
    ("Şeker 1 kg", "Temel gıda", "adet", "holiday", 1.5, 45),
    ("Deterjan", "Temizlik", "adet", "intermittent", 0.4, 180),
    ("Peçete", "Temizlik", "adet", "variable", 2.0, 30),
    ("Yoğurt 1 kg", "Süt ürünleri", "adet", "steady", 5, 55),
    ("Sigara C", "Tütün", "adet", "promo", 10, 92),
    ("Bisküvi", "Atıştırmalık", "adet", "promo", 6, 18),
    ("Salep", "İçecek", "adet", "winter", 1.5, 40),
    ("Kaşar Peyniri", "Şarküteri", "kg", "kg", 1.2, 380),
    ("Tuz", "Temel gıda", "adet", "intermittent", 0.55, 15),
    ("Limonata", "İçecek", "adet", "yearly_strong", 3, 25),
    ("Poğaça", "Ekmek & unlu mamuller", "adet", "weekly", 9, 12),
    ("Islak Mendil", "Temizlik", "adet", "variable", 1.5, 35),
    ("Kraker", "Atıştırmalık", "adet", "steady", 3, 15),
]
_DOW_WEEKLY = np.array([0.8, 0.8, 0.85, 0.9, 1.15, 1.7, 1.5])
_DOW_MILD = np.array([1.0, 0.97, 0.97, 1.0, 1.05, 1.12, 1.0])


@dataclass
class SyntheticData:
    daily: pd.DataFrame  # truth: positive product-day sales (canonical columns)
    extra_rows: pd.DataFrame  # HESAP and return rows in canonical form
    products: pd.DataFrame  # barkod, urun, kategori, birim, regime
    open_days: pd.DatetimeIndex  # days with records
    closed_days: pd.DatetimeIndex  # store closed (no records)
    gap_days: pd.DatetimeIndex  # store open but export missing (no records)
    seed: int

    def canonical_rows(self) -> pd.DataFrame:
        return pd.concat([self.daily, self.extra_rows], ignore_index=True)

    def to_canonical(self, path: str | Path) -> None:
        write_rows(self.canonical_rows(), path)


def _barcode(i: int, unit: str) -> str:
    if unit == "kg":
        return f"{2700 + i:07d}"  # scale-style internal code with leading zeros
    if i % 9 == 4:
        return f"00{86900000 + i * 7919:011d}"[:13]
    return f"869{1000000000 + i * 104729:010d}"


def _bayram_first_days(years: range) -> list[pd.Timestamp]:
    return [pd.Timestamp(d) for y in years for d, _ in _RELIGIOUS.get(y, [])]


def generate(
    months: int = 36,
    n_products: int = 40,
    seed: int = 7,
    end: str = "2026-10-26",
    sundays_closed: bool = False,
    n_gap_days: int = 10,
) -> SyntheticData:
    rng = np.random.default_rng(seed)
    end_ts = pd.Timestamp(end)
    start_ts = (end_ts.to_period("M") - (months - 1)).to_timestamp()
    dates = pd.date_range(start_ts, end_ts, freq="D").as_unit("ns")
    T = len(dates)
    years = range(dates[0].year, dates[-1].year + 1)

    closed = np.zeros(T, bool)
    if sundays_closed:
        closed |= dates.weekday == 6
    closed |= (dates.month == 1) & (dates.day == 1)
    closed |= dates.isin(_bayram_first_days(years))
    gaps = np.zeros(T, bool)
    cand = np.flatnonzero(~closed[1:-1]) + 1
    if n_gap_days and len(cand):
        gaps[rng.choice(cand, size=min(n_gap_days, len(cand)), replace=False)] = True
    open_ = ~closed & ~gaps

    hol, eve = holiday_flags(dates)
    bayram = _bayram_first_days(years)
    pre_bayram = np.zeros(T)
    for b in bayram:
        for k in range(1, 4):
            d = b - pd.Timedelta(days=k)
            if dates[0] <= d <= dates[-1]:
                pre_bayram[dates.get_loc(d)] = 1.0
    doy = dates.dayofyear.to_numpy()
    summer = np.sin(2 * np.pi * (doy - 105) / 365.25)  # peak ~mid July
    tfrac = np.arange(T) / max(T - 1, 1)
    month_idx = (dates.year - dates[0].year) * 12 + dates.month - dates[0].month
    dow = dates.weekday.to_numpy()

    cat = [_CATALOG[i % len(_CATALOG)] for i in range(n_products)]
    rows_daily: list[pd.DataFrame] = []
    specs = []
    for i, (name, category, unit, regime, base, price0) in enumerate(cat):
        if i >= len(_CATALOG):
            name = f"{name} {i // len(_CATALOG) + 1}"
        bc = _barcode(i, unit)
        lam = np.full(T, float(base))
        lam *= _DOW_WEEKLY[dow] if regime == "weekly" else _DOW_MILD[dow]
        if regime == "yearly":
            lam *= 1 + 0.45 * summer
        elif regime == "yearly_strong":
            lam *= np.clip(1 + 1.1 * summer, 0.05, None)
        elif regime == "winter":
            lam *= np.clip(1 - 1.0 * summer, 0.05, None)
        elif regime == "trend_up":
            lam *= 1 + 4.0 * tfrac
        elif regime == "trend_down":
            lam *= np.clip(1 - 0.75 * tfrac, 0.1, None)
        elif regime == "holiday":
            lam *= 1 + 5.0 * pre_bayram + 1.5 * eve
        elif regime == "promo":
            promo = np.zeros(T)
            for s in rng.choice(T - 7, size=max(1, T // 60), replace=False):
                promo[s : s + 7] = 1
            lam *= 1 + 1.6 * promo
        lam *= 1 + 0.25 * eve - 0.3 * hol
        life = np.ones(T, bool)
        if regime == "new":
            life[: int(T * 0.55)] = False
        elif regime == "discontinued":
            life[int(T * 0.8) :] = False
        if unit == "kg":
            customers = rng.poisson(lam * 3.0)
            q = np.array([rng.gamma(2.0, 1 / 6.0, n).sum() if n else 0.0 for n in customers])
            q = np.round(q, 3)
        elif regime in ("variable", "promo"):
            q = rng.poisson(rng.gamma(3.0, lam / 3.0)).astype(float)
        elif regime == "intermittent":
            q = rng.poisson(lam) * rng.choice([1, 1, 1, 2, 3], size=T)
            q = q.astype(float)
        else:
            q = rng.poisson(lam).astype(float)
        q[~open_ | ~life] = 0.0
        price = price0 * (1.025 ** month_idx)
        sel = q > 0
        rows_daily.append(
            pd.DataFrame(
                {
                    "tarih": dates[sel],
                    "barkod": bc,
                    "urun": name,
                    "kategori": category,
                    "birim": unit,
                    "miktar": q[sel],
                    "tutar": np.round(q[sel] * price[sel], 2),
                }
            )
        )
        specs.append({"barkod": bc, "urun": name, "kategori": category, "birim": unit, "regime": regime, "price0": price0})
    daily = pd.concat(rows_daily, ignore_index=True).sort_values(["tarih", "barkod"], ignore_index=True)
    products = pd.DataFrame(specs)

    extra = []
    odays = dates[open_]
    n_hesap = rng.poisson(2.5, len(odays))
    for d, n in zip(odays, n_hesap):
        if n:
            extra.append({"tarih": d, "barkod": "", "urun": "HESAP", "kategori": "", "birim": "",
                          "miktar": float(n), "tutar": round(float(rng.uniform(20, 300, n).sum()), 2)})
    ret_days = odays[rng.random(len(odays)) < 0.08]
    for d in ret_days:
        sp = specs[int(rng.integers(len(specs)))]
        qty = -0.5 if sp["birim"] == "kg" else -1.0
        extra.append({"tarih": d, "barkod": sp["barkod"], "urun": sp["urun"], "kategori": sp["kategori"],
                      "birim": sp["birim"], "miktar": qty, "tutar": round(qty * sp["price0"], 2)})
    extra_df = pd.DataFrame(extra, columns=daily.columns)
    return SyntheticData(
        daily=daily,
        extra_rows=extra_df,
        products=products,
        open_days=dates[open_],
        closed_days=dates[closed],
        gap_days=dates[gaps],
        seed=seed,
    )


# --------------------------------------------------------------------------- raw report
def _tr_num(v: float, decimals: int = 2) -> str:
    s = f"{v:,.{decimals}f}"
    return s.replace(",", "§").replace(".", ",").replace("§", ".")


def _split_qty(q: float, unit: str, rng: np.random.Generator) -> list[float]:
    if unit == "kg":
        n = int(min(max(1, rng.poisson(2)), 4))
        if n == 1:
            return [q]
        w = rng.dirichlet(np.ones(n))
        parts = [round(q * x, 3) for x in w[:-1]]
        parts.append(round(q - sum(parts), 3))
        return [p for p in parts if p > 0] or [q]
    out: list[float] = []
    left = int(round(q))
    while left > 0:
        k = int(min(left, rng.choice([1, 1, 1, 2, 2, 3])))
        out.append(float(k))
        left -= k
    return out


HEADER = ["TARİH", "SAAT", "FİŞ NO", "MÜŞTERİ", "BARKOD", "ÜRÜN ADI", "GRUP", "MİKTAR",
          "BİRİM FİYAT", "TUTAR", "PERSONEL", "ÖDEME", "AÇIKLAMA"]


def report_html(
    data: SyntheticData,
    *,
    start: str | None = None,
    end: str | None = None,
    n_duplicates: int = 3,
    n_invalid: int = 0,
    seed: int | None = None,
) -> tuple[str, dict[str, int]]:
    """Render sale lines as the POS HTML table. Returns (html, truth counts)."""
    rng = np.random.default_rng(data.seed + 1 if seed is None else seed)
    rows = data.canonical_rows()
    if start:
        rows = rows[rows["tarih"] >= pd.Timestamp(start)]
    if end:
        rows = rows[rows["tarih"] <= pd.Timestamp(end)]
    rows = rows.sort_values(["tarih", "barkod"], kind="stable")
    customers = ["PEŞİN", "PEŞİN", "PEŞİN", "Ayşe K. (veresiye)", "Mehmet Ö. 0555 000 00 00"]
    payments = ["NAKİT", "KART", "VERESİYE"]
    lines: list[list[str]] = []
    fis = 1000
    hesap_lines = 0
    for r in rows.itertuples(index=False):
        d = pd.Timestamp(r.tarih).strftime("%d.%m.%Y")
        if r.urun == "HESAP":
            n = int(r.miktar)
            amounts = rng.dirichlet(np.ones(n)) * r.tutar if n > 1 else np.array([r.tutar])
            amounts = np.round(amounts, 2)
            amounts[-1] = round(r.tutar - amounts[:-1].sum(), 2)
            parts = [(1.0, float(a)) for a in amounts]
            hesap_lines += n
        elif r.miktar < 0:
            parts = [(float(r.miktar), float(r.tutar))]
        else:
            unit_price = r.tutar / r.miktar
            parts = [(q, round(q * unit_price, 2)) for q in _split_qty(float(r.miktar), r.birim, rng)]
            diff = round(r.tutar - sum(p[1] for p in parts), 2)
            parts[-1] = (parts[-1][0], round(parts[-1][1] + diff, 2))
        for q, tot in parts:
            fis += 1
            qd = 3 if r.birim == "kg" else 0
            unit_price = tot / q if q else 0.0
            name = str(r.urun).replace("&", "&amp;")
            lines.append([
                d, f"{rng.integers(8, 22):02d}:{rng.integers(0, 60):02d}", str(fis),
                customers[int(rng.integers(len(customers)))], str(r.barkod), name, str(r.kategori),
                _tr_num(q, qd) if qd else str(int(q)), _tr_num(unit_price), _tr_num(tot), "Kasa 1",
                payments[int(rng.integers(len(payments)))], "",
            ])
    dup_idx = rng.choice(len(lines), size=min(n_duplicates, len(lines)), replace=False) if n_duplicates else []
    for k in sorted(dup_idx, reverse=True):
        lines.insert(int(k) + 1, list(lines[int(k)]))
    for k in range(n_invalid):
        bad = list(lines[k])
        bad[0] = "31.02.2024"
        lines.append(bad)
    out = io.StringIO()
    out.write('<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1254">'
              "</head><body>\n<table border=1>\n")
    out.write("<tr><td colspan=13>SATIŞ RAPORU (sentetik)</td></tr>\n")
    out.write("<tr>" + "".join(f"<td><b>{h}</b></td>" for h in HEADER) + "</tr>\n")
    for ln in lines:
        out.write("<tr>" + "".join(f"<td>{c}</td>" for c in ln) + "</tr>\n")
    out.write("<tr><td colspan=9>TOPLAM</td><td>-</td></tr>\n</table></body></html>\n")
    truth = {"lines": len(lines), "duplicates": len(dup_idx), "invalid": n_invalid, "hesap_lines": hesap_lines}
    return out.getvalue(), truth


def write_report(
    data: SyntheticData,
    path: str | Path | None,
    *,
    encoding: str = "cp1254",
    zip_path: str | Path | None = None,
    **kwargs: object,
) -> dict[str, int]:
    html, truth = report_html(data, **kwargs)  # type: ignore[arg-type]
    if encoding.lower().replace("-", "").replace("_", "") == "utf8":
        raw = html.replace("charset=windows-1254", "charset=utf-8").encode("utf-8")
    else:
        raw = html.encode("cp1254")
    if path:
        Path(path).write_bytes(raw)
    if zip_path:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            member = Path(path).name if path else "satis_raporu.xls"
            info = zipfile.ZipInfo(member, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, raw)
    return truth
