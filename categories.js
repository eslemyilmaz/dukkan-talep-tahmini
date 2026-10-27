/* Category icon set. Explicit categories take precedence; product-name matching is a fallback and does not
   rewrite source categories. */
"use strict";
const categoryIcons = {
  bread: {
    label: "Ekmek & unlu mamuller",
    path: "M5 10c-2 0-3-2-3-4s2-4 5-4h10c3 0 5 2 5 4s-1 4-3 4v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z M8 6h8 M9 11v6 M15 11v6",
  },
  drink: {
    label: "İçecekler",
    path: "M9 2h6v5l3 4v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-9l3-4Z M9 5h6 M6 13h12 M6 18h12",
  },
  dairy: {
    label: "Süt & süt ürünleri",
    path: "M6 8l3-6h7l3 6v13H6Z M6 8h13 M9 2l3 6v13 M12 8l4-6 M15 12h2 M15 16h2",
  },
  produce: {
    label: "Meyve & sebze",
    path: "M12 8c-5-4-10 0-9 6s6 10 9 7c3 3 8-1 9-7s-4-10-9-6Z M12 8V4 M12 5c1-4 5-4 6-3-1 3-3 4-6 3",
  },
  clean: { label: "Temizlik ürünleri", path: "M8 8h8l3 6v7H5v-7Z M9 8V5h6v3 M9 5V2h8l3 2h-5 M9 14h6v4H9Z" },
  snack: {
    label: "Atıştırmalıklar",
    path: "M5 3l3 1 4-1 4 1 3-1v18l-3-1-4 1-4-1-3 1Z M8 8h8 M15 14a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M11 13h.01 M13 15h.01",
  },
  tobacco: { label: "Tütün ürünleri", path: "M5 6h14v15H5Z M5 10h14 M8 6V2h3v4 M13 6V2h3v4 M8 14h8 M8 17h5" },
  other: { label: "Diğer ürünler", path: "M3 7l9-4 9 4v12l-9 4-9-4Z M3 7l9 4 9-4 M12 11v12 M8 5l9 4" },
};
function normalized(s) {
  return String(s || "")
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i");
}
function categoryKey(p) {
  let c = normalized(p.category || p.group),
    n = normalized(p.name);
  if (/tutun|sigara/.test(c)) return "tobacco";
  if (/sut|peynir|yogurt|mandira/.test(c)) return "dairy";
  if (/ekmek|unlu|firin/.test(c)) return "bread";
  if (/icecek|mesrubat|su urunleri/.test(c)) return "drink";
  if (/meyve|sebze|manav/.test(c)) return "produce";
  if (/temiz|deterjan/.test(c)) return "clean";
  if (/atistir|biskuvi|cikolata/.test(c)) return "snack";
  if (
    /sigara|tutun|marlboro|winston|parliament|muratti|chesterfield|kent blue|kent switch|camel|lark|ld blue|pall mall/.test(
      n,
    )
  )
    return "tobacco";
  if (/biskuvi|cikolata|gofret|cips|kraker|kek/.test(n)) return "snack";
  if (/sut|peynir|yogurt|tereyag|kaymak|kefir|ayran/.test(n)) return "dairy";
  if (/ekmek|pogaca|simit|baget/.test(n)) return "bread";
  if (/cola|kola|fanta|gazoz|icecek|meyve suyu|soda|maden suyu|cay|kahve|^su\b/.test(n)) return "drink";
  if (/deterjan|sabun|camasir|bulasik|yumusatici|sampuan/.test(n)) return "clean";
  if (/elma|armut|muz|domates|salatalik|patates/.test(n)) return "produce";
  return "other";
}
function categorySvg(key) {
  let c = categoryIcons[key] || categoryIcons.other;
  return `<svg viewBox="0 0 24 25" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${c.path}"/></svg>`;
}
function productMark(p) {
  return `<span class="productIcon" title="${esc(categoryIcons[categoryKey(p)].label)}">${categorySvg(categoryKey(p))}</span>`;
}
function productLabel(p) {
  return `<div class="productLabel">${productMark(p)}<div><strong>${esc(p.name)}</strong><small>${esc(p.category || categoryIcons[categoryKey(p)].label)}${p.barcode ? " · " + esc(p.barcode) : ""}</small></div></div>`;
}
function categoryLegend() {
  return `<div class="categoryLegend" aria-label="Kategori simgeleri">${["bread", "drink", "dairy", "tobacco", "clean", "snack"].map((k) => `<span><span class="productIcon">${categorySvg(k)}</span>${esc(categoryIcons[k].label)}</span>`).join("")}</div>`;
}
