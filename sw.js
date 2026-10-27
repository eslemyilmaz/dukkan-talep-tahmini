/* Service worker: keeps the app shell available offline. No library.
   - Precached same-origin GETs: cache-first (scripts, styles, icons, the manifest, the sales worker).
   - Navigations: network-first, falling back to the cached index.html when offline.
   - Everything else (for example a tahmin.json fetched by hand, test fixtures) goes to the network untouched
     and is never written to the cache. tahmin.json normally arrives through a file input, not fetch.
   Bump CACHE whenever a shell file changes; the old cache is deleted on activate. */
"use strict";

const CACHE = "dukkan-shell-v1";
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
    return await fetch(request);
  } catch (err) {
    let cache = await caches.open(CACHE);
    let cached =
      (await cache.match(SHELL)) || (await cache.match(new URL("./", self.registration.scope).href));
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  let cached = await caches.match(request, { cacheName: CACHE });
  return cached || fetch(request);
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
  event.respondWith(cacheFirst(request));
});
