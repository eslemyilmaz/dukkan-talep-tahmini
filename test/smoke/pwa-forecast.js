// Playwright smoke test for the installable app and the tahmin.json source: serves the repo with python3
// http.server, checks the manifest and the service worker, reloads offline, then loads the model-output
// fixture on the forecasts page, adds a matching product and checks the suggested order, the stock-page
// line, persistence across a reload, removal and error messages.
// Usage: node test/smoke/pwa-forecast.js   (exit code 1 on any failed step or console/page error)
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "tahmin-ornek.json");
const model = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const results = [];
const errors = [];

const nf = (opts) => new Intl.NumberFormat("tr-TR", opts);
const fmt = (n) => nf({ maximumFractionDigits: 3 }).format(n);
const pct = (n) => "%" + nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const ds = (d) => d.split("-").reverse().join(".");
// Expected suggestion, computed independently in integer pack counts.
function expectedOrder(stock, onHand) {
  const pack = stock.pack_size > 0 ? stock.pack_size : 1;
  const packs = Math.ceil(Math.round((Math.max(0, stock.order_up_to - onHand) / pack) * 1e6) / 1e6);
  return Math.round(packs * pack * 1000) / 1000;
}

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

async function waitToast(page, want, timeout = 4000) {
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

async function gotoNav(page, label) {
  await page.locator("#nav button", { hasText: label }).first().click();
  await page.waitForTimeout(150);
  return heading(page);
}

async function expectHeading(page, label, want) {
  const h = await gotoNav(page, label);
  if (h !== want) throw Error(`heading "${h}", expected "${want}"`);
  return h;
}

const orderText = (page, barcode) =>
  page.locator(`#tahminTable tr[data-barcode="${barcode}"] .orderCell`).innerText();

// Fills the add-product modal that is already open; the barcode must be prefilled.
async function fillProduct(page, barcode, name, stock) {
  const prefilled = await page.inputValue("#mbody [name=barcode]");
  if (prefilled !== barcode) throw Error(`barcode prefill "${prefilled}"`);
  await page.fill("#mbody [name=name]", name);
  await page.fill("#mbody [name=category]", "Temel gıda");
  await page.fill("#mbody [name=stock]", String(stock));
  await page.fill("#mbody [name=min]", "5");
  await page.fill("#mbody [name=price]", "10");
  await page.locator("#mbody button.primary").click();
  await page.waitForFunction(() => !document.getElementById("modal").open, null, { timeout: 4000 });
  await waitToast(page, "Ürün listenize eklendi.");
}

(async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const serve = () =>
    spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      cwd: ROOT,
      stdio: "ignore",
    });
  let server = serve();
  let browser;
  try {
    await waitForServer(url);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

    await step("load app", async () => {
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector("#nav button", { timeout: 5000 });
      return url;
    });

    await step("manifest: linked, served as JSON, parses", async () => {
      const href = await page.$eval('link[rel="manifest"]', (l) => l.href);
      const res = await page.request.get(href);
      if (!res.ok()) throw Error("HTTP " + res.status());
      const type = res.headers()["content-type"] || "";
      if (!/^application\/(manifest\+)?json/.test(type)) throw Error("content-type " + type);
      const m = JSON.parse(await res.text());
      if (m.name !== "Dükkan" || m.lang !== "tr" || m.display !== "standalone") throw Error("fields");
      if (m.start_url !== "./" || m.scope !== "./" || m.theme_color !== "#b72b36") throw Error("urls/colors");
      const maskable = m.icons.filter((i) => i.purpose === "maskable").length;
      for (const icon of m.icons) {
        const r = await page.request.get(new URL(icon.src, href).href);
        if (!r.ok() || !(r.headers()["content-type"] || "").startsWith("image/png"))
          throw Error("icon " + icon.src);
      }
      const touch = await page.$eval('link[rel="apple-touch-icon"]', (l) => l.getAttribute("href"));
      if (touch !== "assets/icon-192.png") throw Error("apple-touch-icon " + touch);
      return `${type} · ${m.icons.length} simge (${maskable} maskable)`;
    });

    await step("service worker: registered, activated, controls the page", async () => {
      const state = await page.evaluate(async () => (await navigator.serviceWorker.ready).active.state);
      await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 5000 });
      const keys = await page.evaluate(async () => {
        const names = await caches.keys();
        const cache = await caches.open("dukkan-shell-v1");
        return { names, urls: (await cache.keys()).map((r) => new URL(r.url).pathname) };
      });
      if (keys.names.join() !== "dukkan-shell-v1") throw Error("caches " + keys.names.join());
      for (const want of ["/", "/index.html", "/app.js", "/sales-worker.js", "/pwa.js", "/polish.css"])
        if (!keys.urls.includes(want)) throw Error("not precached: " + want);
      return `${state} · ${keys.urls.length} dosya önbellekte`;
    });

    await step("install button only after beforeinstallprompt", async () => {
      if (await page.locator("#installButton:not(.hidden)").count()) throw Error("visible without the event");
      await page.evaluate(() => {
        const e = new Event("beforeinstallprompt", { cancelable: true });
        e.prompt = () => {};
        e.userChoice = Promise.resolve({ outcome: "dismissed" });
        window.dispatchEvent(e);
      });
      const button = page.locator(".headerActions #installButton");
      if (!(await button.isVisible())) throw Error("not shown after the event");
      const text = (await button.textContent()).trim();
      await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
      if (await button.isVisible()) throw Error("still visible after appinstalled");
      return text;
    });

    // Offline twice over: the browser context is offline and the HTTP server is stopped.
    await step("offline reload renders the app", async () => {
      await context.setOffline(true);
      await new Promise((resolve) => {
        server.once("exit", resolve);
        server.kill();
      });
      try {
        await page.reload({ waitUntil: "load" });
        await page.waitForSelector("#nav button", { timeout: 5000 });
        const n = await page.locator("#nav button").count();
        if (n !== 8) throw Error(n + " nav buttons");
        const fromWorker = await page.evaluate(
          () => performance.getEntriesByType("navigation")[0].workerStart > 0,
        );
        if (!fromWorker) throw Error("navigation did not go through the service worker");
        const h = await expectHeading(page, "Tahminler", "Talep tahminleri");
        return `8 buttons · ${h}`;
      } finally {
        server = serve();
        await waitForServer(url);
        await context.setOffline(false);
      }
    });

    await step("tahminler: no file → demo view and load card, no source switch", async () => {
      await page.reload({ waitUntil: "networkidle" });
      const h = await expectHeading(page, "Tahminler", "Talep tahminleri");
      if (!(await page.locator("#tahminLoad #tahminFile").count())) throw Error("no load card");
      if (await page.locator(".sourceSwitch").count()) throw Error("source switch without a file");
      return h;
    });

    await step("invalid JSON shows an error", async () => {
      await page.setInputFiles("#tahminFile", {
        name: "bozuk.json",
        mimeType: "application/json",
        buffer: Buffer.from("{bozuk"),
      });
      await page.waitForFunction(() => document.querySelector("#tahminResult")?.textContent.trim());
      const msg = (await page.locator("#tahminResult").textContent()).trim();
      if (!msg.includes("geçerli bir JSON değil")) throw Error(msg);
      return msg;
    });

    await step("contract error names the first problem", async () => {
      const bad = structuredClone(model);
      delete bad.products[3].stock.order_up_to;
      await page.setInputFiles("#tahminFile", {
        name: "eksik.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(bad)),
      });
      await page.waitForFunction(() => document.querySelector("#tahminResult")?.textContent.includes("["));
      const msg = (await page.locator("#tahminResult").textContent()).trim();
      if (!msg.includes("products[3].stock.order_up_to")) throw Error(msg);
      const v2 = await page.evaluate((d) => tahminProblem({ ...d, version: 2 }), model);
      if (!v2.includes('"version"')) throw Error(v2);
      return msg.replace("Tahmin dosyası yüklenemedi: ", "");
    });

    await step("load fixture → header card with origin and WAPE", async () => {
      await page.setInputFiles("#tahminFile", FIXTURE);
      await waitToast(page, "Tahmin dosyası yüklendi.");
      const h = await heading(page);
      if (h !== "Model tahminleri") throw Error("heading " + h);
      const head = await page.locator("#tahminHead").innerText();
      const s = model.evaluation.summary;
      const want = [
        ds(model.origin),
        ds(model.horizons.monthly.start),
        pct(s.weekly.wape_pilot.combined),
        pct(s.weekly.wape_pilot.xgboost),
        pct(s.monthly.wape_pilot.combined),
        pct(s.monthly.wape_pilot.seasonal_naive),
        "Bu değerler geriye dönük test ölçümüdür; gelecekteki başarıyı garanti etmez. Tahmin edilen değişken gözlenen satıştır, talep değildir.",
        model.warnings[0],
      ];
      const missing = want.filter((w) => !head.includes(w));
      if (missing.length) throw Error("missing: " + missing.join(" | "));
      const badge = (await page.locator(".demo").textContent()).trim();
      return `${ds(model.origin)} · haftalık ${pct(s.weekly.wape_pilot.combined)} · ${badge}`;
    });

    await step("table rows = products in file", async () => {
      const rows = await page.locator("#tahminTable tbody tr").count();
      if (rows !== model.products.length) throw Error(`${rows} rows, file has ${model.products.length}`);
      const fileOnly = await page.locator("#tahminFileOnly li").count();
      return `${rows} rows · ${fileOnly} uygulamada tanımlı değil`;
    });

    const unitProduct = model.products.find((p) => p.unit === "adet" && p.stock.order_up_to > 30);
    const kgProduct = model.products.find((p) => p.unit === "kg" && p.stock.pack_size !== 1);
    await step("Ürün olarak ekle → suggested order = ceil_pack(max(0, S − stock))", async () => {
      await page.locator(`#tahminFileOnly button[data-barcode="${unitProduct.barcode}"]`).click();
      await fillProduct(page, unitProduct.barcode, unitProduct.name + " (model)", 20);
      const want = expectedOrder(unitProduct.stock, 20);
      const got = (await orderText(page, unitProduct.barcode)).trim();
      if (got !== `${fmt(want)} adet`) throw Error(`got "${got}", want ${fmt(want)} adet`);
      // A kg product with a fractional pack size, added from the order column.
      await page.locator(`#tahminTable tr[data-barcode="${kgProduct.barcode}"] .orderCell button`).click();
      await fillProduct(page, kgProduct.barcode, kgProduct.name + " (model)", 3);
      const wantKg = expectedOrder(kgProduct.stock, 3);
      const gotKg = (await orderText(page, kgProduct.barcode)).trim();
      if (gotKg !== `${fmt(wantKg)} kg`) throw Error(`got "${gotKg}", want ${fmt(wantKg)} kg`);
      const first = await page.locator("#tahminTable tbody tr").first().getAttribute("data-barcode");
      if (first !== unitProduct.barcode) throw Error("not sorted by suggested order: first " + first);
      return `${unitProduct.name}: ${got} · ${kgProduct.name}: ${gotKg} (paket ${fmt(kgProduct.stock.pack_size)})`;
    });

    await step("sort by name", async () => {
      await page.selectOption("#tahminSort", "name");
      const names = await page.locator("#tahminTable tbody tr .tahminName strong").allTextContents();
      const sorted = [...names].sort((a, b) => a.localeCompare(b, "tr"));
      if (names.join("|") !== sorted.join("|")) throw Error("not sorted: " + names.slice(0, 3).join(", "));
      await page.selectOption("#tahminSort", "order");
      return names[0] + " …";
    });

    await step("flags shown as pills with Turkish tooltips", async () => {
      const flagged = await page.evaluate(() =>
        flagPills(["new_product", "fallback_a0", "inactive", "ss_pooled", "not_in_backtest"]),
      );
      const titles = [...flagged.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
      if (titles.length !== 5 || titles.some((t) => !t)) throw Error(flagged.slice(0, 80));
      return titles.length + " bayrak";
    });

    await step("stock page: suggested-order line and edit modal", async () => {
      await gotoNav(page, "Ürünler & stok");
      const line = `Önerilen sipariş: ${fmt(expectedOrder(unitProduct.stock, 20))} (hedef ${fmt(unitProduct.stock.order_up_to)})`;
      const table = await page.locator("#stockTable").innerText();
      if (!table.includes(line)) throw Error("missing: " + line);
      const lines = await page.locator("#stockTable .orderHint").count();
      const row = page.locator("#stockTable tr", { hasText: unitProduct.name + " (model)" });
      await row.locator("button.link").click();
      const body = await page.locator("#mbody").innerText();
      if (!body.includes(line)) throw Error("modal missing the line");
      // Above the target the suggestion is zero.
      await page.fill("#mbody [name=stock]", String(Math.ceil(unitProduct.stock.order_up_to) + 5));
      await page.locator("#mbody button.primary").click();
      await waitToast(page, "Stok güncellendi.");
      const zero = `Önerilen sipariş: 0 (hedef ${fmt(unitProduct.stock.order_up_to)})`;
      if (!(await page.locator("#stockTable").innerText()).includes(zero)) throw Error("missing: " + zero);
      return `${lines} satır · ${line}`;
    });

    await step("reload → file restored from IndexedDB", async () => {
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("#nav button");
      const h = await expectHeading(page, "Tahminler", "Model tahminleri");
      const rows = await page.locator("#tahminTable tbody tr").count();
      if (rows !== model.products.length) throw Error(rows + " rows");
      const got = (await orderText(page, unitProduct.barcode)).trim();
      if (got !== "0 adet") throw Error("order after restore " + got);
      return `${h} · ${rows} rows`;
    });

    await step("source switch: demo and report stay reachable", async () => {
      await page.locator(".sourceSwitch button", { hasText: "Örnek senaryo" }).click();
      const h = await heading(page);
      if (h !== "Talep tahminleri") throw Error("demo heading " + h);
      if (!(await page.locator("#forecastTable tbody tr").count())) throw Error("demo table empty");
      await page.locator(".sourceSwitch button", { hasText: "Model çıktısı" }).click();
      const back = await heading(page);
      if (back !== "Model tahminleri") throw Error("model heading " + back);
      return "Örnek senaryo ↔ Model çıktısı";
    });

    await step("reports page: model output card links to Tahminler", async () => {
      await gotoNav(page, "Raporlar");
      const card = await page.locator("#modelOutput").innerText();
      if (!card.includes("python -m dukkan_tahmin tahmin --girdi")) throw Error("command missing");
      if (!card.includes("API")) throw Error("API note missing");
      await page.locator("#modelOutput button.primary").click();
      await page.waitForTimeout(150);
      const h = await heading(page);
      if (h !== "Model tahminleri") throw Error("heading " + h);
      return h;
    });

    await step("Tahmin dosyasını kaldır clears it (also after reload)", async () => {
      await page.locator("#content .actions button", { hasText: "Tahmin dosyasını kaldır" }).click();
      await waitToast(page, "Tahmin dosyası kaldırıldı.");
      const h = await heading(page);
      if (h !== "Talep tahminleri") throw Error("heading " + h);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("#nav button");
      await expectHeading(page, "Tahminler", "Talep tahminleri");
      if (!(await page.locator("#tahminLoad").count())) throw Error("load card missing");
      const stockLines = await (async () => {
        await gotoNav(page, "Ürünler & stok");
        return page.locator("#stockTable .orderHint").count();
      })();
      if (stockLines) throw Error(stockLines + " stock lines remain");
      return h;
    });

    await step("preview frame: no install button, app renders", async () => {
      const preview = await context.newPage();
      preview.on("pageerror", (e) => errors.push("preview pageerror: " + e.message));
      await preview.goto(url + "?tablet=1", { waitUntil: "networkidle" });
      await preview.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt")));
      const n = await preview.locator("#installButton").count();
      await preview.close();
      if (n) throw Error("install button in preview");
      return "0 buttons";
    });

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
