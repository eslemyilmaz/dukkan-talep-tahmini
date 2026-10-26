# Dükkan — Satış ve stok takip prototipi

Küçük işletmeler için satış analizi, barkodla stok girişi ve talep tahmini denemesi.

## Proje ekibi
- Eslem Yılmaz — Proje geliştiricisi
- Beyza Dönmez — Proje geliştiricisi
- Emre Kişi — Akademik danışman

## Bilgisayarda açma
ZIP dosyasını tamamen çıkarın. Python 3 kurulu Windows bilgisayarda
`BASLAT_WINDOWS.bat` dosyasına çift tıklayın. Tarayıcı açılır;
komut penceresini kullanım boyunca açık tutun.
Mac/Linux: bu klasörde `python3 baslat.py` çalıştırın.
Ek Python paketi gerekmez. `index.html` dosyasına doğrudan çift tıklamak yerine
başlatıcıyı kullanın; dosya aktarımı Worker üzerinden çalışır.

## Bu sürüm
- Kırmızı-beyaz arayüz, telefon ön izlemesi ve duyarlı ekran düzeni.
- Ekmek, içecek, süt ürünleri, tütün ve diğer kategoriler için ortak SVG ikonları.
- Gün sonu ekranında en çok satılan ürünler, miktar, tutar ve gelir payı.
- Miktara veya satış tutarına göre sıralama; gerçek veri varsa tarih seçimi.
- Ürün ekleme, barkodla ürün bulma, stok girişi, düşük stok filtresi ve CSV aktarımı.
- HTML tabanlı market XLS raporunu veya tek rapor içeren ZIP dosyasını okuma.
- Gerçek satış detayları ve son 56 kayıtlı gün üzerinde basit tahmin testi.
- Asistan bildirim ayarları ve örnek mesajlar.

## Gerçek veriyle deneme
Raporlar > Gerçek satış raporuyla deneme alanından market raporunuzu seçin.
Satış raporları bu pakete dahil değildir. Yeni satış dosyası eski satış raporunun
yerini alır; stok listenizi değiştirmez. Veriler bu tarayıcıda tutulur;
cihazlar arasında otomatik eşitleme yoktur.

## Sınırlar
- Veri yüklenmeden görülen satışlar örnektir.
- Güncel stok, geçmiş satıştan hesaplanmaz; ayrı stok kaydı gerekir.
- XGBoost ve özgün matematiksel ML modülü henüz bağlı değildir.
- Test yöntemi, aynı haftanın gününe ait geçmiş en fazla 8 gözlemin ortalamasıdır.
  Her tahminde yalnızca önceki tarihler kullanılır.
- Hesap ve negatif işlemler talep serisinden çıkarılır, günlük ciroda korunur.
- Kayıt bulunmayan günler test edilmez; ürünün bulunmadığı kayıtlı günler
  ön denemede sıfır sayılır. Stok tükenmeleri henüz ayrıştırılmamıştır.
- Farklı birimler miktar sıralamasını etkiler; tutara göre sıralama da sunulur.
- n8n bağlantısı, gerçek otomatik gönderim ve fiziksel tablet/okuyucu testi yoktur.

## GitHub'a yükleme
ZIP'i çıkarıp klasörün içindeki kaynak dosyaları yükleyin; ZIP'i yüklemeyin.
README bu pakette bulunduğundan mevcut README'nizi bununla değiştirebilirsiniz.
Gerçek işletme raporlarını ve kişisel verileri depoya eklemeyin.
GitHub'daki değişiklikler mevcut yayınlanan uygulamaya otomatik yansımaz.
