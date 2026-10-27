"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../register-core.js");

const D = "2026-10-27";
function fresh() {
  return {
    version: 1,
    rev: 0,
    nextNumber: 1,
    products: [
      { id: "p1", name: "Çay", price: 30, cost: 15, stock: 10, barcode: "869", category: "İçecek" },
      { id: "p2", name: "Simit", price: 12.5, cost: null, stock: 5 },
      { id: "p3", name: "Su", price: 0, cost: 2, stock: 5 },
    ],
    entries: [],
    customers: [{ id: "c1", name: "Ali" }],
  };
}
let seq = 0;
const sale = (payment, items, extra = {}) => ({
  id: "t" + ++seq,
  kind: "sale",
  payment,
  date: D,
  time: "10:00",
  items,
  ...extra,
});
const tea = (q = 1) => ({ id: "p1", q, unit: 3000 });
const simit = (q = 1) => ({ id: "p2", q, unit: 1250 });
const internal = (items, extra = {}) => ({
  id: "t" + ++seq,
  kind: "internal",
  note: "Personel",
  date: D,
  time: "11:00",
  items,
  ...extra,
});
const collect = (amount, extra = {}) => ({
  id: "t" + ++seq,
  kind: "collection",
  customerId: "c1",
  payment: "cash",
  amount,
  date: D,
  time: "12:00",
  ...extra,
});
const throwsMsg = (fn, msg) => assert.throws(fn, (e) => e.message === msg);

test("cents: rounding edges", () => {
  assert.equal(R.cents(1.005), 101);
  assert.equal(R.cents(2.675), 268);
  assert.equal(R.cents(5.015), 502); // was 501 with the EPSILON formula
  assert.equal(R.cents(10000.005), 1000001); // was 1000000
  assert.equal(R.cents(0.1 + 0.2), 30);
  assert.equal(R.cents("12.34"), 1234);
  assert.equal(R.cents(1e9), 100000000000);
  throwsMsg(() => R.cents(1e9 + 0.01), "Geçerli bir tutar girin.");
  throwsMsg(() => R.cents(-1), "Geçerli bir tutar girin.");
  throwsMsg(() => R.cents("1,5"), "Geçerli bir tutar girin.");
  throwsMsg(() => R.cents(NaN), "Geçerli bir tutar girin.");
});

test("cents: every 2-decimal string up to 10 000 TL is exact", () => {
  for (let i = 0; i <= 1000000; i++) if (R.cents((i / 100).toFixed(2)) !== i) assert.fail("cents " + i);
});

test("cash sale: stock, totals, cost, numbering", () => {
  const s0 = fresh();
  const s1 = R.commit(s0, sale("cash", [tea(2), simit(1)]));
  const e = s1.entries[0];
  assert.equal(e.total, 2 * 3000 + 1250);
  assert.equal(e.number, 1);
  assert.equal(e.customerId, null);
  assert.equal(e.cost, null); // simit has no cost
  assert.deepEqual(
    e.items.map((p) => [p.id, p.q, p.unit, p.total, p.cost]),
    [
      ["p1", 2, 3000, 6000, 3000],
      ["p2", 1, 1250, 1250, null],
    ],
  );
  assert.equal(s1.products[0].stock, 8);
  assert.equal(s1.products[1].stock, 4);
  assert.equal(s1.rev, 1);
  assert.equal(s1.nextNumber, 2);
});

test("card sale ignores stray customerId", () => {
  const s = R.commit(fresh(), sale("card", [tea()], { customerId: "c1" }));
  assert.equal(s.entries[0].payment, "card");
  assert.equal(s.entries[0].customerId, null);
  assert.equal(s.entries[0].cost, 1500);
});

test("credit sale with new customer, balance and collections", () => {
  let s = R.commit(fresh(), sale("credit", [tea(3)], { newCustomer: { id: "c2", name: "  Ayşe  " } }));
  assert.deepEqual(s.customers.at(-1), { id: "c2", name: "Ayşe" });
  assert.equal(s.entries[0].customerId, "c2");
  assert.equal(R.balance(s, "c2"), 9000);
  assert.equal(R.balance(s, "c1"), 0);
  s = R.commit(s, collect("40.50", { customerId: "c2", payment: "card" }));
  assert.equal(R.balance(s, "c2"), 4950);
  throwsMsg(
    () => R.commit(s, collect("49.51", { customerId: "c2" })),
    "Tahsilat, kalan borçtan fazla veya sıfır olamaz.",
  );
  throwsMsg(
    () => R.commit(s, collect("0", { customerId: "c2" })),
    "Tahsilat, kalan borçtan fazla veya sıfır olamaz.",
  );
  throwsMsg(
    () => R.commit(s, collect("", { customerId: "c2" })),
    "Tahsilat, kalan borçtan fazla veya sıfır olamaz.",
  );
  throwsMsg(() => R.commit(s, collect(1, { customerId: "nope" })), "Müşteri bulunamadı.");
  throwsMsg(() => R.commit(s, collect(1, { customerId: "c2", payment: "credit" })), "Tahsilat türünü seçin.");
  s = R.commit(s, collect(49.5, { customerId: "c2" }));
  assert.equal(R.balance(s, "c2"), 0);
  assert.equal(s.products[0].stock, 7); // collections never touch stock
});

test("credit sale: newCustomer wins over customerId; validation", () => {
  const s = R.commit(
    fresh(),
    sale("credit", [tea()], { customerId: "c1", newCustomer: { id: "c9", name: "Veli" } }),
  );
  assert.equal(s.entries[0].customerId, "c9");
  assert.equal(R.balance(s, "c1"), 0);
  throwsMsg(() => R.commit(fresh(), sale("credit", [tea()])), "Veresiye için bir müşteri seçin.");
  throwsMsg(
    () => R.commit(fresh(), sale("credit", [tea()], { newCustomer: { id: "c1", name: "Ali 2" } })),
    "Müşteri kimliği geçersiz.",
  );
  throwsMsg(
    () => R.commit(fresh(), sale("credit", [tea()], { newCustomer: { id: "c5", name: "x".repeat(81) } })),
    "Müşteri adını girin (en fazla 80 karakter).",
  );
});

test("internal use: with/without cost, stray payment and note rules", () => {
  let s = R.commit(fresh(), internal([{ id: "p1", q: 2 }], { payment: "cash", customerId: "c1" }));
  const e = s.entries[0];
  assert.equal(e.payment, null);
  assert.equal(e.customerId, null);
  assert.equal(e.total, 0);
  assert.equal(e.cost, 3000);
  assert.equal(e.items[0].unit, 0);
  assert.equal(s.products[0].stock, 8);
  s = R.commit(s, internal([{ id: "p2", q: 1 }]));
  assert.equal(s.entries[1].cost, null);
  throwsMsg(
    () => R.commit(fresh(), internal([{ id: "p1", q: 1 }], { note: "  " })),
    "İşletme içi kullanım açıklaması yazın.",
  );
});

test("commit: id checks run in the right order", () => {
  const s = R.commit(fresh(), sale("cash", [tea()], { id: "dup" }));
  throwsMsg(() => R.commit(s, sale("cash", [tea()], { id: "dup" })), "Bu işlem daha önce kaydedildi.");
  // a legacy entry without id must not turn a missing id into "already saved"
  const legacy = { ...fresh(), entries: [{ kind: "sale", items: [], total: 0 }] };
  throwsMsg(() => R.commit(legacy, sale("cash", [tea()], { id: undefined })), "İşlem kimliği eksik.");
  throwsMsg(() => R.commit(fresh(), sale("cash", [tea()], { id: "" })), "İşlem kimliği eksik.");
});

test("commit: rejects bad items", () => {
  throwsMsg(() => R.commit(fresh(), sale("cash", [])), "Sepet boş.");
  throwsMsg(() => R.commit(fresh(), sale("cash", [tea(), tea()])), "Sepette yinelenen ürün var.");
  throwsMsg(
    () => R.commit(fresh(), sale("cash", [{ id: "zz", q: 1, unit: 1 }])),
    "Ürün artık kayıtlı değil.",
  );
  for (const q of ["2", 0, -1, 1.5, 1e6])
    throwsMsg(() => R.commit(fresh(), sale("cash", [tea(q)])), "Ürün miktarı pozitif tam sayı olmalı.");
  throwsMsg(() => R.commit(fresh(), sale("cash", [tea(11)])), "Çay: yeterli stok yok.");
  const stale = "Çay: fiyat eksik veya değişti. Sepeti yeniden kontrol edin.";
  for (const unit of [2999, 0, -3000, "3000"])
    throwsMsg(() => R.commit(fresh(), sale("cash", [{ id: "p1", q: 1, unit }])), stale);
  throwsMsg(
    () => R.commit(fresh(), sale("cash", [{ id: "p3", q: 1, unit: 0 }])),
    "Su: fiyat eksik veya değişti. Sepeti yeniden kontrol edin.",
  );
  throwsMsg(() => R.commit(fresh(), sale("cheque", [tea()])), "Ödeme türünü seçin.");
  throwsMsg(() => R.commit(fresh(), { ...sale("cash", [tea()]), kind: "refund" }), "İşlem türü geçersiz.");
});

test("commit: cost overflow is rejected like total overflow", () => {
  const s = fresh();
  s.products[0] = { ...s.products[0], price: 0.01, cost: 1e9, stock: 999999 };
  throwsMsg(
    () => R.commit(s, sale("cash", [{ id: "p1", q: 999999, unit: 1 }])),
    "İşlem tutarı sınırı aşıldı.",
  );
});

test("commit: never mutates input; failed commit leaves state usable", () => {
  const s0 = fresh();
  const snap = JSON.parse(JSON.stringify(s0));
  const s1 = R.commit(s0, sale("credit", [tea(2)], { newCustomer: { id: "c3", name: "Can" } }));
  assert.deepEqual(s0, snap);
  const snap1 = JSON.parse(JSON.stringify(s1));
  assert.throws(() => R.commit(s1, sale("cash", [tea(1), { id: "p2", q: 99, unit: 1250 }])));
  assert.deepEqual(s1, snap1); // stock of the first line was not decremented
  R.commit(s1, collect(10, { customerId: "c3" }));
  R.daily(s1, D);
  assert.deepEqual(s1, snap1);
});

test("nextNumber is monotonic across kinds and skips nothing on failure", () => {
  let s = fresh();
  s = R.commit(s, sale("credit", [tea()], { customerId: "c1" }));
  try {
    R.commit(s, sale("cash", [tea(99)]));
  } catch {}
  s = R.commit(s, internal([{ id: "p1", q: 1 }]));
  s = R.commit(s, collect(10));
  assert.deepEqual(
    s.entries.map((e) => e.number),
    [1, 2, 3],
  );
  assert.equal(s.nextNumber, 4);
});

test("daily: totals by payment, internal, collections and aggregated items", () => {
  let s = fresh();
  s.products[0].stock = 100;
  s = R.commit(s, sale("cash", [tea(1), simit(2)]));
  s = R.commit(s, sale("card", [tea(1)]));
  s = R.commit(s, sale("credit", [tea(2)], { customerId: "c1" }));
  s = R.commit(s, sale("cash", [tea(5)], { date: "2026-10-26" })); // other day
  s = R.commit(s, collect(20));
  s = R.commit(s, internal([{ id: "p1", q: 3 }]));
  const d = R.daily(s, D);
  assert.equal(d.sales.length, 3);
  assert.equal(d.revenue, 3000 + 2500 + 3000 + 6000);
  assert.equal(d.cash, 5500);
  assert.equal(d.card, 3000);
  assert.equal(d.credit, 6000);
  assert.equal(d.collected, 2000);
  assert.equal(d.internalQty, 3);
  assert.equal(d.internalCost, 4500);
  const byId = Object.fromEntries(d.items.map((p) => [p.id, p]));
  assert.deepEqual([byId.p1.q, byId.p1.total, byId.p1.cost], [4, 12000, 6000]); // cost summed, not first line's
  assert.deepEqual([byId.p2.q, byId.p2.total, byId.p2.cost], [2, 2500, null]);
  assert.equal(d.items.length, 2); // internal use is not a sold item
  s = R.commit(s, internal([{ id: "p2", q: 1 }]));
  assert.equal(R.daily(s, D).internalCost, null);
});

test("daily: aggregated cost becomes null if any line lacks cost", () => {
  let s = fresh();
  s = R.commit(s, sale("cash", [tea(1)]));
  s.products[0].cost = null;
  s = R.commit(s, sale("cash", [tea(1)]));
  s.products[0].cost = 15;
  s = R.commit(s, sale("cash", [tea(1)]));
  const it = R.daily(s, D).items[0];
  assert.equal(it.q, 3);
  assert.equal(it.cost, null);
  const empty = R.daily(fresh(), D);
  assert.deepEqual([empty.revenue, empty.items.length, empty.internalCost], [0, 0, 0]);
});
