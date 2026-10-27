/* Overview page: one layout, two data sources. Without an imported report the cards and chart come
   from the register (registerOverviewParts, register.js); with one, from the report
   (reportOverviewParts, sales-report.js). */
"use strict";

// Cards 1 and 3 open details; the others are plain.
const statActions = [
  null,
  ["openSalesDetails", "Satış detaylarını göster"],
  null,
  ["openCritical", "Kritik ürünleri göster"],
];
function statCard(s, i) {
  let action = statActions[i],
    danger = s.danger ? " danger" : "";
  let attrs = action
    ? ` role="button" tabindex="0" aria-label="${action[1]}" style="cursor:pointer" onclick="${action[0]}()" onkeydown="statKey(event,${action[0]})"`
    : "";
  return `<div class="card stat"${attrs}><div class="stathead">${s.head}</div><div class="value${danger}">${s.value}</div><div class="trend${danger}">${s.trend}</div>${action ? '<div class="link" style="margin-top:12px">Detayları gör →</div>' : ""}</div>`;
}
function statKey(e, fn) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
}
function openSalesDetails() {
  if (salesData) actualSalesDetails();
  else showHistory();
}
function todayRegisterCard() {
  return `<div class="card panel" style="margin-top:22px"><div class="paneltop"><div><h2>Bugünkü kasa kayıtları</h2><p class="muted">Geçmiş rapor ve örnek verilerden ayrı tutulur.</p></div><button class="softLink" onclick="openRegisterDayEnd()">Gün sonunu aç →</button></div><h2>${moneyKurus(registerDaily(todayTR()).revenue)}</h2></div>`;
}
const overviewPage = {
  id: "overview",
  label: "Genel bakış",
  icon: "overview",
  // The register parts read the last seven days (today included); one range query on the "date" index.
  load: () => loadDays(lastSevenDays()),
  render() {
    let v = salesData ? reportOverviewParts() : registerOverviewParts(),
      priority = [...products].sort((a, b) => a.stock / a.min - b.stock / b.min).slice(0, 4);
    return (
      `<div class="reportBanner" style="justify-content:space-between"><span>Yeni kasa ekranı · Barkod, veresiye ve işletme içi kullanım</span><button class="primary" onclick="navigate('sales')">Satışa başla →</button></div>` +
      title("İşletmenize genel bir bakış", v.subtitle, v.buttons) +
      v.note +
      `<div class="stats">${v.stats.map(statCard).join("")}</div><div class="grid">${v.chartPanel}${v.sidePanel}</div>` +
      todayRegisterCard() +
      `<section class="card panel bottom"><div class="paneltop"><div><h2>${v.stockTitle}</h2><p class="muted">${v.stockSubtitle}</p></div><button class="link" onclick="navigate('stock')">Tüm ürünler →</button></div>${stockTable(priority)}</section>` +
      v.after
    );
  },
};
