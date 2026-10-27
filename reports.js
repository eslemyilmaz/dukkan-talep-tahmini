/* Reports page: sales report import (sales-report.js), stock CSV import (stock.js), the product-day CSV
   export of the register's sales for the model, and the tahmin.json loop. */
"use strict";

// ---------- Product-day CSV for the model (model/dukkan_tahmin/io_csv.py reads it) ----------
// Only kind "sale": internal use and credit collections are not demand. One row per (date, barcode) with
// sales; days without sales are left out (the model treats them as missing days, not zero).
const productDayHeader = ["tarih", "barkod", "urun", "kategori", "birim", "miktar", "tutar"];
let productDayBusy = false;

// entries: register entries in number order. withoutBarcode: products without a barcode are written as
// "app:<id>" (the model forecasts them, but Tahminler matches by barcode only); otherwise they are skipped.
function productDayRows(entries, withoutBarcode) {
  let rows = new Map(),
    latest = new Map(),
    skipped = 0;
  for (let e of entries) {
    if (e.kind !== "sale") continue;
    for (let it of e.items) {
      let code = String(it.barcode || "").trim();
      if (!code) {
        if (!withoutBarcode) {
          skipped++;
          continue;
        }
        code = "app:" + it.id;
      }
      let key = e.date + ";" + code,
        r = rows.get(key);
      if (!r) rows.set(key, (r = { date: e.date, code, q: 0, total: 0 }));
      r.q += it.q;
      r.total += it.total;
      latest.set(code, { name: it.name || "", category: it.category || "" });
    }
  }
  let list = [...rows.values()].sort((a, b) =>
    a.date === b.date ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : a.date < b.date ? -1 : 1,
  );
  return {
    skipped,
    rows: list.map((r) => [
      r.date,
      r.code,
      latest.get(r.code).name,
      latest.get(r.code).category,
      "adet",
      String(r.q),
      (r.total / 100).toFixed(2),
    ]),
  };
}

async function exportProductDay() {
  if (productDayBusy) return;
  let from = document.getElementById("productDayFrom").value,
    to = document.getElementById("productDayTo").value,
    withoutBarcode = document.getElementById("productDayNoBarcode").checked;
  if (regProblem) return toast(regProblem);
  if (from && to && from > to) return toast("Başlangıç tarihi bitiş tarihinden sonra olamaz.");
  let button = document.getElementById("productDayDownload");
  productDayBusy = true;
  button.disabled = true;
  try {
    let { rows, skipped } = productDayRows(
      await registerEntries(from || "0000-01-01", to || "9999-12-31"),
      withoutBarcode,
    );
    let note = skipped ? ` Barkodsuz ${skipped} satış satırı dahil edilmedi.` : "";
    if (!rows.length) return toast("Bu aralıkta modele aktarılacak satış yok." + note);
    let days = new Set(rows.map((r) => r[0])).size,
      codes = new Set(rows.map((r) => r[1])).size;
    download(
      `urun-gun-${from || rows[0][0]}_${to || rows.at(-1)[0]}.csv`,
      "\ufeff" + [productDayHeader.join(";"), ...rows.map(csvrow)].join("\r\n") + "\r\n",
    );
    toast(`Ürün-gün CSV indirildi: ${rows.length} satır · ${codes} ürün · ${days} gün.${note}`);
  } catch (e) {
    toast("Kayıtlar okunamadı: " + (e?.message || e));
  } finally {
    productDayBusy = false;
    button.disabled = false;
  }
}

function productDayCard() {
  return `<section class="card panel bottom" id="productDayExport"><div class="paneltop"><div><h2>Satış kayıtlarını modele aktar</h2><p class="subtitle">Satış ekranında kaydedilen satışlar, tahmin modelinin okuduğu ürün-gün CSV dosyasına (<code>tarih;barkod;urun;kategori;birim;miktar;tutar</code>) dönüştürülür: her gün ve barkod için bir satır, miktar adet, tutar TL.</p></div><span class="agentBadge">Bu cihazın kayıtları</span></div><div class="twocol"><label class="field">Başlangıç · boşsa ilk kayıt<input type="date" id="productDayFrom" aria-label="Başlangıç tarihi"></label><label class="field">Bitiş · boşsa son kayıt<input type="date" id="productDayTo" aria-label="Bitiş tarihi"></label></div><label class="rule" style="margin:6px 0 16px"><div><h3>Barkodsuz ürünleri dahil et</h3><p>Barkodu olmayan ürün model çıktısında uygulamadaki ürünle eşleşmez. İşaretlenirse <code>app:</code> önekli ürün kimliğiyle yazılır; tahmini görülür ama Tahminler sayfası sipariş önerisini yalnızca barkodla bağlar.</p></div><input type="checkbox" id="productDayNoBarcode" aria-label="Barkodsuz ürünleri dahil et"></label><button class="primary" id="productDayDownload" onclick="exportProductDay()" ${regProblem ? "disabled" : ""}>Ürün-gün CSV indir ↓</button><p class="muted" style="margin-top:14px">Öneride ileriye dönük pilot veri yolu budur: dükkânın kendi kasa kayıtları. Yalnızca satışlar aktarılır; işletme içi kullanım ve veresiye tahsilatları dahil edilmez. Satış olmayan günler dosyada hiç yer almaz; model bu günleri sıfır satış değil, eksik gün sayar. Dosya UTF-8, <code>;</code> ayırıcılı; model klasöründe <code>python -m dukkan_tahmin tahmin --girdi urun-gun-….csv --cikti tahmin.json</code> ile kullanılır.</p></section>`;
}

// How a tahmin.json reaches the tablet: the model runs on a computer, the file is carried over by hand.
function modelOutputCard() {
  return `<section class="card panel bottom" id="modelOutput"><div class="paneltop"><div><h2>Model çıktısı</h2><p class="subtitle">Tahmin modeli bu cihazda çalışmaz. Bilgisayardaki Python paketi (<code>model/</code>) bir <code>tahmin.json</code> dosyası üretir; uygulama bu dosyayı okur ve sipariş önerisini buradaki stokla hesaplar.</p></div><span class="agentBadge">Elle aktarım</span></div><ol class="steps"><li><strong>Satış kayıtlarını / raporu bilgisayara aktarın.</strong> <span class="muted">Bu cihazın kasa kayıtları için yukarıdaki “Satış kayıtlarını modele aktar” kartını kullanın. Market programının raporu ise önce <code>python -m dukkan_tahmin donustur --girdi rapor.zip --cikti urun_gun.csv</code> ile ürün-gün tablosuna çevrilir.</span></li><li><strong>Tahmini üretin:</strong> <code>python -m dukkan_tahmin tahmin --girdi urun_gun.csv --cikti tahmin.json</code></li><li><strong>Dosyayı Tahminler sayfasından yükleyin.</strong> <span class="muted">Ürünler barkodla eşleştirilir; dosya bu cihazın tarayıcısında saklanır.</span></li></ol><p class="muted">Yerel ağda çalışan bir API isteğe bağlıdır ve bu sürümde yoktur; dosya elle taşınır. Sonuçlar geriye dönük test ölçümüdür, başarı garantisi değildir.</p><button class="primary" onclick="navigate('forecast')">Tahminler sayfasına git →</button></section>`;
}

const reportsPage = {
  id: "reports",
  label: "Raporlar",
  icon: "report",
  render: () =>
    salesImportPanel() +
    title("Raporlar", "Satış verilerinizi hazırlayın, stok listenizi içeri aktarın.") +
    `<div class="twocol">${stockImportPanel()}<section class="card panel"><h2>Satış verisi ve model eğitimi</h2><p class="subtitle">Üstteki satış raporu alanından gerçek raporunuzu yükleyebilirsiniz. Satış aktarımı güncel stok oluşturmaz ve XGBoost eğitimi başlatmaz.</p><div class="note" style="margin-top:20px">Fiyat girilmeden yapılan “Hesap” satışları ayrı işaretlenecek; ürün bazlı adet ve gelir hesaplarına kontrolsüz eklenmeyecek.</div><h3>Bu sürümde</h3><p class="subtitle">Stok listesi yükleme, ürün ekleme, stok güncelleme ve CSV dışa aktarma çalışır. Veriler bu cihazın tarayıcısında tutulur.</p><button onclick="exportCSV()">↓ Mevcut stok raporunu indir</button></section></div>` +
    productDayCard() +
    modelOutputCard(),
};
