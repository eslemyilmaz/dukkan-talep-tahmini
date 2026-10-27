/* Forecasts page. */
"use strict";

// ---------- Data source ----------
// The first available source is shown unless the user picked another one. "model": a tahmin.json written by
// the Python layer (model/). "report": an imported sales report, shown as the backtest trial
// (sales-report.js). "demo": sample daily rate × horizon. The source switch appears only once a tahmin.json
// is loaded; without one the page is the report trial or the demo, as before.
const forecastSources = [
  {
    id: "model",
    label: "Model çıktısı (tahmin.json)",
    available: () => Boolean(tahmin),
    render: () => tahminView(),
    afterRender: () => {},
  },
  {
    id: "report",
    label: "Satış raporu denemesi",
    available: () => Boolean(salesData),
    render: () => trialView(),
    afterRender: () => renderTrial(),
  },
  {
    id: "demo",
    label: "Örnek senaryo",
    available: () => true,
    render: () => demoForecastView(),
    afterRender: () => forecastTable(),
  },
];
let forecastChoice = "";
const forecastSource = () =>
  forecastSources.find((s) => s.id === forecastChoice && s.available()) ||
  forecastSources.find((s) => s.available());
function setForecastSource(id) {
  forecastChoice = id;
  render();
}
function sourceSwitch(active) {
  if (!tahmin) return "";
  return `<div class="sourceSwitch" role="group" aria-label="Tahmin kaynağı"><span class="muted">Kaynak</span>${forecastSources
    .filter((s) => s.available())
    .map(
      (s) =>
        `<button class="${s.id === active.id ? "active" : ""}" aria-pressed="${s.id === active.id}" onclick="setForecastSource('${s.id}')">${esc(s.label)}</button>`,
    )
    .join("")}</div>`;
}

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

// ---------- tahmin.json: storage ----------
// { file, loadedAt, data } in a database of its own; the sales report database is separate.
let tahmin = null,
  tahminSort = "order";

function tahminDB() {
  return new Promise((resolve, reject) => {
    let r = indexedDB.open("dukkan-tahmin", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("data");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tahminWrite(write) {
  let db = await tahminDB();
  try {
    await new Promise((resolve, reject) => {
      let t = db.transaction("data", "readwrite");
      write(t.objectStore("data"));
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}
const persistTahmin = (record) => tahminWrite((s) => s.put(record, "tahmin"));
const forgetTahmin = () => tahminWrite((s) => s.delete("tahmin"));
// Resolves true when a stored file was restored. Never rejects.
async function restoreTahmin() {
  try {
    let db = await tahminDB();
    let record = await new Promise((resolve, reject) => {
      let r = db.transaction("data").objectStore("data").get("tahmin");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    if (!record || tahminProblem(record.data)) return false;
    tahmin ??= record;
    return true;
  } catch {
    console.warn("Tahmin dosyası geri yüklenemedi.");
    return false;
  }
}
// Restored in the background; re-render only when the first render already happened on a page that uses it.
restoreTahmin().then((ok) => {
  if (ok && document.querySelector("#nav button") && ["forecast", "stock"].includes(page)) render();
});

// ---------- tahmin.json: contract check ----------
// Checks the fields this page reads (model/schema/tahmin.schema.json, version 1); extra keys are ignored.
// Returns the first problem as Turkish text, or "" when the file is usable.
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
function tahminProblem(d) {
  if (!isObj(d)) return "Dosya bir JSON nesnesi değil.";
  if (d.version !== 1)
    return `"version" alanı 1 olmalı (dosyada: ${JSON.stringify(d.version) ?? "yok"}). Bu uygulama yalnızca sürüm 1'i okur.`;
  const need = (ok, path, what) => (ok ? "" : `"${path}" alanı eksik veya ${what} değil.`);
  let checks = [
    () => need(isDate(d.origin), "origin", "YYYY-AA-GG biçiminde tarih"),
    () => need(isObj(d.data_range), "data_range", "nesne"),
    () => need(isDate(d.data_range.start), "data_range.start", "tarih"),
    () => need(isDate(d.data_range.end), "data_range.end", "tarih"),
    () => need(isObj(d.method), "method", "nesne"),
    () => need(isNum(d.method.lambda), "method.lambda", "sayı"),
    () => need(isObj(d.method.a0), "method.a0", "nesne"),
    () => need(isObj(d.method.weights), "method.weights", "nesne"),
    () => need(isObj(d.horizons), "horizons", "nesne"),
    ...["weekly", "monthly"].flatMap((h) => [
      () => need(isObj(d.horizons[h]), `horizons.${h}`, "nesne"),
      () => need(isDate(d.horizons[h].start), `horizons.${h}.start`, "tarih"),
      () => need(isDate(d.horizons[h].end), `horizons.${h}.end`, "tarih"),
      () => need(isNum(d.method.a0[h]), `method.a0.${h}`, "sayı"),
      () => need(isObj(d.method.weights[h]), `method.weights.${h}`, "nesne"),
    ]),
    () => need(isObj(d.evaluation), "evaluation", "nesne"),
    () => need(isObj(d.evaluation.summary), "evaluation.summary", "nesne"),
    ...["weekly", "monthly"].map(
      (h) => () =>
        need(isObj(d.evaluation.summary[h]?.wape_pilot), `evaluation.summary.${h}.wape_pilot`, "nesne"),
    ),
    () => need(d.warnings === undefined || Array.isArray(d.warnings), "warnings", "liste"),
    () => need(Array.isArray(d.products), "products", "liste"),
  ];
  for (let check of checks) {
    let problem = check();
    if (problem) return problem;
  }
  let seen = new Set();
  for (let [i, p] of d.products.entries()) {
    let at = `products[${i}]`,
      problem =
        need(isObj(p), at, "nesne") ||
        need(typeof p.barcode === "string" && p.barcode.trim() !== "", at + ".barcode", "metin") ||
        need(typeof p.name === "string", at + ".name", "metin") ||
        need(typeof p.unit === "string", at + ".unit", "metin") ||
        need(isObj(p.forecast), at + ".forecast", "nesne") ||
        need(isNum(p.forecast.weekly?.combined), at + ".forecast.weekly.combined", "sayı") ||
        need(isNum(p.forecast.monthly?.combined), at + ".forecast.monthly.combined", "sayı") ||
        need(isObj(p.stock), at + ".stock", "nesne") ||
        need(
          isNum(p.stock.order_up_to) && p.stock.order_up_to >= 0,
          at + ".stock.order_up_to",
          "sıfır veya pozitif sayı",
        ) ||
        need(p.stock.pack_size == null || isNum(p.stock.pack_size), at + ".stock.pack_size", "sayı") ||
        need(p.flags === undefined || Array.isArray(p.flags), at + ".flags", "liste");
    if (problem) return problem;
    if (seen.has(p.barcode)) return `"${at}.barcode" yineleniyor: ${p.barcode}.`;
    seen.add(p.barcode);
  }
  return "";
}

// ---------- tahmin.json: load / remove ----------
async function loadTahminFile(input) {
  let f = input.files[0],
    out = document.getElementById("tahminResult"),
    data;
  if (!f) return;
  out.textContent = "";
  try {
    if (f.size > 20e6) throw Error("Dosya boyutu en fazla 20 MB olabilir.");
    try {
      data = JSON.parse((await f.text()).replace(/^﻿/, ""));
    } catch {
      throw Error("Dosya geçerli bir JSON değil.");
    }
    let problem = tahminProblem(data);
    if (problem) throw Error(problem);
  } catch (e) {
    input.value = "";
    out.textContent = "Tahmin dosyası yüklenemedi: " + e.message;
    return;
  }
  tahmin = { file: f.name, loadedAt: new Date().toISOString(), data };
  forecastChoice = "model";
  let saved = await persistTahmin(tahmin).then(
    () => true,
    () => false,
  );
  render();
  toast(
    saved
      ? "Tahmin dosyası yüklendi."
      : "Tahmin dosyası yüklendi; bu cihazda saklanamadı, sayfa yenilenince kaybolur.",
  );
}
async function removeTahmin() {
  tahmin = null;
  forecastChoice = "";
  let removed = await forgetTahmin().then(
    () => true,
    () => false,
  );
  render();
  toast(removed ? "Tahmin dosyası kaldırıldı." : "Tahmin dosyası kaldırıldı; kayıtlı kopya silinemedi.");
}

// ---------- tahmin.json: calculations ----------
const round3 = (n) => Math.round(n * 1000) / 1000;
// Order-up-to rule (Eq. 6): ceil_pack(max(0, S − IP)). IP here is the stock on this device only; goods on
// order and reserved stock are not tracked by the app.
function suggestedOrder(stock, onHand) {
  let pack = isNum(stock.pack_size) && stock.pack_size > 0 ? stock.pack_size : 1,
    need = Math.max(0, stock.order_up_to - onHand);
  return round3(Math.max(0, Math.ceil(need / pack - 1e-9)) * pack);
}
// Matched by barcode text (leading zeros kept). Read at render time: the product list may be replaced.
function tahminRows() {
  let byBarcode = new Map();
  for (let p of products)
    if (p.barcode && !byBarcode.has(String(p.barcode))) byBarcode.set(String(p.barcode), p);
  return tahmin.data.products.map((f) => {
    let p = byBarcode.get(f.barcode) || null;
    return { f, p, order: p ? suggestedOrder(f.stock, p.stock) : null };
  });
}
function tahminFor(p) {
  if (!tahmin || !p.barcode) return null;
  let f = tahmin.data.products.find((x) => x.barcode === String(p.barcode));
  return f ? { order: suggestedOrder(f.stock, p.stock), target: f.stock.order_up_to } : null;
}
// Stock page line under a matched product; "" when there is no forecast for it.
function orderHint(p) {
  let t = tahminFor(p);
  return t ? `Önerilen sipariş: ${fmt(t.order)} (hedef ${fmt(t.target)})` : "";
}

// ---------- tahmin.json: view ----------
const fmt1 = (n) => (isNum(n) ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(n) : "—");
const fmt2 = (n) =>
  isNum(n)
    ? new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
    : "—";
const pct = (n) => (isNum(n) ? "%" + fmt2(n) : "—");
const groupNames = {
  steady: "Düzenli",
  variable: "Değişken",
  erratic: "Çok değişken",
  intermittent: "Aralıklı",
  sparse: "Seyrek",
};
const groupHelp = {
  steady: "Düzenli satılan ürünler (düşük değişkenlik).",
  variable: "Satışı günden güne değişen ürünler.",
  erratic: "Satışı çok değişken ürünler.",
  intermittent: "Günlerin çoğunda satışı olmayan ürünler.",
  sparse: "Yeterli gözlemi olmayan ürünler; her zaman ortak ağırlık a₀ kullanılır.",
};
const flagNames = {
  new_product: ["Yeni ürün", "56 günden az gözlem var; tahmin daha belirsizdir."],
  fallback_a0: ["Ortak ağırlık", "Grup ağırlığı yerine bütün ürünlerin ortak ağırlığı a₀ kullanıldı."],
  inactive: ["Satış yok", "Son 56 gündür satış kaydı yok."],
  ss_pooled: [
    "Havuzlanmış emniyet stoku",
    "Üründe yeterli hata ölçümü olmadığından emniyet stoku aynı birimdeki ürünlerin hatalarıyla hesaplandı.",
  ],
  not_in_backtest: ["Testte yok", "Ürün geriye dönük dış testte yoktu; ürün bazında hata ölçümü yok."],
};
const methodNames = { grouped_regularized_combination: "Grup ağırlıklı, düzenlileştirilmiş birleşim" };
const span = (h) => `${ds(h.start)}–${ds(h.end)}${isNum(h.days) ? ` · ${h.days} gün` : ""}`;
// (WAPE_other − WAPE_combined) / WAPE_other: positive means the combination made less error.
function relative(combined, other) {
  if (!isNum(combined) || !isNum(other) || other === 0) return "—";
  let r = ((other - combined) / other) * 100;
  if (Math.abs(r) < 0.005) return "fark yok";
  return `%${fmt2(Math.abs(r))} ${r > 0 ? "daha az hata" : "daha fazla hata"}`;
}

function tahminFileControls() {
  return `<label class="fileButton">${tahmin ? "Başka dosya yükle" : "tahmin.json seçin"}<input type="file" id="tahminFile" accept=".json,application/json" aria-label="tahmin.json dosyası" onchange="loadTahminFile(this)"></label>`;
}
// Shown under the report trial or the demo while no file is loaded.
function tahminLoadCard() {
  return `<section class="card panel bottom" id="tahminLoad"><div class="paneltop"><div><h2>Model çıktısı (tahmin.json)</h2><p class="subtitle">Bilgisayardaki Python paketinin (<code>python -m dukkan_tahmin tahmin</code>) ürettiği dosyayı yükleyin. Dosya yalnızca bu cihazın tarayıcısında saklanır; ürünler barkodla eşleştirilir.</p></div>${tahminFileControls()}</div><p id="tahminResult" role="alert" class="danger"></p><button class="link" onclick="navigate('reports')">Dosya nasıl üretilir? →</button></section>`;
}

function tahminHeader(d) {
  let s = d.evaluation.summary,
    w = s.weekly.wape_pilot,
    m = s.monthly.wape_pilot,
    groups = [
      ...new Set([...Object.keys(d.method.weights.weekly), ...Object.keys(d.method.weights.monthly)]),
    ],
    origins = Array.isArray(d.evaluation.origins) ? d.evaluation.origins : [],
    pilots = Array.isArray(d.evaluation.pilot_products) ? d.evaluation.pilot_products.length : null,
    range = d.data_range,
    fact = (k, v) => `<div><span class="muted">${k}</span><strong>${v}</strong></div>`;
  let facts = [
    fact("Son gözlenen gün", ds(d.origin)),
    fact(
      "Veri aralığı",
      `${ds(range.start)}–${ds(range.end)}${isNum(range.recorded_days) ? ` · ${fmt(range.recorded_days)} kayıtlı gün` : ""}${isNum(range.missing_days) ? ` · ${fmt(range.missing_days)} eksik gün` : ""}`,
    ),
    fact("Haftalık ufuk", span(d.horizons.weekly)),
    fact("Aylık ufuk", span(d.horizons.monthly)),
    fact("Yöntem", esc(methodNames[d.method.name] || d.method.name || "—")),
    fact("λ (düzenlileştirme)", fmt(d.method.lambda)),
    fact("a₀ (ortak ağırlık)", `haftalık ${fmt2(d.method.a0.weekly)} · aylık ${fmt2(d.method.a0.monthly)}`),
  ].join("");
  let weights = `<table class="miniTable"><thead><tr><th>Grup</th><th>Haftalık</th><th>Aylık</th></tr></thead><tbody>${groups.map((g) => `<tr><td title="${esc(groupHelp[g] || "")}">${esc(groupNames[g] || g)}</td><td>${fmt2(d.method.weights.weekly[g])}</td><td>${fmt2(d.method.weights.monthly[g])}</td></tr>`).join("")}</tbody></table>`;
  let wape = `<table class="miniTable" id="tahminWape"><thead><tr><th>Yöntem</th><th>Haftalık WAPE</th><th>Aylık WAPE</th></tr></thead><tbody><tr><td>Önerilen birleşim</td><td>${pct(w.combined)}</td><td>${pct(m.combined)}</td></tr><tr><td>XGBoost</td><td>${pct(w.xgboost)}</td><td>${pct(m.xgboost)}</td></tr><tr><td>Mevsimsel saf</td><td>${pct(w.seasonal_naive)}</td><td>${pct(m.seasonal_naive)}</td></tr><tr class="relRow"><td>Birleşim, XGBoost'a göre</td><td>${relative(w.combined, w.xgboost)}</td><td>${relative(m.combined, m.xgboost)}</td></tr><tr class="relRow"><td>Birleşim, mevsimsel safa göre</td><td>${relative(w.combined, w.seasonal_naive)}</td><td>${relative(m.combined, m.seasonal_naive)}</td></tr></tbody></table>`;
  let warnings = (d.warnings || []).filter((x) => typeof x === "string");
  let stale = d.horizons.weekly.end < todayTR();
  return `<section class="card panel tahminHead" id="tahminHead"><div class="paneltop"><h2>Model ve geriye dönük test</h2><span class="agentBadge">${esc(tahmin.file)}</span></div>${stale ? `<div class="note">Haftalık ufuk (${span(d.horizons.weekly)}) geride kaldı. Güncel satışlarla yeni bir tahmin dosyası üretin.</div>` : ""}<div class="tahminFacts">${facts}</div><div class="twocol tahminTables"><div><h3>Grup ağırlıkları</h3><p class="muted">XGBoost tahmininin payı (a); kalan pay mevsimsel saf tahmindir.</p><div class="tablewrap">${weights}</div></div><div><h3>Pilot ürünlerde hata (WAPE)</h3><p class="muted">${pilots === null ? "" : `${pilots} pilot ürün · `}${origins.length ? `${origins.length} dış test başlangıcı (${ds(origins[0])}–${ds(origins.at(-1))})` : "dış test başlangıcı belirtilmemiş"} · düşük olması daha iyi</p><div class="tablewrap">${wape}</div></div></div><div class="note honesty">Bu değerler geriye dönük test ölçümüdür; gelecekteki başarıyı garanti etmez. Tahmin edilen değişken gözlenen satıştır, talep değildir.</div>${warnings.length ? `<details class="tahminWarnings" open><summary>Dosyadaki uyarılar (${warnings.length})</summary><ul>${warnings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</section>`;
}

function forecastCell(h, unit) {
  let detail = `XGBoost ${fmt1(h.xgboost)} · Mevsimsel saf ${fmt1(h.seasonal_naive)} · XGBoost payı ${fmt2(h.weight)}`;
  return `<details class="fcDetail" title="${detail}"><summary>${fmt1(h.combined)} ${esc(unit)}</summary><small>${detail}</small></details>`;
}
function flagPills(flags) {
  return (flags || [])
    .map((k) => {
      let [name, help] = flagNames[k] || [k, ""];
      return `<span class="pill flag" title="${esc(help)}">${esc(name)}</span>`;
    })
    .join(" ");
}
function setTahminSort(v) {
  tahminSort = v;
  render();
}

function tahminView() {
  let d = tahmin.data,
    rows = tahminRows(),
    cmpName = (a, b) => a.f.name.localeCompare(b.f.name, "tr");
  rows.sort(
    tahminSort === "name"
      ? cmpName
      : (a, b) => (b.order ?? -1) - (a.order ?? -1) || (b.p ? 1 : 0) - (a.p ? 1 : 0) || cmpName(a, b),
  );
  let matched = new Set(rows.filter((r) => r.p).map((r) => r.p)),
    appOnly = products.filter((p) => !matched.has(p)),
    fileOnly = rows.filter((r) => !r.p).sort(cmpName),
    anyFlags = rows.some((r) => r.f.flags?.length);
  let body = rows
    .map(({ f, p, order }) => {
      let unit = f.unit || "";
      return `<tr data-barcode="${esc(f.barcode)}"><td><div class="tahminName"><strong>${esc(f.name)}</strong><small>${esc(f.category || "")}${f.category ? " · " : ""}${esc(f.barcode)}<span class="narrowOnly"> · ${esc(groupNames[f.group] || f.group || "")}</span></small></div></td><td class="optCol">${esc(unit)}</td><td class="optCol" title="${esc(groupHelp[f.group] || "")}">${esc(groupNames[f.group] || f.group || "—")}</td><td>${forecastCell(f.forecast.weekly, unit)}</td><td>${forecastCell(f.forecast.monthly, unit)}</td><td>${p ? `${fmt(p.stock)} ${esc(unit)}` : "—"}</td><td>${fmt(f.stock.order_up_to)} ${esc(unit)}</td><td class="orderCell">${p ? `<span class="pill ${order > 0 ? "" : "ok"}">${fmt(order)} ${esc(unit)}</span>` : `<button class="link" data-barcode="${esc(f.barcode)}" onclick="addProduct(this.dataset.barcode)">Ürün olarak ekle</button>`}</td>${anyFlags ? `<td>${flagPills(f.flags)}</td>` : ""}</tr>`;
    })
    .join("");
  let table = `<section class="card panel bottom"><div class="paneltop"><div><h2>Sipariş önerisi</h2><p class="muted">Önerilen sipariş = hedef stok − mevcut stok, sıfırın altına inmez, paket boyuna yukarı yuvarlanır. Mevcut stok bu cihazdaki kayıttır; yoldaki sipariş ve ayrılmış stok hesaba katılmaz.</p></div><select id="tahminSort" aria-label="Sıralama" onchange="setTahminSort(this.value)"><option value="order" ${tahminSort === "order" ? "selected" : ""}>Siparişe göre</option><option value="name" ${tahminSort === "name" ? "selected" : ""}>Ada göre</option></select></div><div class="tablewrap" tabindex="0" aria-label="Model tahmini ve sipariş önerisi tablosu"><table id="tahminTable"><thead><tr><th>Ürün</th><th class="optCol">Birim</th><th class="optCol">Grup</th><th>Haftalık tahmin</th><th>Aylık tahmin</th><th>Mevcut stok</th><th>Hedef stok</th><th>Önerilen sipariş</th>${anyFlags ? "<th>İşaretler</th>" : ""}</tr></thead><tbody>${body}</tbody></table></div><p class="muted" style="margin-top:14px">Tahmine dokunarak XGBoost ve mevsimsel saf tahmini ile birleşimdeki XGBoost payını görebilirsiniz. Haftalık: ${span(d.horizons.weekly)}; aylık: ${span(d.horizons.monthly)}. Sipariş kararı sizindir.</p></section>`;
  let lists = `<div class="twocol bottom"><section class="card panel" id="tahminAppOnly"><h2>Modelde karşılığı yok <span class="muted">· ${appOnly.length}</span></h2><p class="subtitle">Uygulamadaki bu ürünlerin barkodu tahmin dosyasında yok ya da ürüne barkod tanımlanmamış.</p>${appOnly.length ? `<ul class="plainList">${appOnly.map((p) => `<li><strong>${esc(p.name)}</strong> <span class="muted">${p.barcode ? esc(p.barcode) : "barkodsuz"}</span></li>`).join("")}</ul>` : '<p class="muted">Bütün ürünlerin model tahmini var.</p>'}</section><section class="card panel" id="tahminFileOnly"><h2>Uygulamada tanımlı değil <span class="muted">· ${fileOnly.length}</span></h2><p class="subtitle">Tahmin dosyasındaki bu barkodlar uygulamada kayıtlı değil. Ürün olarak eklerseniz sipariş önerisi hesaplanır.</p>${fileOnly.length ? `<ul class="plainList">${fileOnly.map(({ f }) => `<li><span class="listName"><strong>${esc(f.name)}</strong> <span class="muted">${esc(f.barcode)}</span></span><button class="smallbtn" data-barcode="${esc(f.barcode)}" onclick="addProduct(this.dataset.barcode)">Ürün olarak ekle</button></li>`).join("")}</ul>` : '<p class="muted">Dosyadaki bütün ürünler uygulamada kayıtlı.</p>'}</section></div>`;
  return (
    title(
      "Model tahminleri",
      `tahmin.json · son gözlenen gün ${ds(d.origin)} · ${d.products.length} ürün`,
      `${tahminFileControls()}<button onclick="removeTahmin()">Tahmin dosyasını kaldır</button>`,
    ) +
    `<p id="tahminResult" role="alert" class="danger"></p>` +
    tahminHeader(d) +
    table +
    lists
  );
}

const forecastPage = {
  id: "forecast",
  label: "Tahminler",
  icon: "forecast",
  render() {
    let source = forecastSource();
    return sourceSwitch(source) + source.render() + (tahmin ? "" : tahminLoadCard());
  },
  afterRender: () => forecastSource().afterRender(),
  badge: () => (forecastSource().id === "model" ? "Model çıktısı · stok bu cihazdan" : ""),
};
