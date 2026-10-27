# Dükkan — Stok ve Satış Yönetimi

Küçük perakende işletmeleri için sade, kırmızı temalı; bilgisayar, tablet ve telefona uyumlu web uygulaması **prototipi**. Uygulama tamamen tarayıcıda çalışır; sunucu tarafı, hesap sistemi veya bulut veritabanı yoktur.

## Özellikler

- **Ürün ve stok:** ürün adı, barkod, kategori, fiyat, stok ve alt sınır; CSV ile stok listesi yükleme.
- **Satış ekranı:** barkod okutarak veya ürün seçerek sepet; ödeme türü olarak nakit, kart veya veresiye.
- **İşletme içi kullanım:** dükkânda tüketilen ürünleri satıştan ayrı kaydetme.
- **Veresiye:** müşteri borçları, tahsilat ve işlem geçmişi.
- **Gün sonu:** günlük ciro ve işlem özeti, en çok satılanlar, kritik stoklar.
- **Satış raporu içe aktarma:** market programının HTML tabanlı XLS raporu veya bu raporu içeren ZIP dosyası, tarayıcıda (Web Worker ile) okunur.
- **Basit geri-test:** yüklenen satış geçmişinde, bir ürün için "aynı haftanın gününe ait son 8 kayıtlı günün ortalaması" yöntemi geçmiş günler üzerinde denenir; MAE, WAPE ve "geçen haftayı tekrarla" karşılaştırması gösterilir.

> **Tahmin ekranı hakkında:** Mevcut tahmin/deneme ekranı XGBoost veya başka bir makine öğrenmesi modeli **değildir**. Henüz eğitilmiş ve doğrulanmış bir model yoktur; ileri tarihli tahmin üretilmez. Gösterilen sonuçlar gelecekteki doğruluk için bir garanti değildir.

## Çalıştırma

Uygulama bir yerel web sunucusu üzerinden açılmalıdır. `index.html` dosyasını çift tıklayarak (`file://` adresiyle) açmak yeterli değildir: satış raporu Web Worker içinde ve dosya akışı (stream) olarak işlenir; tarayıcılar bu özellikleri `file://` adreslerinde engeller.

Python 3 gerekir ([python.org/downloads](https://www.python.org/downloads/)). Windows'ta kurulum sırasında "Add python.exe to PATH" seçeneğini işaretleyin.

| Sistem | Yöntem |
| --- | --- |
| Windows | `BASLAT_WINDOWS.bat` dosyasını çift tıklayın. |
| macOS / Linux | `BASLAT_MAC_LINUX.command` dosyasını çalıştırın (ya da terminalde `./BASLAT_MAC_LINUX.command`). |
| Her sistem | Bu klasörde terminal açıp `python3 baslat.py` |

`baslat.py` sunucuyu **yalnızca bu bilgisayardan erişilebilecek şekilde** `127.0.0.1:8765` adresinde başlatır ve tarayıcıda http://127.0.0.1:8765/ adresini açar. Pencere açık kaldığı sürece uygulama çalışır; durdurmak için `Ctrl+C`.

Alternatif olarak herhangi bir statik sunucu da kullanılabilir:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

ardından http://127.0.0.1:8000 adresini açın.

## Tarayıcı gereksinimleri

Kod `DecompressionStream("deflate-raw")`, `navigator.locks`, `Object.hasOwn`, `Array.prototype.at` ve `<dialog>` öğesini kullanır. Bu nedenle en az:

- Chrome / Edge **113+**
- Firefox **113+**
- Safari ve iOS/iPadOS Safari **16.4+**

Daha eski tarayıcılarda rapor içe aktarma veya bazı pencereler çalışmayabilir.

## Veriler nerede tutulur?

- Ürünler, satışlar, veresiye ve ayarlar tarayıcının `localStorage` alanında; içe aktarılan satış raporu `IndexedDB` içinde saklanır.
- Kayıtlar **yalnızca o tarayıcıda ve o cihazda** bulunur. Cihazlar arasında ortak veritabanı veya otomatik eşitleme yoktur.
- Tarayıcı verilerini (site verileri, çerezler ve önbellek) temizlemek **tüm kayıtları siler**. Gizli/özel pencerede girilen veriler pencere kapanınca kaybolur.
- İşletmeye ait satış raporları ve dışa aktarılan dosyalar (`*.xls`, `*.csv`, `*.zip` vb.) `.gitignore` ile depo dışında tutulur; gerçek işletme verisini depoya eklemeyin.

## Kullanım sınırları

- Bu sürüm bir prototiptir; gerçek bir işletmede tek kayıt sistemi olarak kullanılmadan önce ayrıca denenmelidir.
- Kart seçeneği yalnızca ödeme türünü kaydeder; banka işlemi yapmaz, mali fiş veya e-Arşiv belgesi üretmez.
- Barkod akışı klavye gibi çalışan USB/Bluetooth okuyucular için tasarlanmıştır; fiziksel tablet ve okuyucu uyumu ayrıca denenmelidir.
- Bildirim ayarları (Telegram, e-posta, WhatsApp) yalnızca tercih ve ön izlemedir; dış servise bağlantı ve zamanlanmış gönderim yoktur.

## Proje

TÜBİTAK 2209-A Üniversite Öğrencileri Araştırma Projeleri Destekleme Programı kapsamında geliştirilen çalışma prototipidir.

**Proje başlığı:** Küçük Ölçekli Perakende İşletmeleri İçin Uyarlanabilir Bir Makine Öğrenmesi Yöntemi ile Talep Tahmini ve Stok Karar Destek Uygulaması Geliştirilmesi

### Planlanan mimari

*Aşağıdakiler planlanan çalışmalardır; bu depoda henüz tamamlanmış değildir.* Tablet tarafı bu web uygulamasıdır ve kurulabilir bir PWA'ya (ana ekrana eklenebilen, çevrimdışı açılabilen uygulama) dönüştürülecektir. Model tarafı `model/` klasöründe bir Python paketi olacaktır: mevsimsel naif yöntem, XGBoost ve önerilen düzenlileştirilmiş grup-ağırlıklı birleştirme yöntemi; bu yöntemlerin kayan başlangıçlı (rolling-origin) geri-testlerle karşılaştırılması; tahminlerden sipariş miktarı öneren "hedef stok seviyesine tamamlama" (order-up-to) kuralı. İki taraf bir `tahmin.json` dosyası ve isteğe bağlı olarak yalnızca yerel ağda çalışan bir API üzerinden veri alışverişi yapacaktır.

## Geliştirme

Web uygulaması derleme adımı gerektirmez; dosyalar doğrudan sunulur.

```sh
npm test                    # Node.js yerleşik test çalıştırıcısı (node:test), test/ klasörü
python3 -m pytest model/    # Python model katmanı
```

Kök dizindeki dosyalar:

- `index.html`, `polish.css`, `register.css` — işaretleme ve stiller
- `main.js`, `app.js` — sayfa listesi, yönlendirici, ortak yardımcılar ve durum
- `stock.js`, `overview.js`, `forecast.js`, `day-end.js`, `assistant.js`, `reports.js` — ekranlar
- `register.js`, `register-core.js` — satış ekranı, veresiye ve kasa kuralları
- `sales-report.js`, `sales-worker.js` — satış raporu içe aktarma ve geri-test
- `categories.js` — kategori simgeleri
- `model/` — Python tahmin katmanı (kendi README'si var)
- `test/` — birim ve duman testleri
- `baslat.py`, `BASLAT_*` — yerel sunucu başlatıcıları
- `assets/` — logo ve uygulama simgeleri
