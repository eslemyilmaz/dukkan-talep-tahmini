# Dükkan — Stok ve Satış Yönetimi

Küçük perakende işletmeleri için sade, kırmızı temalı; bilgisayar, tablet ve telefona uyumlu web uygulaması **prototipi** ve ona bağlı bir Python tahmin paketi (`model/`). Uygulama tamamen tarayıcıda çalışır; sunucu tarafı, hesap sistemi veya bulut veritabanı yoktur.

## Özellikler

- **Ürün ve stok:** ürün adı, barkod, kategori, fiyat, stok ve alt sınır; barkodla stok girişi; CSV ile stok listesi yükleme ve dışa aktarma.
- **Satış ekranı:** barkod okutarak veya ürün seçerek sepet; ödeme türü olarak nakit, kart veya veresiye.
- **İşletme içi kullanım:** dükkânda tüketilen ürünleri satıştan ayrı kaydetme.
- **Veresiye:** müşteri borçları, tahsilat ve işlem geçmişi.
- **Gün sonu:** günlük ciro ve işlem özeti, en çok satılanlar, kritik stoklar.
- **Yedekleme:** Asistan sayfasında tek JSON dosyasıyla yedek indirme ve doğrulamalı, onaylı geri yükleme.
- **Satış raporu içe aktarma:** market programının HTML tabanlı XLS raporu veya bu raporu içeren ZIP dosyası, tarayıcıda (Web Worker ile) okunur.
- **Modele veri aktarma:** Raporlar → "Satış kayıtlarını modele aktar" kartı, kasa satışlarını modelin okuduğu ürün-gün CSV dosyasına çevirir.
- **Tahminler:** Python paketinin ürettiği `tahmin.json` yüklenir; ürünler barkodla eşleşir, önerilen sipariş bu cihazdaki stokla hesaplanır.
- **Kurulabilir uygulama (PWA):** ana ekrana eklenebilir, uygulama kabuğu çevrimdışı açılır (koşulları aşağıda).

> **Tahmin sonuçları hakkında:** Modelin geri-test sonuçları şu an yalnızca **sentetik** veriden gelir ve bu veride önerilen grup-ağırlıklı birleştirme yöntemi yalın XGBoost'a göre **bir üstünlük göstermemektedir** (fark ölçüm hatası içinde). Yöntem hakkında herhangi bir iddiadan önce gerçek işletme verisiyle değerlendirme gerekir. `tahmin.json` yüklenmemişken Tahminler sayfasındaki deneme ekranı makine öğrenmesi modeli değildir: yüklenen raporda "aynı haftanın gününe ait son 8 kayıtlı günün ortalaması" yöntemini geçmiş günler üzerinde dener.

## Çalıştırma

Uygulama bir yerel web sunucusu üzerinden açılmalıdır. `index.html` dosyasını çift tıklayarak (`file://` adresiyle) açmak yeterli değildir: satış raporu Web Worker içinde ve dosya akışı olarak işlenir, çevrimdışı kabuk bir service worker gerektirir; tarayıcılar bunları `file://` adreslerinde engeller.

Python 3 gerekir ([python.org/downloads](https://www.python.org/downloads/)). Windows'ta kurulum sırasında "Add python.exe to PATH" seçeneğini işaretleyin.

| Sistem | Yöntem |
| --- | --- |
| Windows | `BASLAT_WINDOWS.bat` dosyasını çift tıklayın. |
| macOS / Linux | `BASLAT_MAC_LINUX.command` dosyasını çalıştırın (ya da terminalde `./BASLAT_MAC_LINUX.command`). |
| Her sistem | Bu klasörde terminal açıp `python3 baslat.py` |

`baslat.py` sunucuyu **yalnızca bu cihazdan erişilebilecek şekilde** `127.0.0.1:8765` adresinde başlatır ve tarayıcıda http://127.0.0.1:8765/ adresini açar. Pencere açık kaldığı sürece uygulama çalışır; durdurmak için `Ctrl+C`. Herhangi bir statik sunucu da kullanılabilir (örneğin `python3 -m http.server 8000 --bind 127.0.0.1`).

### Tablette kurulum ve çevrimdışı çalışma

Service worker yalnızca **HTTPS** üzerinden veya **localhost / 127.0.0.1** adresinde çalışır. Bilgisayarda çalışan sunucuya tabletten `http://<bilgisayarın-yerel-IP'si>:8765` ile bağlanmak uygulamayı açabilir, ancak bu adreste **kurulum düğmesi ve çevrimdışı açılış olmaz** (ayrıca `baslat.py` yalnızca 127.0.0.1'i dinler). Seçenekler:

- **Sunucuyu tabletin kendisinde çalıştırmak:** tablette Python varsa (Android'de örneğin Termux ile) `python baslat.py` çalıştırıp tarayıcıda http://127.0.0.1:8765/ adresini açın.
- **HTTPS ile sunmak:** dosyalar statik olduğu için herhangi bir statik barındırma hizmeti kullanılabilir; ya da yerel ağda, tabletin güvendiği (sertifikası tablete yüklenmiş) kendinden imzalı sertifikalı bir ters vekil sunucu.

Kurulduktan sonra uygulama kabuğu ağ olmadan açılır; kayıtlar zaten cihazdadır. Yeni sürüm yayımlandığında uygulama bir güncelleme uyarısı gösterir.

### Barkod okuyucu

USB veya Bluetooth okuyucu **klavye (HID) modunda** kullanılmalı ve okuma sonuna **Enter** eklemelidir (çoğu okuyucunun varsayılanı). Barkod alanı seçiliyken okutulur. Fiziksel tablet ve okuyucu uyumu ayrıca denenmelidir.

## Tarayıcı gereksinimleri

Kod `DecompressionStream("deflate-raw")`, `navigator.locks`, IndexedDB, `Object.hasOwn`, `Array.prototype.at` ve `<dialog>` öğesini kullanır. Bu nedenle en az:

- Chrome / Edge **113+**
- Firefox **113+**
- Safari ve iOS/iPadOS Safari **16.4+**

Daha eski tarayıcılarda rapor içe aktarma veya bazı pencereler çalışmayabilir.

## Veriler nerede tutulur?

- Ürünler, satışlar, işletme içi kullanım, tahsilatlar, müşteri hesapları ve tercihler tarayıcının **IndexedDB** alanında, `dukkan` veritabanında tutulur; içe aktarılan satış raporu da aynı veritabanındadır, yüklenen `tahmin.json` ayrı bir veritabanında (`dukkan-tahmin`). Her kasa işlemi tek bir atomik kayıttır.
- Eski sürümün `localStorage` kayıtları ilk açılışta otomatik olarak IndexedDB'ye taşınır; eski kayıt silinmez, `dukkan-register-v1-migrated` adıyla güvenlik kopyası olarak kalır.
- Kayıtlar **yalnızca o tarayıcıda ve o cihazda** bulunur. Cihazlar arasında ortak veritabanı veya eşitleme yoktur.
- Tarayıcı verilerini (site verileri, çerezler ve önbellek) temizlemek **tüm kayıtları siler**. Gizli/özel pencerede girilen veriler pencere kapanınca kaybolur. Düzenli olarak Asistan → Yedekleme'den yedek indirip cihaz dışında saklayın.
- İşletmeye ait satış raporları ve dışa aktarılan dosyalar (`*.xls`, `*.csv`, `*.zip` vb.) `.gitignore` ile depo dışında tutulur; gerçek işletme verisini depoya eklemeyin.

## Model döngüsü

Model tablette çalışmaz; bilgisayardaki Python paketi (`model/`, ayrıntılar `model/README.md`) dosya üzerinden çalışır:

1. **Ürün-gün CSV'si hazırlayın.** Kasa kayıtları için Raporlar → "Satış kayıtlarını modele aktar" → "Ürün-gün CSV indir" (yalnızca satışlar; işletme içi kullanım ve tahsilatlar hariç). Market programının ham raporu için `python -m dukkan_tahmin donustur --girdi rapor.zip --cikti urun_gun.csv`.
2. **Tahmini üretin** (`model/` klasöründe): `python -m dukkan_tahmin tahmin --girdi urun_gun.csv --cikti tahmin.json`
3. **Dosyayı Tahminler sayfasından yükleyin.** Ürünler barkodla eşleşir; önerilen sipariş, hedef stok seviyesi (dönem ihtiyacı + emniyet stoku) ile **bu cihazdaki** mevcut stok farkından, yalnızca bir kez paket boyutuna yukarı yuvarlanarak hesaplanır.

Yerel ağda çalışan bir API bu sürümde yoktur; dosyalar elle taşınır. Gösterilen hata ölçüleri geriye dönük testtir, gelecekteki doğruluk için garanti değildir.

## Kullanım sınırları

- Bu sürüm bir prototiptir; gerçek bir işletmede tek kayıt sistemi olarak kullanılmadan önce ayrıca denenmelidir.
- Kart seçeneği yalnızca ödeme türünü kaydeder; banka işlemi yapmaz, mali fiş veya e-Arşiv belgesi üretmez.
- Stok tükenmesi kaydı yoktur; model gözlenen satışı tahmin eder, karşılanamayan talebi ölçmez.
- Bildirim ayarları (Telegram, e-posta, WhatsApp) yalnızca tercih ve ön izlemedir; dış servise bağlantı ve zamanlanmış gönderim yoktur.

## Proje

TÜBİTAK 2209-A Üniversite Öğrencileri Araştırma Projeleri Destekleme Programı kapsamında geliştirilen çalışma prototipidir.

**Proje başlığı:** Küçük Ölçekli Perakende İşletmeleri İçin Uyarlanabilir Bir Makine Öğrenmesi Yöntemi ile Talep Tahmini ve Stok Karar Destek Uygulaması Geliştirilmesi

Tablet tarafı bu kurulabilir web uygulamasıdır. Model tarafı `model/` klasöründeki Python paketidir: mevsimsel naif yöntem, XGBoost ve önerilen düzenlileştirilmiş grup-ağırlıklı birleştirme yöntemi; bunların kayan başlangıçlı (rolling-origin) geri-testlerle karşılaştırılması ve tahminlerden sipariş miktarı öneren "hedef stok seviyesine tamamlama" (order-up-to) kuralı. İki taraf ürün-gün CSV'si ve `tahmin.json` dosyasıyla veri alışverişi yapar.

## Geliştirme

Web uygulaması derleme adımı gerektirmez; dosyalar doğrudan sunulur. Ayrıntılar `test/README.md` dosyasındadır.

```sh
npm test                         # birim testleri (node:test), test/**/*.test.js
npm run test:smoke               # Playwright duman testi: kasa, yedek, göç, rapor, model CSV'si
npm run test:pwa                 # Playwright: service worker, çevrimdışı açılış, tahmin.json
npm run test:all                 # üçü birden
python3 -m pytest model/tests -q # Python model katmanı
```

Kök dizindeki dosyalar:

- `index.html`, `polish.css`, `register.css` — işaretleme ve stiller
- `main.js`, `app.js` — sayfa listesi, yönlendirici, ortak yardımcılar ve durum
- `storage.js` — IndexedDB katmanı (`dukkan` veritabanı), yedek dosyası biçimi
- `stock.js`, `overview.js`, `forecast.js`, `day-end.js`, `assistant.js`, `reports.js` — ekranlar
- `register.js`, `register-core.js` — satış ekranı, veresiye, yedekleme ve kasa kuralları
- `sales-report.js`, `sales-worker.js` — satış raporu içe aktarma ve geri-test
- `categories.js` — kategori simgeleri
- `pwa.js`, `sw.js`, `manifest.webmanifest` — kurulum düğmesi, service worker (çevrimdışı kabuk), uygulama bildirimi
- `model/` — Python tahmin katmanı (kendi README'si var)
- `test/` — birim ve duman testleri, fikstürler
- `baslat.py`, `BASLAT_*` — yerel sunucu başlatıcıları
- `assets/` — logo ve uygulama simgeleri
