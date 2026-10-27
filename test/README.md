# Testler

Gereksinim: Node 22 (`.nvmrc`). Birim testleri için `npm install` gerekmez; Node'un yerleşik
`node:test` çalıştırıcısı kullanılır.

| Komut                | Ne yapar                                                   |
| -------------------- | ---------------------------------------------------------- |
| `npm test`           | `test/` altındaki tüm `*.test.js` dosyalarını çalıştırır.  |
| `npm run test:unit`  | Yalnızca `test/unit/` birim testleri.                      |
| `npm run test:smoke` | Playwright ile tarayıcı duman testi (`test/smoke/run.js`). |

**`test/unit/register-core.test.js`** — `register-core.js` kasa kuralları: `cents()` yuvarlama
(1.005, 2.675, 5.015, 0.1+0.2, 1e9 sınırı), nakit/kart/veresiye satış, yeni müşteri, bakiye, tahsilat
(borç içinde/üstünde), işletme içi kullanım (maliyetli/maliyetsiz), hatalı ürün satırları, işlem kimliği
kontrollerinin sırası, `nextNumber` artışı, `commit`'in girdiyi değiştirmemesi ve `daily()` özetleri
(ürün bazında toplanan maliyet dahil).

**`test/unit/storage.test.js`** — `storage.js` saf yardımcıları: `commitScope()` (bir kaydın hangi
eski işlemlere ihtiyaç duyduğu) ve 400 rastgele istekle "kısmi `entries` ile `commit` = tüm durumla
`commit`" denkliği (yinelenen kimlik ve borçtan fazla tahsilat retleri dahil), `checkMeta` /
`splitRegister`, yedek dosyası (`buildBackup` / `readBackup` gidiş-dönüş, özet, hatalı dosyalar) ve eski
yedeğin yalnızca "Mevcut kayıtların yerine geç" ile yüklenebilmesi (`restoreRefusal`).

**`test/smoke/run.js`** — Depo kökünde boş bir portta `python3 -m http.server` başlatır, uygulamayı
Chromium'da `?debug=1` ile açar ve sırasıyla:

1. açılışta `render()`'ın bir kez çağrıldığını, `#nav` içindeki her düğmenin bir başlık çizdiğini;
2. "Satış" sayfasından bir satışı (toast: "Satış kaydedildi; stok güncellendi.") ve bu kaydın IndexedDB
   `dukkan` / `entries` deposunda olduğunu, `localStorage`'a yazılmadığını;
3. ürün ekleme modalını, kayıt başarısız olunca formun açık kaldığını (IndexedDB'deki `meta/register`
   kaydı geçici olarak bozulur), barkodla sepete eklemeyi, yeni müşteriye veresiye satış ve tahsilatı;
4. `window.__dukkanDebug.commit` ile hızlıca 60 satış; "Son işlemler" penceresinde 50 satır ve en üstte en
   yeni işlem; "Gün sonu" cirosu ve kayıt sayısının IndexedDB'den hesaplananla aynı olduğunu;
5. Asistan → Yedekleme: "Yedek indir" (`dukkan-yedek-YYYY-MM-DD.json`, rapor varsayılan olarak hariç,
   sayılar IndexedDB ile aynı), aynı dosyanın **yeni bir tarayıcı profilinde** geri yüklenmesi (işlem
   kimlikleri, ürün/müşteri sayıları, `nextNumber` ve veresiye bakiyesi aynı);
6. ön izleme penceresinin (`?tablet=1`) yazmasının ana ekranda toast göstermediğini, gerçek ikinci sekmenin
   ise `BroadcastChannel` üzerinden "Kayıtlar diğer sekmeden güncellendi." gösterdiğini;
7. artık eski kalan yedeğin uyarıyla reddedildiğini ve onay düğmesinin yalnızca "Mevcut kayıtların yerine
   geç" işaretlenince açıldığını;
8. taşıma: yeni bir profilde `localStorage` `dukkan-register-v1` (2 ürün, 3 işlem, 1 müşteri) ile açılışta
   kayıtların IndexedDB'ye aktarıldığını, anahtarın `dukkan-register-v1-migrated` olarak korunduğunu ve
   veresiye bakiyesinin doğru olduğunu;
9. satış raporu fikstürünü yüklemeyi; eski `dukkan-sales` veritabanındaki raporun yeni bir profilde ortak
   `dukkan` veritabanına taşınıp eski veritabanının silindiğini; tahmin denemesini (56 gün).
10. model CSV'si: yeni bir profilde iki ürün (biri barkodlu, baştaki sıfırıyla), iki güne yayılan üç satış,
    bir işletme içi kullanım ve bir tahsilat; Raporlar → "Ürün-gün CSV indir" dosyasının adını
    (`urun-gun-2026-03-02_2026-03-04.csv`), BOM'unu, başlığını, CRLF satır sonlarını ve satırlarını (yalnızca
    satışlar; barkodsuz ürün varsayılan olarak hariç, kutu işaretlenince `app:<id>`); ardından `model/`
    klasöründe `python3 -c` ile `dukkan_tahmin.io_csv.load_canonical` çağrılarak satır sayısını, miktarları,
    tutarları ve satış olmayan günün eksik gün sayıldığını. `python3` ya da paket içe aktarılamazsa bu adım
    `SKIP:` ile geçilir.

Konsol hataları ve `pageerror` olayları tüm sayfalardan toplanır; herhangi bir adım ya da hata varsa çıkış
kodu 1 olur. Playwright'ın sistemde kurulu olması gerekir (`require("playwright")`).
