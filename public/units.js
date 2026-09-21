// 金額與單位換算。
//
// 兩條規則貫穿整個 App：
//
// 1. 「觀測到的價格」一律是整數便士。£1.45 就是 145，不是 1.45。
//    籃子比價要做大量加總與排序，浮點誤差在「總價差 3p」這種場景會直接騙人。
//
// 2. 「單價」是推算出來的，本來就是小數（145 ÷ 2000ml）。它保持浮點，
//    只在顯示與最後加總的那一刻才 Math.round。把它硬湊成整數會讓
//    £0.0725/ml 這種數字全部塌成 0，比價就沒得比了。
//
// 為什麼一定要換算單位：Aldi 2L 牛奶 £1.45 對上 Waitrose 1.13L £1.35，
// 直接比數字會得到相反的結論。£0.73/L 對 £1.19/L 才是真相。

// 各輸入單位換算到基準單位的倍率。基準單位只有三種：g、ml、each。
const TO_BASE = {
  g:    { base: "g",    factor: 1 },
  kg:   { base: "g",    factor: 1000 },
  ml:   { base: "ml",   factor: 1 },
  l:    { base: "ml",   factor: 1000 },
  cl:   { base: "ml",   factor: 10 },
  each: { base: "each", factor: 1 },
};

export const SIZE_UNITS = ["g", "kg", "ml", "l", "each"];
export const BASE_UNITS = ["g", "ml", "each"];

// 顯示單價時用的單位：每公斤 / 每公升 / 每個。
// 英國標籤就是這樣印的，用「每公克」會變成一串 0.001。
const DISPLAY = {
  g:    { per: 1000, zh: "公斤", en: "kg" },
  ml:   { per: 1000, zh: "公升", en: "L" },
  each: { per: 1,    zh: "個",   en: "each" },
};

export const baseOfUnit = (unit) => (TO_BASE[unit] || TO_BASE.g).base;
export const displayUnitEn = (base) => (DISPLAY[base] || DISPLAY.g).en;
export const displayUnitZh = (base) => (DISPLAY[base] || DISPLAY.g).zh;

// 把「500 g」「2 l」換算成基準單位的數量
export function toBase(size, unit) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return null;
  const m = TO_BASE[unit];
  if (!m) return null;
  return n * m.factor;
}

// 某個商品有多大（基準單位）。沒填容量就回 null —— 沒有容量就算不出單價，
// 這時候寧可不比，也不要拿包裝價當單價混進排序裡。
export function productBaseSize(product) {
  if (!product) return null;
  return toBase(product.size, product.size_unit);
}

// 每一個基準單位多少便士。浮點，不要 round。
export function unitPricePence(pricePence, product) {
  const size = productBaseSize(product);
  if (!size || !Number.isFinite(pricePence)) return null;
  return pricePence / size;
}

// ---------------------------------------------------------------- 格式化

// 英國寫法：不到 £1 用便士寫（89p），£1 以上用鎊寫（£1.45）
export function formatPence(pence, { alwaysPounds = false } = {}) {
  if (pence === null || pence === undefined || !Number.isFinite(pence)) return "—";
  const p = Math.round(pence);
  if (!alwaysPounds && Math.abs(p) < 100) return `${p}p`;
  return `£${(p / 100).toFixed(2)}`;
}

// 給輸入框用：145 → "1.45"
export function penceToInput(pence) {
  if (!Number.isFinite(pence)) return "";
  return (pence / 100).toFixed(2);
}

// 使用者可能打 "1.45"、"£1.45"、"145p"、"89p"
export function inputToPence(text) {
  const s = String(text || "").trim().toLowerCase().replace(/[£,\s]/g, "");
  if (!s) return null;

  if (s.endsWith("p")) {
    const n = parseFloat(s.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// "£1.09/kg" —— 標籤上的小字長什麼樣，這裡就長什麼樣
export function formatUnitPrice(pencePerBase, base) {
  if (pencePerBase === null || pencePerBase === undefined || !Number.isFinite(pencePerBase)) return "—";
  const d = DISPLAY[base] || DISPLAY.g;
  const perDisplay = pencePerBase * d.per;

  // 每公斤 62 便士這種要寫成 62p，寫成 £0.62 反而不像價格標籤
  const money = perDisplay < 100
    ? `${perDisplay < 10 ? perDisplay.toFixed(1) : Math.round(perDisplay)}p`
    : `£${(perDisplay / 100).toFixed(2)}`;

  return `${money}/${d.en}`;
}

// "2L" / "500g" / "1 個"
export function formatSize(size, unit) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (unit === "each") return n === 1 ? "1 個 each" : `${n} 個 each`;
  const label = { g: "g", kg: "kg", ml: "ml", l: "L" }[unit] || unit;
  const num = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
  return num + label;
}

// ---------------------------------------------------------------- 日期
//
// 一律用當地日期，不是 UTC。晚上 11 點在 Sainsbury's 拍的標籤不該被算成隔天。

export function localDate(d = new Date()) {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
}

export function daysAgo(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr + "T12:00:00");
  const now = new Date(localDate() + "T12:00:00");
  if (Number.isNaN(then.getTime())) return null;
  return Math.round((now - then) / 86400000);
}

// 價格會過期。英國食品價格變動很快，拿三個月前的數字比價等於瞎猜，
// 所以每一個價格旁邊都要講清楚它多老。
export const STALE_DAYS = 30;

export function freshness(dateStr) {
  const d = daysAgo(dateStr);
  if (d === null) return { days: null, label: "", stale: true };
  if (d <= 0) return { days: 0, label: "今天 today", stale: false };
  if (d === 1) return { days: 1, label: "昨天 yesterday", stale: false };
  return { days: d, label: `${d} 天前 ${d}d ago`, stale: d > STALE_DAYS };
}
