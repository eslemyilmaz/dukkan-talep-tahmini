/* Service worker: keeps the app shell available offline. No library.
   - Precached same-origin GETs (scripts, styles, icons, the manifest, the sales worker):
     stale-while-revalidate. The cached copy is served at once; the file is fetched again in the background
     and, when its bytes differ, the cache is updated and every open page gets { type: "shell-updated" }
     (pwa.js shows "Yeni sürüm hazır; sayfayı yenileyin." once). The next load uses the new file.
   - Navigations: network-first (a fresh index.html is also stored), falling back to the cached index.html
     when offline.
   - Everything else (for example a tahmin.json fetched by hand, test fixtures) goes to the network untouched
     and is never written to the cache. tahmin.json normally arrives through a file input, not fetch.
   SHELL_HASH is a short hash of every file in ASSETS (test/tools/sw-hash.js). After changing a shell file
   run `npm run sw:hash`; test/unit/sw-version.test.js fails while it is stale. The changed sw.js makes the
   browser install this worker again with a new cache name; the old cache is deleted on activate.
   Between that install and a reload, an open page can still mix old and new files (for example a newer
   sales-worker.js than its sales-report.js); the update notice asks for the reload. */
"use strict";

const SHELL_HASH = "820f3f56";
// Bump the leading number for a change to this worker's own caching rules.
const SHELL_VERSION = "2-" + SHELL_HASH;
const CACHE = "dukkan-shell-v" + SHELL_VERSION;
const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "polish.css",
  "register.css",
  "register-core.js",
  "storage.js",
  "app.js",
  "categories.js",
  "stock.js",
  "sales-report.js",
  "sales-worker.js",
  "day-end.js",
  "register.js",
  "overview.js",
  "forecast.js",
  "assistant.js",
  "reports.js",
  "main.js",
  "pwa.js",
  "assets/m-logo.svg",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "assets/icon-maskable-512.png",
];
const PRECACHED = new Set(ASSETS.map((a) => new URL(a, self.registration.scope).href));
const SHELL = new URL("index.html", self.registration.scope).href;
const ROOT = new URL("./", self.registration.scope).href;

// Each asset is fetched on its own so one missing file (404 or network error) does not fail the install.
async function precache() {
  let cache = await caches.open(CACHE);
  await Promise.all(
    ASSETS.map(async (asset) => {
      try {
        let response = await fetch(new Request(asset, { cache: "reload" }));
        if (response.ok) await cache.put(asset, response);
      } catch {
        // Skipped; the file is fetched from the network when it is next requested.
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith("dukkan-shell-") && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirstPage(request) {
  try {
    let response = await fetch(request);
    let path = new URL(response.url || request.url);
    path.search = path.hash = "";
    if (response.ok && (path.href === SHELL || path.href === ROOT)) {
      let copy = response.clone();
      caches
        .open(CACHE)
        .then((cache) => cache.put(SHELL, copy))
        .catch(() => {});
    }
    return response;
  } catch (err) {
    let cache = await caches.open(CACHE);
    let cached = (await cache.match(SHELL)) || (await cache.match(ROOT));
    if (cached) return cached;
    throw err;
  }
}

async function sameBytes(a, b) {
  let [x, y] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return false;
  let u = new Uint8Array(x),
    v = new Uint8Array(y);
  for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
  return true;
}
// Background half of stale-while-revalidate. "no-cache" revalidates with the server instead of taking the
// HTTP cache's copy. Offline or on an error the cached copy simply stays.
async function revalidate(href, cached) {
  try {
    let fresh = await fetch(new Request(href, { cache: "no-cache" }));
    if (!fresh.ok || (await sameBytes(cached, fresh.clone()))) return;
    let cache = await caches.open(CACHE);
    await cache.put(href, fresh);
    for (let client of await self.clients.matchAll({ type: "window" }))
      client.postMessage({ type: "shell-updated", url: href });
  } catch {
    // Kept as it is.
  }
}

self.addEventListener("fetch", (event) => {
  let request = event.request;
  if (request.method !== "GET") return;
  let url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(request));
    return;
  }
  url.hash = "";
  if (url.search || !PRECACHED.has(url.href)) return;
  event.respondWith(
    (async () => {
      let cached = await caches.match(url.href, { cacheName: CACHE });
      if (cached) {
        event.waitUntil(revalidate(url.href, cached.clone()));
        return cached;
      }
      let response = await fetch(request);
      if (response.ok) {
        let copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(url.href, copy)));
      }
      return response;
    })(),
  );
});
