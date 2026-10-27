// Local-only processing: never transmits report data.

// Number rules (cells are already entity-decoded and trimmed; optional leading "-"):
//  - Contains a comma (Turkish format): exactly one comma is the decimal separator; dots are thousands
//    separators and must form 3-digit groups ("1.234,50", "1234,5", ",5" -> 0.5).
//  - No comma, exactly one dot followed by 1-2 digits at the end: the dot is decimal ("1234.56", "1.5").
//  - No comma, dots only in 3-digit groups: dots are thousands separators ("1.234", "1.234.567").
//  - Plain digits are integers. Anything else (e.g. "12.34,5", "1234.567", "1,2,3", "") is rejected.
const numeric = (s) => {
  s = String(s).trim();
  let m = /^(-?)(.*)$/.exec(s),
    sign = m[1],
    body = m[2],
    out;
  if (body.includes(",")) {
    let [int, dec, extra] = body.split(",");
    if (extra !== undefined || !/^\d+$/.test(dec) || !/^(\d*|\d{1,3}(\.\d{3})+)$/.test(int))
      throw Error("Geçersiz sayı");
    out = (int.replace(/\./g, "") || "0") + "." + dec;
  } else if (/^\d*\.\d{1,2}$/.test(body)) out = (body.startsWith(".") ? "0" : "") + body;
  else if (/^\d{1,3}(\.\d{3})+$/.test(body)) out = body.replace(/\./g, "");
  else if (/^\d+$/.test(body)) out = body;
  else throw Error("Geçersiz sayı");
  return Number(sign + out);
};

const NAMED = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
// Single pass, so "&amp;lt;" stays "&lt;" (no double decoding). Unknown entities are left as-is.
function text(s) {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? all;
      let n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    })
    .trim();
}

// 53-bit string hash (cyrb53: two 32-bit halves) over the cell texts, so duplicate detection keeps one
// number per row instead of the full row (which includes customer/personnel columns). A collision
// (~n²/2^54, e.g. ~0.1% for 5 million rows) would under-count duplicates by one; it only affects the
// informational stats.duplicate counter, never the sales totals.
function rowHash(cells) {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let c of cells) {
    for (let i = 0; i < c.length; i++) {
      let ch = c.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ 0x1f, 2654435761); // cell separator
    h2 = Math.imul(h2 ^ 0x1f, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Header matching: Turkish-aware upper-casing, then diacritics folded so "MİKTAR"/"MIKTAR",
// "ÜRÜN ADI"/"URUN ADI" match alike. Per field: exact matches first, then partial (substring) matches,
// patterns in priority order; each column is used once. Category is resolved before name so that
// "ÜRÜN GRUBU" is not taken as the product name.
const fold = (s) =>
  s
    .toLocaleUpperCase("tr")
    .replace(/[İÜÖÇŞĞ]/g, (ch) => ({ İ: "I", Ü: "U", Ö: "O", Ç: "C", Ş: "S", Ğ: "G" })[ch])
    .replace(/\s+/g, " ")
    .trim();
const FIELDS = [
  ["date", ["TARIH"], true],
  ["barcode", ["BARKOD"], true],
  ["category", ["KATEGORI", "GRUP", "GRUB"], false],
  ["qty", ["MIKTAR", "ADET"], true],
  ["price", ["BIRIM FIYAT", "FIYAT"], false],
  ["total", ["TOPLAM", "TUTAR"], true],
  ["name", ["URUN ADI", "URUN", "STOK ADI", "MAL ADI", "ADI", "AD"], true],
];
const NOT_NAME = /MUSTERI|PERSONEL|KASIYER|CARI|SATICI|PLASIYER/;
const FIXED = { date: 0, barcode: 4, name: 5, category: 6, qty: 7, price: 8, total: 9 };
function mapColumns(cells) {
  let f = cells.map(fold),
    used = new Set(),
    map = {};
  for (let pass of ["exact", "partial"])
    for (let [field, patterns] of FIELDS) {
      if (field in map) continue;
      search: for (let p of patterns)
        for (let i = 0; i < f.length; i++) {
          if (used.has(i) || !(pass === "exact" ? f[i] === p : f[i].includes(p))) continue;
          if (field === "name" && NOT_NAME.test(f[i])) continue;
          if (pass === "partial" && p.length < 3) continue; // "AD" only as an exact header
          map[field] = i;
          used.add(i);
          break search;
        }
    }
  let missing = FIELDS.filter(([field, , required]) => required && !(field in map)).map(([field]) => field);
  if (!missing.length) return { source: "header", map };
  if (cells.length === 13) return { source: "fixed", map: { ...FIXED } };
  const label = { date: "TARİH", barcode: "BARKOD", qty: "MİKTAR", total: "TOPLAM", name: "ÜRÜN ADI" };
  throw Error(`Başlık satırında gerekli sütunlar bulunamadı: ${missing.map((k) => label[k]).join(", ")}.`);
}

async function reportStream(file) {
  if (!file.name.toLowerCase().endsWith(".zip")) return file.stream();
  let end = new Uint8Array(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer()),
    v = new DataView(end.buffer),
    e = -1;
  for (let i = end.length - 22; i >= 0; i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      e = i;
      break;
    }
  if (e < 0) throw Error("ZIP dizini okunamadı.");
  let offset = v.getUint32(e + 16, true),
    size = v.getUint32(e + 12, true);
  let buf = await file.slice(offset, offset + size).arrayBuffer(),
    cv = new DataView(buf),
    bytes = new Uint8Array(buf),
    files = [];
  for (let i = 0; i + 46 <= bytes.length; ) {
    if (cv.getUint32(i, true) !== 0x02014b50) throw Error("ZIP dizini geçersiz.");
    let nl = cv.getUint16(i + 28, true),
      ex = cv.getUint16(i + 30, true),
      co = cv.getUint16(i + 32, true),
      name = new TextDecoder().decode(bytes.slice(i + 46, i + 46 + nl));
    if (/\.(xls|html?)$/i.test(name))
      files.push({
        method: cv.getUint16(i + 10, true),
        flags: cv.getUint16(i + 8, true),
        size: cv.getUint32(i + 20, true),
        unpacked: cv.getUint32(i + 24, true),
        offset: cv.getUint32(i + 42, true),
      });
    i += 46 + nl + ex + co;
  }
  if (files.length !== 1) throw Error("ZIP içinde tek bir XLS/HTML satış raporu bulunmalı.");
  let f = files[0];
  if (f.flags & 1) throw Error("Şifreli ZIP desteklenmiyor.");
  if (f.unpacked > 500e6) throw Error("Açılmış rapor en fazla 500 MB olabilir.");
  let h = new DataView(await file.slice(f.offset, f.offset + 30).arrayBuffer());
  if (h.getUint32(0, true) !== 0x04034b50) throw Error("ZIP dosya başlığı hatalı.");
  let start = f.offset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  let stream = file.slice(start, start + f.size).stream();
  if (f.method === 0) return stream;
  if (f.method !== 8) throw Error("Bu ZIP sıkıştırma yöntemi desteklenmiyor.");
  return stream.pipeThrough(new DecompressionStream("deflate-raw"));
}

// Encoding sniffing on the first bytes of the (decompressed) stream, in order:
//  1. BOM (UTF-8, UTF-16LE/BE).
//  2. <meta charset=...> or content="...; charset=..." naming utf-8 or windows-1254 / iso-8859-9
//     (an alias of windows-1254 in the WHATWG Encoding spec). A utf-8 claim whose bytes are not valid
//     UTF-8 is ignored, so a mislabelled windows-1254 export is not decoded into U+FFFD.
//  3. Valid UTF-8 containing multibyte sequences -> utf-8.
//  4. windows-1254.
// At least SNIFF bytes are inspected; while they are pure ASCII (no meta, nothing to decide on) reading
// continues up to SNIFF_MAX. The buffered bytes are re-emitted ahead of the rest, so the stream is read
// once and stays streaming.
const SNIFF = 4096,
  SNIFF_MAX = 65536;
function detectEncoding(head) {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "utf-8";
  if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
  let validUtf8 = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    validUtf8 = false;
  }
  let ascii = new TextDecoder("windows-1252").decode(head.subarray(0, SNIFF_MAX)),
    meta = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(ascii);
  if (meta) {
    let enc;
    try {
      enc = new TextDecoder(meta[1]).encoding;
    } catch {}
    if (enc === "windows-1254" || (enc === "utf-8" && validUtf8)) return enc;
  }
  return validUtf8 && head.some((b) => b > 0x7f) ? "utf-8" : "windows-1254";
}
async function decodedStream(bytes) {
  let reader = bytes.getReader(),
    chunks = [],
    size = 0,
    nonAscii = false,
    done = false;
  const head = () => {
    let h = new Uint8Array(size),
      o = 0;
    for (let c of chunks) h.set(c, o), (o += c.length);
    return h;
  };
  while (size < SNIFF || (size < SNIFF_MAX && !nonAscii)) {
    let r = await reader.read();
    if ((done = r.done)) break;
    chunks.push(r.value);
    size += r.value.length;
    nonAscii ||= r.value.some((b) => b > 0x7f);
  }
  let first = head(),
    encoding = detectEncoding(first);
  let replay = new ReadableStream({
    start(c) {
      if (first.length) c.enqueue(first);
      if (done) c.close();
    },
    async pull(c) {
      let r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { encoding, stream: replay.pipeThrough(new TextDecoderStream(encoding)) };
}

onmessage = async ({ data: file }) => {
  try {
    let result = {
        version: 1,
        days: {},
        products: {},
        stats: {
          rows: 0,
          hesap: 0,
          negative: 0,
          invalid: 0,
          fractional: 0,
          duplicate: 0,
          encoding: "",
          columns: null,
        },
      },
      seen = new Set(),
      decoded = await decodedStream(await reportStream(file)),
      reader = decoded.stream.getReader(),
      buf = "",
      read = 0,
      last = 0,
      cols = null,
      need = 0;
    result.stats.encoding = decoded.encoding;
    function row(html) {
      let c = [...html.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1\s*>/gi)].map((m) => text(m[2]));
      let up = /barkod/i.test(html) && c.map(fold);
      if (up && up.some((s) => s.includes("BARKOD")) && up.some((s) => s.includes("MIKTAR"))) {
        let m = mapColumns(c);
        cols = m.map;
        need = Math.max(...Object.values(cols)) + 1;
        result.stats.columns = {
          source: m.source,
          fields: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, { index: i, header: c[i] }])),
        };
        return;
      }
      if (!cols || c.length < need || !/^\d{2}\.\d{2}\.\d{4}$/.test(c[cols.date])) return;
      let match = c[cols.date].split("."),
        dt = `${match[2]}-${match[1]}-${match[0]}`;
      if (new Date(dt + "T12:00:00Z").toISOString().slice(0, 10) !== dt) {
        result.stats.invalid++;
        return;
      }
      let q, total;
      try {
        q = numeric(c[cols.qty]);
        if (cols.price !== undefined) numeric(c[cols.price]); // validated only; not stored
        total = numeric(c[cols.total]);
      } catch {
        result.stats.invalid++;
        return;
      }
      let b = c[cols.barcode],
        name = c[cols.name],
        category = cols.category === undefined ? "" : c[cols.category],
        hesap = name.toLocaleUpperCase("tr").includes("HESAP"),
        negative = q < 0 || total < 0;
      result.stats.rows++;
      result.stats.hesap += +hesap;
      result.stats.negative += +negative;
      result.stats.fractional += +!Number.isInteger(q);
      let key = rowHash(c);
      if (seen.has(key)) result.stats.duplicate++;
      else seen.add(key);
      let d = result.days[dt] || (result.days[dt] = { total: 0, rows: 0, qty: 0, hesap: 0, items: {} });
      d.total += total;
      d.rows++;
      if (hesap) d.hesap += total;
      if (!hesap && !negative && b && q > 0) {
        d.qty += q;
        let p =
          result.products[b] ||
          (result.products[b] = { name, category, barcode: b, qty: 0, total: 0, daily: {} });
        p.name = name;
        p.category = category;
        p.qty += q;
        p.total += total;
        p.daily[dt] = (p.daily[dt] || 0) + q;
        let it = d.items[b] || (d.items[b] = { q: 0, total: 0 });
        it.q += q;
        it.total += total;
      }
    }
    // Row split: one case-insensitive regex pass per chunk (linear). The carried-over partial row has no
    // complete "</tr>", so a match can only start at its last "<" or later.
    const TR_END = /<\/tr\s*>/gi;
    while (true) {
      let { value, done } = await reader.read();
      if (done) break;
      read += value.length;
      let carried = buf.length;
      buf += value;
      let from = carried ? buf.lastIndexOf("<", carried - 1) : 0,
        cut = 0,
        m;
      TR_END.lastIndex = from < 0 ? carried : from;
      while ((m = TR_END.exec(buf))) {
        row(buf.slice(cut, TR_END.lastIndex));
        cut = TR_END.lastIndex;
      }
      if (cut) buf = buf.slice(cut);
      if (buf.length > 5e6)
        throw Error(
          "Tablo biçimi desteklenmiyor. XLSX veya ikili XLS yerine bu market programının HTML tabanlı XLS raporunu seçin.",
        );
      if (read - last > 5e6) {
        postMessage({ progress: result.stats.rows });
        last = read;
      }
    }
    if (!cols || !result.stats.rows) throw Error("Beklenen satış sütunları bulunamadı.");
    if (result.stats.invalid)
      throw Error(
        `${result.stats.invalid} satırda tarih veya sayı okunamadı; eksik veriyle aktarım yapılmadı.`,
      );
    seen.clear();
    postMessage({ result });
  } catch (e) {
    postMessage({ error: e.message + " ZIP açılamıyorsa içindeki XLS dosyasını doğrudan seçin." });
  }
};
