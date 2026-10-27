/* Reports page: sales report import (sales-report.js), stock CSV import (stock.js) and the tahmin.json loop. */
"use strict";

// How a tahmin.json reaches the tablet: the model runs on a computer, the file is carried over by hand.
function modelOutputCard() {
  return `<section class="card panel bottom" id="modelOutput"><div class="paneltop"><div><h2>Model çıktısı</h2><p class="subtitle">Tahmin modeli bu cihazda çalışmaz. Bilgisayardaki Python paketi (<code>model/</code>) bir <code>tahmin.json</code> dosyası üretir; uygulama bu dosyayı okur ve sipariş önerisini buradaki stokla hesaplar.</p></div><span class="agentBadge">Elle aktarım</span></div><ol class="steps"><li><strong>Satış kayıtlarını / raporu bilgisayara aktarın.</strong> <span class="muted">Market programının raporu önce <code>python -m dukkan_tahmin donustur --girdi rapor.zip --cikti urun_gun.csv</code> ile ürün-gün tablosuna çevrilir.</span></li><li><strong>Tahmini üretin:</strong> <code>python -m dukkan_tahmin tahmin --girdi urun_gun.csv --cikti tahmin.json</code></li><li><strong>Dosyayı Tahminler sayfasından yükleyin.</strong> <span class="muted">Ürünler barkodla eşleştirilir; dosya bu cihazın tarayıcısında saklanır.</span></li></ol><p class="muted">Yerel ağda çalışan bir API isteğe bağlıdır ve bu sürümde yoktur; dosya elle taşınır. Sonuçlar geriye dönük test ölçümüdür, başarı garantisi değildir.</p><button class="primary" onclick="navigate('forecast')">Tahminler sayfasına git →</button></section>`;
}

const reportsPage = {
  id: "reports",
  label: "Raporlar",
  icon: "report",
  render: () =>
    salesImportPanel() +
    title("Raporlar", "Satış verilerinizi hazırlayın, stok listenizi içeri aktarın.") +
    `<div class="twocol">${stockImportPanel()}<section class="card panel"><h2>Satış verisi ve model eğitimi</h2><p class="subtitle">Üstteki satış raporu alanından gerçek raporunuzu yükleyebilirsiniz. Satış aktarımı güncel stok oluşturmaz ve XGBoost eğitimi başlatmaz.</p><div class="note" style="margin-top:20px">Fiyat girilmeden yapılan “Hesap” satışları ayrı işaretlenecek; ürün bazlı adet ve gelir hesaplarına kontrolsüz eklenmeyecek.</div><h3>Bu sürümde</h3><p class="subtitle">Stok listesi yükleme, ürün ekleme, stok güncelleme ve CSV dışa aktarma çalışır. Veriler bu cihazın tarayıcısında tutulur.</p><button onclick="exportCSV()">↓ Mevcut stok raporunu indir</button></section></div>` +
    modelOutputCard(),
};
