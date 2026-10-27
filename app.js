/* Shared state, helpers and the router. Page modules register nothing themselves: main.js lists the
   pages in nav order and calls boot(). Scripts are classic `defer` scripts sharing one global scope. */
"use strict";

const isPreview = /[?&](mobile|tablet)=1\b/.test(location.search);
const debug = /[?&]debug=1\b/.test(location.search) ? (window.__dukkanDebug = { renders: 0 }) : null;

// ---------- Formatting ----------
const moneyFormats = {};
// Amounts in TL. Two decimals everywhere on screen; chart axis labels pass digits = 0.
function money(tl, digits = 2) {
  moneyFormats[digits] ??= new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return moneyFormats[digits].format(tl);
}
// Amounts in kuruş (register snapshots store integer kuruş).
const moneyKurus = (kurus) => money(kurus / 100);
const fmt = (n) => new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 3 }).format(n);
const ds = (d) => d.split("-").reverse().join(".");
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const uid = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("");

const todayTR = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const timeTR = () =>
  new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());

// ---------- Settings (assistant preferences; keys unchanged) ----------
function readJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function writeKey(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
const settings = {
  rules: readJSON("dukkan-rules", [true, true, true]),
  setRule(i, on) {
    settings.rules[i] = on;
    writeKey("dukkan-rules", JSON.stringify(settings.rules));
  },
  get time() {
    try {
      return localStorage.getItem("dukkan-time") || "22:00";
    } catch {
      return "22:00";
    }
  },
  get channel() {
    try {
      return localStorage.getItem("dukkan-channel") || "Telegram";
    } catch {
      return "Telegram";
    }
  },
  savePreferences(time, channel) {
    return writeKey("dukkan-time", time) && writeKey("dukkan-channel", channel);
  },
};

// ---------- Product list (the register snapshot replaces it in initRegister) ----------
const sampleProducts = () => [
  { name: "Ekmek", category: "Temel gıda", stock: 18, min: 30, price: 15, icon: "◒", daily: 42 },
  { name: "Süt · 1 L", category: "Süt ürünleri", stock: 8, min: 15, price: 45, icon: "▯", daily: 12 },
  { name: "Yumurta · 30’lu", category: "Temel gıda", stock: 5, min: 10, price: 150, icon: "▦", daily: 4 },
  { name: "Ayçiçek yağı · 1 L", category: "Temel gıda", stock: 24, min: 10, price: 85, icon: "♧", daily: 3 },
  { name: "Çay · 500 g", category: "İçecek", stock: 32, min: 12, price: 130, icon: "▱", daily: 3 },
  { name: "Su · 1,5 L", category: "İçecek", stock: 65, min: 30, price: 15, icon: "♧", daily: 20 },
];
let products = readJSON("dukkan-products", null) || sampleProducts();
const productById = (id) => products.find((p) => p.id === id);
const lowStock = () => products.filter((p) => p.stock < p.min);

// ---------- UI helpers ----------
let toastTimer = 0;
function toast(t) {
  let el = document.getElementById("toast");
  el.textContent = t;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3800);
}
function modal(title, html) {
  document.getElementById("mtitle").textContent = title;
  document.getElementById("mbody").innerHTML = html;
  document.getElementById("modal").showModal();
}
const closeModal = () => document.getElementById("modal").close();
// Shows a failure next to the form when it has a role=alert element, otherwise as a toast.
function showError(form, message) {
  let el = form?.querySelector('[role="alert"]');
  if (el) el.textContent = message;
  else toast(message);
}
function title(t, s, buttons = "") {
  return `<div class="titlebar"><div><h1>${t}</h1><p class="subtitle">${s}</p></div><div class="actions">${buttons}</div></div>`;
}
function download(name, text, type = "text/csv;charset=utf-8") {
  let a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function csvrow(a) {
  return a.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(";");
}
// Returns [{ line, cells }] where line is the 1-based file line the row starts on; blank rows are skipped.
function parseCSV(t) {
  t = t.replace(/^﻿/, "");
  let sep = t.split(/\r?\n/)[0].includes(";") ? ";" : ",";
  let rows = [],
    r = [],
    s = "",
    quote = false,
    line = 1,
    start = 1;
  const endRow = () => {
    r.push(s.trim());
    if (r.some(Boolean)) rows.push({ line: start, cells: r });
    r = [];
    s = "";
  };
  for (let i = 0; i < t.length; i++) {
    let c = t[i];
    if (c === "\n") line++;
    if (c === '"') {
      if (quote && t[i + 1] === '"') {
        s += '"';
        i++;
      } else quote = !quote;
    } else if (c === sep && !quote) {
      r.push(s.trim());
      s = "";
    } else if (c === "\n" && !quote) {
      endRow();
      start = line;
    } else if (c !== "\r") s += c;
  }
  if (quote) throw Error("Kapanmamış çift tırnak var.");
  endRow();
  return rows;
}

// ---------- Icons ----------
const paths = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  stock: "M3 7l9-4 9 4v11l-9 4-9-4z M3 7l9 4 9-4 M12 11v11",
  forecast: "M3 19h18 M5 15l5-5 4 3 6-9",
  agent: "M12 3v3 M7 6h10a4 4 0 014 4v7a3 3 0 01-3 3H6a3 3 0 01-3-3v-7a4 4 0 014-4 M8 11v3 M16 11v3 M9 17h6",
  report: "M5 3h10l4 4v14H5z M9 11h6 M9 15h6",
  sale: "M3 3h2l3 12h10l3-8H6 M9 20h.01 M18 20h.01",
  credit: "M3 5h18v15H3z M3 9h18 M7 14h4",
};
const ico = (k) =>
  `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[k] || paths.report}"/></svg>`;

// ---------- Router ----------
// pages: ordered [{ id, label, icon, render() -> html, afterRender?({ entered }), badge?() -> text }]
let pages = [];
let page = "overview";
let lastRendered = null;
const currentPage = () => pages.find((p) => p.id === page) || pages[0];
function navigate(id) {
  criticalOnly = false;
  page = id;
  render();
  window.scrollTo(0, 0);
}
function dataBadge() {
  return salesData ? "Gerçek satış · stok ayrı" : "Örnek veri";
}
function render() {
  if (debug) debug.renders++;
  let current = currentPage();
  page = current.id;
  document.getElementById("nav").innerHTML = pages
    .map(
      (p) =>
        `<button class="${p.id === page ? "active" : ""}" onclick="navigate('${p.id}')">${ico(p.icon)}<span>${p.label}</span></button>`,
    )
    .join("");
  document.getElementById("crumb").textContent = current.label;
  document.getElementById("content").innerHTML = current.render();
  let entered = lastRendered !== page;
  lastRendered = page;
  current.afterRender?.({ entered });
  document.querySelector(".demo").textContent = current.badge?.() || dataBadge();
}
