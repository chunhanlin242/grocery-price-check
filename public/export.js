// 匯出 CSV 與 Excel。
//
// 不引入 SheetJS —— 跟 travel-money 一樣自己寫極簡產生器。
// xlsx 其實就是一個 zip 裡面裝幾個 XML，用「不壓縮」（method 0）的方式打包完全合法，
// Excel、Numbers、Google Sheets 都讀得開。整份不到 200 行，比拉一個 800KB 的函式庫划算。
//
// 比價的邏輯不在這裡重寫：`rankItem` 之類的函式由 app.js 傳進來，
// 免得匯出的數字跟畫面上看到的對不起來 —— 那種 bug 最難發現。

import * as u from "./units.js";
import { allStores, storeName, storeGroup, groupById } from "./stores.js";
import { category } from "./i18n.js";

// ---------------------------------------------------------------- 取資料

// 每一筆價格觀測。原始流水帳，要自己在 Excel 裡樞紐分析的人用這張。
function priceRows(ctx) {
  const { items, products, prices } = ctx;
  const itemOf = (id) => items.find((i) => i.id === id);
  const productOf = (id) => products.find((p) => p.id === id);

  const header = [
    "日期 Date", "超市 Store", "類型 Type",
    "品項 Item", "品項英文 Item (EN)", "分類 Category",
    "貨架名稱 Name on shelf", "品牌 Brand",
    "容量 Size", "單位 Unit",
    "價格 Price (£)", "單價 Unit price", "單價單位 Per",
    "特價 Promo", "特價名目 Promo type",
    "分店 Branch", "標籤單價 Label unit price", "來源 Source",
  ];

  const rows = prices
    .map((price) => {
      const product = productOf(price.product_id);
      const item = product ? itemOf(product.item_id) : null;
      if (!product || !item) return null;

      const unit = u.unitPricePence(price.price_pence, product);
      const base = item.base_unit;
      const perLabel = base === "ml" ? "£/L" : base === "each" ? "£/each" : "£/kg";
      // 顯示單位是每公斤／每公升，所以要乘回 1000
      const perDisplay = unit === null ? null
        : unit * (base === "each" ? 1 : 1000) / 100;

      return [
        price.observed_on,
        storeName(product.store_id),
        groupById(storeGroup(product.store_id)).zh,
        item.name_zh || "",
        item.name_en || "",
        category(item.category)[1],
        product.name_en || "",
        product.brand || "",
        product.size ?? "",
        product.size_unit || "",
        price.price_pence / 100,
        perDisplay === null ? "" : Number(perDisplay.toFixed(4)),
        perLabel,
        price.is_promo ? "是 yes" : "",
        price.promo_note || "",
        price.branch || "",
        price.label_unit_price || "",
        price.source === "ai" ? "AI 辨識" : "手動 manual",
      ];
    })
    .filter(Boolean);

  // 新的在上面，跟畫面一致
  rows.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  return { name: "價格紀錄 Prices", header, rows };
}

// 一個品項一列，每家店一欄，格子裡是單價。這張是拿來「看」的。
function comparisonRows(ctx) {
  const { items, rankItem } = ctx;

  // 只放真的有資料的店，不然會有一堆空欄
  const ranks = new Map(items.map((i) => [i.id, rankItem(i.id)]));
  const used = allStores().filter((s) =>
    items.some((i) => ranks.get(i.id).some((r) => r.store.id === s.id)));

  const header = [
    "品項 Item", "品項英文 Item (EN)", "分類 Category", "類型 Type", "單位 Per",
    ...used.map((s) => s.name),
    "最便宜 Cheapest", "最大價差 Spread",
  ];

  const rows = items.map((item) => {
    const rank = ranks.get(item.id);
    const base = item.base_unit;
    const perLabel = base === "ml" ? "£/L" : base === "each" ? "£/each" : "£/kg";
    const mul = base === "each" ? 1 : 1000;

    const cells = used.map((s) => {
      const hit = rank.find((r) => r.store.id === s.id);
      return hit ? Number((hit.unit * mul / 100).toFixed(4)) : "";
    });

    // 價差只在同一組裡才有意義（亞洲超市的醬油跟 Aldi 沒得比），
    // 但這張表是給人在 Excel 裡自己篩的，所以照樣算全體，另外給一欄類型讓你分組
    const values = rank.map((r) => r.unit * mul / 100);
    const spread = values.length > 1
      ? Number((Math.max(...values) - Math.min(...values)).toFixed(4))
      : "";

    return [
      item.name_zh || "",
      item.name_en || "",
      category(item.category)[1],
      rank.length ? groupById(rank[0].store.group).zh : "",
      perLabel,
      ...cells,
      rank.length ? rank[0].store.name : "",
      spread,
    ];
  });

  rows.sort((a, b) => String(a[2]).localeCompare(String(b[2])) || String(a[0]).localeCompare(String(b[0]), "zh-Hant"));
  return { name: "比價總表 Comparison", header, rows };
}

function itemRows(ctx) {
  const { items, products, prices } = ctx;
  const header = [
    "品項 Item", "品項英文 Item (EN)", "分類 Category", "計價基準 Priced by",
    "商品數 Products", "價格筆數 Observations", "最後更新 Last seen",
  ];

  const rows = items.map((item) => {
    const own = products.filter((p) => p.item_id === item.id);
    const ids = new Set(own.map((p) => p.id));
    const obs = prices.filter((p) => ids.has(p.product_id));
    const last = obs.reduce((m, p) => (p.observed_on > m ? p.observed_on : m), "");
    return [
      item.name_zh || "", item.name_en || "",
      category(item.category)[1],
      item.base_unit === "ml" ? "容量 volume" : item.base_unit === "each" ? "計個 per item" : "重量 weight",
      own.length, obs.length, last,
    ];
  });

  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh-Hant"));
  return { name: "品項 Items", header, rows };
}

export function sheets(ctx) {
  return [comparisonRows(ctx), priceRows(ctx), itemRows(ctx)];
}

// ---------------------------------------------------------------- CSV

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(sheet) {
  const lines = [sheet.header, ...sheet.rows].map((r) => r.map(csvCell).join(","));
  // \r\n 是 CSV 的規矩，Excel 對 \n 有時候會出怪事
  return lines.join("\r\n");
}

export function csvBlob(sheet) {
  // BOM 是必要的：沒有它 Excel 會用系統 ANSI 編碼開，中文全部變亂碼
  return new Blob(["﻿" + toCsv(sheet)], { type: "text/csv;charset=utf-8" });
}

// ---------------------------------------------------------------- XLSX
//
// 一個 zip + 幾個 XML。不壓縮（method 0）也完全合法，省掉整個 deflate 實作。

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  // 所有檔案都用同一個時間戳。zip 的時間欄位是 DOS 格式，精度只到 2 秒，
  // 這裡也不需要真的時間 —— 固定值反而讓同樣的資料匯出兩次會是同一份檔案。
  const time = 0x6000;   // 12:00:00
  const date = 0x5a21;   // 2025-01-01

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);        // version needed
    lv.setUint16(6, 0x0800, true);    // UTF-8 檔名
    lv.setUint16(8, 0, true);         // method 0 = stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

// 1 → A、27 → AA
function colRef(n) {
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
}

function cellXml(value, ref, headerStyle) {
  if (value === "" || value === null || value === undefined) return "";
  const style = headerStyle ? ' s="1"' : "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${style}><v>${value}</v></c>`;
  }
  // inlineStr 省掉整張 sharedStrings 表，檔案大一點但少一個檔案要維護
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
}

function sheetXml(sheet) {
  const rowXml = (cells, rowNum, isHeader) =>
    `<row r="${rowNum}">${cells.map((v, i) => cellXml(v, colRef(i + 1) + rowNum, isHeader)).join("")}</row>`;

  const body = [
    rowXml(sheet.header, 1, true),
    ...sheet.rows.map((r, i) => rowXml(r, i + 2, false)),
  ].join("");

  // 凍結首列，資料一多才不會捲到不知道哪一欄是哪一欄
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetData>${body}</sheetData></worksheet>`;
}

// Excel 的工作表名稱不能含 : \ / ? * [ ]，長度上限 31
const safeName = (s) => s.replace(/[:\\/?*[\]]/g, " ").slice(0, 31);

export function xlsxBlob(sheetList) {
  const files = [];
  const add = (name, text) => files.push({ name, data: enc.encode(text) });

  add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheetList.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`);

  add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);

  add("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetList.map((s, i) =>
  `<sheet name="${xmlEsc(safeName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>`);

  add("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetList.map((_, i) =>
  `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${sheetList.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);

  // 只有兩個樣式：0 是預設，1 是粗體（表頭）
  add("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`);

  sheetList.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));

  return zip(files);
}

// ---------------------------------------------------------------- 下載

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 會讓某些瀏覽器來不及開始下載
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export const stamp = () => u.localDate();
