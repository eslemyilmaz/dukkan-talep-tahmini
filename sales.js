let salesData = null,
  salesDate = "",
  trialProduct = "",
  salesBusy = false;
const fmt = (n) => new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 }).format(n);
const ds = (d) => d.split("-").reverse().join(".");
function salesDB() {
  return new Promise((resolve, reject) => {
    let r = indexedDB.open("dukkan-sales", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("data");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function persistSales(data) {
  let db = await salesDB();
  await new Promise((resolve, reject) => {
    let t = db.transaction("data", "readwrite");
    t.objectStore("data").put(data, "report");
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  db.close();
}
async function restoreSales() {
  try {
    let db = await salesDB();
    let data = await new Promise((resolve, reject) => {
      let r = db.transaction("data").objectStore("data").get("report");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    if (data) {
      activateSales(data);
      render();
    }
  } catch (e) {
    console.warn("Satış raporu geri yüklenemedi.");
  }
}
function activateSales(data) {
  salesData = data;
  salesDate =
    Object.keys(data.days || {})
      .sort()
      .at(-1) || "";
  let list = Object.values(data.products || {}).sort((a, b) => b.qty - a.qty);
  trialProduct =
    list.find((p) => p.name.toLocaleUpperCase("tr").includes("EKMEK"))?.barcode || list[0]?.barcode || "";
}
const originalReports = reports;
reports = function () {
  return (
    `<section class="card panel" style="margin-bottom:24px;border-top:3px solid var(--red)"><h2>Gerçek satış raporuyla deneme</h2><p class="subtitle">Gönderdiğiniz market raporu biçimi desteklenir: ZIP içindeki HTML tabanlı XLS veya doğrudan XLS. En fazla 300 MB dosya / 500 MB açılmış rapor.</p><label class="field">Satış raporu seç<input type="file" id="salesFile" accept=".zip,.xls,.html,.htm" ${salesBusy ? "disabled" : ""}></label><button id="salesImport" class="primary" onclick="loadSalesFile()" ${salesBusy ? "disabled" : ""}>${salesBusy ? "Rapor işleniyor…" : "Satış raporunu kontrol et ve yükle"}</button><p id="salesStatus" class="muted" role="status">${salesData ? `${fmt(salesData.stats.rows)} satış satırı yüklü. Yeni dosya mevcut satış raporunun yerini alır; stokları değiştirmez.` : "Dosya bu tarayıcıda işlenir. Müşteri ve personel alanları saklanmaz; sunucuya satış verisi gönderilmez."}</p><p class="muted">Satış tutarı, rapordaki TOPLAM alanından alınır. “Hesap” ve negatif satırlar ciro toplamında korunur; ürün talep serisinden çıkarılır. Kayıt olmayan günler otomatik sıfır sayılmaz.</p></section>` +
    originalReports().replace(
      "Mevcut market raporunuzun sütunlarını inceledikten sonra satış aktarımını bağlayacağız. Stok CSV aktarımı model eğitimi başlatmaz.",
      "Üstteki satış raporu alanından gerçek raporunuzu yükleyebilirsiniz. Satış aktarımı güncel stok oluşturmaz ve XGBoost eğitimi başlatmaz.",
    )
  );
};
async function loadSalesFile() {
  if (salesBusy) return;
  let f = document.getElementById("salesFile").files[0],
    status = document.getElementById("salesStatus");
  if (!f) {
    status.textContent = "Önce rapor dosyasını seçin.";
    return;
  }
  if (f.size > 300e6) {
    status.textContent = "Dosya en fazla 300 MB olabilir. ZIP olarak seçebilirsiniz.";
    return;
  }
  salesBusy = true;
  document.getElementById("salesImport").disabled = true;
  document.getElementById("salesFile").disabled = true;
  status.textContent = "Rapor okunuyor; lütfen bu sekmeyi açık tutun…";
  let worker = new Worker("sales-worker.js");
  function finish() {
    salesBusy = false;
    worker.terminate();
    if (document.getElementById("salesImport")) {
      document.getElementById("salesImport").disabled = false;
      document.getElementById("salesFile").disabled = false;
    }
  }
  worker.onerror = () => {
    finish();
    toast("Rapor okunamadı. ZIP içindeki XLS dosyasını doğrudan deneyin.");
  };
  worker.onmessage = async ({ data }) => {
    if (data.progress) {
      if (document.getElementById("salesStatus"))
        document.getElementById("salesStatus").textContent = fmt(data.progress) + " satır işlendi…";
      return;
    }
    if (data.error) {
      finish();
      if (document.getElementById("salesStatus"))
        document.getElementById("salesStatus").textContent = data.error;
      return;
    }
    try {
      await persistSales(data.result);
      activateSales(data.result);
      finish();
      navigate("Genel bakış");
      toast("Gerçek satış raporu yüklendi.");
    } catch (e) {
      finish();
      toast("Rapor saklanamadı. Tarayıcı depolama alanını kontrol edin. Eski rapor korundu.");
    }
  };
  worker.postMessage(f);
}
function actualSalesDetails() {
  let day = salesData.days[salesDate],
    items = Object.entries(day.items).sort((a, b) => b[1].total - a[1].total);
  modal(
    ds(salesDate) + " · Satış detayları",
    `<p class="muted">Pozitif miktar ve tutarlı, ürünle eşleşen satırlar. Kesirli miktarlar rapor birimindedir; tümünü “adet” olarak yorumlamayın.</p><div class="tablewrap" style="max-height:50vh;overflow:auto"><table><thead><tr><th>Ürün</th><th>Miktar</th><th>Tutar</th></tr></thead><tbody>${items.map(([b, it]) => `<tr><td>${esc(salesData.products[b].name)}</td><td>${fmt(it.q)}</td><td>${money(it.total)}</td></tr>`).join("")}</tbody></table></div><p class="muted">Hesap kayıtları ve negatif işlemler bu ürün listesinde yer almaz. Günlük ciro bu nedenle ürün tablosu toplamından farklı olabilir.</p>`,
  );
}
const exampleOpenSales = openSales;
openSales = function () {
  if (salesData) actualSalesDetails();
  else exampleOpenSales();
};
const beforeSalesOverview = overview;
overview = function () {
  let html = beforeSalesOverview();
  if (!salesData) return html;
  let dates = Object.keys(salesData.days).sort(),
    d = salesData.days[salesDate];
  return html
    .replace(
      "Bugünün özeti, öncelikleriniz ve bir sonraki adımınız.",
      "Yüklenen satış raporunuzun özeti. Tarihi seçerek geçmiş günleri inceleyin.",
    )
    .replace(
      '<div class="stats">',
      `<div class="note"><strong>Gerçek satış verisi · ${ds(dates[0])}–${ds(dates.at(-1))}</strong><label class="field">İncelenen gün<select aria-label="Satış günü" onchange="salesDate=this.value;render()">${dates.map((dt) => `<option value="${dt}" ${dt === salesDate ? "selected" : ""}>${ds(dt)}</option>`).join("")}</select></label>Güncel stok listesi henüz bağlı değil. Aşağıdaki stok kartları örnek / elle girilen stoklardır.</div><div class="stats">`,
    );
};
function realChart() {
  let dates = Object.keys(salesData.days)
      .sort()
      .filter((d) => d <= salesDate)
      .slice(-14),
    max = Math.max(...dates.map((d) => salesData.days[d].total), 1);
  let pts = dates
    .map(
      (d, i) =>
        `${45 + (i * 510) / Math.max(1, dates.length - 1)},${220 - (salesData.days[d].total / max) * 160}`,
    )
    .join(" ");
  return `<svg viewBox="0 0 600 270" class="chart" role="img" aria-label="Yüklenen rapordaki son 14 kayıtlı günün cirosu"><line x1="45" y1="225" x2="560" y2="225" stroke="#ddd"/><polyline points="${pts}" fill="none" stroke="#b72b36" stroke-width="2.5"/>${dates
    .filter((d, i) => i === 0 || i === dates.length - 1)
    .map((d, i) => `<text x="${i ? 460 : 45}" y="255" fill="#888" font-size="12">${ds(d)}</text>`)
    .join("")}<text x="45" y="25" fill="#888" font-size="12">Üst değer: ${money(max)}</text></svg>`;
}
function backtestProduct(b) {
  let pr = salesData.products[b],
    dates = Object.keys(salesData.days).sort(),
    tests = dates.slice(-56);
  if (dates.length < 112) return null;
  let fallbacks = 0;
  let outcomes = tests.map((dt) => {
    let weekday = new Date(dt + "T12:00:00Z").getUTCDay(),
      earlier = dates.filter((d) => d < dt),
      past = earlier.filter((d) => new Date(d + "T12:00:00Z").getUTCDay() === weekday).slice(-8),
      fallback = !past.length;
    // No earlier same-weekday day: mean of the last 8 recorded days of any weekday, else 0.
    if (fallback) {
      past = earlier.slice(-8);
      fallbacks++;
    }
    let pred = past.length ? past.reduce((s, d) => s + (pr.daily[d] || 0), 0) / past.length : 0,
      prev = new Date(dt + "T12:00:00Z");
    prev.setUTCDate(prev.getUTCDate() - 7);
    let prevKey = prev.toISOString().slice(0, 10),
      last = Object.hasOwn(salesData.days, prevKey) ? pr.daily[prevKey] || 0 : null;
    return { date: dt, actual: pr.daily[dt] || 0, pred, last, fallback };
  });
  let err = outcomes.reduce((s, r) => s + Math.abs(r.actual - r.pred), 0),
    total = outcomes.reduce((s, r) => s + r.actual, 0),
    paired = outcomes.filter((r) => r.last !== null),
    weekdayMAE = paired.length
      ? paired.reduce((s, r) => s + Math.abs(r.actual - r.pred), 0) / paired.length
      : null,
    lastMAE = paired.length
      ? paired.reduce((s, r) => s + Math.abs(r.actual - r.last), 0) / paired.length
      : null;
  return {
    outcomes,
    mae: err / outcomes.length,
    wape: total ? (err / total) * 100 : null,
    lastMAE,
    weekdayMAE,
    paired: paired.length,
    total,
    fallbacks,
  };
}
const beforeRealForecastTable = forecastTable;
forecastTable = function () {
  if (!salesData) beforeRealForecastTable();
};
const beforeRealForecast = forecasts;
forecasts = function () {
  if (!salesData) return beforeRealForecast();
  if (!Object.keys(salesData.products).length)
    return (
      title("Gerçek veriyle tahmin denemesi", "Geçmişi tahmin edin, sonucu gerçek satışla karşılaştırın.") +
      `<div class="note">Raporda ürün bazlı pozitif satış satırı yok; tüm satırlar Hesap kaydı, negatif işlem veya barkodsuz. Tahmin denemesi için ürün satırları içeren bir rapor yükleyin.</div>`
    );
  let options = Object.values(salesData.products).sort((a, b) => a.name.localeCompare(b.name, "tr"));
  return (
    title("Gerçek veriyle tahmin denemesi", "Geçmişi tahmin edin, sonucu gerçek satışla karşılaştırın.") +
    `<div class="note">Bu ilk denemede XGBoost çalışmıyor. Karşılaştırma yöntemi: aynı haftanın gününe ait son 8 kayıtlı günün ortalaması. Tahmin edilen günün ve sonrasının satışları o tahminde kullanılmaz.</div><section class="card panel"><label class="field">Ürün<select aria-label="Test edilecek ürün" onchange="trialProduct=this.value;renderTrial()">${options.map((p) => `<option value="${esc(p.barcode)}" ${p.barcode === trialProduct ? "selected" : ""}>${esc(p.name)} · ${esc(p.barcode)}</option>`).join("")}</select></label><div id="realTrial"></div></section>`
  );
};
function renderTrial() {
  let target = document.getElementById("realTrial");
  if (!target || !salesData?.products[trialProduct]) return;
  let result = backtestProduct(trialProduct);
  if (!result) {
    target.innerHTML = "<p>Bu test için en az 112 farklı kayıtlı gün gerekiyor.</p>";
    return;
  }
  let { outcomes, mae, wape, lastMAE, weekdayMAE, paired, total, fallbacks } = result;
  target.innerHTML = `<p class="muted">Test: ${ds(outcomes[0].date)}–${ds(outcomes.at(-1).date)} · ${outcomes.length} kayıtlı gün · gerçekleşen toplam miktar: ${fmt(total)}</p><div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-top:18px"><div class="stat card"><p class="muted">Ortalama mutlak hata · MAE</p><div class="value">${fmt(mae)}</div><p class="muted">Ürünün rapor birimi / gün</p></div><div class="stat card"><p class="muted">Ağırlıklı mutlak yüzde hata</p><div class="value">${wape === null ? "—" : "%" + fmt(wape)}</div><p class="muted">${wape === null ? "Gerçekleşen toplam sıfır; tanımsız." : "WAPE · düşük olması daha iyi"}</p></div><div class="stat card"><p class="muted">Geçen haftayı tekrarla · MAE</p><div class="value">${lastMAE === null ? "—" : fmt(lastMAE)}</div><p class="muted">Ortak ${paired} gün; ortalama yönteminin MAE’si ${weekdayMAE === null ? "—" : fmt(weekdayMAE)}</p></div></div>${fallbacks ? `<p class="muted">${fallbacks} test gününde aynı haftanın gününe ait önceki kayıt yoktu; bu günlerde son 8 kayıtlı günün ortalaması (o da yoksa 0) kullanıldı.</p>` : ""}<p class="muted">Veri olmayan takvim günleri test edilmedi. Ürünün bulunmadığı kayıtlı günler bu ön denemede sıfır kabul edildi; ürünün satışta olup olmadığı ve stok tükenmeleri doğrulanmalı. Hesap ve negatif işlemler talep serisinden çıkarıldı; benzer satırlar korunuyor.</p><div class="tablewrap" style="max-height:360px;overflow:auto;margin-top:18px"><table><thead><tr><th>Tarih</th><th>Gerçek</th><th>Ortalama tahmini</th><th>Mutlak hata</th><th>Geçen hafta</th></tr></thead><tbody>${outcomes.map((r) => `<tr><td>${ds(r.date)}</td><td>${fmt(r.actual)}</td><td>${fmt(r.pred)}</td><td>${fmt(Math.abs(r.actual - r.pred))}</td><td>${r.last === null ? "—" : fmt(r.last)}</td></tr>`).join("")}</tbody></table></div><p class="muted">Bu sonuçlar gelecek tahmin başarısı garantisi veya doğruluk yüzdesi değildir. İleri tarihli tahminler ve eğitilmiş ML modeli henüz bağlı değil.</p>`;
}
const beforeRealRender = render;
render = function () {
  beforeRealRender();
  if (!salesData) return;
  document.querySelector(".demo").textContent = "Gerçek satış · stok ayrı";
  if (page === "Genel bakış") {
    let d = salesData.days[salesDate],
      cards = document.querySelectorAll(".stats .stat");
    cards[0].querySelector(".stathead").textContent = "Seçilen günün cirosu";
    cards[0].querySelector(".value").textContent = money(d.total);
    cards[0].querySelector(".trend").textContent = ds(salesDate) + " · TOPLAM alanı";
    cards[1].querySelector(".stathead").textContent = "Satılan miktar";
    cards[1].querySelector(".value").textContent = fmt(d.qty);
    cards[1].querySelector(".trend").textContent = "Hesap / negatif işlemler hariç · karışık birim";
    cards[2].querySelector(".stathead").textContent = "Rapordaki ürün";
    cards[2].querySelector(".value").textContent = fmt(Object.keys(salesData.products).length);
    cards[2].querySelector(".trend").textContent = "Talep serisine alınan barkodlar";
    cards[3].querySelector(".stathead").textContent = "Kritik stok · ayrı liste";
    cards[3].querySelector(".trend").textContent = "Satış raporundan hesaplanmadı";
    let chart = document.querySelector(".chart");
    chart.outerHTML = realChart();
    let panel = document.querySelector(".grid .panel");
    panel.querySelector(".paneltop").innerHTML =
      '<h2>Satışların seyri</h2><span class="muted">Son 14 kayıtlı gün</span>';
    panel.querySelector(".legend").textContent = "Gerçek günlük ciro · TL";
    panel.querySelector(".insight").textContent =
      `${fmt(salesData.stats.rows)} satır · ${salesData.stats.hesap} Hesap kaydı · ${salesData.stats.negative} negatif satır · ${salesData.stats.duplicate} birebir benzer satır (korundu)`;
    let agent = document.querySelector(".assistant");
    agent.innerHTML =
      '<div class="paneltop"><h2>Veri kontrolü</h2><span class="agentBadge">Ön deneme</span></div><p>Gerçek satış raporu yüklü. Güncel stok verisi ve otomatik bildirim servisi henüz bağlı değil.</p><div class="insight"><h3>Ekmek tahminini test edin</h3><p>Son 56 kayıtlı gündeki tahminleri gerçekleşen satışlarla karşılaştırabilirsiniz.</p><button class="primary" onclick="navigate(\'Tahminler\')">Tahmin denemesini aç</button></div>';
    document.querySelector(".bottom h2").textContent = "Stok listesi · örnek / elle girilen";
    document.querySelector(".bottom .muted").textContent =
      "Geçmiş satış raporu güncel stok miktarını vermez.";
  }
  if (page === "Tahminler") renderTrial();
};
restoreSales();
