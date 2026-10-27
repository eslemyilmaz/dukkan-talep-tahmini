/* Register: the authoritative local records (products, entries, customers), POS screen, product
   price/barcode/cost editor, history, credit accounts, backup/restore and the register-based overview parts.
   Records live in IndexedDB (storage.js). In memory: `reg` (the meta record: everything except entries),
   customer balances, and the entries of the days pages have loaded. Every write goes through
   writeRegister(): Web Lock -> one readwrite transaction (read meta, decide, write) -> adopt -> broadcast. */
"use strict";

const LEGACY_KEY = "dukkan-register-v1",
  LEGACY_COPY = "dukkan-register-v1-migrated",
  writer = isPreview ? "preview" : "main";
let reg = null,
  regProblem = "",
  balances = {},
  dayCache = new Map(),
  regChannel = null,
  cart = [],
  cartId = uid(),
  posMode = "sale",
  posPayment = "cash",
  posCategory = "all",
  posQuery = "",
  posCustomer = "",
  posNewName = "",
  posNote = "",
  posBusy = false,
  collecting = false;

// ---------- Records ----------
function adopt(meta) {
  reg = meta;
  products = meta.products.map((p) => ({ ...p }));
}
function withRegisterLock(fn) {
  return navigator.locks ? navigator.locks.request("dukkan-register-write", fn) : Promise.resolve().then(fn);
}
function storageMessage(e) {
  return e?.name === "QuotaExceededError"
    ? "Tarayıcı depolama alanı doldu. Yedek alıp eski verileri temizleyin."
    : e?.message || String(e);
}
// work(t, meta) runs inside the transaction and returns { meta, entry? }: the next meta record (it must not
// modify `meta`) and at most one new entry. Both are written in the same transaction, so a commit is atomic.
// On failure the stored meta is re-adopted and the promise rejects with a user-facing message.
async function writeRegister(work) {
  if (regProblem) throw Error(regProblem);
  try {
    let out = await withRegisterLock(() =>
      Store.transaction(["meta", "entries"], "readwrite", async (t) => {
        let out = await work(t, Store.checkMeta(await t.get("meta", "register")));
        t.put("meta", out.meta, "register");
        t.put("meta", writer, "writer");
        if (out.entry) t.put("entries", out.entry);
        return out;
      }),
    );
    adopt(out.meta);
    if (out.entry) remember(out.entry);
    announce();
    return out;
  } catch (e) {
    try {
      adopt(Store.checkMeta(await Store.get("meta", "register")));
    } catch {}
    throw Error(storageMessage(e));
  }
}
// One sale / internal use / collection. RegisterCore.commit gets the meta record plus only the entries it
// reads for this request (see Store.commitScope): the stored entry with the same id, if any, so the core
// rejects the duplicate itself, and for a collection that customer's entries for balance(). Resolves with
// the new entry.
async function commitEntry(request) {
  let out = await writeRegister(async (t, meta) => {
    let need = Store.commitScope(request),
      known = need.customerId ? await t.getAll("entries", need.customerId, { index: "customerId" }) : [];
    if (need.id && !known.some((e) => e.id === need.id)) {
      let same = await t.get("entries", need.id);
      if (same) known.push(same);
    }
    let { entries, ...next } = RegisterCore.commit({ ...meta, entries: known }, request);
    return { meta: next, entry: entries.at(-1) };
  });
  return out.entry;
}
// Product edits: fn(products, draft) mutates a copy of the latest meta record; one revision per call.
function updateProducts(fn) {
  return writeRegister((t, meta) => {
    let next = structuredClone(meta);
    fn(next.products, next);
    next.rev = meta.rev + 1;
    return { meta: next };
  });
}

// ---------- Caches: balances and per-day entries ----------
async function loadBalances() {
  if (regProblem) return;
  let byCustomer = {};
  for (let e of await Store.getAll("entries", null, { index: "customerId" }))
    (byCustomer[e.customerId] ??= []).push(e);
  balances = Object.fromEntries(
    Object.entries(byCustomer).map(([id, list]) => [id, RegisterCore.balance({ entries: list }, id)]),
  );
}
const customerBalance = (id) => balances[id] || 0;
const byNumber = (a, b) => a.number - b.number;
// Loads the missing dates with one range query on the "date" index (from the first to the last missing
// date; entries of dates in between that are already cached are skipped). Returns nothing when every date
// is cached (the router then renders synchronously), else a promise. replace: drop the whole cache once
// the requested dates have been read (after another tab wrote), so nothing renders from an emptied cache.
function loadDays(dates, replace = false) {
  if (dayCache.size > 60) dayCache.clear();
  let sorted = [...new Set(replace ? dates : dates.filter((d) => !dayCache.has(d)))].sort();
  if (regProblem || !sorted.length) return null;
  return Store.getAll("entries", IDBKeyRange.bound(sorted[0], sorted.at(-1)), { index: "date" }).then(
    (list) => {
      let fresh = new Map(sorted.map((d) => [d, []]));
      for (let e of list) fresh.get(e.date)?.push(e);
      if (replace) dayCache = new Map();
      for (let [d, day] of fresh) dayCache.set(d, day.sort(byNumber));
    },
  );
}
// Entries of one date in number order; empty until loadDays() has run for it.
const dayEntries = (date) => dayCache.get(date) || [];
const registerDaily = (date) => RegisterCore.daily({ entries: dayEntries(date) }, date);
function remember(entry) {
  let day = dayCache.get(entry.date);
  if (day && !day.some((e) => e.id === entry.id)) day.push(entry);
  if (entry.customerId)
    balances[entry.customerId] =
      customerBalance(entry.customerId) + RegisterCore.balance({ entries: [entry] }, entry.customerId);
}
// Entries between two dates (inclusive), in number order, for exports and reports.
async function registerEntries(from, to) {
  if (regProblem) return [];
  return (await Store.getAll("entries", IDBKeyRange.bound(from, to), { index: "date" })).sort(byNumber);
}
// Re-reads everything held in memory: at boot, after another tab's commit and after a restore. Other cached
// days are dropped; the router's next load() reads the ones its page needs.
async function reloadRegister() {
  adopt(Store.checkMeta(await Store.get("meta", "register")));
  settings.adopt(await Store.get("meta", "settings"));
  await loadBalances();
  await loadDays([todayTR()], true);
}

// ---------- Boot: open, migrate, create ----------
const seedProducts = () =>
  (readJSON("dukkan-products", null) || sampleProducts()).map((p) => ({
    ...p,
    id: p.id || uid(),
    cost: p.cost ?? null,
  }));
// Under the lock, in one transaction: keep the stored register; else import the old localStorage blob
// (meta + every entry); else create a register from the seed products. The settings seed is written the
// same way. Returns the legacy blob when one was found, so the caller can rename it.
async function openRegister() {
  let legacy = readKey(LEGACY_KEY);
  await Store.transaction(["meta", "entries"], "readwrite", async (t) => {
    if (!(await t.get("meta", "settings"))) t.put("meta", settings.snapshot(), "settings");
    if (await t.get("meta", "register")) return;
    let meta, entries;
    if (legacy) {
      ({ meta, entries } = Store.splitRegister(JSON.parse(legacy)));
      // Legacy products without an id get one, once; everything else is keyed by id.
      if (meta.products.some((p) => !p.id))
        meta = {
          ...meta,
          rev: meta.rev + 1,
          products: meta.products.map((p) => (p.id ? p : { ...p, id: uid() })),
        };
    } else {
      meta = { version: 1, rev: 0, nextNumber: 1, products: seedProducts(), customers: [] };
      entries = [];
    }
    t.put("meta", meta, "register");
    for (let e of entries) t.put("entries", e);
  });
  return legacy;
}
// The imported blob stays as a safety copy under a new name; it is never deleted. If localStorage has no
// room for the copy, the blob stays under its old name (the register in IndexedDB wins from now on).
function renameLegacy(raw) {
  try {
    localStorage.setItem(LEGACY_COPY, raw);
    localStorage.removeItem(LEGACY_KEY);
  } catch (e) {
    console.warn("Eski kasa kaydı yeniden adlandırılamadı; yerinde bırakıldı.", e);
  }
}
async function initRegister() {
  try {
    await Store.openDb();
    let legacy = await withRegisterLock(openRegister);
    if (legacy) renameLegacy(legacy);
    await reloadRegister();
  } catch (e) {
    console.warn("Kasa kayıtları açılamadı:", e);
    regProblem = "Kasa kayıtları açılamadı. Tarayıcı depolamasını kontrol edin; mevcut veriler silinmedi.";
    reg = { version: 1, rev: 0, nextNumber: 1, products: seedProducts(), customers: [] };
    adopt(reg);
    return;
  }
  if (typeof BroadcastChannel === "function") {
    regChannel = new BroadcastChannel("dukkan-register");
    regChannel.onmessage = onRegisterMessage;
  }
  Store.requestPersistence();
  if (debug) {
    debug.commit = commitEntry;
    debug.products = () => products;
  }
}
// IndexedDB writes fire no `storage` event; other tabs (and the preview frame) hear about commits here.
function announce() {
  regChannel?.postMessage({ rev: reg.rev, writer });
}
async function onRegisterMessage({ data }) {
  if (!data || typeof data.rev !== "number") return;
  try {
    await reloadRegister();
  } catch {
    return;
  }
  await show();
  // The preview frame shares this shop's records; its writes are not news for the main screen.
  if (!isPreview && data.writer !== "preview") toast("Kayıtlar diğer sekmeden güncellendi.");
}

// ---------- Backup / restore (UI in assistant.js) ----------
// One readonly transaction, so meta, entries and settings are from the same moment.
async function registerBackup(includeReport) {
  if (regProblem) throw Error(regProblem);
  let stores = includeReport ? ["meta", "entries", "report"] : ["meta", "entries"],
    data = await Store.transaction(stores, "readonly", async (t) => ({
      meta: Store.checkMeta(await t.get("meta", "register")),
      entries: await t.getAll("entries", null, { index: "number" }),
      settings: (await t.get("meta", "settings")) ?? null,
      report: includeReport ? ((await t.get("report", "report")) ?? null) : null,
    }));
  return Store.buildBackup({ ...data, exportedAt: new Date().toISOString() });
}
async function registerCounts() {
  return regProblem ? null : { nextNumber: reg.nextNumber, entries: await Store.count("entries") };
}
// backup: Store.readBackup() output. Replaces meta, every entry and settings (and the report when the
// backup has one) in one transaction. rev keeps growing so other tabs and later commits see a newer record.
async function restoreRegister(backup, override) {
  if (regProblem) throw Error(regProblem);
  let stores = backup.report ? ["meta", "entries", "report"] : ["meta", "entries"];
  try {
    await withRegisterLock(() =>
      Store.transaction(stores, "readwrite", async (t) => {
        let current = Store.checkMeta(await t.get("meta", "register")),
          refusal = Store.restoreRefusal(
            backup.summary,
            { nextNumber: current.nextNumber, entries: await t.count("entries") },
            override,
          );
        if (refusal) throw Error(refusal);
        t.clear("entries");
        for (let e of backup.entries) t.put("entries", e);
        t.put("meta", { ...backup.meta, rev: Math.max(current.rev, backup.meta.rev) + 1 }, "register");
        t.put("meta", writer, "writer");
        if (backup.settings) t.put("meta", backup.settings, "settings");
        if (backup.report) t.put("report", backup.report, "report");
      }),
    );
  } catch (e) {
    throw Error(storageMessage(e));
  }
  resetCart();
  await reloadRegister();
  if (backup.report) activateSales(backup.report);
  announce();
}

// ---------- POS ----------
function pStatus(msg) {
  let el = document.getElementById("posStatus");
  if (el) el.textContent = msg;
  else toast(msg);
}
function cartTotal() {
  return cart.reduce((s, p) => s + p.unit * p.q, 0);
}
function modeChange(mode) {
  posMode = mode;
  posNote = "";
  cart.forEach((r) => {
    let p = productById(r.id);
    r.unit = mode === "sale" ? RegisterCore.cents(p?.price || 0) : 0;
  });
  render();
}
function setPosCategory(id) {
  posCategory = id;
  render();
}
function setPayment(id) {
  posPayment = id;
  render();
}
function setPosCustomer(id) {
  posCustomer = id;
  render();
}
function posInput(value) {
  posQuery = value;
  drawQuickProducts();
}
function posScreen() {
  return `<div class="posHeading"><div><h1>Satış ekranı</h1><p class="subtitle">Ürünleri okutun, sepete ekleyin, işlemi tamamlayın.</p></div><div class="posSecondary"><button onclick="showHistory()">◷ Son işlemler</button><button onclick="navigate('dayEnd')">Gün sonu →</button></div></div>${regProblem ? `<div class="note">${esc(regProblem)}</div>` : ""}<div class="posLayout"><section><div class="posModes" aria-label="İşlem türü"><button class="${posMode === "sale" ? "chosen" : ""}" onclick="modeChange('sale')">Satış</button><button class="${posMode === "internal" ? "chosen" : ""}" onclick="modeChange('internal')">İşletme içi kullanım</button></div><p class="posHelp">${posMode === "sale" ? "Barkodla veya ürün kartına dokunarak sepete ekleyin." : "Bu işlem stoktan düşer; ciroya ve müşteri talebine eklenmez."}</p><form class="scanBox" onsubmit="posScan(event)">${ico("stock")}<input id="posBarcode" aria-label="Satış barkodu veya ürün arama" autocomplete="off" placeholder="Barkodu okutun veya ürün arayın" value="${esc(posQuery)}" oninput="posInput(this.value)"><button type="submit">Ekle ↵</button></form><div class="posStatus" id="posStatus" role="status"></div><div class="posFilters">${[
    ["all", "Tümü"],
    ["bread", "Ekmek"],
    ["drink", "İçecek"],
    ["dairy", "Süt ürünleri"],
    ["tobacco", "Tütün"],
  ]
    .map(
      ([id, t]) =>
        `<button class="${posCategory === id ? "chosen" : ""}" onclick="setPosCategory('${id}')">${t}</button>`,
    )
    .join(
      "",
    )}</div><div class="posSearchTitle"><h2>Hızlı ürünler</h2><button class="link" onclick="addProduct()">+ Ürün ekle</button></div><div id="quickProducts" class="quickProducts"></div><div class="posNotice"><span class="greenDot"></span><span><strong>Barkod girişi</strong><br>Klavye modunda USB / Bluetooth okuyucu · Barkod alanına dokunun, okutun. Enter ile ürün eklenir. Fiziksel okuyucunuzla bağlantı henüz test edilmedi.</span></div><p class="deviceNote">Kayıtlar yalnızca bu cihazın tarayıcısında saklanır. Kart seçimi ödeme kaydıdır; banka/POS cihazından ödeme çekmez. Mali fiş düzenlemez.</p></section><section class="posReceipt" aria-label="Sepet"><div class="receiptTop"><h2>${posMode === "internal" ? "Kullanım listesi" : "Sepet"}</h2><span class="agentBadge">${cart.length} ürün çeşidi</span><button class="smallbtn" onclick="clearCart()" ${cart.length ? "" : "disabled"}>Temizle</button></div><div class="receiptItems">${
    cart.length
      ? cart
          .map((r, i) => {
            let p = products.find((p) => p.id === r.id) || r;
            return `<div class="receiptItem">${productMark(p)}<div><strong>${esc(p.name)}</strong><div class="muted" style="margin-top:4px">${posMode === "sale" ? moneyKurus(r.unit) + " / adet" : "İşletme içi kullanım"}</div><div class="qtyControl"><button aria-label="${esc(p.name)} miktarını azalt" onclick="changeCart(${i},-1)">−</button><span>${r.q}</span><button aria-label="${esc(p.name)} miktarını artır" onclick="changeCart(${i},1)">+</button></div></div><div><div class="lineTotal">${posMode === "sale" ? moneyKurus(r.q * r.unit) : r.q + " adet"}</div><button class="removeLine" aria-label="${esc(p.name)} sepetten çıkar" onclick="removeLine(${i})">×</button></div></div>`;
          })
          .join("")
      : '<div class="posEmpty">Sepetiniz hazır.<br>Bir ürün okutun veya soldaki kartlardan seçin.</div>'
  }</div><div class="receiptFoot"><div class="receiptTotals"><span class="muted">Toplam miktar</span><b>${cart.reduce((s, p) => s + p.q, 0)} adet</b></div>${
    posMode === "sale"
      ? `<div class="receiptTotals"><b>Genel toplam</b><strong>${moneyKurus(cartTotal())}</strong></div><label style="font-size:12px;font-weight:600">Ödeme türü</label><div class="payments">${[
          ["cash", "Nakit"],
          ["card", "Kart"],
          ["credit", "Veresiye"],
        ]
          .map(
            ([id, t]) =>
              `<button class="${posPayment === id ? "chosen" : ""}" onclick="setPayment('${id}')">${t}</button>`,
          )
          .join(
            "",
          )}</div>${posPayment === "credit" ? `<label class="field">Müşteri hesabı<select id="posCustomer" onchange="setPosCustomer(this.value)"><option value="">Müşteri seçin</option>${reg.customers.map((c) => `<option value="${esc(c.id)}" ${posCustomer === c.id ? "selected" : ""}>${esc(c.name)} · ${c.id.slice(0, 4)} · ${moneyKurus(customerBalance(c.id))}</option>`).join("")}<option value="new" ${posCustomer === "new" ? "selected" : ""}>+ Yeni müşteri</option></select></label>${posCustomer === "new" ? `<label class="field">Yeni müşteri adı<input maxlength="80" value="${esc(posNewName)}" oninput="posNewName=this.value" placeholder="Ad / hesap adı"></label>` : ""}<p class="muted">Satış tutarı müşteri borcuna eklenir; şu an tahsilat yapılmaz.</p>` : ""}`
      : `<div class="internalWarning">Stok azalır. Satış tutarı ve müşteri borcu oluşmaz.</div><label class="field">Kullanım açıklaması<textarea maxlength="300" aria-label="Kullanım açıklaması" oninput="posNote=this.value" placeholder="Örn. İşletmede tüketildi">${esc(posNote)}</textarea></label><p class="muted">Alış maliyeti bilinen ürünler için tüketim maliyeti ayrıca kaydedilir.</p>`
  }<button class="primary checkout" onclick="completeRegister()" ${!cart.length || posBusy || regProblem ? "disabled" : ""}>${posBusy ? "Kaydediliyor…" : posMode === "sale" ? "✓ Satışı tamamla" : "✓ Kullanımı kaydet"}</button><p class="receiptBodyNote">Stok yalnızca işlem tamamlandığında değişir. Sepeti temizlemek stoğu etkilemez.</p></div></section></div>`;
}
function drawQuickProducts() {
  let el = document.getElementById("quickProducts");
  if (!el) return;
  let q = normalized(posQuery.trim()),
    list = products
      .filter(
        (p) =>
          (posCategory === "all" || categoryKey(p) === posCategory) &&
          (!q || normalized(p.name).includes(q) || (p.barcode || "").includes(posQuery.trim())),
      )
      .slice(0, 30);
  el.innerHTML = list.length
    ? list
        .map((p) => {
          return `<article class="quickProduct">${productMark(p)}<h3>${esc(p.name)}</h3><div class="tileBottom"><span class="productPrice">${moneyKurus(RegisterCore.cents(p.price || 0))}</span><button class="tileAdd" aria-label="${esc(p.name)} sepete ekle" onclick="addToCart('${esc(p.id)}')" ${p.stock > 0 ? "" : "disabled"}>+</button></div><p class="muted">Stok: ${fmt(p.stock)} adet${p.barcode ? " · " + esc(p.barcode) : ""}</p><button class="tileEdit" onclick="editRegisterProduct('${esc(p.id)}')">Fiyat / barkod / maliyet</button></article>`;
        })
        .join("")
    : '<div class="posEmpty" style="grid-column:1/-1">Ürün bulunamadı. Ürünler & stok bölümünden listenizi ekleyebilirsiniz.</div>';
}
function addToCart(id) {
  let p = products.find((p) => p.id === id);
  if (!p) return pStatus("Ürün bulunamadı.");
  let unit;
  try {
    unit = posMode === "sale" ? RegisterCore.cents(p.price) : 0;
  } catch {
    return pStatus("Ürünün fiyatını kontrol edin.");
  }
  if (posMode === "sale" && unit <= 0)
    return pStatus("Bu ürünün satış fiyatı eksik. Karttaki fiyat/barkod bağlantısından güncelleyin.");
  let old = cart.find((r) => r.id === id),
    q = old ? old.q + 1 : 1;
  if (q > p.stock) return pStatus(p.name + ": yeterli stok yok.");
  if (old) {
    old.q = q;
    old.unit = unit;
  } else cart.push({ id: p.id, name: p.name, q: 1, unit });
  posQuery = "";
  render();
  document.getElementById("posBarcode")?.focus();
}
function posScan(e) {
  e.preventDefault();
  let b = document.getElementById("posBarcode").value.trim();
  if (!b) return;
  let matches = products.filter((p) => p.barcode === b);
  if (matches.length === 1) {
    addToCart(matches[0].id);
    return;
  }
  if (matches.length > 1) return pStatus("Aynı barkod birden fazla üründe kayıtlı. Ürün listesini düzeltin.");
  let names = products.filter((p) => normalized(p.name) === normalized(b));
  if (names.length === 1) {
    addToCart(names[0].id);
    return;
  }
  pStatus("Barkod bulunamadı. Ürün kartından seçin veya yeni ürün tanımlayın.");
  document.getElementById("posBarcode").select();
}
function changeCart(i, delta) {
  let r = cart[i];
  if (!r) return;
  let q = r.q + delta,
    p = products.find((p) => p.id === r.id);
  if (q < 1) {
    cart.splice(i, 1);
    render();
    return;
  }
  if (!p || q > p.stock) return pStatus("Yeterli stok yok.");
  r.q = q;
  render();
}
function clearCart() {
  resetCart();
  render();
}
function removeLine(i) {
  cart.splice(i, 1);
  render();
}
function resetCart() {
  cart = [];
  cartId = uid();
  posNote = "";
  posNewName = "";
  posCustomer = "";
  posQuery = "";
}
async function completeRegister() {
  if (posBusy || !cart.length) return;
  posBusy = true;
  document.querySelector(".checkout")?.setAttribute("disabled", "");
  let failure = "";
  try {
    await commitEntry({
      id: cartId,
      kind: posMode,
      payment: posPayment,
      items: cart.map((p) => ({ ...p })),
      customerId: posCustomer === "new" ? null : posCustomer,
      newCustomer:
        posMode === "sale" && posPayment === "credit" && posCustomer === "new"
          ? { id: uid(), name: posNewName }
          : null,
      note: posNote,
      date: todayTR(),
      time: timeTR(),
    });
    let wasInternal = posMode === "internal";
    resetCart();
    registerDate = todayTR();
    toast(
      wasInternal
        ? "İşletme içi kullanım kaydedildi. Ciro değişmedi."
        : "Satış kaydedildi; stok güncellendi.",
    );
  } catch (e) {
    failure = e.message;
    toast("İşlem kaydedilmedi: " + e.message);
  } finally {
    posBusy = false;
    render();
    if (failure) pStatus(failure);
    document.getElementById("posBarcode")?.focus();
  }
}
function editRegisterProduct(id) {
  let p = productById(id);
  if (!p) return;
  modal(
    "Ürün bilgileri",
    `<form onsubmit="saveRegisterProduct(event,'${esc(id)}')"><p>${esc(p.name)}</p><label class="field">Barkod<input name="barcode" value="${esc(p.barcode || "")}" maxlength="64"></label><label class="field">Satış fiyatı (TL)<input name="price" type="number" min="0" max="1000000000" step="0.01" required value="${p.price}"></label><label class="field">Alış maliyeti (TL) · isteğe bağlı<input name="cost" type="number" min="0" max="1000000000" step="0.01" value="${p.cost ?? ""}" placeholder="Bilinmiyorsa boş bırakın"></label><p id="productSaveError" role="alert" class="danger"></p><button class="primary">Kaydet</button></form>`,
  );
}
async function saveRegisterProduct(e, id) {
  e.preventDefault();
  let form = e.target,
    button = form.querySelector("button.primary");
  if (button.disabled) return;
  try {
    let d = new FormData(form),
      b = String(d.get("barcode")).trim(),
      price = RegisterCore.cents(d.get("price")) / 100,
      cost = optionalCost(d.get("cost"));
    if (b && !validBarcode(b)) throw Error("Barkod 4–64 karakter olmalı.");
    button.disabled = true;
    await updateProducts((list) => {
      if (b && list.some((p) => p.id !== id && p.barcode === b))
        throw Error("Bu barkod başka üründe kayıtlı.");
      let p = list.find((p) => p.id === id);
      if (!p) throw Error("Ürün artık kayıtlı değil.");
      Object.assign(p, { barcode: b, price, cost });
    });
    cart.forEach((r) => {
      if (r.id === id) r.unit = RegisterCore.cents(price);
    });
  } catch (err) {
    button.disabled = false;
    return showError(form, err.message);
  }
  closeModal();
  render();
  toast("Ürün bilgileri güncellendi.");
}
const paymentNames = { cash: "Nakit", card: "Kart", credit: "Veresiye" };
const kindNames = { sale: "Satış", internal: "İşletme içi kullanım", collection: "Borç tahsilatı" };
function customerName(id) {
  return reg.customers.find((c) => c.id === id)?.name || "Müşteri hesabı";
}
function receiptDetails(t) {
  return `<details class="historyDetail"><summary><span><strong>#${String(t.number).padStart(4, "0")} · ${kindNames[t.kind]}</strong><br>${esc(t.date)} · ${esc(t.time)}${t.customerId ? " · " + esc(customerName(t.customerId)) : ""}</span><span class="pill ${t.kind === "sale" ? "ok" : ""}">${t.kind === "internal" ? "Ciroya eklenmez" : moneyKurus(t.total)}${t.payment ? " · " + paymentNames[t.payment] : ""}</span></summary>${t.items.length ? `<div class="tablewrap"><table><thead><tr><th>Ürün</th><th>Miktar</th><th>Tutar</th></tr></thead><tbody>${t.items.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.q}</td><td>${t.kind === "sale" ? moneyKurus(p.total) : "—"}</td></tr>`).join("")}</tbody></table></div>` : ""}${t.note ? `<p class="muted">Açıklama: ${esc(t.note)}</p>` : ""}${t.kind === "internal" ? `<p class="muted">Tüketim maliyeti: ${t.cost === null ? "Alış maliyeti eksik; hesaplanamadı." : moneyKurus(t.cost)}</p>` : ""}</details>`;
}
// The last 50 entries by number, newest first, straight from the "number" index.
async function showHistory() {
  let list;
  try {
    list = regProblem
      ? []
      : await Store.getAll("entries", null, { index: "number", direction: "prev", limit: 50 });
  } catch (e) {
    return toast("Son işlemler okunamadı: " + storageMessage(e));
  }
  modal(
    "Son işlemler",
    `<p class="muted">Bu tarayıcıdaki son 50 tamamlanmış işlem. Sepette bekleyen ürünler kaydedilmiş satış değildir.</p>${list.length ? list.map(receiptDetails).join("") : '<div class="empty">Henüz tamamlanmış işlem yok.</div>'}`,
  );
}
function creditScreen() {
  return (
    title(
      "Veresiye hesapları",
      "Müşteri borçları ve sonradan yapılan tahsilatlar.",
      `<button onclick="navigate('sales')">+ Yeni satış</button>`,
    ) +
    `<div class="reportBanner">Veresiye satış ciroya bir kez eklenir. Sonraki borç ödemeleri tahsilattır; yeni satış oluşturmaz.</div><div class="creditCards">${reg.customers.length ? reg.customers.map((c) => `<section class="card creditCard"><h2>${esc(c.name)}</h2><p class="muted">Hesap ${c.id.slice(0, 8)}</p><div class="value">${moneyKurus(customerBalance(c.id))}</div><p class="muted">Kalan borç</p><button class="primary" style="margin-top:15px" onclick="collectDebt('${esc(c.id)}')" ${customerBalance(c.id) > 0 ? "" : "disabled"}>Tahsilat kaydet</button></section>`).join("") : '<section class="card panel"><h2>Henüz müşteri hesabı yok</h2><p class="subtitle">Satış ekranında Veresiye → Yeni müşteri seçerek ilk hesabı oluşturun.</p></section>'}</div>`
  );
}
function collectDebt(id) {
  modal(
    "Borç tahsilatı",
    `<form onsubmit="saveCollection(event,'${esc(id)}')"><h3>${esc(customerName(id))}</h3><p>Kalan borç: <strong>${moneyKurus(customerBalance(id))}</strong></p><label class="field">Ödenen tutar (TL)<input name="amount" type="number" min="0.01" max="${customerBalance(id) / 100}" step="0.01" required></label><label class="field">Tahsilat türü<select name="payment"><option value="cash">Nakit</option><option value="card">Kart</option></select></label><p class="muted">Bu kayıt müşteri borcunu azaltır. Stok ve satış cirosu değişmez.</p><p id="collectionError" class="danger" role="alert"></p><button class="primary">Tahsilatı kaydet</button></form>`,
  );
}
async function saveCollection(e, id) {
  e.preventDefault();
  if (collecting) return;
  collecting = true;
  let form = e.target,
    d = new FormData(form),
    btn = form.querySelector("button");
  btn.disabled = true;
  try {
    await commitEntry({
      id: uid(),
      kind: "collection",
      customerId: id,
      amount: d.get("amount"),
      payment: d.get("payment"),
      date: todayTR(),
      time: timeTR(),
    });
    closeModal();
    render();
    toast("Tahsilat kaydedildi; ciro değişmedi.");
  } catch (err) {
    showError(form, err.message);
    btn.disabled = false;
  } finally {
    collecting = false;
  }
}

const salesPage = {
  id: "sales",
  label: "Satış",
  icon: "sale",
  render: posScreen,
  afterRender({ entered }) {
    drawQuickProducts();
    if (entered) document.getElementById("posBarcode")?.focus();
  },
  badge: () => "Bu cihaz · yerel kayıt",
};
const creditPage = {
  id: "credit",
  label: "Veresiye",
  icon: "credit",
  // Balances are kept current after each commit; entering the page re-reads them from the customerId index.
  load: loadBalances,
  render: creditScreen,
  badge: () => "Bu cihaz · yerel kayıt",
};

// ---------- Overview parts (used by overview.js when no report is loaded) ----------
// Today and the six days before it, oldest first (Türkiye dates).
function lastSevenDays() {
  return Array.from({ length: 7 }, (_, i) => {
    let dt = new Date(todayTR() + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() - 6 + i);
    return dt.toISOString().slice(0, 10);
  });
}
// Needs loadDays(lastSevenDays()) (overviewPage.load).
function registerOverviewParts() {
  let d = registerDaily(todayTR()),
    vals = lastSevenDays().map((day) => ({ day, value: registerDaily(day).revenue })),
    max = Math.max(...vals.map((v) => v.value), 1),
    pts = vals.map((v, i) => `${40 + i * 82},${210 - (v.value / max) * 150}`).join(" ");
  return {
    subtitle: "Bugünkü kasa kayıtları ve öncelikli stoklar.",
    buttons: `<button onclick="navigate('reports')">Rapor yükle</button><button class="primary" onclick="navigate('sales')">+ Yeni satış</button>`,
    note: "",
    stats: [
      { head: "Bugünkü satış cirosu", value: moneyKurus(d.revenue), trend: "Nakit, kart ve yeni veresiye" },
      {
        head: "Satılan miktar",
        value: d.items.reduce((n, p) => n + p.q, 0) + " adet",
        trend: "İşletme içi kullanım hariç",
      },
      { head: "Takip edilen ürün", value: products.length, trend: "Bu cihazın ürün listesi" },
      { head: "Kritik stok", value: lowStock().length + " ürün", trend: "Alt sınırın altında" },
    ],
    chartPanel: `<section class="card panel"><div class="paneltop"><div><h2>Son 7 günün satışları</h2><p class="muted">Kaydedilmiş kasa satışları · Türkiye saati</p></div></div><svg class="chart" viewBox="0 0 580 250" role="img" aria-label="Son yedi günün kasa cirosu"><path d="M35 215h510" stroke="#eee"/><polyline points="${pts}" fill="none" stroke="#b42434" stroke-width="3"/>${vals.map((v, i) => `<text x="${35 + i * 82}" y="240" font-size="10" fill="#97878e">${v.day.slice(8)}.${v.day.slice(5, 7)}</text>`).join("")}</svg><div class="legend">Veresiye tahsilatı satış cirosuna eklenmez.</div><div class="insight">Bu cihazda tamamlanmış ${d.sales.length} satış kaydı var.</div></section>`,
    sidePanel: `<section class="card panel assistant"><div class="paneltop"><h2>Günün kısa özeti</h2><span class="agentBadge">Yerel kayıt</span></div><div class="agentitem"><div><h3>İşletme içi kullanım</h3><p>${d.internalQty} adet · Ciroya eklenmedi.</p></div></div><div class="agentitem"><div><h3>Yeni veresiye</h3><p>${moneyKurus(d.credit)} · Satış cirosuna dahil.</p></div></div><div class="agentitem"><div><h3>Borç tahsilatı</h3><p>${moneyKurus(d.collected)} · Ayrı kaydedildi.</p></div></div><button class="link" onclick="navigate('dayEnd')">Gün sonunu incele →</button></section>`,
    stockTitle: "Öncelikli stoklar",
    stockSubtitle: "Stok alt sınırlarını ürün bazında düzenleyebilirsiniz.",
    after: "",
  };
}
