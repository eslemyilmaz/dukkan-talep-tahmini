// Playwright smoke test: serves the repo with python3 http.server, clicks through the app, makes sales,
// checks they land in IndexedDB, adds a product, records a credit collection, makes 60 quick sales,
// downloads a backup and restores it in a fresh profile, checks the preview frame, migrates an old
// localStorage register in a fresh profile and loads a sales report fixture.
// Usage: node test/smoke/run.js   (exit code 1 on any failed step or console/page error)
"use strict";
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");
const RegisterCore = require("../../register-core.js");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "satis-raporu-ornek.xls");
const results = [];
const errors = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(url, ms = 10000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on("error", () =>
          Date.now() > until ? reject(Error("server did not start")) : setTimeout(tryOnce, 100),
        );
    };
    tryOnce();
  });
}

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail || "" });
  } catch (e) {
    results.push({ ok: false, name, detail: String(e.message || e).split("\n")[0] });
  }
}

const heading = (page) =>
  page.$eval("#content", (c) => {
    const h = c.querySelector("h1,h2,h3,[role=heading]");
    return h ? h.textContent.trim().replace(/\s+/g, " ") : "";
  });

async function waitToast(page, want, timeout = 3000) {
  await page
    .waitForFunction(
      (w) => {
        const t = document.querySelector("#toast");
        return t && !t.classList.contains("hidden") && t.textContent.includes(w);
      },
      want,
      { timeout },
    )
    .catch(async () => {
      throw Error("toast was: " + (await page.$eval("#toast", (t) => t.textContent.trim())));
    });
  return want;
}

// The app's IndexedDB (storage.js), read from inside the page. Only after the app has opened it: opening a
// missing database here would create it without stores.
const readDb = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("dukkan");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            t = db.transaction(["meta", "entries"]),
            out = {};
          t.objectStore("meta").get("register").onsuccess = (e) => (out.meta = e.target.result);
          t.objectStore("entries").getAll().onsuccess = (e) => (out.entries = e.target.result);
          t.oncomplete = () => {
            db.close();
            resolve(out);
          };
          t.onerror = () => reject(t.error);
        };
      }),
  );
const putRegisterMeta = (page, value) =>
  page.evaluate(
    (v) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("dukkan");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result,
            t = db.transaction("meta", "readwrite");
          t.objectStore("meta").put(v, "register");
          t.oncomplete = () => {
            db.close();
            resolve();
          };
          t.onerror = () => reject(t.error);
        };
      }),
    value,
  );
const localStorageDump = (page) =>
  page.evaluate(() => Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));

function watch(page) {
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  return page;
}

// An old-format register: everything in one localStorage blob, built with the real rules.
function legacyRegister() {
  let s = {
    version: 1,
    rev: 0,
    nextNumber: 1,
    products: [
      { id: "lp1", name: "Peynir", category: "Süt ürünleri", stock: 10, min: 2, price: 120, cost: null },
      { id: "lp2", name: "Zeytin", category: "Temel gıda", stock: 10, min: 2, price: 45, cost: 30 },
    ],
    entries: [],
    customers: [{ id: "lc1", name: "Ayşe Hanım" }],
  };
  const at = { date: "2026-01-15", time: "10:00:00" };
  s = RegisterCore.commit(s, {
    id: "le1",
    kind: "sale",
    payment: "cash",
    items: [{ id: "lp1", q: 1, unit: 12000 }],
    ...at,
  });
  s = RegisterCore.commit(s, {
    id: "le2",
    kind: "sale",
    payment: "credit",
    customerId: "lc1",
    items: [{ id: "lp2", q: 2, unit: 4500 }],
    ...at,
  });
  return RegisterCore.commit(s, {
    id: "le3",
    kind: "collection",
    customerId: "lc1",
    amount: 40,
    payment: "cash",
    ...at,
  });
}

async function gotoNav(page, label) {
  const buttons = page.locator("#nav button");
  const texts = (await buttons.allTextContents()).map((t) => t.trim());
  let i = texts.findIndex((t) => t === label);
  if (i < 0) i = texts.findIndex((t) => t.startsWith(label));
  if (i < 0) i = texts.findIndex((t) => t.includes(label));
  if (i < 0) throw Error(`nav button "${label}" not found`);
  await buttons.nth(i).click();
  await page.waitForTimeout(150);
  const h = await heading(page);
  if (!h) throw Error(`"${label}" rendered no heading`);
  return h;
}

(async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  let browser;
  try {
    await waitForServer(url);
    browser = await chromium.launch();
    const page = watch(await (await browser.newContext({ acceptDownloads: true })).newPage());

    await step("load app", async () => {
      await page.goto(url + "?debug=1", { waitUntil: "networkidle" });
      await page.waitForSelector("#nav button", { timeout: 5000 });
      return url;
    });

    await step("render() called once at load", async () => {
      await page.waitForTimeout(300);
      const n = await page.evaluate(() => window.__dukkanDebug?.renders);
      if (n !== 1) throw Error("render count " + n);
      return "1 render";
    });

    const navs = (await page.locator("#nav button").allTextContents()).map((t) => t.trim());
    await step("nav buttons", async () => {
      if (!navs.length) throw Error("no #nav buttons");
      return navs.length + " buttons";
    });
    for (let i = 0; i < navs.length; i++)
      await step(`nav: ${navs[i]}`, async () => {
        await page.locator("#nav button").nth(i).click();
        await page.waitForTimeout(150);
        const h = await heading(page);
        if (!h) throw Error("no heading in #content");
        return h;
      });

    await step("sale", async () => {
      await gotoNav(page, "Satış");
      const add = page.locator(".quickProducts .tileAdd:not([disabled])").first();
      await add.waitFor({ timeout: 5000 });
      await add.click();
      await page.locator("button.checkout").first().click();
      const want = "Satış kaydedildi; stok güncellendi.";
      await page
        .waitForFunction((w) => document.querySelector("#toast")?.textContent.includes(w), want, {
          timeout: 3000,
        })
        .catch(async () => {
          throw Error("toast was: " + (await page.$eval("#toast", (t) => t.textContent.trim())));
        });
      return want;
    });

    await step("sale: entry in IndexedDB, not in localStorage", async () => {
      const db = await readDb(page);
      const last = [...db.entries].sort((a, b) => b.number - a.number)[0];
      if (!last || last.kind !== "sale" || !last.items.length) throw Error("no sale entry in IndexedDB");
      if ("entries" in db.meta) throw Error("meta record carries entries");
      if (db.meta.nextNumber !== last.number + 1) throw Error("nextNumber " + db.meta.nextNumber);
      const ls = await localStorageDump(page);
      const leaked = ls.find(([k, v]) => k.startsWith("dukkan-register") || v.includes(last.id));
      if (leaked) throw Error("localStorage still holds register data: " + leaked[0]);
      return `#${last.number} in IndexedDB · localStorage keys: ${ls.length}`;
    });
    const productName = "Smoke Ürün";
    const productBarcode = "SMOKE0001";
    await step("stock: add product via modal", async () => {
      await gotoNav(page, "Ürünler & stok");
      const focused = await page.evaluate(() => document.activeElement?.id);
      if (focused !== "barcodeScan") throw Error("barcode field not focused on entry: " + focused);
      await page.locator("#content .actions button.primary").click();
      await page.fill("#mbody [name=barcode]", productBarcode);
      await page.fill("#mbody [name=name]", productName);
      await page.fill("#mbody [name=category]", "Süt ürünleri");
      await page.fill("#mbody [name=stock]", "20");
      await page.fill("#mbody [name=min]", "5");
      await page.fill("#mbody [name=price]", "12.5");
      await page.locator("#mbody button.primary").click();
      await waitToast(page, "Ürün listenize eklendi.");
      if (!(await page.locator("#stockTable").textContent()).includes(productName))
        throw Error("product missing from #stockTable");
      const after = await page.evaluate(() => document.activeElement?.id);
      if (after === "barcodeScan") throw Error("barcode field refocused after a form save");
      return productName;
    });

    await step("stock: failed save keeps the form open", async () => {
      const saved = (await readDb(page)).meta;
      await putRegisterMeta(page, "{broken");
      await page.locator("#stockTable button.link").first().click();
      await page.locator("#mbody button.primary").click();
      await page.waitForTimeout(200);
      const open = await page.evaluate(() => document.getElementById("modal").open);
      const msg = await page.locator("#mbody [role=alert]").textContent();
      await putRegisterMeta(page, saved);
      await page.evaluate(() => document.getElementById("modal").close());
      if (!open) throw Error("modal closed after a failed save");
      if (!msg.startsWith("Kaydedilemedi:")) throw Error("alert was: " + msg);
      return msg.slice(0, 40);
    });

    await step("sales: scan barcode adds to cart", async () => {
      await gotoNav(page, "Satış");
      await page.fill("#posBarcode", productBarcode);
      await page.press("#posBarcode", "Enter");
      await page.waitForTimeout(150);
      const cartText = await page.locator(".posReceipt .receiptItems").textContent();
      if (!cartText.includes(productName)) throw Error("cart: " + cartText.trim().slice(0, 80));
      return productName + " in cart";
    });

    const customer = "Test Müşteri";
    await step("credit: sale to new customer, then a collection", async () => {
      await page.locator(".payments button", { hasText: "Veresiye" }).click();
      await page.selectOption("#posCustomer", "new");
      await page.locator(".posReceipt input[maxlength='80']").fill(customer);
      await page.locator("button.checkout").click();
      await waitToast(page, "Satış kaydedildi; stok güncellendi.");
      await gotoNav(page, "Veresiye");
      const card = page.locator(".creditCard", { hasText: customer });
      await card.waitFor({ timeout: 3000 });
      await card.locator("button.primary").click();
      await page.fill("#mbody [name=amount]", "5");
      await page.locator("#mbody button.primary").click();
      await waitToast(page, "Tahsilat kaydedildi; ciro değişmedi.");
      const balance = (await card.locator(".value").textContent()).trim();
      if (balance !== "₺7,50") throw Error("balance " + balance);
      return customer + " · kalan " + balance;
    });

    await step("60 quick sales: history shows 50, day-end totals match", async () => {
      await gotoNav(page, "Satış");
      await page.evaluate(async () => {
        const d = window.__dukkanDebug;
        for (let i = 0; i < 60; i++) {
          const p = d
            .products()
            .filter((p) => p.price > 0)
            .sort((a, b) => b.stock - a.stock)[0];
          await d.commit({
            id: "smoke-quick-" + i,
            kind: "sale",
            payment: i % 3 ? "cash" : "card",
            items: [{ id: p.id, q: 1, unit: RegisterCore.cents(p.price) }],
            date: todayTR(),
            time: "12:00:00",
          });
        }
      });
      await page.locator("#content button", { hasText: "Son işlemler" }).click();
      await page.waitForSelector("#modal[open] #mbody .historyDetail");
      const rows = await page.locator("#mbody .historyDetail").count();
      const top = await page.locator("#mbody .historyDetail summary strong").first().textContent();
      await page.evaluate(() => document.getElementById("modal").close());
      const db = await readDb(page);
      const newest = Math.max(...db.entries.map((e) => e.number));
      if (rows !== 50) throw Error(rows + " history rows");
      if (!top.includes("#" + String(newest).padStart(4, "0"))) throw Error("newest row is " + top);
      const today = await page.evaluate(() => todayTR());
      const day = db.entries.filter((e) => e.date === today);
      const revenue = day.filter((e) => e.kind === "sale").reduce((s, e) => s + e.total, 0);
      const want = await page.evaluate((k) => moneyKurus(k), revenue);
      await gotoNav(page, "Gün sonu");
      const shown = (await page.locator(".registerSummary .card strong").first().textContent()).trim();
      const count = (await page.locator("section.bottom .paneltop .muted").textContent()).trim();
      if (shown !== want) throw Error(`revenue ${shown}, IndexedDB says ${want}`);
      if (count !== day.length + " kayıt") throw Error(`${count}, IndexedDB has ${day.length}`);
      return `${rows} rows · ${count} · ${shown}`;
    });

    let backupFile = "",
      backup = null;
    await step("backup: download", async () => {
      await gotoNav(page, "Asistan");
      const info = await page.locator("#storageInfo").textContent();
      if (!/Kalıcı depolama: (açık|kapalı|bilinmiyor)/.test(info)) throw Error("storage line: " + info);
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#backupDownload")]);
      const name = dl.suggestedFilename();
      if (!/^dukkan-yedek-\d{4}-\d{2}-\d{2}\.json$/.test(name)) throw Error("file name " + name);
      backupFile = await dl.path();
      backup = JSON.parse(fs.readFileSync(backupFile, "utf8"));
      const db = await readDb(page);
      if (backup.format !== "dukkan-backup" || backup.version !== 1) throw Error("format/version");
      if (backup.reportIncluded !== false || "report" in backup) throw Error("report included by default");
      const r = backup.register;
      if (r.entries.length !== db.entries.length)
        throw Error(`${r.entries.length} vs ${db.entries.length} entries`);
      if (r.products.length !== db.meta.products.length || r.customers.length !== db.meta.customers.length)
        throw Error("product/customer counts differ");
      if (r.nextNumber !== db.meta.nextNumber) throw Error("nextNumber differs");
      return `${name} · ${r.entries.length} işlem · ${r.products.length} ürün · ${r.customers.length} müşteri`;
    });

    await step("backup: restore into a fresh profile", async () => {
      if (!backup) throw Error("no backup from the previous step");
      const ctx = await browser.newContext();
      const fresh = watch(await ctx.newPage());
      try {
        await fresh.goto(url, { waitUntil: "networkidle" });
        await gotoNav(fresh, "Asistan");
        await fresh.setInputFiles("#restoreFile", backupFile);
        await fresh.waitForSelector("#restoreConfirm:not([disabled])", { timeout: 3000 });
        const summary = await fresh.locator("#restoreSummary").textContent();
        const r = backup.register;
        if (
          !summary.startsWith(`${r.entries.length} işlem · ${r.products.length} ürün · ${r.customers.length}`)
        )
          throw Error("summary: " + summary);
        await fresh.click("#restoreConfirm");
        await waitToast(fresh, "Yedek geri yüklendi");
        const db = await readDb(fresh);
        const ids = (list) =>
          list
            .map((e) => e.id)
            .sort()
            .join();
        if (ids(db.entries) !== ids(r.entries)) throw Error(`${db.entries.length} entries after restore`);
        if (db.meta.products.length !== r.products.length || db.meta.customers.length !== r.customers.length)
          throw Error("product/customer counts differ");
        if (db.meta.nextNumber !== r.nextNumber) throw Error("nextNumber " + db.meta.nextNumber);
        await gotoNav(fresh, "Veresiye");
        const card = (await fresh.locator(".creditCard", { hasText: customer }).textContent()) || "";
        if (!card.includes("₺7,50")) throw Error("credit card: " + card);
        return `${db.entries.length} işlem · ${db.meta.products.length} ürün · ${customer} ₺7,50`;
      } finally {
        await ctx.close();
      }
    });

    await step("preview frame shares records without a cross-tab toast", async () => {
      const preview = await page.context().newPage();
      await preview.goto(url + "?tablet=1", { waitUntil: "networkidle" });
      const banner = await preview.locator(".previewBanner").textContent();
      if (!banner.includes("Ön izleme · kayıtlar ana ekranla ortak")) throw Error("no preview banner");
      await preview.locator("#nav button", { hasText: "Satış" }).click();
      await preview.locator(".quickProducts .tileAdd:not([disabled])").first().click();
      await preview.locator("button.checkout").click();
      await waitToast(preview, "Satış kaydedildi; stok güncellendi.");
      await page.waitForTimeout(300);
      const toastText = await page.$eval("#toast", (t) =>
        t.classList.contains("hidden") ? "" : t.textContent,
      );
      await preview.close();
      if (toastText.includes("diğer sekmeden")) throw Error("main screen toasted: " + toastText);
      // A real second tab still notifies.
      const other = await page.context().newPage();
      await other.goto(url, { waitUntil: "networkidle" });
      await other.locator("#nav button", { hasText: "Satış" }).click();
      await other.locator(".quickProducts .tileAdd:not([disabled])").first().click();
      await other.locator("button.checkout").click();
      await waitToast(other, "Satış kaydedildi; stok güncellendi.");
      await other.close();
      return waitToast(page, "Kayıtlar diğer sekmeden güncellendi.");
    });

    await step("backup: an older backup needs the explicit override", async () => {
      await gotoNav(page, "Asistan");
      await page.setInputFiles("#restoreFile", backupFile);
      await page.waitForSelector("#restoreRefusal", { timeout: 3000 });
      if (!(await page.locator("#restoreConfirm").isDisabled()))
        throw Error("confirm enabled without override");
      await page.check("#restoreOverride");
      if (await page.locator("#restoreConfirm").isDisabled()) throw Error("override did not enable confirm");
      await gotoNav(page, "Genel bakış");
      return "refused until ticked";
    });

    await step("migration: localStorage register moves to IndexedDB", async () => {
      const ctx = await browser.newContext();
      const old = watch(await ctx.newPage());
      try {
        const legacy = legacyRegister(),
          raw = JSON.stringify(legacy);
        await old.goto(url + "README.md");
        await old.evaluate((r) => localStorage.setItem("dukkan-register-v1", r), raw);
        await old.goto(url, { waitUntil: "networkidle" });
        await old.waitForSelector("#nav button", { timeout: 5000 });
        const db = await readDb(old);
        if (db.meta.products.length !== 2 || db.meta.customers.length !== 1) throw Error("meta not imported");
        if (db.entries.length !== 3 || db.meta.nextNumber !== 4) throw Error(db.entries.length + " entries");
        const ls = Object.fromEntries(await localStorageDump(old));
        if ("dukkan-register-v1" in ls) throw Error("old key still present");
        if (ls["dukkan-register-v1-migrated"] !== raw) throw Error("safety copy missing or changed");
        await gotoNav(old, "Veresiye");
        const card = await old.locator(".creditCard", { hasText: "Ayşe Hanım" }).textContent();
        if (!card.includes("₺50,00")) throw Error("balance: " + card);
        return "2 ürün · 3 işlem · 1 müşteri (₺50,00) · key renamed";
      } finally {
        await ctx.close();
      }
    });

    await step("reports: load sales report fixture", async () => {
      await gotoNav(page, "Raporlar");
      await page.setInputFiles("#salesFile", FIXTURE);
      await page.click("#salesImport");
      return waitToast(page, "Gerçek satış raporu yüklendi.", 30000);
    });

    await step("report: old dukkan-sales database moves to the shared one", async () => {
      const report = await page.evaluate(() => Store.get("report", "report"));
      if (!report?.days) throw Error("no report in the shared database");
      const ctx = await browser.newContext();
      const old = watch(await ctx.newPage());
      try {
        await old.goto(url + "README.md");
        await old.evaluate(
          (data) =>
            new Promise((resolve, reject) => {
              const r = indexedDB.open("dukkan-sales", 1);
              r.onupgradeneeded = () => r.result.createObjectStore("data");
              r.onerror = () => reject(r.error);
              r.onsuccess = () => {
                const t = r.result.transaction("data", "readwrite");
                t.objectStore("data").put(data, "report");
                t.oncomplete = () => (r.result.close(), resolve());
              };
            }),
          report,
        );
        await old.goto(url, { waitUntil: "networkidle" });
        await old.waitForSelector("#nav button", { timeout: 5000 });
        const badge = await old.locator(".demo").textContent();
        if (badge !== "Gerçek satış · stok ayrı") throw Error("badge: " + badge);
        const moved = await old.evaluate(async () => {
          const data = await Store.get("report", "report");
          const names = (await indexedDB.databases()).map((d) => d.name);
          return { rows: data?.stats?.rows, names };
        });
        if (moved.rows !== report.stats.rows) throw Error("report not in the shared database");
        if (moved.names.includes("dukkan-sales")) throw Error("old database not deleted");
        return `${moved.rows} satır taşındı · databases: ${moved.names.join(", ")}`;
      } finally {
        await ctx.close();
      }
    });

    await step("forecasts: trial from the loaded report", async () => {
      const h = await gotoNav(page, "Tahminler");
      if (h !== "Gerçek veriyle tahmin denemesi") throw Error("heading " + h);
      const rows = await page.locator("#realTrial tbody tr").count();
      if (rows !== 56) throw Error(rows + " trial rows");
      return h + " · " + rows + " gün";
    });

    await step("nav: Veresiye", () => gotoNav(page, "Veresiye"));
    await step("nav: Gün sonu", () => gotoNav(page, "Gün sonu"));
    // Register sales -> product-day CSV (Raporlar) -> the model's canonical CSV loader.
    let productDayFiles = null;
    const productDayDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "urun-gun-"));
    await step("model CSV: register sales export as product-day CSV", async () => {
      const ctx = await browser.newContext({ acceptDownloads: true });
      const shop = watch(await ctx.newPage());
      try {
        await shop.goto(url + "README.md");
        await shop.evaluate(() =>
          localStorage.setItem(
            "dukkan-products",
            JSON.stringify([
              {
                id: "rt1",
                name: "Ayran",
                category: "İçecek",
                barcode: "0869000000017",
                stock: 50,
                min: 2,
                price: 12.5,
              },
              { id: "rt2", name: "Simit", category: "Fırın", stock: 50, min: 2, price: 10 },
            ]),
          ),
        );
        await shop.goto(url + "?debug=1", { waitUntil: "networkidle" });
        await shop.waitForSelector("#nav button", { timeout: 5000 });
        await shop.evaluate(async () => {
          const c = window.__dukkanDebug.commit,
            day1 = { date: "2026-03-02", time: "10:00:00" },
            day2 = { date: "2026-03-04", time: "11:00:00" };
          const a = (q) => ({ id: "rt1", q, unit: 1250 }),
            b = (q) => ({ id: "rt2", q, unit: 1000 });
          await c({ id: "rt-s1", kind: "sale", payment: "cash", items: [a(2), b(1)], ...day1 });
          await c({ id: "rt-s2", kind: "sale", payment: "card", items: [a(1)], ...day1 });
          await c({
            id: "rt-s3",
            kind: "sale",
            payment: "credit",
            newCustomer: { id: "rtc1", name: "Deneme" },
            items: [a(4), b(2)],
            ...day2,
          });
          await c({ id: "rt-i1", kind: "internal", note: "Çay ocağı", items: [a(5)], ...day2 });
          await c({
            id: "rt-c1",
            kind: "collection",
            customerId: "rtc1",
            amount: 10,
            payment: "cash",
            ...day2,
          });
        });
        await gotoNav(shop, "Raporlar");
        const grab = async () => {
          const [dl] = await Promise.all([shop.waitForEvent("download"), shop.click("#productDayDownload")]);
          const file = path.join(productDayDir, fs.readdirSync(productDayDir).length + ".csv");
          await dl.saveAs(file);
          return { name: dl.suggestedFilename(), file, text: fs.readFileSync(file, "utf8") };
        };
        const plain = await grab();
        await waitToast(shop, "Barkodsuz 2 satış satırı dahil edilmedi.");
        await shop.check("#productDayNoBarcode");
        const all = await grab();
        const header = "tarih;barkod;urun;kategori;birim;miktar;tutar";
        if (plain.name !== "urun-gun-2026-03-02_2026-03-04.csv") throw Error("file name " + plain.name);
        for (const f of [plain, all]) {
          if (!f.text.startsWith("﻿" + header + "\r\n")) throw Error("BOM/header: " + f.text.slice(0, 60));
          if (/[^\r]\n/.test(f.text)) throw Error("line ending is not CRLF");
        }
        const lines = (f) => f.text.slice(1).trim().split("\r\n").slice(1);
        const want = [
          '"2026-03-02";"0869000000017";"Ayran";"İçecek";"adet";"3";"37.50"',
          '"2026-03-04";"0869000000017";"Ayran";"İçecek";"adet";"4";"50.00"',
        ];
        if (lines(plain).join("|") !== want.join("|")) throw Error("rows: " + lines(plain).join(" | "));
        const extra = lines(all).filter((l) => l.includes('"app:rt2"'));
        if (lines(all).length !== 4 || extra.length !== 2)
          throw Error("with app: ids: " + lines(all).join(" | "));
        productDayFiles = { plain: plain.file, all: all.file };
        return `${plain.name} · 2 satır (barkodsuz hariç) · 4 satır (app: dahil)`;
      } finally {
        await ctx.close();
      }
    });

    await step("model CSV: dukkan_tahmin.io_csv.load_canonical reads it", async () => {
      if (!productDayFiles) throw Error("no CSV from the previous step");
      const { spawnSync } = require("node:child_process");
      const modelDir = path.join(ROOT, "model");
      const probe = spawnSync("python3", ["-c", "import dukkan_tahmin.io_csv"], {
        cwd: modelDir,
        encoding: "utf8",
      });
      if (probe.error || probe.status !== 0)
        return (
          "SKIP: python3 or dukkan_tahmin unavailable (" +
          (probe.error?.code || probe.stderr.trim().split("\n").at(-1)) +
          ")"
        );
      const script = [
        "import json, sys",
        "from dukkan_tahmin.io_csv import load_canonical, read_canonical_rows",
        "out = []",
        "for p in sys.argv[1:]:",
        "    rows, invalid, cols = read_canonical_rows(p)",
        "    d = load_canonical(p)",
        "    s = d.sales.sort_values(['tarih', 'barkod'])",
        "    out.append({'rows': len(rows), 'invalid': invalid, 'sep': cols['separator'],",
        "                'sales': [[str(r.tarih.date()), r.barkod, float(r.miktar), float(r.tutar)] for r in s.itertuples()],",
        "                'units': sorted(set(d.products['birim'])), 'missing': d.quality['missing_days']})",
        "print(json.dumps(out))",
      ].join("\n");
      const run = spawnSync("python3", ["-c", script, productDayFiles.plain, productDayFiles.all], {
        cwd: modelDir,
        encoding: "utf8",
      });
      if (run.status !== 0) throw Error("python: " + run.stderr.trim().split("\n").at(-1));
      const [plain, all] = JSON.parse(run.stdout);
      const sales = (r) => r.sales.map((x) => x.join(",")).join(" | ");
      if (plain.rows !== 2 || plain.invalid || plain.sep !== ";")
        throw Error("plain: " + JSON.stringify(plain));
      if (sales(plain) !== "2026-03-02,0869000000017,3,37.5 | 2026-03-04,0869000000017,4,50")
        throw Error("plain sales: " + sales(plain));
      if (all.rows !== 4 || all.invalid) throw Error("all: " + JSON.stringify(all));
      const simit = all.sales.filter((x) => x[1] === "app:rt2").map((x) => x[2]);
      if (simit.join() !== "1,2") throw Error("app:rt2 quantities " + simit.join());
      if (all.units.join() !== "adet") throw Error("units " + all.units.join());
      if (plain.missing.join() !== "2026-03-03") throw Error("missing days " + plain.missing.join());
      return "2 + 4 satır · miktar 3/4 · 2026-03-03 eksik gün";
    });
    fs.rmSync(productDayDir, { recursive: true, force: true });

    await step("no console/page errors", async () => {
      if (errors.length) throw Error(errors.length + " error(s)");
      return "0 errors";
    });
  } catch (e) {
    results.push({ ok: false, name: "setup", detail: String(e.message || e) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }

  const w = Math.max(...results.map((r) => r.name.length), 4);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}`);
  for (const e of errors) console.log("  " + e);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
