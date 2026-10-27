# dukkan_tahmin — araştırma ve modelleme katmanı

TÜBİTAK 2209-A projesi *"Küçük Ölçekli Perakende İşletmeleri İçin Uyarlanabilir Bir Makine
Öğrenmesi Yöntemi ile Talep Tahmini ve Stok Karar Destek Uygulaması Geliştirilmesi"*
(Sakarya Üniversitesi Matematik Bölümü; Eslem Yılmaz, Beyza Dönmez; danışman Dr. Emre Kişi)
için Python katmanı. Önerinin İP1–İP4 iş paketlerini ve Denklem 6 stok kuralını
tekrarlanabilir, sınanmış bir paket olarak uygular. Tablet uygulaması bu paketin ürettiği
`tahmin.json` dosyasını okur.

> **Sonuçlar başarı iddiası değildir.** Bu paket yalnızca ölçer: hangi yöntemin hangi
> veride, hangi ufukta, ne kadar hata yaptığını. Henüz gerçek işletme verisi yoktur;
> aşağıdaki bütün sayılar **sentetik** veriden gelir.

## Amaç

Gözlem birimi ürün-gündür. Hedef değişken `y[i,t]`, ürün *i*'nin *t* gününde **gözlenen
satış miktarıdır; talep değildir.** Stok tükenmesi kaydı olmadığı için karşılanamayan talep
ölçülmez ve ölçülmüş gibi sunulmaz.

Araştırma sorusu: ürün gruplarına göre düzenlileştirilmiş ve zaman içinde güncellenen
tahmin birleştirme yöntemi, aynı bilgiyle çalışan yalın XGBoost ve mevsimsel saf tahmine
göre haftalık ve aylık hatayı azaltıyor mu? Paket bu soruyu sınamak için gereken
karşılaştırmayı yürütür. Üstünlük bulunmaması da bir sonuçtur.

## Kurulum

Python 3.10 veya üstü gerekir (3.13 ile denendi). Alt sınırlar: pandas ≥ 2.2
(`groupby.apply(include_groups=…)`), numpy ≥ 1.24, xgboost ≥ 2.0, scikit-learn ≥ 1.3.
`test_parser_parity.py` uygulamanın ayrıştırıcısını Node ile çalıştırır (Node 18+, 22 ile
denendi); `node` yoksa bu testler atlanır.

```sh
cd model
pip install -e .            # numpy, pandas, xgboost, scikit-learn
pip install -e ".[test]"    # + pytest, jsonschema
```

Kurulum yapmadan da çalışır: `model/` klasöründe `python -m dukkan_tahmin ...` komutunu verin.

## Komutlar

```sh
# 1) Ham market raporu (HTML tabanlı .xls veya tek rapor içeren .zip) -> ürün-gün CSV + kalite raporu
python -m dukkan_tahmin donustur --girdi rapor.zip --cikti urun_gun.csv --kalite kalite.json [--devam]

# 2) Sentetik veri (kanonik CSV; istenirse ham rapor biçiminde de)
python -m dukkan_tahmin sentetik --cikti urun_gun.csv --ay 36 --urun 40 --tohum 7 --html rapor.xls --zip rapor.zip

# 3) İlerleyen başlangıçlı geriye dönük test ve bileşen çıkarma (ablasyon)
python -m dukkan_tahmin degerlendir --girdi urun_gun.csv --cikti degerlendirme.json [--baslangic-sayisi 6] [--hizli]

# 4) Son güne kadar tüm veriyle tahmin, stok önerisi ve değerlendirme bloğu
python -m dukkan_tahmin tahmin --girdi urun_gun.csv --cikti tahmin.json [--lambda 0.1] [--hizli]
```

Sık kullanılan seçenekler:

| Seçenek | Anlamı |
|---|---|
| `--kapali-gunler 6` | Kapalı hafta günleri (0 = Pazartesi … 6 = Pazar). Verilmezse dış test alanından önceki tarihlerinin %10'undan azı kayıtlı olan hafta günü kapalı sayılır (`donustur`: dosyanın tamamı). |
| `--kapali-tarihler 2025-01-01,...` | Kapalı tarihler; eksik gün listesinden çıkarılır, ileride 0 tahmin edilir. |
| `--yinelenenleri-sil` | Birebir yinelenen satırları siler. Varsayılan: yalnızca sayar. |
| `--aylik-mod calendar\|30d` | Aylık ufuk: gelecek takvim ayı (varsayılan) veya sonraki 30 gün. |
| `--pilot dosya_veya_barkodlar` | Önceden belirlenmiş pilot ürün kümesi. Varsayılan: iç alanda en çok satılan 20 adet ürünü. |
| `--tedarik-gun 2 --gozden-gecirme-gun 7 --hizmet-duzeyi 0.9` | Stok kuralı parametreleri. |
| `--stok-parametreleri p.csv` | Ürün bazında `barkod;tedarik_gun;gozden_gecirme_gun;paket`. |
| `--hizli` | Küçük ızgara ve az ağaç; testler ve deneme için. Araştırma sonucu için kullanmayın. |
| `--en-az-egitim-ay 12` | İlk iç başlangıçtan önceki en kısa eğitim süresi (ay). Kısa veride küçültülebilir; aşağıdaki "en az veri uzunluğu" kuralına bakın. |
| `--devam` (`donustur`) | Tarihi ya da sayısı okunamayan satırda durma; bu satırları dışarıda bırak ve kalite raporunda say. Varsayılan: uygulamadaki gibi aktarımı durdur. |
| `--ayrintili` | Hata olursa Python hata izini de yaz. Varsayılan: tek satırlık Türkçe hata mesajı, çıkış kodu 1. |

Komutlar stdout'a kısa bir Türkçe özet tablo yazar. İlerleme mesajları stderr'e gider;
`--sessiz` bunları kapatır.

## Girdi biçimleri

**Kanonik ürün-gün CSV** (tablet uygulamasının dışa aktardığı biçim de budur):
`tarih;barkod;urun;kategori;birim;miktar;tutar`. Dosya UTF-8 olmalıdır; `;` ya da `,`
ayırıcısı otomatik algılanır, `.gz` de kabul edilir. `tarih` alanı `YYYY-AA-GG` biçimindedir.
Her ürün-gün için bir satır olmalıdır; tekrar eden satırlar toplanır. Barkodlar metin olarak
okunur, baştaki sıfırlar korunur.

Tablet uygulaması bu dosyayı Raporlar → "Satış kayıtlarını modele aktar" kartından üretir
(UTF-8 BOM'lu, `;` ayırıcılı, `urun-gun-BAŞLANGIÇ_BİTİŞ.csv`). Yalnızca satış kayıtları
aktarılır: işletme içi kullanım ve veresiye tahsilatları dahil edilmez. Satış olmayan günler
dosyada yer almaz ve eksik gün sayılır. Barkodsuz ürünler varsayılan olarak dışarıda kalır;
istenirse `app:` önekli ürün kimliğiyle yazılır, ancak uygulama tahmini yalnızca barkodla eşleştirir.

**Ham market raporu**: Satış programının HTML tabanlı ".xls" çıktısıdır, ZIP içinde de
gelebilir. `io_report`, uygulamanın ayrıştırıcısı `sales-worker.js`'in Python karşılığıdır;
`tests/test_parser_parity.py` ikisini repodaki `test/fixtures/satis-raporu-ornek.xls` ve
zorlayıcı küçük raporlar üzerinde çalıştırıp satır, HESAP, iade, yinelenen sayılarını, gün
toplamlarını ve ürün miktarlarını karşılaştırır. Kurallar:

- **Kodlama:** BOM; yoksa `<meta charset>` (UTF-8 iddiası ancak baytlar geçerli UTF-8 ise);
  yoksa çok baytlı geçerli UTF-8; aksi hâlde windows-1254.
- **Başlık satırı:** Bir hücresinde `BARKOD`, bir hücresinde `MIKTAR` geçen satırdır. Eşleştirme
  Türkçe büyük harfe çevirip İ/Ü/Ö/Ç/Ş/Ğ harflerini I/U/O/C/S/G'ye indirgedikten sonra yapılır;
  `MİKTAR`, `MIKTAR` ve `miktar` aynıdır. Her alan için önce tam eşleşme, sonra (en az 3 harfli
  kalıplarla) içerme aranır; öncelik sırası uygulamadakiyle aynıdır (tutar için `TOPLAM`,
  sonra `TUTAR`; kategori addan önce, böylece `ÜRÜN GRUBU` ürün adı sayılmaz; `KASİYER ADI`,
  `MÜŞTERİ ADI` gibi sütunlar ad olamaz). Zorunlu bir sütun bulunamazsa ve başlık 13 hücreliyse
  sabit sıra kullanılır (0 tarih, 4 barkod, 5 ürün adı, 6 grup, 7 miktar, 8 birim fiyat,
  9 tutar); değilse eksik sütunları sayan bir hata verilir. Başlıktan önceki satırlar okunmaz.
- **Satır:** En yüksek eşlenen sütun sırasından en az bir fazla hücresi olan ve tarihi
  `gg.aa.yyyy` olan satırlar okunur (hücre sayısı başlıktan farklı olabilir; bu satırlar
  `cell_count_mismatch_rows` olarak sayılır ve uyarı verilir).
- **Sayılar:** Virgül varsa tek virgül ondalık ayracıdır ve noktalar 3 haneli binlik
  gruplarıdır (`1.234,50`, `,5`). Virgül yoksa tek nokta ve ardından 1–2 hane ondalıktır
  (`95.12`, `0.75`); yalnızca 3 haneli gruplar arasındaki noktalar binliktir (`1.234.567`);
  düz rakamlar tamsayıdır. Başka her biçim (`12.34,5`, `1234.567`, boşluklu sayı) geçersizdir.
- **Geçersiz satır:** Takvimde olmayan bir tarih (`31.02.2024`) ya da okunamayan miktar,
  birim fiyat veya tutar, uygulamada olduğu gibi aktarımı durdurur. `--devam` ile bu satırlar
  dışarıda bırakılır ve `invalid_rows` olarak raporlanır.
- **ZIP:** İçinde tek bir `.xls`/`.htm`/`.html` dosyası olmalıdır; `__MACOSX/` altındaki ve adı
  `._` ile başlayan macOS ek dosyaları sayılmaz. Şifreli ZIP ve 500 MB'tan büyük açılmış
  rapor reddedilir.

Dosya parçalar hâlinde akış olarak okunur (`io_report.iter_rows`). Müşteri, personel ve ödeme
sütunları **hiç saklanmaz**; yinelenen satır tespiti yalnızca satırın kısa bir özetiyle
(hash) yapılır. `donustur` çıktısındaki `birim` sütunu yalnızca kaynakta beyan edilmiş birimi
taşır; ham raporda birim olmadığı için bu sütun boş kalır ve birim model tarafından
(aşağıdaki kesim kuralıyla) yeniden çıkarılır.

## Öneri maddeleri ve modüller

| Öneri | Ne yapılıyor | Modül / işlev |
|---|---|---|
| 2.2 veri kuralları | HESAP satırları (Türkçe büyük harf) ve negatif (iade) satırlar miktar serisinden çıkarılır ve sayılır. Yinelenen satırlar sayılır, silinmez. Kayıt olmayan gün sıfır sayılmaz, eksik gün olarak listelenir. Kapalı günler ayrı tutulur. Birim kesirli miktardan çıkarılır (kg/adet) ve iki birim toplanmaz. Birim çıkarımı ve kapalı hafta günü algılama yalnızca dış test alanından önceki günlere bakar. | `quality.clean_sales`, `quality.internal_cutoff`, `io_report`, `io_csv` |
| 2.2 özellikler (Denk. 1) | Gecikmeler 1, 7, 14, 28; yalnızca *t*'den önceki günlerden hareketli ortalama (7, 28); haftanın günü, ay, resmî tatil ve arife; kategorik ürün kimliği. | `features.feature_tensor`, `calendar_tr` |
| 2.3 temel modeller | Mevsimsel saf S; tek küresel XGBoost X (`enable_categorical`, `hist`), günden güne yinelemeli. İkisi de ≥ 0'a kırpılır. Hiperparametre ızgarası (derinlik {3,5}, eta {0,05; 0,1}, ağaç {200,400}, min_child_weight {1,5}) yalnızca iç doğrulamada seçilir. | `baselines`, `backtest.tune_xgboost` |
| 2.4 gruplar | Eğitim geçmişinden sıfır gün oranı ve pozitif günlerde CV hesaplanır. Gruplar: `steady`, `variable`, `intermittent`, `sparse` (< 56 gözlem; her zaman a₀). Eşikler iç doğrulamada seçilir ve dondurulur. | `groups` |
| 2.4 birleşim (Denk. 2–4) | Kapalı çözüm, [0,1]'e izdüşüm. λ = 0 ve Σd² = 0 ya da N_g = 0 ise a₀ kullanılır. a₀ tüm ürünlerin λ = 0 çözümüdür. | `combine.closed_form_weight`, `combine.fit_weights` |
| 2.4 güncelleme ve sürüm | λ ve a₀ yalnızca iç doğrulamada belirlenir ve sabit kalır; her dış başlangıçta yalnızca grup ağırlıkları a_g, ufku bitmiş tahminlerle yeniden hesaplanır. λ, a₀, eşikler, pencereler ve grup atamaları başlangıç başına kaydedilir. | `backtest.run_backtest` → `per_origin[].version` |
| 2.4 bileşen çıkarma | (i) ortak a₀, (ii) grup λ = 0, (iii) grup + λ bir kez, (iv) grup ağırlıkları her başlangıçta güncellenir, λ ve a₀ sabit (= önerilen); ayrıca X ve S. | `config.METHODS` |
| 2.5 değerlendirme (Denk. 5) | Rastgele bölme yoktur. İlk 24 ay iç alan, son 12 ay dış test (ay sonu başlangıçlar, ≥ 6). Ürün bazında MAE; birimi aynı gruplarda WAPE (Σy = 0 ise `null`); pilot kümede aylık WAPE; başlangıçlar arası min/maks/std; blok bootstrap aralığı (üçü de aynı başlangıç kümesinde). MAPE yoktur. | `backtest`, `metrics` |
| 2.6 stok (Denk. 6) | S = D(L+R) + SS; SS, aynı pencerede yalnızca eksik tahmin hatalarının (gerçekleşen − tahmin > 0) yüzdeliğidir. S yuvarlanmaz; yalnızca sipariş ⌈max(0, S − IP)⌉ paket olarak bir kez yuvarlanır. Varsayımlı politika simülasyonu yapılır. | `stock` |
| İP5 sözleşme | `tahmin.json` ve JSON Schema. | `output`, `schema/tahmin.schema.json` |

## Yöntemdeki uygulama kararları

Öneri metni bu noktaları açık bırakıyordu. Seçilen yol ve gerekçesi aşağıdadır.

- **Başlangıç (origin)** son gözlenen gündür. Tahmin ertesi gün başlar.
  - Haftalık ufuk sonraki 7 gündür.
  - Aylık ufuk "gelecek takvim ayı"dır. Örnek: başlangıç 26 Ekim ise ufuk 1–30 Kasım'dır.
    Aradaki günler yinelemede tahmin edilir ama toplama girmez.
  - Değerlendirme başlangıçları ay sonlarıdır. Haftalık test başlangıçları aylık
    başlangıçlarla aynıdır.
- **Eksik ve kapalı günler** geçmişte bilinmeyen (`NaN`) değer olarak tutulur. Gecikme
  özelliği bu günlerde `NaN` olur; XGBoost bunu kendisi işler.
  - Hareketli ortalama, penceredeki *bilinen* günlerin ortalamasıdır. Takvim eksiksizse
    Denklem 1'in kendisidir.
  - Değerlendirmede ufuk içindeki eksik günler hem gerçekleşen hem tahmin toplamından
    çıkarılır.
  - Gelecekteki kapalı günlerin tahmini 0'dır.
- **Ölçek.** Denklem 3–4 varsayılan olarak ürün ölçeğine bölünmüş değerlere uygulanır
  (`scale="product_mean"`). Ürün ölçeği, ürünün başlangıca kadarki ortalama günlük satışı
  ile değerlendirilen gün sayısının çarpımıdır. Böylece çok satan ürünler kareli kaybı tek
  başına belirlemez ve λ her grupta aynı anlamı taşır. `scale="none"`, denklemi ham
  miktarlara birebir uygular.
- **Grup eşikleri.** Sıfır gün oranı adayları {0,3; 0,5}'tir. CV kesim noktası adayları,
  iç alandaki CV dağılımının %33, %50 ve %67'lik değerleridir. λ adayları
  {0; 0,01; 0,03; 0,1; 0,3; 1}'dir. Seçim, iç başlangıçlarda (iv) kuralı ilerletilerek ve
  pilot ürünlerin haftalık ile aylık WAPE toplamı en küçük olacak biçimde yapılır.
  Eşitlikte büyük λ seçilir. Pilot gerçekleşen toplamı 0 olan ufkun WAPE'si tanımsızdır ve
  toplama 0 olarak değil hiç girmez; hiçbir ufku geçerli olmayan aday seçilemez (hiçbir aday
  geçerli değilse ilk aday ve en büyük λ kullanılır ve uyarı yazılır).
- **a₀ ve (iv).** Öneri 2.4'e göre λ ve referans ağırlığı a₀ yalnızca iç doğrulamada
  belirlenir: a₀, iç alandaki tüm doğrulama kayıtlarının λ = 0 çözümüdür ve dış testte ve son
  tahminde sabit kalır (`method.update_rule`). (iv) her dış başlangıçta yalnızca grup
  ağırlıklarını a_g günceller. (i), (ii) ve (iii) iç alanda bir kez hesaplanıp sabit kalır.
  İç seçim sırasında (iv) ilerletilirken a₀ o iç başlangıçta ufku bitmiş kayıtlardan
  hesaplanır; bu hâlâ iç doğrulamanın içindedir. λ = 0 çözümü tanımsızsa a₀ = 0,5 alınır.
- **Birim ve kapalı gün çıkarımı (sızıntı koruması).** `tahmin` ve `degerlendir`, birimi
  (kesirli miktar → kg) ve otomatik kapalı hafta günlerini yalnızca dış test alanının ilk
  gününden (`quality.internal_cutoff`, planla aynı kural) önceki satırlardan çıkarır. Böylece
  test dönemindeki tek bir kesirli satış ya da kapanış pilot kümeyi veya değerlendirme
  düzenini değiştiremez. İlk satışı test alanında olan ürünler (pilot adayı değildir)
  birimini kendi tüm satırlarından alır. Tüm geçmişten çıkan birim farklıysa ürün
  `quality.units_changed_in_test_area` listesine girer, uyarı verilir ve son tahminde
  (`products[].unit`, paket büyüklüğü) tüm geçmişten çıkan birim kullanılır. Beyan edilmiş
  `birim` sütunu her zaman önceliklidir.
- **Pilot küme boş olamaz.** İç alanda satışı olan adet birimli ürün yoksa (ör. tüm ürünler
  kesirli) ya da `--pilot` barkodlarının hiçbiri veride yoksa komut Türkçe bir hatayla durur;
  `--pilot` ile barkod verin ya da `birim` sütununa `adet` yazın.
- **Pilot WAPE, dağılım ve bootstrap aynı başlangıç kümesinde.** Pilot ürünlerin gerçekleşen
  toplamı 0 olan başlangıcın WAPE'si tanımsızdır; bu başlangıç havuzlanmış pilot WAPE'ye,
  başlangıçlar arası min/maks/std değerine ve blok bootstrap'a girmez (`n_origins` geçerli,
  `n_origins_zero_actual` dışarıda kalan başlangıç sayısıdır; uyarı yazılır). Ürün bazında MAE
  bütün başlangıçları kullanır. Bir ufukta hiç geçerli başlangıç yoksa uyarı verilir.
- **En az veri uzunluğu.** Plan; `--en-az-egitim-ay` (varsayılan 12) aylık ilk eğitimden
  sonra 2 iç başlangıç (bu ayın ve sonraki ayın sonu) ve dış testte en az 1 başlangıç ister.
  İç başlangıcın aylık ufku dış test alanı başlamadan bitmelidir; dış test alanı veri 30 aydan
  kısaysa son ⌊n/3⌋ takvim ayıdır. Sonuç: verinin dokunduğu takvim ayı sayısı n (yarım ilk ve
  son ay dahil) ayın 1'inde başlayan veride en az 20, ayın 2'si veya sonrasında başlayan
  veride en az 22 olmalıdır (`backtest.min_months_required`; 20 ayda dış test 6 başlangıçtır).
  Önerideki düzen (24 ay iç alan + 12 ay dış test) 36 ay gerektirir. Daha kısa veride hata
  mesajı bu kuralı ve `--en-az-egitim-ay` seçeneğini gösterir.
- **Gruplar** her yeniden eğitimde o ana kadarki veriyle yeniden atanır. Doğrulama
  gözlemi, tahminin yapıldığı andaki grubuyla etiketlenir.
- **Emniyet stoku.** e = gerçekleşen − tahmin, L+R günlük pencerede, ufku bitmiş
  başlangıçlardan alınır. Öneri 2.6'ya göre yalnızca eksik tahmin hataları (e > 0) kullanılır:
  SS = Q_q({e : e > 0}); fazla tahminler yüzdeliğe girmez.
  - En az 4 hatası olup hiçbiri pozitif olmayan üründe SS = 0'dır.
  - 4'ten az pozitif hatası olan (ya da 4'ten az hatası olan) üründe aynı birimdeki ürünlerin
    ölçeklenmiş pozitif hataları havuzlanır ve ürünün kendi ölçeğiyle çarpılır (`ss_pooled`
    bayrağı).
  - Başlangıç sayısı azdır (simülasyonda yalnızca iç başlangıçlar, ~4–6): bu kadar az
    gözlemde 0,9 yüzdeliği pratikte görülen en büyük eksik tahmine yakındır.
  - L+R ≤ 14 gün ise günlük birleşimde haftalık ağırlık, değilse aylık ağırlık kullanılır.
  - İç başlangıçlarda (iii) ağırlıkları kullanıldığı için bu hatalar ağırlık açısından
    örneklem içidir. Bir grup için tek parametre olduğundan etkisi sınırlıdır.
- **XGBoost araması** son 3 iç başlangıçta yapılır (`--hizli`: 2 başlangıç ve 2 aday).
  `n_jobs = 2`, `random_state = 7`.

## Çıktı sözleşmesi (`tahmin.json`)

Şema: [`schema/tahmin.schema.json`](schema/tahmin.schema.json) (JSON Schema 2020-12).
`tahmin` komutu dosyayı yazmadan önce çıktıyı bu şemayla doğrular; testler hem yerleşik
doğrulayıcıyı hem de `jsonschema` paketini kullanır.

Ana alanlar:

- `origin`: son gözlenen gün.
- `data_range`: kayıtlı ve eksik gün sayısı.
- `method`: λ, a₀, eşikler, grup ağırlıkları, XGBoost ayarları, seçim tabloları ve sabit
  ablasyon ağırlıkları.
- `horizons`: haftalık ve aylık tarih aralıkları.
- `products[]`: her ürün için tahminler (`combined`, `xgboost`, `seasonal_naive`, `weight`;
  haftalık için 7 günlük `daily`), ürün bazında geriye dönük test sonucu, stok bloğu ve
  bayraklar.
- `evaluation`: dış test başlangıçları, pilot ürünler, özet (pilot WAPE, MAE ortalaması,
  dağılım, birim ve grup kırılımları, bootstrap aralığı), başlangıç başına sonuçlar ve
  sürüm bilgisi, stok simülasyonu.
- `quality`: veri kalite raporu.
- `warnings`: Türkçe uyarılar.

Kurallar:

- Sayılar ondalıklıdır; tanımsız değer `null` olur. Örneğin Σy = 0 olduğunda WAPE `null`'dır.
- `stock.order_up_to` = `demand_over_lead_and_review` + `safety_stock`'tur ve paket katına
  **yuvarlanmaz**. Paket yuvarlaması yalnızca bir kez, son siparişte yapılır.
- `stock.on_hand` ve `stock.suggested_order` her zaman `null` gelir. Python katmanı mevcut
  stoğu bilmez; uygulama IP = eldeki + yoldaki − ayrılmış değerini hesaplayıp siparişi
  ⌈max(0, order_up_to − IP)⌉ `pack_size` katı olarak bulur. Aynı hesap
  `stock.compute_order` işlevinde vardır.
- `method.a0` dış testte ve son tahminde sabit olan referans ağırlığıdır;
  `method.update_rule` hangi parametrenin nerede belirlendiğini yazar.
- `quality.closed_weekdays` değerleri 0 = Pazartesi … 6 = Pazar biçimindedir.

Bayraklar:

| Bayrak | Anlamı |
|---|---|
| `new_product` | 56'dan az gözlem var. |
| `fallback_a0` | Grup ağırlığı yerine a₀ kullanıldı. |
| `inactive` | Son 56 gündür satış yok. |
| `ss_pooled` | Emniyet stoku havuzlanmış hatalardan hesaplandı. |
| `not_in_backtest` | Ürün dış testte yoktu. |

`degerlendir` komutu aynı `method`, `evaluation` ve `quality` bloklarını, ayrıca
kullanılan tüm ayarları (`config`) yazar.

## Sentetik veri ve örnek dosyalar

`dukkan_tahmin.synthetic` tohumla kontrol edilen yaklaşık 36 aylık veri üretir. Ürünlerin
satış örüntüleri birbirinden farklıdır:

- her gün düzenli satılan,
- hafta sonu artan,
- aşırı dağılımlı (değişken),
- seyrek satılan,
- artan ya da azalan eğilimli,
- habersiz kampanyalı,
- yıllık mevsimsel,
- bayram öncesi artan,
- kesirli kg ürünleri,
- dönem ortasında satışa giren ve satıştan kalkan.

Mağaza takvimi ve kayıt kusurları da üretilir: 1 Ocak ve bayramların ilk günü kapalı
(isteğe bağlı olarak pazar günleri de), birkaç eksik aktarım günü, HESAP satırları, iadeler
ve birkaç yinelenen ham satır. Ham rapor windows-1254 ya da UTF-8 kodlamalı ve isteğe
bağlı olarak ZIP'li yazılır; ayrıştırıcı bu dosyalarla uçtan uca sınanır.

`ornek/` klasöründeki dosyalar (toplam yaklaşık 130 KB):

- `urun_gun.csv.gz`: 20 ürün, 36 ay, tohum 7.
- `rapor.zip`: son 14 günün ham raporu.

Bu dosyaları yeniden üretmek için `sh ornek/uret.sh` komutunu çalıştırın. Bir test,
dosyaların bu komutla bayt bayt aynı üretildiğini denetler.

### Sentetik örnekte ölçülen değerler (gerçek işletme sonucu değildir)

Komut: `python -m dukkan_tahmin degerlendir --girdi ornek/urun_gun.csv.gz --cikti degerlendirme.json`.
Tam ızgarayla çalıştırıldı (a₀ iç doğrulamada sabitlenmiş, emniyet stoku yalnızca pozitif
hatalardan). Ölçüt, 11 dış test başlangıcında 19 adet ürünlük pilot kümenin WAPE (%)
değeridir; hiçbir başlangıçta pilot toplamı 0 değildir. **Sentetik veridir.**

| Yöntem | Haftalık | Aylık | Aylık min–maks |
|---|---|---|---|
| Önerilen birleşim (iv) | 11,43 | 6,98 | 4,0–10,2 |
| Yalın XGBoost (X) | 11,41 | 6,97 | 4,0–10,1 |
| Mevsimsel saf (S) | 13,94 | 11,72 | 8,8–20,5 |
| (i) ortak a₀ | 11,41 | 6,97 | 4,0–10,1 |
| (ii) grup, λ = 0 | 11,43 | 7,04 | 3,9–11,0 |
| (iii) grup, λ, sabit | 11,41 | 7,01 | 3,9–10,6 |

Seçilen λ = 0,03. XGBoost'a göre göreli fark haftalıkta −0,24, aylıkta −0,20'dir. Aylık WAPE
farkı (iv − X) 0,01 puan, blok bootstrap %95 aralığı [−0,01; 0,05] puandır.

Bu sentetik veride XGBoost mevsimsel saf tahminden açıkça iyidir. Bu nedenle a₀ 1 çıkar
(haftalık 1,00, aylık 1,00) ve birleşim XGBoost'tan ayırt edilemez. Bu bir ölçümdür;
yöntem hakkında genel bir yargı değildir. Gerçek veride sonuç farklı olabilir ve önerinin
%5 göreli iyileşme hedefi burada **sağlanmamıştır**.

## Testler

```sh
cd model && python -m pytest tests -q
```

Testlerin denetledikleri:

| Test dosyası | Denetlenen |
|---|---|
| `test_parser.py` | Ham raporun windows-1254, UTF-8 ve ZIP biçimlerinden okunup üreticinin ürün-gün değerleriyle birebir eşleşmesi. HESAP, iade, yinelenen sayımları; geçersiz satırda durma ve `--devam`; baştaki sıfırlar; kişisel verinin çıktıya girmemesi; başlıktan sütun bulma (ASCII/küçük harf başlık, TOPLAM/TUTAR önceliği); sayı kuralları (`0.75`, `95.12`, `1.234,50` ve reddedilen biçimler); hücre sayısı farklı satırlar; ZIP'te macOS ek dosyaları; eksik ve kapalı günler; birim çıkarımı; ayırıcı algılama. |
| `test_parser_parity.py` | `sales-worker.js` Node'da çalıştırılır (`tests/tools/run_worker.mjs`); repodaki örnek rapor ve zorlayıcı küçük raporlarda satır, HESAP, iade, yinelenen ve geçersiz sayıları, sütun eşleştirmesi, gün toplamları, gün ve ürün miktarları Python ile birebir karşılaştırılır. Geçersiz tarihte ikisi de durur. `node` yoksa atlanır. |
| `test_features_no_leakage.py` | Başlangıçtan sonraki değerler rastgele değiştirildiğinde özelliklerin, eğitim satırlarının, grup istatistiklerinin, mevsimsel saf tahminin ve yinelemeli XGBoost tahmininin **bit bit aynı** kalması. Gecikmeler ve hareketli ortalamanın Denklem 1 ile eşitliği. |
| `test_combine_closed_form.py` | Denklem 4'ün, [0,1] üzerinde 100 001 noktalı ızgara aramasıyla bulunan minimumla eşleşmesi (100 rastgele durum). İkinci türevin (2/N)Σd² + 2λ olması. İzdüşüm sınırları, a₀'a dönüş durumları, büyük λ'da a₀'a büzülme, ölçek değişmezliği. |
| `test_backtest_split.py` | Zaman sıralı bölme. Takvim ayı ve 30 günlük ufuklar. Ham satırlar temizlemeden önce test döneminde değiştirildiğinde (kesirli satış, kapanış, sıfırlama, ×50) pilot kümenin, birimlerin ve kapalı günlerin değişmemesi. Boş pilot kümede hata. a₀ ve λ'nın dış testte sabit kalması; (iv) güncellemesinin yalnızca ufku bitmiş sonuçları kullanması. Tanımsız WAPE'nin seçimde atlanması. Pilot WAPE ile dağılımın aynı başlangıç kümesini kullanması. En az veri uzunluğu kuralı. Metrik tanımları ve bootstrap. |
| `test_stock.py` | Tek paket yuvarlaması (yuvarlanmamış S, yuvarlanan sipariş) ve IP hesabı; SS'nin yalnızca pozitif hatalardan alınması ve havuzlama; stok bloğu. Simülasyonda bütün yöntemlere aynı kuralın uygulanması ve hizmet düzeyiyle tutarlı (monoton) davranış. |
| `test_schema.py`, `test_end_to_end.py` | Şemaya uygunluk. Dört CLI komutunun uçtan uca çalışması; beklenmeyen hatada tek satırlık Türkçe mesaj (`--ayrintili` ile hata izi); kısa veri ve geçersiz rapor mesajları. Aynı tohumla aynı çıktı. Örnek dosyanın yeniden üretilebilirliği. |

## Varsayımlar ve sınırlılıklar

- **Gözlenen satış ≠ talep.** Stok tükenmesi kaydı yoktur. Model ve simülasyon gözlenen
  satışı hedef alır; kayıp talep ölçülmez.
- **Tek işletme.** Sonuçlar başka işletmelere genellenemez.
- **Yıllık ufuk üretilmez.** Üç yıllık veride bağımsız yıllık sınama sayısı çok azdır;
  yıllık ufuk ancak keşifsel olarak ele alınabilir.
- **Bayram tarihleri** (2023–2027) `calendar_tr.py` içine elle girilmiştir ve resmî Diyanet
  takvimiyle doğrulanmalıdır. Tabloda olmayan yıllar için uyarı verilir.
- **Kampanya ve gelecek fiyat bilgisi** kullanılmaz; tahmin anında bilinmez.
- **"HESAP" kalemi** ürüne eşlenemediği için miktar serisine girmez; tutarı yalnızca kalite
  raporunda izlenir.
- **Kapalı günler** belirtilmezse yalnızca sürekli kapalı hafta günleri otomatik algılanır;
  algılama dış test alanından önceki günlere bakar, test döneminde başlayan bir kapanış
  `--kapali-gunler` ile verilmelidir. Tatil kapanışları eksik gün olarak listelenir;
  `--kapali-tarihler` ile ayrılabilir.
- **Kanonik CSV'de geçersiz satırlar** (okunamayan tarih ya da miktar) ham rapordan farklı
  olarak aktarımı durdurmaz; sayılır, uyarı verilir ve dışarıda bırakılır.
- **Stok simülasyonu bir senaryodur**:
  - Tedarik süresi sabit kabul edilir; bozulma, kapasite ve minimum sipariş modellenmez.
  - Karşılanamayan miktar kaybolur, sonraya ertelenmez.
  - Kayıt olmayan günlerde satış sıfır sayılır.
  - Gerçek stok geçmişi olmadığından kayıp satış ya da kâr iddiası üretmez; alış maliyeti
    olmadığından kârlılık hesaplanmaz.
- **XGBoost** tek bir tohumla ve iki iş parçacığıyla deterministik çalışır. Farklı donanım
  ya da kütüphane sürümünde küçük sayısal farklar olabilir.
- **Paket yalnızca ölçer.** Önerilen modülün yalın XGBoost'tan iyi olduğunu iddia etmez.
  Göreli iyileşme raporlanır ama başarı ölçütü olarak yorumlanmamalıdır.
