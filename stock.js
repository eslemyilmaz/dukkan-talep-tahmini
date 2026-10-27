/* Products & stock: barcode receiving, search/filter, product table, add/edit forms, CSV import/export.
   Every write goes through updateProducts() (register.js), which commits under the register lock. */
"use strict";

// Keyboard-mode USB/Bluetooth scanners send barcode text followed by Enter.
let criticalOnly = false,
  productFromScan = false,
  pendingImport = [];
const validBarcode = (b) => /^[0-9A-Za-z._-]{4,64}$/.test(b);
const findBarcode = (b) => products.find((p) => p.barcode === b);
const barcodeRule = "Barkod 4–64 karakter olmalı; harf, rakam, nokta, tire ve alt çizgi içerebilir.";
const barcodeTaken = "Bu barkod zaten kayıtlı. Stok girişi alanından okutun.";

function stockTable(list, edit = false) {
  return `<div class="tablewrap" tabindex="0" aria-label="Ürün stok tablosu"><table><thead><tr><th>Ürün</th><th>Mevcut stok</th><th>Alt sınır</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>${list.map((p) => `<tr><td>${productLabel(p)}${orderHintLine(p)}</td><td>${p.stock} adet</td><td>${p.min} adet</td><td><span class="pill ${p.stock >= p.min ? "ok" : ""}">${p.stock >= p.min ? "Yeterli" : "Düşük stok"}</span></td><td><button class="link" onclick="editStock('${esc(p.id)}')">${edit ? "Stok güncelle" : p.stock < p.min ? "Stok ekle →" : "Görüntüle →"}</button></td></tr>`).join("")}</tbody></table></div>`;
}

// A loaded tahmin.json (forecast.js) adds a muted suggested-order line under matched products.
function orderHintLine(p, cls = "orderHint") {
  let hint = orderHint(p);
  return hint ? `<small class="${cls}">${esc(hint)}</small>` : "";
}

function scanPanel() {
  return `<section class="card panel" style="margin-bottom:22px;border-top:3px solid var(--red)"><div class="paneltop"><div><h2>Barkodla stok girişi</h2><p class="muted">Okutun, ürünü bulun, gelen miktarı stoğa ekleyin.</p></div><span class="agentBadge">Barkod okuyucu</span></div><form onsubmit="scanBarcode(event)" style="display:flex;gap:10px;flex-wrap:wrap"><input id="barcodeScan" aria-label="Barkod okut" placeholder="Buraya dokunun ve barkodu okutun" autocomplete="off" inputmode="numeric" style="flex:1;min-width:180px"><button class="primary">Ürünü bul</button></form><p class="muted" style="margin-top:12px">Klavye modunda çalışan USB / Bluetooth okuyucu kullanın. Okuyucunun okuma sonu tuşu Enter olmalı. Barkod alanı seçiliyken okutun.</p><div id="scanResult" role="status" style="margin-top:14px"></div><button class="link" style="margin-top:12px" onclick="navigate('reports')">Ürünleri tek tek tanımlamak yerine barkodlu CSV listenizi yükleyin →</button>${categoryLegend()}</section>`;
}

function stockListHTML() {
  if (!criticalOnly) return stockTable(products, true);
  if (!lowStock().length)
    return '<div class="empty">Alt sınırın altında ürün yok. Tüm stoklarınız yeterli.</div>';
  return stockTable(lowStock(), true);
}

const stockPage = {
  id: "stock",
  label: "Ürünler & stok",
  icon: "stock",
  render() {
    return (
      scanPanel() +
      title(
        criticalOnly ? "Kritik stoklar" : "Ürünler & stok",
        "Ürünlerinizi takip edin, alt sınırları işletmenize göre belirleyin.",
        `<button onclick="exportCSV()">↓ Listeyi indir</button><button class="primary" onclick="addProduct()">+ Ürün ekle</button>`,
      ) +
      `<section class="card panel"><div class="paneltop"><input id="search" placeholder="Ürün adı veya barkod ara…" aria-label="Ürün adı veya barkod ara" oninput="filterStock()"><select aria-label="Stok filtresi" id="stockFilter" onchange="filterStock()"><option value="all">Tüm ürünler</option><option value="low">Düşük stoklar</option></select></div><div id="stockTable">${stockListHTML()}</div></section>`
    );
  },
  afterRender({ entered }) {
    if (criticalOnly) document.getElementById("stockFilter").value = "low";
    // Focus only when arriving on the page; re-renders after edits must not pop the tablet keyboard.
    if (entered) document.getElementById("barcodeScan").focus();
  },
};

function filterStock() {
  let q = document.getElementById("search").value,
    low = document.getElementById("stockFilter").value === "low",
    list = products.filter(
      (p) =>
        (p.name.toLocaleLowerCase("tr").includes(q.toLocaleLowerCase("tr")) ||
          (p.barcode || "").includes(q)) &&
        (!low || p.stock < p.min),
    );
  document.getElementById("stockTable").innerHTML = list.length
    ? stockTable(list, true)
    : '<div class="empty">Ürün bulunamadı.</div>';
}

function openCritical() {
  page = "stock";
  criticalOnly = true;
  render();
  window.scrollTo(0, 0);
}

// ---------- Barcode receiving ----------
function scanBarcode(e) {
  e.preventDefault();
  let field = document.getElementById("barcodeScan"),
    b = field.value.trim(),
    result = document.getElementById("scanResult");
  if (!validBarcode(b)) {
    result.textContent = "4–64 karakterlik geçerli bir barkod okutun.";
    return;
  }
  let p = findBarcode(b);
  field.value = "";
  if (!p) {
    addProduct(b);
    return;
  }
  result.innerHTML = `<div class="note">${productMark(p)}<strong>${esc(p.name)}</strong> bulundu · Stok: ${p.stock} adet · Barkod: ${esc(b)}</div><form onsubmit="receiveStock(event,'${esc(p.id)}')" style="display:flex;gap:10px;align-items:end"><label class="field" style="flex:1;margin:0">Gelen miktar<input id="receiveQty" name="qty" type="number" min="1" max="999999" step="1" value="1" required></label><button class="primary">Stoğa ekle</button></form><p class="muted">Yalnızca stok girişi yapar; satış oluşturmaz. Tekrar okutmak onaylanmamış miktarı artırmaz.</p>`;
  let qty = document.getElementById("receiveQty");
  qty.focus();
  qty.select();
}

async function receiveStock(e, id) {
  e.preventDefault();
  let form = e.target,
    q = Number(new FormData(form).get("qty")),
    button = form.querySelector("button");
  if (!Number.isSafeInteger(q) || q < 1 || q > 999999 || button.disabled) return;
  button.disabled = true;
  try {
    await updateProducts((list) => {
      let p = list.find((p) => p.id === id);
      if (!p) throw Error("Ürün artık kayıtlı değil.");
      if (!Number.isSafeInteger(p.stock + q)) throw Error("Stok miktarı çok büyük.");
      p.stock += q;
    });
  } catch (err) {
    button.disabled = false;
    toast("Kaydedilemedi: " + err.message);
    return;
  }
  let p = productById(id);
  render();
  document.getElementById("scanResult").textContent =
    `${p.name}: ${q} adet eklendi. Yeni stok: ${p.stock} adet.`;
  document.getElementById("barcodeScan").focus();
}

// ---------- Add / edit product ----------
function addProduct(b = "") {
  productFromScan = Boolean(b);
  modal(
    "Yeni ürün ekle",
    `<form onsubmit="submitProduct(event)"><p class="muted">${b ? "Barkod henüz kayıtlı değil. Ürünü bir kez tanımladıktan sonra sonraki okutmalarda otomatik bulunur." : "Barkodlu ürün, sonraki okutmalarda otomatik bulunur."}</p><label class="field">Barkod<input name="barcode" aria-label="Ürün barkodu" autocomplete="off" maxlength="64" value="${esc(b)}" placeholder="Okuyucuyla okutun veya boş bırakın" onkeydown="barcodeEnter(event)"></label><p id="productError" role="alert" class="danger"></p><label class="field">Ürün adı<input name="name" required maxlength="80" placeholder="Örn. Süt · 1 L" oninput="categoryPreview(this.form)"></label><label class="field">Kategori<input name="category" required placeholder="Örn. Süt ürünleri" list="productCategories" oninput="categoryPreview(this.form)"></label><div class="iconPreview" id="categoryPreview"></div><div class="twocol"><label class="field">Mevcut stok<input name="stock" type="number" min="0" step="1" required></label><label class="field">Alt sınır<input name="min" type="number" min="1" step="1" required></label></div><label class="field">Satış fiyatı (TL)<input name="price" type="number" min="0" step="0.01" required></label><label class="field">Alış maliyeti (TL) · isteğe bağlı<input name="cost" type="number" min="0" step="0.01" placeholder="Bilinmiyorsa boş bırakın"></label><button class="primary">Ürünü kaydet</button><datalist id="productCategories">${Object.values(
      categoryIcons,
    )
      .map((c) => `<option value="${esc(c.label)}">`)
      .join("")}</datalist></form>`,
  );
  let form = document.querySelector("#mbody form");
  categoryPreview(form);
  form.querySelector(b ? '[name="name"]' : '[name="barcode"]').focus();
}
// A scanner ends the barcode with Enter; move on to the name instead of submitting the form.
function barcodeEnter(e) {
  if (e.key !== "Enter") return;
  e.preventDefault();
  e.target.form.querySelector('[name="name"]').focus();
}
function categoryPreview(form) {
  let p = { name: form.elements.name.value, category: form.elements.category.value };
  document.getElementById("categoryPreview").innerHTML =
    productMark(p) +
    `<div><strong style="font-size:12px">${esc(categoryIcons[categoryKey(p)].label)}</strong><p class="muted">Kategori simgesi otomatik seçilir.</p></div>`;
}

const optionalCost = (v) => (v === "" || v === null ? null : RegisterCore.cents(v) / 100);

async function submitProduct(e) {
  e.preventDefault();
  let form = e.target,
    d = new FormData(form),
    b = String(d.get("barcode") || "").trim(),
    button = form.querySelector("button.primary");
  if (button.disabled) return;
  if (b && !validBarcode(b)) return showError(form, barcodeRule);
  if (b && findBarcode(b)) return showError(form, barcodeTaken);
  let product;
  try {
    product = {
      id: uid(),
      name: d.get("name").trim(),
      category: d.get("category").trim(),
      stock: +d.get("stock"),
      min: +d.get("min"),
      price: RegisterCore.cents(d.get("price")) / 100,
      daily: 0,
      icon: "▦",
      barcode: b,
      cost: optionalCost(d.get("cost")),
    };
  } catch (err) {
    return showError(form, err.message);
  }
  button.disabled = true;
  try {
    await updateProducts((list) => {
      if (b && list.some((p) => p.barcode === b)) throw Error(barcodeTaken);
      list.push(product);
    });
  } catch (err) {
    button.disabled = false;
    return showError(form, "Kaydedilemedi: " + err.message);
  }
  closeModal();
  render();
  toast("Ürün listenize eklendi.");
  // Back to the scanner only when the product was defined from an unknown scan.
  if (productFromScan && page === "stock") document.getElementById("barcodeScan").focus();
}

function editStock(id) {
  let p = productById(id);
  if (!p) return toast("Ürün bulunamadı.");
  modal(
    p.name + " · Stok güncelle",
    `<form onsubmit="updateStock(event,'${esc(id)}')">${orderHintLine(p, "orderHint modalHint")}<label class="field">Mevcut stok<input name="stock" type="number" min="0" step="1" required value="${p.stock}"></label><label class="field">Alt sınır<input name="min" type="number" min="1" step="1" required value="${p.min}"></label><p id="stockError" role="alert" class="danger"></p><button class="primary">Değişiklikleri kaydet</button></form>`,
  );
}

async function updateStock(e, id) {
  e.preventDefault();
  let form = e.target,
    d = new FormData(form),
    button = form.querySelector("button.primary");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await updateProducts((list) => {
      let p = list.find((p) => p.id === id);
      if (!p) throw Error("Ürün artık kayıtlı değil.");
      p.stock = +d.get("stock");
      p.min = +d.get("min");
    });
  } catch (err) {
    button.disabled = false;
    return showError(form, "Kaydedilemedi: " + err.message);
  }
  closeModal();
  render();
  toast("Stok güncellendi.");
}

// ---------- CSV ----------
const csvKeys = ["urun", "kategori", "stok", "alt_sinir", "fiyat"];
function exportCSV() {
  download(
    "dukkan-barkodlu-stok.csv",
    "﻿" +
      [
        csvrow(["barkod", ...csvKeys]),
        ...products.map((p) => csvrow([p.barcode || "", p.name, p.category, p.stock, p.min, p.price])),
      ].join("\r\n"),
  );
}
function template() {
  download(
    "barkodlu-stok-sablonu.csv",
    "﻿barkod;urun;kategori;stok;alt_sinir;fiyat\r\nDEMO001;Örnek ürün;Temel gıda;18;30;15",
  );
}

class ImportError extends Error {
  constructor(message, prefix) {
    super(message);
    this.prefix = prefix;
  }
}
// One pass over the parsed rows; the optional `barkod` column is checked with the other fields.
function validateStockRows(rows) {
  let header = rows.shift()?.cells || [];
  if (!csvKeys.every((k) => header.includes(k)))
    throw Error("Başlıklar eksik. Lütfen örnek CSV şablonunu kullanın.");
  let idx = Object.fromEntries(csvKeys.map((k) => [k, header.indexOf(k)])),
    barcodeAt = header.indexOf("barkod"),
    seen = new Set(products.filter((p) => p.barcode).map((p) => p.barcode));
  let data = rows.map(({ line, cells: r }) => {
    let p = {
      name: r[idx.urun],
      category: r[idx.kategori],
      stock: Number(r[idx.stok]),
      min: Number(r[idx.alt_sinir]),
      price: Number((r[idx.fiyat] || "").replace(",", ".")),
      daily: 0,
      icon: "▦",
      barcode: barcodeAt < 0 ? "" : (r[barcodeAt] || "").trim(),
    };
    if (
      !p.name ||
      !p.category ||
      ![p.stock, p.min, p.price].every(Number.isFinite) ||
      p.stock < 0 ||
      p.min < 1 ||
      p.price < 0 ||
      !Number.isInteger(p.stock) ||
      !Number.isInteger(p.min) ||
      [idx.stok, idx.alt_sinir, idx.fiyat].some((n) => !r[n])
    )
      throw Error(`${line}. satırda eksik veya geçersiz değer var.`);
    if (p.barcode && (!validBarcode(p.barcode) || seen.has(p.barcode)))
      throw new ImportError(
        `${line}. satırda geçersiz veya daha önce kayıtlı barkod var: ${p.barcode}`,
        "Aktarım durduruldu: ",
      );
    if (p.barcode) seen.add(p.barcode);
    return p;
  });
  if (!data.length) throw Error("Dosyada ürün satırı yok.");
  return data;
}

async function checkCSV() {
  let el = document.getElementById("importResult"),
    f = document.getElementById("csvFile").files[0];
  pendingImport = [];
  if (!f) {
    el.textContent = "Lütfen önce bir CSV dosyası seçin.";
    return;
  }
  try {
    if (f.size > 5e6) throw Error("Dosya boyutu en fazla 5 MB olabilir.");
    pendingImport = validateStockRows(parseCSV(await f.text()));
    let n = pendingImport.length;
    el.innerHTML = `<p>${n} ürün kontrol edildi. Var olan ürünler korunur; bu satırlar yeni ürün olarak eklenir.</p><button class="primary" onclick="importCSV()">${n} ürünü ekle</button>`;
  } catch (e) {
    el.textContent = (e.prefix || "Dosya yüklenemedi: ") + e.message;
  }
}

async function importCSV() {
  let rows = pendingImport,
    el = document.getElementById("importResult");
  if (!rows.length) return;
  pendingImport = [];
  el.querySelector("button")?.setAttribute("disabled", "");
  try {
    await updateProducts((list) => {
      let taken = rows.find((p) => p.barcode && list.some((x) => x.barcode === p.barcode));
      if (taken) throw Error("Barkod başka üründe kayıtlı: " + taken.barcode);
      list.push(...rows.map((p) => ({ ...p, id: uid(), cost: null })));
    });
  } catch (err) {
    el.textContent = "Aktarım durduruldu: " + err.message;
    return;
  }
  render();
  toast("Dosyadaki ürünler listenize eklendi.");
}

function stockImportPanel() {
  return `<section class="card panel"><h2>Stok listesi yükle</h2><p class="subtitle">Barkodlu ürün listenizi topluca yükleyin. Mevcut barkodlar yinelenirse aktarım durur; stoklar otomatik değiştirilmez.</p><div class="importzone">${ico("report")}<p>CSV dosyası seçin</p><p class="muted">Başlıklar: barkod, urun, kategori, stok, alt_sinir, fiyat</p><input type="file" id="csvFile" accept=".csv,text/csv" aria-label="Stok CSV dosyası"></div><button class="primary" onclick="checkCSV()">Dosyayı kontrol et</button> <button onclick="template()">Örnek CSV indir</button><div id="importResult" style="margin-top:20px" role="status"></div></section>`;
}
