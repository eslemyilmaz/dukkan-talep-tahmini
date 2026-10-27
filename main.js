/* Composition root: page order, phone/tablet preview, and the single initial render. */
"use strict";

pages = [
  overviewPage,
  salesPage,
  stockPage,
  forecastPage,
  dayEndPage,
  creditPage,
  assistantPage,
  reportsPage,
];

function openPreview(kind) {
  let dialog = document.getElementById("phone"),
    tablet = kind === "tablet";
  dialog.style.width = tablet ? "min(1080px,96vw)" : "";
  dialog.querySelector("h2").textContent = tablet ? "Tablet görünümü" : "Telefon görünümü";
  document.getElementById("phoneFrame").src = location.pathname + (tablet ? "?tablet=1" : "?mobile=1");
  dialog.showModal();
}
const openPhone = () => openPreview("phone");
const openTablet = () => openPreview("tablet");

async function boot() {
  initRegister();
  if (isPreview) {
    document.querySelectorAll(".phoneButton,.tabletButton").forEach((b) => (b.style.display = "none"));
    document
      .querySelector("main")
      .insertAdjacentHTML(
        "afterbegin",
        '<div class="previewBanner" role="note">Ön izleme · kayıtlar ana ekranla ortak</div>',
      );
  }
  // Wait briefly for a stored sales report so the first render already shows it.
  let restoring = restoreSales(),
    restored = await Promise.race([restoring, new Promise((r) => setTimeout(() => r(null), 1500))]);
  render();
  if (restored === null && (await restoring)) render();
}
boot();
