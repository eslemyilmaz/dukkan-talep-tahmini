// Playwright smoke test: serves the repo with python3 http.server, clicks through the app, makes one sale.
// Usage: node test/smoke/run.js   (exit code 1 on any failed step or console/page error)
"use strict";
const { spawn } = require("node:child_process");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
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
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector("#nav button", { timeout: 5000 });
      return url;
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
