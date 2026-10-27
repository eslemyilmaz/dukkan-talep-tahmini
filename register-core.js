/* Pure register rules: money in kurus, each commit returns one new snapshot. */
(function (root) {
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function cents(value) {
    let n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1e9) throw Error("Geçerli bir tutar girin.");
    return Math.round((n + Number.EPSILON) * 100);
  }
  function balance(s, id) {
    return s.entries.reduce(
      (sum, t) =>
        sum +
        (t.kind === "sale" && t.payment === "credit" && t.customerId === id ? t.total : 0) -
        (t.kind === "collection" && t.customerId === id ? t.total : 0),
      0,
    );
  }
  function commit(state, request) {
    let s = clone(state);
    if (s.entries.some((e) => e.id === request.id)) throw Error("Bu işlem daha önce kaydedildi.");
    if (!request.id) throw Error("İşlem kimliği eksik.");
    if (request.kind === "collection") {
      if (!s.customers.some((c) => c.id === request.customerId)) throw Error("Müşteri bulunamadı.");
      if (!["cash", "card"].includes(request.payment)) throw Error("Tahsilat türünü seçin.");
      let total = cents(request.amount);
      if (total <= 0 || total > balance(s, request.customerId))
        throw Error("Tahsilat, kalan borçtan fazla veya sıfır olamaz.");
      s.entries.push({
        id: request.id,
        kind: "collection",
        date: request.date,
        time: request.time,
        customerId: request.customerId,
        payment: request.payment,
        total,
        items: [],
        number: s.nextNumber++,
      });
      s.rev++;
      return s;
    }
    if (!["sale", "internal"].includes(request.kind)) throw Error("İşlem türü geçersiz.");
    if (!request.items?.length) throw Error("Sepet boş.");
    if (request.kind === "internal" && !request.note?.trim())
      throw Error("İşletme içi kullanım açıklaması yazın.");
    if (request.kind === "sale" && !["cash", "card", "credit"].includes(request.payment))
      throw Error("Ödeme türünü seçin.");
    let customerId = request.customerId || null;
    if (request.kind === "sale" && request.payment === "credit") {
      if (request.newCustomer) {
        let name = String(request.newCustomer.name || "").trim();
        if (!name || name.length > 80) throw Error("Müşteri adını girin (en fazla 80 karakter).");
        if (!request.newCustomer.id || s.customers.some((c) => c.id === request.newCustomer.id))
          throw Error("Müşteri kimliği geçersiz.");
        customerId = request.newCustomer.id;
        s.customers.push({ id: customerId, name });
      }
      if (!s.customers.some((c) => c.id === customerId)) throw Error("Veresiye için bir müşteri seçin.");
    } else customerId = null;
    let unique = new Set(),
      items = request.items.map((row) => {
        if (unique.has(row.id)) throw Error("Sepette yinelenen ürün var.");
        unique.add(row.id);
        let p = s.products.find((p) => p.id === row.id);
        if (!p) throw Error("Ürün artık kayıtlı değil.");
        if (!Number.isSafeInteger(row.q) || row.q < 1 || row.q > 999999)
          throw Error("Ürün miktarı pozitif tam sayı olmalı.");
        if (!Number.isFinite(p.stock) || p.stock < row.q) throw Error(p.name + ": yeterli stok yok.");
        let unit = request.kind === "sale" ? cents(p.price) : 0;
        if (request.kind === "sale" && (unit <= 0 || unit !== row.unit))
          throw Error(p.name + ": fiyat eksik veya değişti. Sepeti yeniden kontrol edin.");
        let cost = p.cost === null || p.cost === undefined || p.cost === "" ? null : cents(p.cost);
        p.stock -= row.q;
        return {
          id: p.id,
          name: p.name,
          barcode: p.barcode || "",
          category: p.category || "",
          q: row.q,
          unit: request.kind === "sale" ? unit : 0,
          total: request.kind === "sale" ? unit * row.q : 0,
          cost: cost === null ? null : cost * row.q,
        };
      });
    let total = items.reduce((a, p) => a + p.total, 0);
    if (!Number.isSafeInteger(total)) throw Error("İşlem tutarı sınırı aşıldı.");
    s.entries.push({
      id: request.id,
      number: s.nextNumber++,
      kind: request.kind,
      payment: request.kind === "sale" ? request.payment : null,
      customerId,
      note: String(request.note || "")
        .trim()
        .slice(0, 300),
      date: request.date,
      time: request.time,
      items,
      total,
      cost: items.every((p) => p.cost !== null) ? items.reduce((a, p) => a + p.cost, 0) : null,
    });
    s.rev++;
    return s;
  }
  function daily(s, date) {
    let entries = s.entries.filter((t) => t.date === date),
      sales = entries.filter((t) => t.kind === "sale"),
      internal = entries.filter((t) => t.kind === "internal"),
      collections = entries.filter((t) => t.kind === "collection"),
      items = {};
    sales.forEach((t) =>
      t.items.forEach((p) => {
        let k = p.id;
        let it = items[k] || (items[k] = { ...p, q: 0, total: 0 });
        it.q += p.q;
        it.total += p.total;
      }),
    );
    return {
      entries,
      sales,
      internal,
      collections,
      items: Object.values(items),
      revenue: sales.reduce((a, t) => a + t.total, 0),
      cash: sales.filter((t) => t.payment === "cash").reduce((a, t) => a + t.total, 0),
      card: sales.filter((t) => t.payment === "card").reduce((a, t) => a + t.total, 0),
      credit: sales.filter((t) => t.payment === "credit").reduce((a, t) => a + t.total, 0),
      collected: collections.reduce((a, t) => a + t.total, 0),
      internalQty: internal.reduce((a, t) => a + t.items.reduce((n, p) => n + p.q, 0), 0),
      internalCost: internal.every((t) => t.cost !== null) ? internal.reduce((a, t) => a + t.cost, 0) : null,
    };
  }
  root.RegisterCore = { commit, balance, daily, cents };
  if (typeof module !== "undefined") module.exports = root.RegisterCore;
})(typeof globalThis !== "undefined" ? globalThis : this);
