/* IndexedDB layer (no library) and the pure helpers around it: register record shape, which entries a
   commit needs, and the backup file format. One database, "dukkan" v1:
     meta     key -> value   "register": { version, rev, nextNumber, products, customers } (no entries),
                             "settings", "writer" ("main" | "preview"), "persistRequested"
     entries  keyPath "id"   one record per register entry; indexes "date", "number", "customerId"
                             (entries without a customer are not in the "customerId" index)
     report   key -> value   "report": the imported sales report (sales-report.js)
   Browser helpers return promises; transaction(stores, mode, fn) runs fn(t) inside ONE transaction and
   resolves with fn's result after the transaction has committed (or rejects and nothing is written).
   fn may await t.get/t.put/... but nothing else, or the transaction auto-commits early. */
(function (root) {
  "use strict";
  const DB_NAME = "dukkan",
    DB_VERSION = 1,
    FORMAT = "dukkan-backup",
    KINDS = ["sale", "internal", "collection"];
  let dbPromise = null;

  // ---------- Browser: IndexedDB ----------
  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  // Writes are usually not awaited inside a transaction; their failure aborts the transaction, which
  // rejects transaction(). Keep the per-request promise from becoming an unhandled rejection.
  function quiet(p) {
    p.catch(() => {});
    return p;
  }
  function openDb() {
    return (dbPromise ??= new Promise((resolve, reject) => {
      let r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        let db = r.result;
        db.createObjectStore("meta");
        let entries = db.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("date", "date");
        entries.createIndex("number", "number");
        entries.createIndex("customerId", "customerId");
        db.createObjectStore("report");
      };
      r.onsuccess = () => {
        let db = r.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      r.onerror = () => {
        dbPromise = null;
        reject(r.error);
      };
    }));
  }
  // opts: { index, direction: "next" | "prev", limit }. "prev" walks a cursor (getAll is ascending only).
  function readAll(source, range, opts = {}) {
    if (opts.direction !== "prev") return req(source.getAll(range ?? null, opts.limit || undefined));
    return new Promise((resolve, reject) => {
      let out = [],
        r = source.openCursor(range ?? null, "prev");
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        let c = r.result;
        if (!c || (opts.limit && out.length >= opts.limit)) return resolve(out);
        out.push(c.value);
        c.continue();
      };
    });
  }
  function scope(tx) {
    const store = (s, opts) => (opts?.index ? tx.objectStore(s).index(opts.index) : tx.objectStore(s));
    return {
      get: (s, key) => quiet(req(tx.objectStore(s).get(key))),
      put: (s, value, key) =>
        quiet(req(key === undefined ? tx.objectStore(s).put(value) : tx.objectStore(s).put(value, key))),
      delete: (s, key) => quiet(req(tx.objectStore(s).delete(key))),
      clear: (s) => quiet(req(tx.objectStore(s).clear())),
      count: (s, range, opts) => quiet(req(store(s, opts).count(range ?? null))),
      getAll: (s, range, opts) => quiet(readAll(store(s, opts), range, opts)),
    };
  }
  async function transaction(stores, mode, fn) {
    let db = await openDb();
    return new Promise((resolve, reject) => {
      let tx = db.transaction(stores, mode),
        failure = null,
        work;
      try {
        work = Promise.resolve(fn(scope(tx)));
      } catch (e) {
        work = Promise.reject(e);
      }
      work.catch((e) => {
        failure = e;
        try {
          tx.abort();
        } catch {}
      });
      tx.oncomplete = () => work.then(resolve, reject);
      tx.onabort = () => reject(failure || tx.error || Error("Kayıt işlemi tamamlanamadı."));
    });
  }
  const get = (s, key) => transaction([s], "readonly", (t) => t.get(s, key));
  const put = (s, value, key) => transaction([s], "readwrite", (t) => t.put(s, value, key));
  const getAll = (s, range, opts) => transaction([s], "readonly", (t) => t.getAll(s, range, opts));
  const count = (s, range, opts) => transaction([s], "readonly", (t) => t.count(s, range, opts));

  // ---------- Browser: quota and persistence ----------
  async function storageInfo() {
    let s = typeof navigator !== "undefined" ? navigator.storage : null,
      info = { usage: null, quota: null, persisted: null };
    try {
      if (s?.estimate) {
        let e = await s.estimate();
        info.usage = e.usage ?? null;
        info.quota = e.quota ?? null;
      }
    } catch {}
    try {
      if (s?.persisted) info.persisted = await s.persisted();
    } catch {}
    return info;
  }
  // Asks once per device for storage the browser will not evict under pressure; the result is logged.
  async function requestPersistence() {
    let s = typeof navigator !== "undefined" ? navigator.storage : null;
    if (!s?.persist || !s.persisted) return null;
    try {
      if (await s.persisted()) return true;
      if (await get("meta", "persistRequested")) return false;
      await put("meta", new Date().toISOString(), "persistRequested");
      let granted = await s.persist();
      console.info("Kalıcı depolama isteği: " + (granted ? "verildi" : "verilmedi"));
      return granted;
    } catch {
      return null;
    }
  }

  // ---------- Pure: register records ----------
  const isInt = (n, min) => Number.isSafeInteger(n) && n >= min;
  // Ids end up in data-* attributes and lookups; a backup is a file from outside, so they are restricted to
  // what uid() and the app produce (UUIDs, hex, short test ids).
  const ID = /^[\w.:-]{1,64}$/,
    ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const isId = (v) => typeof v === "string" && ID.test(v);
  const optNumber = (v) => v === undefined || v === null || Number.isFinite(v);
  const optString = (v) => v === undefined || v === null || typeof v === "string";
  function checkMeta(m) {
    if (
      m?.version !== 1 ||
      !Array.isArray(m.products) ||
      !Array.isArray(m.customers) ||
      !isInt(m.rev, 0) ||
      !isInt(m.nextNumber, 1)
    )
      throw Error("Kasa kayıt biçimi okunamadı.");
    return m;
  }
  // A whole-snapshot register (the old localStorage blob, or a backup) -> the meta record + entries.
  function splitRegister(state) {
    if (!Array.isArray(state?.entries)) throw Error("Kasa kayıt biçimi okunamadı.");
    let { entries, ...meta } = state;
    return { meta: checkMeta(meta), entries };
  }
  /* What RegisterCore.commit(state, request) reads from state.entries (register-core.js), so a commit can
     pass a partial `entries` array and get the same result and the same new entry:
       - every kind: the duplicate check `entries.some(e => e.id === request.id)` needs at most the stored
         entry with that id;
       - "collection": balance(state, customerId) sums only entries whose customerId matches, so that
         customer's entries are enough;
       - "sale" (cash, card and credit alike) and "internal": no balance() call and no other read of entries.
         A credit sale checks the customer against state.customers, which is in the meta record.
     nextNumber and rev come from the meta record, never from entries. */
  function commitScope(request) {
    return {
      id: request?.id || null,
      customerId: request?.kind === "collection" ? request.customerId || null : null,
    };
  }

  // ---------- Pure: backup file ----------
  function buildBackup({ meta, entries, settings, report, exportedAt }) {
    let backup = {
      format: FORMAT,
      version: 1,
      exportedAt,
      register: { ...meta, entries },
      settings: settings ?? null,
      reportIncluded: Boolean(report),
    };
    if (report) backup.report = report;
    return backup;
  }
  // Validates a parsed backup file. Returns { meta, entries, settings, report, summary } or throws a
  // message for the shop owner.
  function readBackup(b) {
    if (b?.format !== FORMAT) throw Error("Bu dosya bir Dükkan yedeği değil.");
    if (b.version !== 1) throw Error("Bu yedek sürümü desteklenmiyor (sürüm " + String(b.version) + ").");
    let meta, entries;
    try {
      ({ meta, entries } = splitRegister(b.register));
    } catch {
      throw Error("Yedekteki kasa kayıtları okunamadı.");
    }
    if (meta.products.some((p) => typeof p?.id !== "string" || !p.id || typeof p.name !== "string"))
      throw Error("Yedekte kimliği veya adı eksik ürün var.");
    if (meta.customers.some((c) => typeof c?.id !== "string" || !c.id || typeof c.name !== "string"))
      throw Error("Yedekte kimliği veya adı eksik müşteri var.");
    if (meta.products.some((p) => !isId(p.id)))
      throw Error(
        "Yedekte geçersiz ürün kimliği var; dosya bu uygulamadan alınmış bir yedek gibi görünmüyor.",
      );
    if (
      meta.products.some(
        (p) =>
          !["stock", "min", "price", "cost", "daily"].every((k) => optNumber(p[k])) ||
          !["barcode", "category", "icon"].every((k) => optString(p[k])),
      )
    )
      throw Error("Yedekte okunamayan ürün bilgisi var (stok, fiyat, barkod veya kategori).");
    if (meta.customers.some((c) => !isId(c.id)))
      throw Error(
        "Yedekte geçersiz müşteri kimliği var; dosya bu uygulamadan alınmış bir yedek gibi görünmüyor.",
      );
    let ids = new Set(),
      numbers = new Set();
    for (let e of entries) {
      if (
        !isId(e?.id) ||
        !isInt(e.number, 1) ||
        e.number >= meta.nextNumber ||
        !ISO_DATE.test(e.date) ||
        !KINDS.includes(e.kind) ||
        !Array.isArray(e.items) ||
        !Number.isSafeInteger(e.total) ||
        !(e.customerId === undefined || e.customerId === null || isId(e.customerId)) ||
        !optString(e.time) ||
        !optString(e.note) ||
        e.items.some((it) => !isId(it?.id) || typeof it.name !== "string" || !Number.isFinite(it.q))
      )
        throw Error(
          "Yedekte okunamayan bir işlem kaydı var" + (isInt(e?.number, 1) ? " (#" + e.number + ")." : "."),
        );
      if (ids.has(e.id) || numbers.has(e.number))
        throw Error("Yedekte aynı işlem iki kez var (#" + e.number + ").");
      ids.add(e.id);
      numbers.add(e.number);
    }
    if (b.reportIncluded && (typeof b.report?.days !== "object" || !b.report.days))
      throw Error("Yedekte satış raporu olduğu yazıyor ama rapor okunamadı.");
    if (b.reportIncluded) {
      let days = Object.entries(b.report.days),
        stats = b.report.stats;
      if (days.some(([day, v]) => !ISO_DATE.test(day) || typeof v !== "object" || !v))
        throw Error("Yedekteki satış raporunda YYYY-AA-GG biçiminde olmayan bir gün var.");
      if (
        stats !== undefined &&
        (typeof stats !== "object" ||
          !stats ||
          ["rows", "hesap", "negative", "invalid", "fractional", "duplicate"].some(
            (k) => !optNumber(stats[k]),
          ))
      )
        throw Error("Yedekteki satış raporunun özet sayıları okunamadı.");
    }
    let dates = entries.map((e) => e.date).sort();
    return {
      meta,
      entries,
      settings: b.settings && typeof b.settings === "object" ? b.settings : null,
      report: b.reportIncluded ? b.report : null,
      summary: {
        exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : "",
        entries: entries.length,
        products: meta.products.length,
        customers: meta.customers.length,
        nextNumber: meta.nextNumber,
        from: dates[0] || "",
        to: dates.at(-1) || "",
        reportIncluded: Boolean(b.reportIncluded),
      },
    };
  }
  // current: { nextNumber, entries } of this device. An older backup must not silently replace newer work.
  function restoreRefusal(summary, current, override = false) {
    if (override || !current) return "";
    if (summary.nextNumber < current.nextNumber && current.entries > summary.entries)
      return `Bu yedek, cihazdaki kayıtlardan eski görünüyor: cihazda ${current.entries} işlem, yedekte ${summary.entries} işlem var. Yedeği yüklemek için “Mevcut kayıtların yerine geç” seçeneğini işaretleyin.`;
    return "";
  }

  root.Store = {
    openDb,
    transaction,
    get,
    put,
    getAll,
    count,
    storageInfo,
    requestPersistence,
    checkMeta,
    splitRegister,
    commitScope,
    buildBackup,
    readBackup,
    restoreRefusal,
  };
  if (typeof module !== "undefined") module.exports = root.Store;
})(typeof globalThis !== "undefined" ? globalThis : this);
