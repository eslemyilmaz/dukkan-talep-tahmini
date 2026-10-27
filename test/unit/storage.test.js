"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../register-core.js");
const S = require("../../storage.js");

const D = "2026-10-27";
function fresh() {
  return {
    version: 1,
    rev: 0,
    nextNumber: 1,
    products: [
      { id: "p1", name: "Çay", price: 30, cost: 15, stock: 1000 },
      { id: "p2", name: "Simit", price: 12.5, cost: null, stock: 1000 },
    ],
    entries: [],
    customers: [
      { id: "c1", name: "Ali" },
      { id: "c2", name: "Ayşe" },
    ],
  };
}
// What register.js commitEntry() loads from IndexedDB for a request: the entry with the same id (if any)
// and, for a collection, the customer's entries (the "customerId" index holds only entries with a customer).
function scoped(state, request) {
  let need = S.commitScope(request),
    known = need.customerId ? state.entries.filter((e) => e.customerId === need.customerId) : [];
  if (need.id && !known.some((e) => e.id === need.id))
    known.push(...state.entries.filter((e) => e.id === need.id));
  let { entries, ...meta } = state;
  return { ...meta, entries: known };
}
const attempt = (fn) => {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: e.message };
  }
};

test("commitScope: only collections need a customer's entries", () => {
  assert.deepEqual(S.commitScope({ id: "a", kind: "sale", payment: "cash" }), { id: "a", customerId: null });
  assert.deepEqual(S.commitScope({ id: "b", kind: "sale", payment: "credit", customerId: "c1" }), {
    id: "b",
    customerId: null,
  });
  assert.deepEqual(S.commitScope({ id: "c", kind: "internal", note: "x" }), { id: "c", customerId: null });
  assert.deepEqual(S.commitScope({ id: "d", kind: "collection", customerId: "c1" }), {
    id: "d",
    customerId: "c1",
  });
  assert.deepEqual(S.commitScope({ kind: "collection" }), { id: null, customerId: null });
});

test("commit with the scoped entries equals commit with the full state", () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 48271) % 2147483647), seed % n);
  let full = fresh(),
    ids = [],
    checked = 0,
    refused = new Set();
  for (let i = 0; i < 400; i++) {
    let reuse = ids.length && rnd(10) === 0,
      id = reuse ? ids[rnd(ids.length)] : "t" + i,
      customerId = ["c1", "c2", "c9"][rnd(3)],
      kind = ["sale", "sale", "internal", "collection"][rnd(4)],
      payment = ["cash", "card", "credit"][rnd(3)],
      request =
        kind === "collection"
          ? { id, kind, customerId, amount: [1, 5, 12.5, 40, 500][rnd(5)], payment: ["cash", "card"][rnd(2)] }
          : {
              id,
              kind,
              payment,
              customerId,
              note: kind === "internal" ? "Personel" : "",
              newCustomer:
                kind === "sale" && payment === "credit" && rnd(8) === 0
                  ? { id: "n" + i, name: "Yeni" }
                  : null,
              items: [{ id: "p1", q: 1 + rnd(3), unit: 3000 }],
            };
    Object.assign(request, { date: D, time: "10:00" });
    let a = attempt(() => R.commit(full, request)),
      b = attempt(() => R.commit(scoped(full, request), request));
    assert.equal(b.error, a.error, `request ${i}`);
    if (a.error) refused.add(a.error);
    if (a.ok) {
      let { entries: ea, ...ma } = a.ok,
        { entries: eb, ...mb } = b.ok;
      assert.deepEqual(mb, ma, `meta after request ${i}`);
      assert.deepEqual(eb.at(-1), ea.at(-1), `new entry for request ${i}`);
      full = a.ok;
      ids.push(id);
      checked++;
    }
  }
  assert.ok(checked > 150, checked + " successful commits");
  assert.ok(full.entries.some((e) => e.kind === "collection"));
  // The paths that read entries were exercised, not only the happy ones.
  assert.ok(refused.has("Bu işlem daha önce kaydedildi."));
  assert.ok(refused.has("Tahsilat, kalan borçtan fazla veya sıfır olamaz."));
});

test("checkMeta and splitRegister", () => {
  let { meta, entries } = S.splitRegister(
    R.commit(fresh(), {
      id: "a",
      kind: "sale",
      payment: "cash",
      items: [{ id: "p1", q: 1, unit: 3000 }],
      date: D,
      time: "1",
    }),
  );
  assert.equal(entries.length, 1);
  assert.equal("entries" in meta, false);
  assert.equal(meta.nextNumber, 2);
  assert.throws(() => S.splitRegister({ ...fresh(), entries: null }), /okunamadı/);
  assert.throws(() => S.checkMeta({ ...meta, version: 2 }), /okunamadı/);
  assert.throws(() => S.checkMeta({ ...meta, nextNumber: 0 }), /okunamadı/);
  assert.throws(() => S.checkMeta("{broken"), /okunamadı/);
});

function sampleBackup(report = null) {
  let s = fresh();
  s = R.commit(s, {
    id: "e1",
    kind: "sale",
    payment: "credit",
    customerId: "c1",
    items: [{ id: "p1", q: 2, unit: 3000 }],
    date: "2026-10-01",
    time: "1",
  });
  s = R.commit(s, {
    id: "e2",
    kind: "collection",
    customerId: "c1",
    amount: 10,
    payment: "cash",
    date: "2026-10-03",
    time: "2",
  });
  let { meta, entries } = S.splitRegister(s);
  return S.buildBackup({
    meta,
    entries,
    settings: { rules: [true], time: "21:00", channel: "Telegram" },
    report,
    exportedAt: "2026-10-27T10:00:00.000Z",
  });
}

test("backup round trip and summary", () => {
  let b = JSON.parse(JSON.stringify(sampleBackup()));
  assert.equal(b.format, "dukkan-backup");
  assert.equal(b.version, 1);
  assert.equal(b.reportIncluded, false);
  assert.equal("report" in b, false);
  let r = S.readBackup(b);
  assert.deepEqual(r.summary, {
    exportedAt: "2026-10-27T10:00:00.000Z",
    entries: 2,
    products: 2,
    customers: 2,
    nextNumber: 3,
    from: "2026-10-01",
    to: "2026-10-03",
    reportIncluded: false,
  });
  assert.equal(r.report, null);
  assert.equal(r.settings.time, "21:00");
  assert.equal(R.balance({ entries: r.entries }, "c1"), 5000);
  let withReport = S.readBackup(
    JSON.parse(JSON.stringify(sampleBackup({ days: { "2026-10-01": {} }, stats: {} }))),
  );
  assert.equal(withReport.summary.reportIncluded, true);
  assert.ok(withReport.report.days);
});

test("readBackup rejects files that are not a usable backup", () => {
  const bad = (change, re) => {
    let b = JSON.parse(JSON.stringify(sampleBackup()));
    change(b);
    assert.throws(() => S.readBackup(b), re);
  };
  assert.throws(() => S.readBackup(null), /Dükkan yedeği değil/);
  bad((b) => (b.format = "other"), /Dükkan yedeği değil/);
  bad((b) => (b.version = 2), /sürümü desteklenmiyor/);
  bad((b) => delete b.register.entries, /kasa kayıtları okunamadı/);
  bad((b) => (b.register.products[0].id = ""), /ürün/);
  bad((b) => (b.register.customers[0].name = 5), /müşteri/);
  bad((b) => (b.register.entries[1].number = 1), /iki kez/);
  bad((b) => (b.register.entries[1].id = "e1"), /iki kez/);
  bad((b) => (b.register.entries[1].number = 3), /okunamayan.*#3/);
  bad((b) => (b.register.entries[0].date = "01.10.2026"), /okunamayan/);
  bad((b) => (b.register.entries[0].kind = "refund"), /okunamayan/);
  bad((b) => (b.reportIncluded = true), /rapor okunamadı/);
});

test("readBackup rejects hostile ids, fields and report day keys", () => {
  const bad = (change, re) => {
    let b = JSON.parse(JSON.stringify(sampleBackup()));
    change(b);
    assert.throws(() => S.readBackup(b), re);
  };
  const withReport =
    (days, stats = {}) =>
    (b) => {
      b.reportIncluded = true;
      b.report = { version: 1, days, products: {}, stats };
    };
  const day = { total: 1, rows: 1, qty: 1, hesap: 0, items: {} };
  // Quotes survive esc() as &#39; and are decoded before an inline handler runs.
  bad((b) => (b.register.products[0].id = "x');window.__xss=1;//"), /geçersiz ürün kimliği/);
  bad((b) => (b.register.products[0].id = "a".repeat(65)), /geçersiz ürün kimliği/);
  bad((b) => (b.register.products[0].id = "p 1"), /geçersiz ürün kimliği/);
  bad((b) => (b.register.customers[0].id = '"><img src=x onerror=alert(1)>'), /geçersiz müşteri kimliği/);
  bad((b) => (b.register.entries[0].id = "e1');alert(1);//"), /okunamayan.*#1/);
  bad((b) => (b.register.entries[0].customerId = "c1'"), /okunamayan.*#1/);
  bad((b) => (b.register.entries[0].items[0].id = "<p1>"), /okunamayan.*#1/);
  bad((b) => (b.register.entries[0].items[0].q = "<img>"), /okunamayan.*#1/);
  bad((b) => (b.register.products[0].stock = "<img src=x onerror=alert(1)>"), /ürün bilgisi/);
  bad((b) => (b.register.products[0].price = "1"), /ürün bilgisi/);
  bad((b) => (b.register.products[0].barcode = 5), /ürün bilgisi/);
  bad(withReport({ "<img src=x onerror=window.__xss3=1>": day }), /YYYY-AA-GG/);
  bad(withReport({ "2024-01-01": day, '"></option></select><img src=x>': day }), /YYYY-AA-GG/);
  bad(withReport({ "2024-01-01": "x" }), /YYYY-AA-GG/);
  bad(withReport({ "2024-01-01": day }, { rows: "<b>1</b>" }), /özet sayıları/);
  // What the app itself writes still passes: UUIDs, hex ids, ISO day keys and the worker's stats.
  let ok = JSON.parse(JSON.stringify(sampleBackup()));
  ok.register.products[0].id = "0b6f0c8e-5d0a-4c1e-9a65-3f1b2c4d5e6f";
  ok.register.entries[0].items[0].id = ok.register.products[0].id;
  ok.register.customers[1].id = "9f86d081884c7d659a2feaa0c55ad015";
  withReport({ "2024-01-01": day }, { rows: 1, hesap: 0, encoding: "windows-1254", columns: null })(ok);
  assert.equal(S.readBackup(ok).summary.reportIncluded, true);
});

test("restoreRefusal: an older backup needs the override when this device has more entries", () => {
  let summary = { nextNumber: 10, entries: 9 };
  assert.match(S.restoreRefusal(summary, { nextNumber: 20, entries: 19 }), /Mevcut kayıtların yerine geç/);
  assert.equal(S.restoreRefusal(summary, { nextNumber: 20, entries: 19 }, true), "");
  assert.equal(S.restoreRefusal(summary, { nextNumber: 1, entries: 0 }), "");
  assert.equal(S.restoreRefusal(summary, { nextNumber: 10, entries: 9 }), "");
  // Older numbering but no more entries here (e.g. a fresh device that made a few test sales): allowed.
  assert.equal(S.restoreRefusal(summary, { nextNumber: 12, entries: 2 }), "");
  assert.equal(S.restoreRefusal(summary, null), "");
});
