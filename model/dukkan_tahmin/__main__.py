"""Komut satırı arayüzü: ``python -m dukkan_tahmin <komut> ...``

Komutlar: donustur, sentetik, degerlendir, tahmin.
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback
from dataclasses import replace
from pathlib import Path
from typing import Any

from .config import Config, fast_config

METHOD_TR = {
    "combined": "Önerilen birleşim (iv)",
    "xgboost": "Yalın XGBoost (X)",
    "seasonal_naive": "Mevsimsel saf (S)",
    "ablation_common_weight": "Ablasyon (i) ortak a0",
    "ablation_group_no_reg": "Ablasyon (ii) grup, λ=0",
    "ablation_group_reg_fixed": "Ablasyon (iii) grup, λ, sabit",
}


def _err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _fmt(v: Any, nd: int = 2) -> str:
    return "—" if v is None else f"{v:.{nd}f}"


def _ints(s: str | None) -> tuple[int, ...] | None:
    if s is None:
        return None
    s = s.strip()
    return tuple(int(x) for x in s.split(",") if x.strip()) if s else ()


def _strs(s: str | None) -> tuple[str, ...]:
    return tuple(x.strip() for x in (s or "").split(",") if x.strip())


def _read_barcode_list(path: str | None) -> set[str] | None:
    if not path:
        return None
    lines = Path(path).read_text(encoding="utf-8-sig").splitlines()
    out = set()
    for ln in lines:
        cell = ln.replace(",", ";").split(";")[0].strip()
        if cell and cell.lower() not in {"barkod", "barcode"}:
            out.add(cell)
    return out


def build_config(a: argparse.Namespace) -> Config:
    base = Config()
    kw: dict[str, Any] = {}
    if getattr(a, "kapali_gunler", None) is not None:
        kw["closed_weekdays"] = _ints(a.kapali_gunler)
    if getattr(a, "kapali_tarihler", None):
        kw["closed_dates"] = _strs(a.kapali_tarihler)
    if getattr(a, "yinelenenleri_sil", False):
        kw["drop_duplicates"] = True
    if getattr(a, "tohum", None) is not None:
        kw["random_state"] = a.tohum
    if getattr(a, "is_parcacigi", None):
        kw["n_jobs"] = a.is_parcacigi
    if getattr(a, "aylik_mod", None):
        kw["monthly_mode"] = a.aylik_mod
    if getattr(a, "baslangic_sayisi", None):
        kw["n_external_origins"] = a.baslangic_sayisi
    if getattr(a, "en_az_egitim_ay", None) is not None:
        if a.en_az_egitim_ay < 1:
            raise ValueError("--en-az-egitim-ay en az 1 olmalı.")
        kw["min_train_months"] = a.en_az_egitim_ay
    if getattr(a, "pilot", None):
        p = Path(a.pilot)
        kw["pilot_products"] = tuple(sorted(_read_barcode_list(a.pilot) or ())) if p.exists() else _strs(a.pilot)
    if getattr(a, "lambda_", None) is not None:
        kw["lambda_grid"] = (float(a.lambda_),)
    for opt, key in (("tedarik_gun", "lead_time_days"), ("gozden_gecirme_gun", "review_days"), ("hizmet_duzeyi", "service_level")):
        if getattr(a, opt, None) is not None:
            kw[key] = getattr(a, opt)
    cfg = fast_config(base) if getattr(a, "hizli", False) else base
    return replace(cfg, **kw)


# --------------------------------------------------------------------------- commands
def cmd_donustur(a: argparse.Namespace) -> int:
    from .io_csv import write_canonical
    from .io_report import convert_report
    from .output import write_json
    from .quality import quality_warnings

    cfg = build_config(a)
    data = convert_report(a.girdi, cfg, catalog_barcodes=_read_barcode_list(a.katalog), allow_invalid=a.devam)
    write_canonical(data.sales, data.products, a.cikti)
    if a.kalite:
        write_json(data.quality, a.kalite)
    q = data.quality
    print("Rapor dönüştürüldü")
    print(f"  Satır (geçerli)            : {q['rows']}")
    print(f"  Tarih aralığı              : {q['date_range']['start']} – {q['date_range']['end']}")
    print(f"  Kayıtlı gün / eksik gün    : {q['recorded_days']} / {len(q['missing_days'])}")
    print(f"  Ürün (adet / kg)           : {q['products']} ({q['units']['adet']} / {q['units']['kg']})")
    print(f"  HESAP satırı / tutarı      : {q['hesap_rows']} / {q['hesap_amount']:.2f}")
    print(f"  Negatif (iade) satır       : {q['negative_rows']}")
    print(f"  Yinelenen / geçersiz satır : {q['duplicate_rows']} / {q['invalid_rows']}")
    print(f"  Hücre sayısı farklı satır  : {q.get('cell_count_mismatch_rows', 0)}")
    print(f"  Ürün-gün satırı yazıldı    : {len(data.sales)} -> {a.cikti}")
    for w in quality_warnings(q):
        print("  Uyarı: " + w)
    return 0


def cmd_sentetik(a: argparse.Namespace) -> int:
    from .synthetic import generate, write_report

    d = generate(months=a.ay, n_products=a.urun, seed=a.tohum, end=a.bitis, sundays_closed=a.pazar_kapali)
    d.to_canonical(a.cikti)
    print(f"Sentetik veri üretildi (tohum {a.tohum}): {len(d.daily)} ürün-gün satırı, {a.urun} ürün, {a.ay} ay -> {a.cikti}")
    if a.html or a.zip:
        truth = write_report(
            d, a.html, encoding=a.kodlama, zip_path=a.zip,
            start=a.html_baslangic, end=a.html_bitis,
        )
        targets = " ve ".join(x for x in (a.html, a.zip) if x)
        print(f"Ham rapor (HTML-XLS, {a.kodlama}): {truth['lines']} satış satırı -> {targets}")
    print("Not: Sentetik veridir; gerçek işletme sonucu değildir.")
    return 0


def print_evaluation(ev: dict[str, Any], method: dict[str, Any]) -> None:
    s = ev["summary"]
    n = s["monthly"]["n_origins"]
    npil = s["monthly"]["n_pilot_products"]
    print()
    print(f"Dış test değerlendirmesi — {n} başlangıç, pilot {npil} adet ürünü, WAPE (%)")
    print(f"{'Yöntem':<32}{'Haftalık':>10}{'Aylık':>10}{'Aylık min–maks':>18}")
    for m, name in METHOD_TR.items():
        sp = s["monthly"]["spread"][m]
        rng = f"{_fmt(sp['min'], 1)}–{_fmt(sp['max'], 1)}"
        print(f"{name:<32}{_fmt(s['weekly']['wape_pilot'][m]):>10}{_fmt(s['monthly']['wape_pilot'][m]):>10}{rng:>18}")
    rel = ev["relative_improvement_vs_xgboost_pct"]
    print(f"{'XGBoost’a göre göreli fark (%)*':<32}{_fmt(rel['weekly']):>10}{_fmt(rel['monthly']):>10}")
    print("  * (WAPE_X − WAPE_iv) / WAPE_X × 100; pozitif değer önerilen birleşimin daha az hata yaptığını gösterir.")
    ci = s["monthly"]["bootstrap_ci_wape_diff"]["combined_minus_xgboost"]
    if ci:
        print(f"Aylık WAPE farkı (iv − X), blok bootstrap %95 aralık: {ci['estimate']:.2f} [{ci['lo']:.2f}, {ci['hi']:.2f}] puan")
    th = method["group_thresholds"]
    print(
        f"Seçilen λ = {method['lambda']}; a0 haftalık {method['a0']['weekly']:.3f}, aylık {method['a0']['monthly']:.3f}; "
        f"aralıklı eşiği {th['zero_ratio_intermittent']}, CV kesimi {', '.join(f'{c:.3f}' for c in th['cv_split'])}, "
        f"en az gözlem {th['min_obs']}"
    )
    sim = ev.get("stock_simulation")
    if sim:
        print(f"Stok simülasyonu ({sim['period']['start']} – {sim['period']['end']}, L={sim['lead_time_days']}, R={sim['review_days']}; varsayımlı):")
        for m, r in sim["methods"].items():
            print(f"  {METHOD_TR[m]:<30} karşılanamayan {r['unmet_observed_sales']:>9.1f}   ort. stok {r['avg_on_hand']:>9.1f}   doluluk {_fmt(r['fill_rate'], 3)}")
    print("Not: Bu tablo ölçülen hataları gösterir; başarı iddiası değildir.")


def _progress(quiet: bool):
    t0 = time.time()

    def f(msg: str) -> None:
        if not quiet:
            _err(f"[{time.time() - t0:6.1f} sn] {msg}")

    return f


def cmd_degerlendir(a: argparse.Namespace) -> int:
    from .output import write_json
    from .pipeline import evaluate_file

    cfg = build_config(a)
    out = evaluate_file(a.girdi, cfg, _progress(a.sessiz))
    write_json(out, a.cikti)
    print_evaluation(out["evaluation"], out["method"])
    print(f"Çıktı: {a.cikti}")
    return 0


def cmd_tahmin(a: argparse.Namespace) -> int:
    from .forecast import read_stock_params
    from .io_csv import load_canonical
    from .output import write_json
    from .pipeline import forecast_data
    from .schema_check import load_schema, validate

    cfg = build_config(a)
    data = load_canonical(a.girdi, cfg)
    sp = read_stock_params(a.stok_parametreleri) if a.stok_parametreleri else None
    out = forecast_data(data, cfg, _progress(a.sessiz), sp)
    schema = load_schema()
    if schema is not None:
        errs = validate(out, schema)
        if errs:
            _err("Şema doğrulaması başarısız:\n  " + "\n  ".join(errs[:20]))
            return 2
    write_json(out, a.cikti)
    print_evaluation(out["evaluation"], out["method"])
    hz = out["horizons"]
    print()
    print(f"Tahmin başlangıcı {out['origin']} — haftalık {hz['weekly']['start']}–{hz['weekly']['end']}, aylık {hz['monthly']['start']}–{hz['monthly']['end']}")
    print(f"{'Ürün':<22}{'Birim':<6}{'Grup':<13}{'Haftalık':>10}{'Aylık':>10}{'Sipariş üst sınırı':>20}")
    prods = sorted(out["products"], key=lambda p: -(p["forecast"]["monthly"]["combined"] or 0))
    for p in prods[: a.satir]:
        f = p["forecast"]
        print(f"{p['name'][:21]:<22}{p['unit']:<6}{p['group']:<13}{_fmt(f['weekly']['combined'], 1):>10}{_fmt(f['monthly']['combined'], 1):>10}{_fmt(p['stock']['order_up_to'], 1):>20}")
    if len(prods) > a.satir:
        print(f"... toplam {len(prods)} ürün; tümü {a.cikti} dosyasında.")
    print(f"Çıktı: {a.cikti} (şema doğrulandı)" if schema is not None else f"Çıktı: {a.cikti}")
    return 0


# --------------------------------------------------------------------------- parser
def _common_data(p: argparse.ArgumentParser) -> None:
    p.add_argument("--kapali-gunler", help="Kapalı hafta günleri, 0=Pazartesi … 6=Pazar (örn. 6). Boş bırakılırsa otomatik algılanır.")
    p.add_argument("--kapali-tarihler", help="Kapalı tarihler, virgülle (YYYY-AA-GG).")
    p.add_argument("--yinelenenleri-sil", action="store_true", help="Birebir yinelenen satırları sil (varsayılan: yalnızca say).")


def _common_model(p: argparse.ArgumentParser) -> None:
    _common_data(p)
    p.add_argument("--hizli", action="store_true", help="Küçük arama ızgarası ve az ağaç (test/deneme için).")
    p.add_argument("--baslangic-sayisi", type=int, help="Dış test başlangıç sayısı (varsayılan: son 12 aydaki tümü).")
    p.add_argument(
        "--en-az-egitim-ay", type=int,
        help="İlk iç başlangıçtan önceki en kısa eğitim süresi, ay (varsayılan 12). Kısa veride küçültün.",
    )
    p.add_argument("--aylik-mod", choices=["calendar", "30d"], help="Aylık ufuk: gelecek takvim ayı (varsayılan) veya 30 gün.")
    p.add_argument("--pilot", help="Pilot ürün barkodları (virgülle) veya barkod listesi dosyası.")
    p.add_argument("--tohum", type=int, help="Rastgelelik tohumu (varsayılan 7).")
    p.add_argument("--is-parcacigi", type=int, help="XGBoost iş parçacığı sayısı (varsayılan 2).")
    p.add_argument("--sessiz", action="store_true", help="İlerleme mesajlarını gösterme.")
    p.add_argument("--tedarik-gun", type=int, help="Tedarik süresi L (gün, varsayılan 2).")
    p.add_argument("--gozden-gecirme-gun", type=int, help="Gözden geçirme aralığı R (gün, varsayılan 7).")
    p.add_argument("--hizmet-duzeyi", type=float, help="Emniyet stoku yüzdeliği (varsayılan 0.9).")


def make_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--ayrintili", action="store_true", help="Hata olursa Python hata izini (traceback) de yaz.")
    ap = argparse.ArgumentParser(prog="python -m dukkan_tahmin", description="Dükkan talep tahmini araştırma katmanı.")
    sub = ap.add_subparsers(dest="komut", required=True)

    def add_parser(name: str, **kw: Any) -> argparse.ArgumentParser:
        return sub.add_parser(name, parents=[common], **kw)

    p = add_parser("donustur", help="Ham market raporunu (HTML-XLS / ZIP) ürün-gün CSV'sine dönüştür.")
    p.add_argument("--girdi", required=True)
    p.add_argument("--cikti", required=True)
    p.add_argument("--kalite", help="Veri kalite raporu (JSON).")
    p.add_argument("--katalog", help="Ürün kataloğu barkod listesi (eşleşmeyen barkodlar için).")
    p.add_argument(
        "--devam", action="store_true",
        help="Tarihi veya sayısı okunamayan satırlarda durma; bu satırları dışarıda bırak ve kalite raporunda say.",
    )
    _common_data(p)
    p.set_defaults(func=cmd_donustur)

    p = add_parser("sentetik", help="Sentetik satış verisi üret.")
    p.add_argument("--cikti", required=True)
    p.add_argument("--ay", type=int, default=36)
    p.add_argument("--urun", type=int, default=40)
    p.add_argument("--tohum", type=int, default=7)
    p.add_argument("--bitis", default="2026-10-26")
    p.add_argument("--pazar-kapali", action="store_true")
    p.add_argument("--html", help="Ham rapor (HTML-XLS) dosyası da yaz.")
    p.add_argument("--zip", help="Ham raporu ZIP içinde de yaz.")
    p.add_argument("--kodlama", default="cp1254", choices=["cp1254", "utf-8"])
    p.add_argument("--html-baslangic", help="Ham raporu bu tarihten başlat (YYYY-AA-GG).")
    p.add_argument("--html-bitis", help="Ham raporu bu tarihte bitir.")
    p.set_defaults(func=cmd_sentetik)

    p = add_parser("degerlendir", help="İlerleyen başlangıçlı geriye dönük test ve bileşen çıkarma.")
    p.add_argument("--girdi", required=True)
    p.add_argument("--cikti", required=True)
    _common_model(p)
    p.set_defaults(func=cmd_degerlendir)

    p = add_parser("tahmin", help="Son güne kadar tüm veriyle tahmin + stok önerisi (tahmin.json).")
    p.add_argument("--girdi", required=True)
    p.add_argument("--cikti", required=True)
    p.add_argument("--lambda", dest="lambda_", type=float, help="λ değerini sabitle (iç seçim yapılmaz).")
    p.add_argument("--stok-parametreleri", help="CSV: barkod;tedarik_gun;gozden_gecirme_gun;paket")
    p.add_argument("--satir", type=int, default=12, help="Özet tabloda gösterilecek ürün sayısı.")
    _common_model(p)
    p.set_defaults(func=cmd_tahmin)
    return ap


def _one_line(e: BaseException) -> str:
    return " ".join(str(e).split())


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    verbose = bool(getattr(args, "ayrintili", False))
    try:
        return int(args.func(args))
    except (ValueError, FileNotFoundError, PermissionError, IsADirectoryError) as e:
        if verbose:
            traceback.print_exc()
        msg = _one_line(e)
        if isinstance(e, OSError) and getattr(e, "filename", None):
            msg = f"{e.strerror or type(e).__name__}: {e.filename}"
        _err(f"Hata: {msg}")
        return 1
    except Exception as e:  # noqa: BLE001 -- last-resort handler: one Turkish line, traceback on request
        if verbose:
            traceback.print_exc()
            _err(f"Hata: beklenmeyen sorun ({type(e).__name__}: {_one_line(e)}).")
        else:
            _err(
                f"Hata: beklenmeyen sorun ({type(e).__name__}: {_one_line(e)}). "
                "Ayrıntı için komutu --ayrintili ile yeniden çalıştırın."
            )
        return 1


if __name__ == "__main__":
    sys.exit(main())
