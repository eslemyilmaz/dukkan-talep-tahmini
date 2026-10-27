/* Assistant page: notification preferences and message previews (nothing is sent). */
"use strict";

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
        )}</div><label class="field">Gün sonu bildirim saati · Türkiye saati<input id="sendTime" type="time" value="${esc(settings.time)}"></label><label class="field">Tercih edilen kanal<select id="channel"><option>Telegram</option><option>E-posta</option><option>WhatsApp</option></select></label><button class="primary" onclick="savePreferences()">Tercihleri kaydet</button></section><section class="card panel"><div class="paneltop"><h2>Bildirim ön izlemesi</h2><span class="agentBadge">Örnek mesaj</span></div><div style="background:#f7f6f6;border:1px solid var(--line);border-radius:12px;padding:22px"><strong>Dükkan · Yılmaz Market</strong><p style="margin-top:16px">Gününüzün kısa özeti hazır.</p><p>Bugünkü ciro: <strong>${money(32450)}</strong><br>Satış adedi: <strong>286</strong><br>Düşük stok: <strong>${lowStock().length} ürün</strong></p><p class="muted">Örnek veri · Gerçek mesaj gönderilmedi.</p></div><button style="margin-top:17px" onclick="previewMessage()">Stok uyarısını ön izle</button><div class="insight"><h3>Otomasyon nasıl bağlanacak?</h3><p>n8n veya tercih edeceğiniz ajan, satış ve stok verisini kontrol edip seçilen kanala mesaj iletecek. Bu sürümde dış servise bağlantı ve zamanlanmış gönderim yok.</p><button class="link" onclick="downloadEvent()">Örnek entegrasyon verisini indir ↓</button></div></section></div>`
    );
  },
  afterRender() {
    document.getElementById("channel").value = settings.channel;
  },
};
function savePreferences() {
  settings.savePreferences(
    document.getElementById("sendTime").value,
    document.getElementById("channel").value,
  );
  toast("Tercihler bu tarayıcıya kaydedildi. Gönderim henüz bağlı değil.");
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
