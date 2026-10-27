/* Assistant page: notification preferences, message previews (nothing is sent) and the backup card
   (download / restore of the register records; data side in register.js, file format in storage.js). */
"use strict";

let storageInfo = null,
  pendingRestore = null,
  backupBusy = false;

const ruleTexts = [
  ["Düşük stok uyarısı", "Ürün stoğu belirlediğiniz alt sınırın altına indiğinde."],
  ["Gün sonu özeti", "Günlük ciro, satış adedi ve kritik stok özeti."],
  ["Talep tahmini özeti", "Haftalık ihtiyaç ve önerilen stok hazırlığı."],
];
const assistantPage = {
  id: "assistant",
  label: "Asistan",
  icon: "agent",
  render() {
    return (
      `<section class="card panel" style="margin-bottom:22px"><div class="paneltop"><div><div class="eyebrow">Günlük özet</div><h2>Bugün en çok ne satıldı?</h2><p class="muted">Ürünler, miktarlar ve satış tutarları gün sonu tablosunda.</p></div><button class="primary" onclick="navigate('dayEnd')">Gün sonunu incele →</button></div></section>` +
      title("Dükkan Asistanı", "İşletmenizin önemli haberleri, doğru zamanda elinizin altında.") +
      `<div class="twocol"><section class="card panel"><div class="paneltop"><h2>Otomatik bildirimler</h2><span class="pill">Bağlantı bekleniyor</span></div><div class="rules">${ruleTexts
        .map(
          (r, i) =>
            `<label class="rule"><div><h3>${r[0]}</h3><p>${r[1]}</p></div><input type="checkbox" ${settings.rules[i] ? "checked" : ""} onchange="settings.setRule(${i},this.checked)" aria-label="${r[0]}"></label>`,
        )
        .join(
          "",
        )}</div><label class="field">Gün sonu bildirim saati · Türkiye saati<input id="sendTime" type="time" value="${esc(settings.time)}"></label><label class="field">Tercih edilen kanal<select id="channel"><option>Telegram</option><option>E-posta</option><option>WhatsApp</option></select></label><button class="primary" onclick="savePreferences()">Tercihleri kaydet</button></section><section class="card panel"><div class="paneltop"><h2>Bildirim ön izlemesi</h2><span class="agentBadge">Örnek mesaj</span></div><div style="background:#f7f6f6;border:1px solid var(--line);border-radius:12px;padding:22px"><strong>Dükkan · Yılmaz Market</strong><p style="margin-top:16px">Gününüzün kısa özeti hazır.</p><p>Bugünkü ciro: <strong>${money(32450)}</strong><br>Satış adedi: <strong>286</strong><br>Düşük stok: <strong>${lowStock().length} ürün</strong></p><p class="muted">Örnek veri · Gerçek mesaj gönderilmedi.</p></div><button style="margin-top:17px" onclick="previewMessage()">Stok uyarısını ön izle</button><div class="insight"><h3>Otomasyon nasıl bağlanacak?</h3><p>n8n veya tercih edeceğiniz ajan, satış ve stok verisini kontrol edip seçilen kanala mesaj iletecek. Bu sürümde dış servise bağlantı ve zamanlanmış gönderim yok.</p><button class="link" onclick="downloadEvent()">Örnek entegrasyon verisini indir ↓</button></div></section></div>` +
      backupCard()
    );
  },
  // Quota and persistence for the backup card.
  load: () =>
    Store.storageInfo().then((info) => {
      storageInfo = info;
    }),
  afterRender() {
    document.getElementById("channel").value = settings.channel;
  },
};
async function savePreferences() {
  let ok = await settings.savePreferences(
    document.getElementById("sendTime").value,
    document.getElementById("channel").value,
  );
  toast(
    ok
      ? "Tercihler bu tarayıcıya kaydedildi. Gönderim henüz bağlı değil."
      : "Tercihler kaydedilemedi. Tarayıcı depolamasını kontrol edin.",
  );
}

// ---------- Backup ----------
const megabytes = (n) => new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(n / 1e6) + " MB";
function storageLine() {
  let i = storageInfo || {},
    used =
      i.usage === null || i.usage === undefined
        ? "Kullanılan alan bu tarayıcıda ölçülemiyor."
        : `Kullanılan alan: ${megabytes(i.usage)}${i.quota ? " / yaklaşık " + megabytes(i.quota) : ""}.`,
    persisted =
      i.persisted === null || i.persisted === undefined
        ? "Kalıcı depolama: bilinmiyor"
        : "Kalıcı depolama: " + (i.persisted ? "açık" : "kapalı");
  return `${used} ${persisted}${i.persisted === false ? " (tarayıcı yer açmak için site verilerini silebilir; düzenli yedek alın)" : ""}.`;
}
function backupCard() {
  return `<section class="card panel" id="backupCard" style="margin-top:24px"><div class="paneltop"><div><div class="eyebrow">Veri güvenliği</div><h2>Yedekleme</h2><p class="muted">Satışlar, işletme içi kullanım, tahsilatlar, ürünler, müşteri hesapları ve tercihler yalnızca bu tarayıcıda durur. Site verilerini temizlemek, tarayıcıyı sıfırlamak veya cihazı değiştirmek bu kayıtları siler. Düzenli olarak yedek indirip cihaz dışında (USB bellek, e-posta, bulut klasörü) saklayın.</p></div><span class="agentBadge">Bu cihaz</span></div>${regProblem ? `<div class="note">${esc(regProblem)}</div>` : ""}<div class="twocol"><div><h3>Yedek indir</h3><p class="muted">Tek bir JSON dosyası: <code>dukkan-yedek-YYYY-AA-GG.json</code>. Yüklenen satış raporu varsayılan olarak eklenmez; rapor yüzlerce MB olabilir ve dosyasından yeniden yüklenebilir.</p><label class="rule" style="margin:14px 0"><div><h3>Satış raporunu da ekle</h3><p>${salesData ? "Yedek dosyası çok büyüyebilir." : "Şu an yüklü satış raporu yok."}</p></div><input type="checkbox" id="backupReport" aria-label="Satış raporunu yedeğe ekle" ${salesData ? "" : "disabled"}></label><button class="primary" id="backupDownload" onclick="downloadBackup()" ${regProblem || backupBusy ? "disabled" : ""}>Yedek indir ↓</button></div><div><h3>Yedekten geri yükle</h3><p class="muted">Seçilen yedek, onayınızdan sonra bu cihazdaki tüm kasa kayıtlarının, ürünlerin ve müşteri hesaplarının yerine geçer. Önce mevcut durumun yedeğini indirin.</p><label class="field">Yedek dosyası<input type="file" id="restoreFile" accept=".json,application/json" onchange="checkBackupFile()" ${regProblem || backupBusy ? "disabled" : ""}></label><div id="restoreResult" role="status"></div></div></div><p class="muted" id="storageInfo" style="margin-top:16px">${storageLine()}</p></section>`;
}
async function downloadBackup() {
  if (backupBusy) return;
  backupBusy = true;
  let button = document.getElementById("backupDownload");
  if (button) button.disabled = true;
  try {
    let withReport = Boolean(document.getElementById("backupReport")?.checked),
      backup = await registerBackup(withReport);
    download(`dukkan-yedek-${todayTR()}.json`, JSON.stringify(backup), "application/json");
    toast(`Yedek indirildi: ${backup.register.entries.length} işlem${withReport ? " ve satış raporu" : ""}.`);
  } catch (e) {
    toast("Yedek alınamadı: " + e.message);
  } finally {
    backupBusy = false;
    if (button) button.disabled = false;
  }
}
async function checkBackupFile() {
  let el = document.getElementById("restoreResult"),
    f = document.getElementById("restoreFile").files[0];
  pendingRestore = null;
  if (!f) {
    el.textContent = "";
    return;
  }
  try {
    let parsed;
    try {
      parsed = JSON.parse(await f.text());
    } catch {
      throw Error("Dosya JSON olarak okunamadı.");
    }
    pendingRestore = Store.readBackup(parsed);
    let s = pendingRestore.summary,
      refusal = Store.restoreRefusal(s, await registerCounts());
    el.innerHTML = `<div class="note"><strong>Yedek özeti</strong><br>${s.exportedAt ? "Alındığı an: " + esc(new Date(s.exportedAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })) + "<br>" : ""}<span id="restoreSummary">${s.entries} işlem · ${s.products} ürün · ${s.customers} müşteri hesabı</span><br>Tarih aralığı: ${s.from ? ds(s.from) + " – " + ds(s.to) : "işlem yok"}<br>Satış raporu: ${s.reportIncluded ? "yedekte var; mevcut raporun yerine geçer" : "yedekte yok; mevcut rapor korunur"}</div>${refusal ? `<p class="danger" id="restoreRefusal">${esc(refusal)}</p><label class="rule" style="margin:10px 0"><div><h3>Mevcut kayıtların yerine geç</h3><p>Bu cihazdaki daha yeni kayıtlar silinir.</p></div><input type="checkbox" id="restoreOverride" aria-label="Mevcut kayıtların yerine geç" onchange="document.getElementById('restoreConfirm').disabled=!this.checked"></label>` : ""}<button class="primary" id="restoreConfirm" onclick="confirmRestore()" ${refusal ? "disabled" : ""}>Bu yedeği geri yükle</button><p id="restoreError" class="danger" role="alert"></p>`;
  } catch (e) {
    pendingRestore = null;
    el.textContent = "Yedek kullanılamaz: " + e.message;
  }
}
async function confirmRestore() {
  if (!pendingRestore || backupBusy) return;
  backupBusy = true;
  let button = document.getElementById("restoreConfirm"),
    override = Boolean(document.getElementById("restoreOverride")?.checked),
    s = pendingRestore.summary;
  button.disabled = true;
  try {
    await restoreRegister(pendingRestore, override);
  } catch (e) {
    backupBusy = false;
    button.disabled = false;
    document.getElementById("restoreError").textContent = "Geri yüklenmedi: " + e.message;
    return;
  }
  pendingRestore = null;
  backupBusy = false;
  await show();
  toast(`Yedek geri yüklendi: ${s.entries} işlem, ${s.products} ürün, ${s.customers} müşteri hesabı.`);
}
function previewMessage() {
  let low = lowStock();
  modal(
    "Stok uyarısı · Ön izleme",
    `<p>Yılmaz Market, ${low.length} ürünün stoğu alt sınırın altında.</p>${low.map((p) => `<p><strong>${esc(p.name)}</strong>: ${p.stock} adet kaldı; alt sınır ${p.min} adet.</p>`).join("")}<p class="muted">Bu mesaj gönderilmedi. Bildirim kanalı bağlantısı bekleniyor.</p>`,
  );
}
function downloadEvent() {
  download(
    "dukkan-ornek-olay.json",
    JSON.stringify(
      {
        demo: true,
        event: "stock.low",
        store: "Yılmaz Market",
        timezone: "Europe/Istanbul",
        products: lowStock().map((p) => ({ name: p.name, stock: p.stock, threshold: p.min })),
        note: "Örnek veri. n8n akış dosyası değildir; harici gönderim yapılandırılmamıştır.",
      },
      null,
      2,
    ),
    "application/json",
  );
}
