// Playwright smoke test: serves the repo with python3 http.server, clicks through the app, makes sales,
// adds a product, records a credit collection, checks the preview frame and loads a sales report fixture.
// Usage: node test/smoke/run.js   (exit code 1 on any failed step or console/page error)
"use strict";
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

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
    const page = await (await browser.newContext()).newPage();
    page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

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
      const saved = await page.evaluate(() => localStorage.getItem("dukkan-register-v1"));
      await page.evaluate(() => localStorage.setItem("dukkan-register-v1", "{broken"));
      await page.locator("#stockTable button.link").first().click();
      await page.locator("#mbody button.primary").click();
      await page.waitForTimeout(200);
      const open = await page.evaluate(() => document.getElementById("modal").open);
      const msg = await page.locator("#mbody [role=alert]").textContent();
      await page.evaluate((s) => localStorage.setItem("dukkan-register-v1", s), saved);
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

    await step("reports: load sales report fixture", async () => {
      await gotoNav(page, "Raporlar");
      await page.setInputFiles("#salesFile", FIXTURE);
      await page.click("#salesImport");
      return waitToast(page, "Gerçek satış raporu yüklendi.", 30000);
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
