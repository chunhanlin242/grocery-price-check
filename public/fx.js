// 英鎊換算台幣。
//
// ---------------------------------------------------------------- 跟 travel-money 的差別
//
// travel-money 會把記帳當下的匯率**凍結**在每一筆帳上，因為那是記帳：
// 「這趟總共花了多少台幣」必須是一個對得起來、不會每天變的數字。
//
// 這裡剛好相反，**不凍結**、一律用目前匯率換算。因為你問的問題不一樣：
// 「這罐醬油貴不貴？」是拿今天的物價感覺去對照，用三個月前的匯率換算反而礙事。
//
// 所以台幣在這個 App 裡永遠是**參考值**，用 ≈ 標示，不參與任何排序或加總，
// 比價的真相永遠是英鎊那一欄。

let rate = null;      // 1 GBP = ? TWD
let rateDate = null;  // 這個匯率是哪一天的

export function setRate(value, date) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return false;
  rate = n;
  rateDate = date || null;
  return true;
}

export const getRate = () => rate;
export const getRateDate = () => rateDate;
export const hasRate = () => rate !== null;

// 便士 → 台幣。回 null 代表還沒拿到匯率（離線第一次開就會這樣）。
export function penceToTwd(pence) {
  if (rate === null || !Number.isFinite(pence)) return null;
  return (pence / 100) * rate;
}

// 台幣不需要小數 —— 它只是給你一個量級感，NT$57.83 這種精度是假的。
// 上千之後連個位數都沒意義，直接進到十位。
export function formatTwd(twd) {
  if (twd === null || twd === undefined || !Number.isFinite(twd)) return "";
  const n = Math.abs(twd) >= 1000 ? Math.round(twd / 10) * 10 : Math.round(twd);
  return "NT$" + n.toLocaleString("en-US");
}

// 「≈ NT$58」。拿不到匯率就回空字串，呼叫端直接接在後面不用判斷。
export function twdLabel(pence, { prefix = "≈ " } = {}) {
  const twd = penceToTwd(pence);
  if (twd === null) return "";
  return prefix + formatTwd(twd);
}
