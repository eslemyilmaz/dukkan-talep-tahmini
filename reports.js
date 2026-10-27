/* Reports page: sales report import (sales-report.js) and stock CSV import (stock.js). */
"use strict";

const reportsPage = {
  id: "reports",
  label: "Raporlar",
  icon: "report",
  render: () =>
    salesImportPanel() +
    title("Raporlar", "Satış verilerinizi hazırlayın, stok listenizi içeri aktarın.") +
    `<div class="twocol">${stockImportPanel()}<section class="card panel"><h2>Satış verisi ve model eğitimi</h2><p class="subtitle">Üstteki satış raporu alanından gerçek raporunuzu yükleyebilirsiniz. Satış aktarımı güncel stok oluşturmaz ve XGBoost eğitimi başlatmaz.</p><div class="note" style="margin-top:20px">Fiyat girilmeden yapılan “Hesap” satışları ayrı işaretlenecek; ürün bazlı adet ve gelir hesaplarına kontrolsüz eklenmeyecek.</div><h3>Bu sürümde</h3><p class="subtitle">Stok listesi yükleme, ürün ekleme, stok güncelleme ve CSV dışa aktarma çalışır. Veriler bu cihazın tarayıcısında tutulur.</p><button onclick="exportCSV()">↓ Mevcut stok raporunu indir</button></section></div>`,
};
