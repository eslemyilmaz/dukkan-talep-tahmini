/* Day-end page: register records (default) or the imported historical report, never summed together. */
"use strict";

let endSort = "quantity",
  daySource = "register",
  registerDate = todayTR();
function setEndSort(v) {
  endSort = v;
  render();
}
function setDaySource(v) {
  daySource = v;
  show();
}
function setRegisterDate(v) {
  if (!v) return;
  registerDate = v;
  show();
}
function openRegisterDayEnd() {
  daySource = "register";
  navigate("dayEnd");
}

// ---------- Imported report / sample day ----------
const exampleDayItems = [
  { name: "Ekmek", category: "Ekmek & unlu mamuller", q: 100, total: 1500 },
  { name: "Çay · 500 g", category: "İçecekler", q: 60, total: 7800 },
  { name: "Süt · 1 L", category: "Süt & süt ürünleri", q: 50, total: 2250 },
  { name: "Ayçiçek yağı · 1 L", category: "Temel gıda", q: 40, total: 3400 },
  { name: "Yumurta · 30’lu", category: "Temel gıda", q: 30, total: 4500 },
  { name: "Diğer ürünler", category: "Diğer ürünler", q: 6, total: 13000 },
];
function dayItems() {
  if (!salesData) return exampleDayItems.map((p) => ({ ...p }));
  let day = salesData.days[salesDate];
  return Object.entries(day.items).map(([barcode, it]) => ({
    ...salesData.products[barcode],
    barcode,
    q: it.q,
    total: it.total,
  }));
}
function rankedItems(sort = endSort) {
  return dayItems().sort(
    (a, b) => (sort === "revenue" ? b.total - a.total : b.q - a.q) || a.name.localeCompare(b.name, "tr"),
  );
}
function topSellers(compact = false) {
  let rows = rankedItems().slice(0, compact ? 5 : 10),
    all = dayItems(),
    revenue = all.reduce((s, p) => s + p.total, 0),
    mode = salesData ? "Gerçek satış" : "Örnek veri",
    date = salesData ? esc(ds(salesDate)) : "Örnek gün";
  return `<section class="card panel endOfDay"><div class="paneltop"><div><div class="eyebrow">Gün sonu raporu</div><h2>En çok satılan ürünler</h2><p class="muted">${date} · İlk ${Math.min(all.length, compact ? 5 : 10)} ürün · ${mode}</p></div><div class="endToolbar">${compact ? '<button class="softLink" onclick="navigate(\'dayEnd\')">Gün sonunu aç →</button>' : `<label>Sıralama<select aria-label="En çok satılanları sırala" onchange="setEndSort(this.value)"><option value="quantity" ${endSort === "quantity" ? "selected" : ""}>Satılan miktara göre</option><option value="revenue" ${endSort === "revenue" ? "selected" : ""}>Satış tutarına göre</option></select></label>`}</div></div><div class="tablewrap" tabindex="0" aria-label="En çok satılan ürünler tablosu"><table class="endTable"><thead><tr><th style="width:40px">Sıra</th><th>Ürün</th><th class="numeric">Satılan miktar</th><th class="numeric">Satış tutarı</th><th class="numeric">Ürün gelir payı</th></tr></thead><tbody>${
    rows.length
      ? rows
          .map((p, i) => {
            let share = revenue ? (p.total / revenue) * 100 : 0;
            return `<tr><td><span class="rank ${i === 0 ? "first" : ""}">${String(i + 1).padStart(2, "0")}</span></td><td>${productLabel(p)}</td><td class="numeric">${fmt(p.q)}</td><td class="numeric amountStrong">${money(p.total)}</td><td class="numeric"><div class="share"><span class="shareTrack"><span class="shareFill" style="display:block;width:${Math.min(100, share)}%"></span></span><span>%${new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(share)}</span></div></td></tr>`;
          })
          .join("")
      : '<tr><td colspan="5" class="empty">Bu gün için uygun ürün satışı bulunamadı.</td></tr>'
  }</tbody></table></div><div class="tableFoot"><span>${salesData ? "Hesap kayıtları ve negatif işlemler ürün sıralamasına alınmaz." : "Örnek ürünlerdir. Gerçek sıralama için satış raporunuzu yükleyin."}</span><span>Gelir payı: listedeki tüm uygun ürünlerin toplamına göre.</span></div><p class="dayEndNote">Miktarlar ürünün rapor birimindedir. Adet ve kilogram gibi farklı birimler varsa miktar sıralaması doğrudan karşılaştırılamaz; satış tutarına göre sıralamayı kullanabilirsiniz.</p></section>`;
}
function importedDayEnd() {
  let items = rankedItems("quantity"),
    revenue = dayItems().reduce((s, p) => s + p.total, 0),
    d = salesData ? salesData.days[salesDate] : null;
  return (
    title(
      "Gün sonu",
      "İşletmenizin günlük performansı, tek bir bakışta.",
      `<button onclick="navigate('reports')">↓ Satış raporu yükle</button>`,
    ) +
    `<div class="reportBanner">${ico("report")}<span>${salesData ? "Yüklenen rapordan hesaplandı. Bu bir geçmiş gün özetidir; canlı kasa bağlantısı yok." : "Örnek gün sonu raporu. Gerçek verilerinizi yüklediğinizde tablo otomatik güncellenir."}</span></div>${
      salesData
        ? `<label class="field" style="max-width:260px">Rapor günü<select aria-label="Gün sonu rapor tarihi" onchange="setSalesDate(this.value)">${Object.keys(
            salesData.days,
          )
            .sort()
            .reverse()
            .map(
              (dt) =>
                `<option value="${esc(dt)}" ${dt === salesDate ? "selected" : ""}>${esc(ds(dt))}</option>`,
            )
            .join("")}</select></label>`
        : ""
    }<div class="endSummary"><div class="card"><p class="muted">${salesData ? "Seçilen günün" : "Örnek günün"} cirosu</p><div class="value">${money(d ? d.total : 32450)}</div><span class="muted">${d ? "TOPLAM alanı · Hesap ve negatif işlemler dahil" : "Örnek satış tutarı"}</span></div><div class="card"><p class="muted">Satılan ürün çeşidi</p><div class="value">${fmt(items.length)}</div><span class="muted">Pozitif satış içeren ${salesData ? "barkodlar" : "ürün / ürün grupları"}</span></div><div class="card"><p class="muted">Ürün sıralamasındaki satış tutarı</p><div class="value">${money(revenue)}</div><span class="muted">Hesap ve negatif işlemler hariç</span></div></div>${topSellers()}<div class="insight"><strong>Asistanla paylaşım</strong><p class="muted">Bu özet, otomasyon bağlandığında gün sonu mesajına eklenebilir. Şu anda otomatik gönderim yok.</p><button class="link" onclick="navigate('assistant')">Bildirim tercihlerini aç →</button></div>`
  );
}

// ---------- Register records ----------
function localDayTable(items) {
  let rows = [...items].sort(
      (a, b) => (endSort === "revenue" ? b.total - a.total : b.q - a.q) || a.name.localeCompare(b.name, "tr"),
    ),
    total = items.reduce((s, p) => s + p.total, 0);
  return `<section class="card panel"><div class="paneltop"><div><div class="eyebrow">Kasa kayıtları</div><h2>En çok satılan ürünler</h2></div><select aria-label="Yerel ürün sıralaması" onchange="setEndSort(this.value)"><option value="quantity" ${endSort === "quantity" ? "selected" : ""}>Miktara göre</option><option value="revenue" ${endSort === "revenue" ? "selected" : ""}>Tutara göre</option></select></div><div class="tablewrap"><table><thead><tr><th>Sıra</th><th>Ürün</th><th>Satılan adet</th><th>Tutar</th><th>Gelir payı</th></tr></thead><tbody>${
    rows.length
      ? rows
          .slice(0, 20)
          .map(
            (p, i) =>
              `<tr><td><span class="rank ${i ? "" : "first"}">${i + 1}</span></td><td>${productLabel(p)}</td><td>${p.q}</td><td>${moneyKurus(p.total)}</td><td>%${total ? ((p.total / total) * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 }) : "0"}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="empty">Bu tarihte kaydedilmiş satış yok.</td></tr>'
  }</tbody></table></div><p class="dayEndNote">İşletme içi kullanım ve borç tahsilatları satış sıralamasına dahil değildir.</p></section>`;
}
function registerDayEnd() {
  let d = registerDaily(registerDate);
  return (
    title(
      "Gün sonu",
      "Satışlar, işletme içi kullanım ve tahsilatlar ayrı ayrı.",
      `<button onclick="showHistory()">Son işlemler</button>`,
    ) +
    daySourceToggle() +
    `<label class="field" style="max-width:230px">Gün · Türkiye saati<input type="date" aria-label="Kasa rapor günü" value="${registerDate}" onchange="setRegisterDate(this.value)"></label><div class="registerSummary">${[
      ["Satış cirosu", moneyKurus(d.revenue), "Nakit + kart + yeni veresiye"],
      ["Yeni veresiye", moneyKurus(d.credit), "Seçilen günün borçlu satışları"],
      ["Borç tahsilatı", moneyKurus(d.collected), "Ciroya ikinci kez eklenmez"],
      ["İşletme içi kullanım", d.internalQty + " adet", "Satış sıralamasına dahil değil"],
    ]
      .map(
        ([a, b, c]) =>
          `<div class="card"><p class="muted">${a}</p><strong>${b}</strong><span class="muted">${c}</span></div>`,
      )
      .join(
        "",
      )}</div><div class="moneyGrid" style="margin-bottom:20px"><div class="card"><p class="muted">Nakit satış</p><h2>${moneyKurus(d.cash)}</h2></div><div class="card"><p class="muted">Kart satış</p><h2>${moneyKurus(d.card)}</h2></div><div class="card"><p class="muted">İşletme içi tüketim maliyeti</p><h2>${d.internalCost === null ? "Maliyet eksik" : moneyKurus(d.internalCost)}</h2><p class="muted">Cirodan düşülmez; maliyet değerlendirmesinde ayrı izlenir.</p></div></div>${localDayTable(d.items)}<section class="card panel bottom"><div class="paneltop"><h2>Günün işlemleri</h2><span class="muted">${d.entries.length} kayıt</span></div>${d.entries.length ? [...d.entries].reverse().slice(0, 30).map(receiptDetails).join("") : '<p class="subtitle">Seçili günde işlem yok. Satış ekranından yeni kayıt oluşturabilirsiniz.</p>'}</section><p class="deviceNote">Kasa kayıtları ve yüklenen geçmiş rapor otomatik toplanmaz; aynı satışın iki kez sayılmasını önlemek için kaynaklar ayrı görüntülenir.</p>`
  );
}
function daySourceToggle() {
  return `<div class="registerSource"><button class="${daySource === "register" ? "primary" : ""}" onclick="setDaySource('register')">Kasa kayıtları</button><button class="${daySource === "import" ? "primary" : ""}" onclick="setDaySource('import')">Yüklenen geçmiş rapor</button></div>`;
}

const dayEndPage = {
  id: "dayEnd",
  label: "Gün sonu",
  icon: "report",
  // Register view: the chosen day's entries, by the "date" index (register.js).
  load: () => (daySource === "register" ? loadDays([registerDate]) : null),
  render: () => (daySource === "import" ? daySourceToggle() + importedDayEnd() : registerDayEnd()),
  badge: () => (daySource === "register" ? "Bu cihaz · yerel kayıt" : ""),
};
