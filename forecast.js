/* Forecasts page. */
"use strict";

// ---------- Data source ----------
// The first available source is shown. "report": an imported sales report, shown as the backtest trial
// (sales-report.js). "demo": sample daily rate × horizon. A tahmin.json import belongs here as its own
// source, listed before "report".
const forecastSources = [
  {
    id: "report",
    available: () => Boolean(salesData),
    render: () => trialView(),
    afterRender: () => renderTrial(),
  },
  { id: "demo", available: () => true, render: () => demoForecastView(), afterRender: () => forecastTable() },
];
const forecastSource = () => forecastSources.find((s) => s.available());

// ---------- Demo view ----------
function demoForecastView() {
  return (
    title("Talep tahminleri", "Gelecekteki ihtiyacı görün, stok kararlarınızı planlayın.") +
    `<div class="note">Örnek senaryo: Bu ekranda eğitilmiş XGBoost modeli çalışmıyor. Değerler, örnek günlük satış hızının dönemle çarpımından oluşur; model başarısı olarak yorumlanamaz.</div><section class="card panel"><div class="paneltop"><h2>İhtiyaç planı</h2><select id="horizon" aria-label="Tahmin dönemi" onchange="forecastTable()"><option value="7">Haftalık · 7 gün</option><option value="30">Aylık · 30 gün</option><option value="365">Yıllık · 365 gün</option></select></div><div id="forecastTable"></div></section><div class="twocol bottom"><section class="card panel"><h2>Model bağlantısı</h2><p class="subtitle">Üç yıllık satış verisiyle zaman sırasına göre eğitim ve geçmiş dönem testi yapılacak. XGBoost ve matematiksel karar modülünün sonuçları bu ekrana bağlanacak.</p><span class="pill">Veri ve model bekleniyor</span></section><section class="card panel"><h2>Tahmin size de ulaşsın</h2><p class="subtitle">Dönemlik talep ve stok açığı özetini asistanın bildirim ön izlemesinde görebilirsiniz.</p><button class="link" onclick="navigate('assistant')">Bildirim ayarlarını aç →</button></section></div>`
  );
}
function forecastTable() {
  let days = +document.getElementById("horizon").value;
  document.getElementById("forecastTable").innerHTML =
    `<div class="tablewrap"><table><thead><tr><th>Ürün</th><th>Örnek ihtiyaç</th><th>Mevcut stok</th><th>Örnek stok açığı</th></tr></thead><tbody>${products.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.daily * days} adet</td><td>${p.stock} adet</td><td><span class="pill">${Math.max(0, p.daily * days - p.stock)} adet</span></td></tr>`).join("")}</tbody></table></div><p class="muted" style="margin-top:16px">Basit ihtiyaç hesabıdır. Teslim süresi, güvenlik stoğu ve belirsizlik henüz hesaba katılmıyor.</p>`;
}

const forecastPage = {
  id: "forecast",
  label: "Tahminler",
  icon: "forecast",
  render: () => forecastSource().render(),
  afterRender: () => forecastSource().afterRender(),
};
