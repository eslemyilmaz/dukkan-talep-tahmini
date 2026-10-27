# Dükkan — Stok ve Satış Yönetimi

Küçük işletmeler için sade, kırmızı temalı; bilgisayar, tablet ve telefona uyumlu web uygulaması prototipi.

## Özellikler
- Ürün, barkod, fiyat ve stok yönetimi; kategori simgeleri.
- Barkod veya ürün seçimiyle satış sepeti; nakit, kart ve veresiye kayıtları.
- İşletme içi tüketimi satıştan ayrı kaydetme.
- Müşteri borçları, tahsilat ve işlem geçmişi.
- Gün sonu özeti, en çok satılan ürünler ve kritik stoklar.
- Geçmiş satış raporlarını yükleme ve tablet/telefon görünümünü inceleme.

## Çalıştırma
Dosyaları aynı klasörde tutun. Python kuruluysa bu klasörde terminal açıp:

```sh
python -m http.server 8000
```

Tarayıcıdan http://localhost:8000 adresini açın. Dosyayı çift tıklamak yerine yerel sunucu kullanın; rapor işleme gibi tarayıcı özellikleri buna ihtiyaç duyabilir.

## GitHub'a güncelleme yükleme
1. ZIP'i bilgisayarınızda ayıklayın.
2. Mevcut GitHub deponuzda Add file → Upload files bölümünü açın.
3. Bu ZIP'in içindeki dosyaları ve assets klasörünü birlikte yükleyin. ZIP'in kendisini yüklemeyin.
4. Aynı adlı dosyaların güncelleneceğini kontrol edip Commit changes seçin.
5. Ana index.html deponun kökünde olmalıdır. Mevcut README.md bu dosyayla değişir; kendi eklediğiniz açıklamalar varsa önce birleştirin.

## Kullanım sınırları
Bu sürüm prototiptir. Kayıtlar kullanılan tarayıcıda yerel olarak tutulur; cihazlar arasında ortak veritabanı veya otomatik eşitleme yoktur. Tarayıcı verilerini temizlemek kayıtları silebilir. ZIP, tarayıcıda yaptığınız satışları ve yüklediğiniz verileri içermez.

Kart seçeneği yalnızca ödeme türünü kaydeder; banka işlemi veya mali fiş üretmez. Barkod akışı klavye gibi çalışan USB/Bluetooth okuyucular için tasarlanmıştır; fiziksel tablet/okuyucu uyumu ayrıca denenmelidir.

Mevcut tahmin ekranı, eğitilmiş ve doğrulanmış XGBoost modeli anlamına gelmez. Özgün tahmin modülü, walk-forward değerlendirme, ortak veritabanı ve n8n/AI agent bildirim bağlantıları sonraki geliştirme aşamalarıdır; bu pakette etkin değildir.

## Proje
TÜBİTAK 2209-A başvurusu kapsamında geliştirilen çalışma prototipi.
