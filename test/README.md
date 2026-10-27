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

**`test/smoke/run.js`** — Depo kökünde boş bir portta `python3 -m http.server` başlatır, uygulamayı
Chromium'da açar, `#nav` içindeki her düğmeye tıklayıp başlık arar, "Satış" sayfasından bir satış yapar
(toast: "Satış kaydedildi; stok güncellendi."), ardından "Veresiye" ve "Gün sonu" sayfalarını açar.
Konsol hataları ve `pageerror` olayları toplanır; herhangi bir adım ya da hata varsa çıkış kodu 1 olur.
Playwright'ın sistemde kurulu olması gerekir (`require("playwright")`).
