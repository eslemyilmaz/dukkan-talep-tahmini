/* Installable app: service worker registration, the "Uygulamayı yükle" button and the update notice.
   Loaded last. Does nothing inside the phone/tablet preview frames or where service workers cannot run
   (file:// and plain http on a non-local address). */
"use strict";

(() => {
  if (/[?&](mobile|tablet)=1\b/.test(location.search)) return;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (!("serviceWorker" in navigator) || !(location.protocol === "https:" || local)) return;

  let installPrompt = null,
    updateShown = false;

  function installButton() {
    let button = document.getElementById("installButton");
    if (button) return button;
    button = document.createElement("button");
    button.id = "installButton";
    button.className = "installButton hidden";
    button.type = "button";
    button.title = "Ana ekrana ekleyin; internet olmadan da açılır.";
    button.textContent = "Uygulamayı yükle";
    button.addEventListener("click", async () => {
      if (!installPrompt) return;
      let prompt = installPrompt;
      installPrompt = null;
      button.classList.add("hidden");
      prompt.prompt();
      try {
        await prompt.userChoice;
      } catch {
        // Ignored: the browser may offer the prompt again later.
      }
    });
    let anchor = document.querySelector(".headerActions .phoneButton");
    if (anchor) anchor.after(button);
    else document.querySelector(".headerActions")?.prepend(button);
    return button;
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    installButton().classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    document.getElementById("installButton")?.classList.add("hidden");
    toast("Uygulama yüklendi.");
  });

  function announceUpdate() {
    if (updateShown) return;
    updateShown = true;
    toast("Yeni sürüm hazır; sayfayı yenileyin.");
  }
  // A worker that installs while this page already has a controller is a new version.
  function watch(worker) {
    if (!worker) return;
    const check = () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) announceUpdate();
    };
    check();
    worker.addEventListener("statechange", check);
  }

  navigator.serviceWorker
    .register("sw.js")
    .then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) announceUpdate();
      watch(registration.installing);
      registration.addEventListener("updatefound", () => watch(registration.installing));
    })
    .catch(() => console.warn("Çevrimdışı kullanım için service worker kaydedilemedi."));
})();
