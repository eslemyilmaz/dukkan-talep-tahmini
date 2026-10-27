const REGISTER_KEY = "dukkan-register-v1",
  uid = () =>
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join(
          "",
        ),
  todayTR = () =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  timeTR = () =>
    new Intl.DateTimeFormat("tr-TR", {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date()),
  priceText = (c) =>
    new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 2 }).format(
      c / 100,
    );
let reg = null,
  regProblem = "",
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
  registerDate = todayTR(),
  daySource = "register";
function readRegister() {
  let raw = localStorage.getItem(REGISTER_KEY);
  if (!raw) return null;
  let s = JSON.parse(raw);
  if (
    s.version !== 1 ||
    !Array.isArray(s.products) ||
    !Array.isArray(s.entries) ||
    !Array.isArray(s.customers)
  )
    throw Error("Kasa kayıt biçimi okunamadı.");
  return s;
}
function adopt(s) {
  reg = s;
  products = s.products.map((p) => ({ ...p }));
}
function persistRegister(s) {
  localStorage.setItem(REGISTER_KEY, JSON.stringify(s));
  adopt(s);
  try {
    localStorage.setItem("dukkan-products", JSON.stringify(products));
  } catch {}
}
try {
  let saved = readRegister();
  if (saved) adopt(saved);
  else {
    let s = {
      version: 1,
      rev: 0,
      nextNumber: 1,
      products: products.map((p) => ({ ...p, id: p.id || uid(), cost: p.cost ?? null })),
      entries: [],
      customers: [],
    };
    persistRegister(s);
  }
} catch (e) {
  regProblem = "Kasa kayıtları açılamadı. Tarayıcı depolamasını kontrol edin; mevcut veriler silinmedi.";
  reg = {
    version: 1,
    rev: 0,
    nextNumber: 1,
    products: products.map((p) => ({ ...p, id: p.id || uid() })),
    entries: [],
    customers: [],
  };
}
// Stock edits made by existing forms use the same authoritative snapshot.
save = function () {
  try {
    if (regProblem) throw Error(regProblem);
    let latest = readRegister();
    if (latest && latest.rev !== reg.rev) {
      adopt(latest);
      throw Error("Başka sekmede stok değişti. Sayfayı yenileyip işlemi tekrar deneyin.");
    }
    let next = { ...reg, rev: reg.rev + 1, products: products.map((p) => ({ ...p, id: p.id || uid() })) };
    persistRegister(next);
  } catch (e) {
    let last;
    try {
      last = readRegister();
    } catch {}
    if (last) adopt(last);
    toast("Kaydedilemedi: " + e.message);
    throw e;
  }
};
window.addEventListener("storage", (e) => {
  if (e.key === REGISTER_KEY && e.newValue) {
    try {
      adopt(JSON.parse(e.newValue));
      render();
      toast("Kayıtlar diğer sekmeden güncellendi.");
    } catch {}
  }
});
const coreNavigate = navigate;
navigate = function (p) {
  coreNavigate(p);
  if (p === "Satış") setTimeout(() => document.getElementById("posBarcode")?.focus(), 0);
};
paths.sale = "M3 3h2l3 12h10l3-8H6 M9 20h.01 M18 20h.01";
paths.credit = "M3 5h18v15H3z M3 9h18 M7 14h4";
if (!pages.some(([p]) => p === "Satış")) pages.splice(1, 0, ["Satış", "sale"]);
if (!pages.some(([p]) => p === "Veresiye"))
  pages.splice(
    pages.findIndex(([p]) => p === "Asistan"),
    0,
    ["Veresiye", "credit"],
  );
function regNav() {
  document.getElementById("nav").innerHTML = pages
    .map(
      ([p, i]) =>
        `<button class="${page === p ? "active" : ""}" onclick="navigate('${p}')">${ico(i)}<span>${p}</span></button>`,
    )
    .join("");
  document.getElementById("crumb").textContent = page;
}
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
    let p = products.find((p) => p.id === r.id);
    r.unit = mode === "sale" ? RegisterCore.cents(p?.price || 0) : 0;
  });
  render();
}
function posScreen() {
  return `<div class="posHeading"><div><h1>Satış ekranı</h1><p class="subtitle">Ürünleri okutun, sepete ekleyin, işlemi tamamlayın.</p></div><div class="posSecondary"><button onclick="showHistory()">◷ Son işlemler</button><button onclick="navigate('Gün sonu')">Gün sonu →</button></div></div>${regProblem ? `<div class="note">${esc(regProblem)}</div>` : ""}<div class="posLayout"><section><div class="posModes" aria-label="İşlem türü"><button class="${posMode === "sale" ? "chosen" : ""}" onclick="modeChange('sale')">Satış</button><button class="${posMode === "internal" ? "chosen" : ""}" onclick="modeChange('internal')">İşletme içi kullanım</button></div><p class="posHelp">${posMode === "sale" ? "Barkodla veya ürün kartına dokunarak sepete ekleyin." : "Bu işlem stoktan düşer; ciroya ve müşteri talebine eklenmez."}</p><form class="scanBox" onsubmit="posScan(event)">${ico("stock")}<input id="posBarcode" aria-label="Satış barkodu veya ürün arama" autocomplete="off" placeholder="Barkodu okutun veya ürün arayın" value="${esc(posQuery)}" oninput="posQuery=this.value;drawQuickProducts()"><button type="submit">Ekle ↵</button></form><div class="posStatus" id="posStatus" role="status"></div><div class="posFilters">${[
    ["all", "Tümü"],
    ["bread", "Ekmek"],
    ["drink", "İçecek"],
    ["dairy", "Süt ürünleri"],
    ["tobacco", "Tütün"],
  ]
    .map(
      ([id, t]) =>
        `<button class="${posCategory === id ? "chosen" : ""}" onclick="posCategory='${id}';render()">${t}</button>`,
    )
    .join(
      "",
    )}</div><div class="posSearchTitle"><h2>Hızlı ürünler</h2><button class="link" onclick="addProduct()">+ Ürün ekle</button></div><div id="quickProducts" class="quickProducts"></div><div class="posNotice"><span class="greenDot"></span><span><strong>Barkod girişi</strong><br>Klavye modunda USB / Bluetooth okuyucu · Barkod alanına dokunun, okutun. Enter ile ürün eklenir. Fiziksel okuyucunuzla bağlantı henüz test edilmedi.</span></div><p class="deviceNote">Kayıtlar yalnızca bu cihazın tarayıcısında saklanır. Kart seçimi ödeme kaydıdır; banka/POS cihazından ödeme çekmez. Mali fiş düzenlemez.</p></section><section class="posReceipt" aria-label="Sepet"><div class="receiptTop"><h2>${posMode === "internal" ? "Kullanım listesi" : "Sepet"}</h2><span class="agentBadge">${cart.length} ürün çeşidi</span><button class="smallbtn" onclick="clearCart()" ${cart.length ? "" : "disabled"}>Temizle</button></div><div class="receiptItems">${
    cart.length
      ? cart
          .map((r, i) => {
            let p = products.find((p) => p.id === r.id) || r;
            return `<div class="receiptItem">${productMark(p)}<div><strong>${esc(p.name)}</strong><div class="muted" style="margin-top:4px">${posMode === "sale" ? priceText(r.unit) + " / adet" : "İşletme içi kullanım"}</div><div class="qtyControl"><button aria-label="${esc(p.name)} miktarını azalt" onclick="changeCart(${i},-1)">−</button><span>${r.q}</span><button aria-label="${esc(p.name)} miktarını artır" onclick="changeCart(${i},1)">+</button></div></div><div><div class="lineTotal">${posMode === "sale" ? priceText(r.q * r.unit) : r.q + " adet"}</div><button class="removeLine" aria-label="${esc(p.name)} sepetten çıkar" onclick="cart.splice(${i},1);render()">×</button></div></div>`;
          })
          .join("")
      : '<div class="posEmpty">Sepetiniz hazır.<br>Bir ürün okutun veya soldaki kartlardan seçin.</div>'
  }</div><div class="receiptFoot"><div class="receiptTotals"><span class="muted">Toplam miktar</span><b>${cart.reduce((s, p) => s + p.q, 0)} adet</b></div>${
    posMode === "sale"
      ? `<div class="receiptTotals"><b>Genel toplam</b><strong>${priceText(cartTotal())}</strong></div><label style="font-size:12px;font-weight:600">Ödeme türü</label><div class="payments">${[
          ["cash", "Nakit"],
          ["card", "Kart"],
          ["credit", "Veresiye"],
        ]
          .map(
            ([id, t]) =>
              `<button class="${posPayment === id ? "chosen" : ""}" onclick="posPayment='${id}';render()">${t}</button>`,
          )
          .join(
            "",
          )}</div>${posPayment === "credit" ? `<label class="field">Müşteri hesabı<select id="posCustomer" onchange="posCustomer=this.value;render()"><option value="">Müşteri seçin</option>${reg.customers.map((c) => `<option value="${esc(c.id)}" ${posCustomer === c.id ? "selected" : ""}>${esc(c.name)} · ${c.id.slice(0, 4)} · ${priceText(RegisterCore.balance(reg, c.id))}</option>`).join("")}<option value="new" ${posCustomer === "new" ? "selected" : ""}>+ Yeni müşteri</option></select></label>${posCustomer === "new" ? `<label class="field">Yeni müşteri adı<input maxlength="80" value="${esc(posNewName)}" oninput="posNewName=this.value" placeholder="Ad / hesap adı"></label>` : ""}<p class="muted">Satış tutarı müşteri borcuna eklenir; şu an tahsilat yapılmaz.</p>` : ""}`
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
          let i = products.indexOf(p);
          return `<article class="quickProduct">${productMark(p)}<h3>${esc(p.name)}</h3><div class="tileBottom"><span class="productPrice">${priceText(RegisterCore.cents(p.price || 0))}</span><button class="tileAdd" aria-label="${esc(p.name)} sepete ekle" onclick="addToCart('${p.id}')" ${p.stock > 0 ? "" : "disabled"}>+</button></div><p class="muted">Stok: ${fmt(p.stock)} adet${p.barcode ? " · " + esc(p.barcode) : ""}</p><button class="tileEdit" onclick="editRegisterProduct('${p.id}')">Fiyat / barkod / maliyet</button></article>`;
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
  cart = [];
  cartId = uid();
  posNote = "";
  posNewName = "";
  posCustomer = "";
  posQuery = "";
  render();
}
async function locked(fn) {
  return navigator.locks ? navigator.locks.request("dukkan-register-write", fn) : fn();
}
async function completeRegister() {
  if (posBusy || !cart.length) return;
  posBusy = true;
  document.querySelector(".checkout")?.setAttribute("disabled", "");
  try {
    await locked(() => {
      let latest = readRegister();
      if (!latest) throw Error("Kasa kaydı bulunamadı.");
      let request = {
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
        },
        next = RegisterCore.commit(latest, request);
      persistRegister(next);
    });
    let wasInternal = posMode === "internal";
    cart = [];
    cartId = uid();
    posNote = "";
    posNewName = "";
    posCustomer = "";
    posQuery = "";
    registerDate = todayTR();
    toast(
      wasInternal
        ? "İşletme içi kullanım kaydedildi. Ciro değişmedi."
        : "Satış kaydedildi; stok güncellendi.",
    );
  } catch (e) {
    try {
      let s = readRegister();
      if (s) adopt(s);
    } catch {}
    toast("İşlem kaydedilmedi: " + e.message);
    setTimeout(() => pStatus(e.message), 0);
  } finally {
    posBusy = false;
    render();
    document.getElementById("posBarcode")?.focus();
  }
}
function editRegisterProduct(id) {
  let p = products.find((p) => p.id === id);
  if (!p) return;
  modal(
    "Ürün bilgileri",
    `<form onsubmit="saveRegisterProduct(event,'${id}')"><p>${esc(p.name)}</p><label class="field">Barkod<input name="barcode" value="${esc(p.barcode || "")}" maxlength="64"></label><label class="field">Satış fiyatı (TL)<input name="price" type="number" min="0" max="1000000000" step="0.01" required value="${p.price}"></label><label class="field">Alış maliyeti (TL) · isteğe bağlı<input name="cost" type="number" min="0" max="1000000000" step="0.01" value="${p.cost ?? ""}" placeholder="Bilinmiyorsa boş bırakın"></label><p id="productSaveError" role="alert" class="danger"></p><button class="primary">Kaydet</button></form>`,
  );
}
function saveRegisterProduct(e, id) {
  e.preventDefault();
  try {
    let d = new FormData(e.target),
      b = String(d.get("barcode")).trim();
    if (b && !validBarcode(b)) throw Error("Barkod 4–64 karakter olmalı.");
    if (b && products.some((p) => p.id !== id && p.barcode === b))
      throw Error("Bu barkod başka üründe kayıtlı.");
    let p = products.find((p) => p.id === id);
    p.barcode = b;
    p.price = RegisterCore.cents(d.get("price")) / 100;
    p.cost = d.get("cost") === "" ? null : RegisterCore.cents(d.get("cost")) / 100;
    save();
    cart.forEach((r) => {
      if (r.id === id) r.unit = RegisterCore.cents(p.price);
    });
    document.getElementById("modal").close();
    render();
    toast("Ürün bilgileri güncellendi.");
  } catch (err) {
    document.getElementById("productSaveError").textContent = err.message;
  }
}
const paymentNames = { cash: "Nakit", card: "Kart", credit: "Veresiye" };
const kindNames = { sale: "Satış", internal: "İşletme içi kullanım", collection: "Borç tahsilatı" };
function customerName(id) {
  return reg.customers.find((c) => c.id === id)?.name || "Müşteri hesabı";
}
function receiptDetails(t) {
  return `<details class="historyDetail"><summary><span><strong>#${String(t.number).padStart(4, "0")} · ${kindNames[t.kind]}</strong><br>${esc(t.date)} · ${esc(t.time)}${t.customerId ? " · " + esc(customerName(t.customerId)) : ""}</span><span class="pill ${t.kind === "sale" ? "ok" : ""}">${t.kind === "internal" ? "Ciroya eklenmez" : priceText(t.total)}${t.payment ? " · " + paymentNames[t.payment] : ""}</span></summary>${t.items.length ? `<div class="tablewrap"><table><thead><tr><th>Ürün</th><th>Miktar</th><th>Tutar</th></tr></thead><tbody>${t.items.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.q}</td><td>${t.kind === "sale" ? priceText(p.total) : "—"}</td></tr>`).join("")}</tbody></table></div>` : ""}${t.note ? `<p class="muted">Açıklama: ${esc(t.note)}</p>` : ""}${t.kind === "internal" ? `<p class="muted">Tüketim maliyeti: ${t.cost === null ? "Alış maliyeti eksik; hesaplanamadı." : priceText(t.cost)}</p>` : ""}</details>`;
}
function showHistory() {
  modal(
    "Son işlemler",
    `<p class="muted">Bu tarayıcıdaki son 50 tamamlanmış işlem. Sepette bekleyen ürünler kaydedilmiş satış değildir.</p>${reg.entries.length ? [...reg.entries].reverse().slice(0, 50).map(receiptDetails).join("") : '<div class="empty">Henüz tamamlanmış işlem yok.</div>'}`,
  );
}
function creditScreen() {
  return (
    title(
      "Veresiye hesapları",
      "Müşteri borçları ve sonradan yapılan tahsilatlar.",
      `<button onclick="navigate('Satış')">+ Yeni satış</button>`,
    ) +
    `<div class="reportBanner">Veresiye satış ciroya bir kez eklenir. Sonraki borç ödemeleri tahsilattır; yeni satış oluşturmaz.</div><div class="creditCards">${reg.customers.length ? reg.customers.map((c) => `<section class="card creditCard"><h2>${esc(c.name)}</h2><p class="muted">Hesap ${c.id.slice(0, 8)}</p><div class="value">${priceText(RegisterCore.balance(reg, c.id))}</div><p class="muted">Kalan borç</p><button class="primary" style="margin-top:15px" onclick="collectDebt('${c.id}')" ${RegisterCore.balance(reg, c.id) > 0 ? "" : "disabled"}>Tahsilat kaydet</button></section>`).join("") : '<section class="card panel"><h2>Henüz müşteri hesabı yok</h2><p class="subtitle">Satış ekranında Veresiye → Yeni müşteri seçerek ilk hesabı oluşturun.</p></section>'}</div>`
  );
}
function collectDebt(id) {
  modal(
    "Borç tahsilatı",
    `<form onsubmit="saveCollection(event,'${id}')"><h3>${esc(customerName(id))}</h3><p>Kalan borç: <strong>${priceText(RegisterCore.balance(reg, id))}</strong></p><label class="field">Ödenen tutar (TL)<input name="amount" type="number" min="0.01" max="${RegisterCore.balance(reg, id) / 100}" step="0.01" required></label><label class="field">Tahsilat türü<select name="payment"><option value="cash">Nakit</option><option value="card">Kart</option></select></label><p class="muted">Bu kayıt müşteri borcunu azaltır. Stok ve satış cirosu değişmez.</p><p id="collectionError" class="danger" role="alert"></p><button class="primary">Tahsilatı kaydet</button></form>`,
  );
}
let collecting = false;
async function saveCollection(e, id) {
  e.preventDefault();
  if (collecting) return;
  collecting = true;
  let d = new FormData(e.target),
    btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    await locked(() => {
      let latest = readRegister(),
        next = RegisterCore.commit(latest, {
          id: uid(),
          kind: "collection",
          customerId: id,
          amount: d.get("amount"),
          payment: d.get("payment"),
          date: todayTR(),
          time: timeTR(),
        });
      persistRegister(next);
    });
    document.getElementById("modal").close();
    render();
    toast("Tahsilat kaydedildi; ciro değişmedi.");
  } catch (err) {
    document.getElementById("collectionError").textContent = err.message;
    btn.disabled = false;
  } finally {
    collecting = false;
  }
}
function localDayTable(items) {
  let rows = [...items].sort(
      (a, b) => (endSort === "revenue" ? b.total - a.total : b.q - a.q) || a.name.localeCompare(b.name, "tr"),
    ),
    total = items.reduce((s, p) => s + p.total, 0);
  return `<section class="card panel"><div class="paneltop"><div><div class="eyebrow">Kasa kayıtları</div><h2>En çok satılan ürünler</h2></div><select aria-label="Yerel ürün sıralaması" onchange="endSort=this.value;render()"><option value="quantity" ${endSort === "quantity" ? "selected" : ""}>Miktara göre</option><option value="revenue" ${endSort === "revenue" ? "selected" : ""}>Tutara göre</option></select></div><div class="tablewrap"><table><thead><tr><th>Sıra</th><th>Ürün</th><th>Satılan adet</th><th>Tutar</th><th>Gelir payı</th></tr></thead><tbody>${
    rows.length
      ? rows
          .slice(0, 20)
          .map(
            (p, i) =>
              `<tr><td><span class="rank ${i ? "" : "first"}">${i + 1}</span></td><td>${productLabel(p)}</td><td>${p.q}</td><td>${priceText(p.total)}</td><td>%${total ? ((p.total / total) * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 }) : "0"}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="empty">Bu tarihte kaydedilmiş satış yok.</td></tr>'
  }</tbody></table></div><p class="dayEndNote">İşletme içi kullanım ve borç tahsilatları satış sıralamasına dahil değildir.</p></section>`;
}
const importedDayEnd = dayEnd;
dayEnd = function () {
  let toggle = `<div class="registerSource"><button class="${daySource === "register" ? "primary" : ""}" onclick="daySource='register';render()">Kasa kayıtları</button><button class="${daySource === "import" ? "primary" : ""}" onclick="daySource='import';render()">Yüklenen geçmiş rapor</button></div>`;
  if (daySource === "import") return toggle + importedDayEnd();
  let d = RegisterCore.daily(reg, registerDate);
  return (
    title(
      "Gün sonu",
      "Satışlar, işletme içi kullanım ve tahsilatlar ayrı ayrı.",
      `<button onclick="showHistory()">Son işlemler</button>`,
    ) +
    toggle +
    `<label class="field" style="max-width:230px">Gün · Türkiye saati<input type="date" aria-label="Kasa rapor günü" value="${registerDate}" onchange="if(this.value){registerDate=this.value;render()}"></label><div class="registerSummary">${[
      ["Satış cirosu", priceText(d.revenue), "Nakit + kart + yeni veresiye"],
      ["Yeni veresiye", priceText(d.credit), "Seçilen günün borçlu satışları"],
      ["Borç tahsilatı", priceText(d.collected), "Ciroya ikinci kez eklenmez"],
      ["İşletme içi kullanım", d.internalQty + " adet", "Satış sıralamasına dahil değil"],
    ]
      .map(
        ([a, b, c]) =>
          `<div class="card"><p class="muted">${a}</p><strong>${b}</strong><span class="muted">${c}</span></div>`,
      )
      .join(
        "",
      )}</div><div class="moneyGrid" style="margin-bottom:20px"><div class="card"><p class="muted">Nakit satış</p><h2>${priceText(d.cash)}</h2></div><div class="card"><p class="muted">Kart satış</p><h2>${priceText(d.card)}</h2></div><div class="card"><p class="muted">İşletme içi tüketim maliyeti</p><h2>${d.internalCost === null ? "Maliyet eksik" : priceText(d.internalCost)}</h2><p class="muted">Cirodan düşülmez; maliyet değerlendirmesinde ayrı izlenir.</p></div></div>${localDayTable(d.items)}<section class="card panel bottom"><div class="paneltop"><h2>Günün işlemleri</h2><span class="muted">${d.entries.length} kayıt</span></div>${d.entries.length ? [...d.entries].reverse().slice(0, 30).map(receiptDetails).join("") : '<p class="subtitle">Seçili günde işlem yok. Satış ekranından yeni kayıt oluşturabilirsiniz.</p>'}</section><p class="deviceNote">Kasa kayıtları ve yüklenen geçmiş rapor otomatik toplanmaz; aynı satışın iki kez sayılmasını önlemek için kaynaklar ayrı görüntülenir.</p>`
  );
};
const beforeRegisterRender = render;
render = function () {
  if (page === "Satış" || page === "Veresiye") {
    let target = page;
    page = "Raporlar";
    beforeRegisterRender();
    page = target;
    regNav();
    document.getElementById("content").innerHTML = target === "Satış" ? posScreen() : creditScreen();
    document.querySelector(".demo").textContent = "Bu cihaz · yerel kayıt";
    if (target === "Satış") drawQuickProducts();
    return;
  }
  beforeRegisterRender();
  regNav();
  if (page === "Gün sonu" && daySource === "register")
    document.querySelector(".demo").textContent = "Bu cihaz · yerel kayıt";
  if (page === "Genel bakış") {
    document
      .getElementById("content")
      .insertAdjacentHTML(
        "afterbegin",
        `<div class="reportBanner" style="justify-content:space-between"><span>Yeni kasa ekranı · Barkod, veresiye ve işletme içi kullanım</span><button class="primary" onclick="navigate('Satış')">Satışa başla →</button></div>`,
      );
    document
      .querySelector(".bottom")
      ?.insertAdjacentHTML(
        "beforebegin",
        `<div class="card panel" style="margin-top:22px"><div class="paneltop"><div><h2>Bugünkü kasa kayıtları</h2><p class="muted">Geçmiş rapor ve örnek verilerden ayrı tutulur.</p></div><button class="softLink" onclick="daySource='register';navigate('Gün sonu')">Gün sonunu aç →</button></div><h2>${priceText(RegisterCore.daily(reg, todayTR()).revenue)}</h2></div>`,
      );
  }
};
// Keep new product forms compatible with the current list and optional costs.
const addWithCategories = addProduct;
addProduct = function (b = "") {
  addWithCategories(b);
  let form = document.querySelector("#mbody form");
  form
    .querySelector("button.primary")
    .insertAdjacentHTML(
      "beforebegin",
      '<label class="field">Alış maliyeti (TL) · isteğe bağlı<input name="cost" type="number" min="0" step="0.01" placeholder="Bilinmiyorsa boş bırakın"></label>',
    );
};
const submitWithBarcode = submitProduct;
submitProduct = function (e) {
  let cost = new FormData(e.target).get("cost"),
    len = products.length;
  submitWithBarcode(e);
  if (products.length > len) {
    products.at(-1).cost = cost === "" || cost === null ? null : RegisterCore.cents(cost) / 100;
    save();
  }
};
render();
// On a fresh device the overview shows recorded register activity, not sample revenue.
const reportOverview = overview;
overview = function () {
  if (salesData) return reportOverview();
  let d = RegisterCore.daily(reg, todayTR()),
    vals = Array.from({ length: 7 }, (_, i) => {
      let dt = new Date(todayTR() + "T12:00:00Z");
      dt.setUTCDate(dt.getUTCDate() - 6 + i);
      let day = dt.toISOString().slice(0, 10);
      return { day, value: RegisterCore.daily(reg, day).revenue };
    }),
    max = Math.max(...vals.map((v) => v.value), 1),
    pts = vals.map((v, i) => `${40 + i * 82},${210 - (v.value / max) * 150}`).join(" ");
  return (
    title(
      "İşletmenize genel bir bakış",
      "Bugünkü kasa kayıtları ve öncelikli stoklar.",
      `<button onclick="navigate('Raporlar')">Rapor yükle</button><button class="primary" onclick="navigate('Satış')">+ Yeni satış</button>`,
    ) +
    `<div class="stats">${[
      ["Bugünkü satış cirosu", priceText(d.revenue), "Nakit, kart ve yeni veresiye"],
      ["Satılan miktar", d.items.reduce((n, p) => n + p.q, 0) + " adet", "İşletme içi kullanım hariç"],
      ["Takip edilen ürün", products.length, "Bu cihazın ürün listesi"],
      ["Kritik stok", products.filter((p) => p.stock < p.min).length + " ürün", "Alt sınırın altında"],
    ]
      .map(
        ([a, b, c]) =>
          `<div class="card stat"><div class="stathead">${a}</div><div class="value">${b}</div><div class="trend">${c}</div></div>`,
      )
      .join(
        "",
      )}</div><div class="grid"><section class="card panel"><div class="paneltop"><div><h2>Son 7 günün satışları</h2><p class="muted">Kaydedilmiş kasa satışları · Türkiye saati</p></div></div><svg class="chart" viewBox="0 0 580 250" role="img" aria-label="Son yedi günün kasa cirosu"><path d="M35 215h510" stroke="#eee"/><polyline points="${pts}" fill="none" stroke="#b42434" stroke-width="3"/>${vals.map((v, i) => `<text x="${35 + i * 82}" y="240" font-size="10" fill="#97878e">${v.day.slice(8)}.${v.day.slice(5, 7)}</text>`).join("")}</svg><div class="legend">Veresiye tahsilatı satış cirosuna eklenmez.</div><div class="insight">Bu cihazda tamamlanmış ${d.sales.length} satış kaydı var.</div></section><section class="card panel assistant"><div class="paneltop"><h2>Günün kısa özeti</h2><span class="agentBadge">Yerel kayıt</span></div><div class="agentitem"><div><h3>İşletme içi kullanım</h3><p>${d.internalQty} adet · Ciroya eklenmedi.</p></div></div><div class="agentitem"><div><h3>Yeni veresiye</h3><p>${priceText(d.credit)} · Satış cirosuna dahil.</p></div></div><div class="agentitem"><div><h3>Borç tahsilatı</h3><p>${priceText(d.collected)} · Ayrı kaydedildi.</p></div></div><button class="link" onclick="navigate('Gün sonu')">Gün sonunu incele →</button></section></div><section class="card panel bottom"><div class="paneltop"><div><h2>Öncelikli stoklar</h2><p class="muted">Stok alt sınırlarını ürün bazında düzenleyebilirsiniz.</p></div><button class="link" onclick="navigate('Ürünler & stok')">Tüm ürünler →</button></div>${table([...products].sort((a, b) => a.stock / a.min - b.stock / b.min).slice(0, 4))}</section>`
  );
};
const importedOpenSales = openSales;
openSales = function () {
  if (salesData) importedOpenSales();
  else showHistory();
};
render();

const oldPhonePreview = openPhone;
openPhone = function () {
  let dialog = document.getElementById("phone");
  dialog.style.width = "";
  dialog.querySelector("h2").textContent = "Telefon görünümü";
  oldPhonePreview();
};
function openTablet() {
  let dialog = document.getElementById("phone");
  dialog.style.width = "min(1080px,96vw)";
  dialog.querySelector("h2").textContent = "Tablet görünümü";
  document.getElementById("phoneFrame").src = location.pathname + "?tablet=1";
  dialog.showModal();
}
if (location.search.includes("mobile=1") || location.search.includes("tablet=1"))
  document.querySelectorAll(".phoneButton,.tabletButton").forEach((b) => (b.style.display = "none"));
