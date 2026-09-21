// 中英並列。
//
// 使用者住在英國但用中文思考：中文負責「這是什麼」，英文負責「在店裡怎麼找、
// 網站上怎麼搜」。所以不是二選一的語言切換，是兩個都要同時看得到。
//
// 排版規則：中文為主字級、英文小一號且用 --faint。
//   bi()  兩行（頁面標題、清單主要文字）
//   bi1() 同一行（按鈕、chip、短標籤）

export const L = {
  // 導覽
  app:        ["超市比價", "Price Check"],
  compare:    ["比價", "Compare"],
  basket:     ["清單", "Basket"],
  items:      ["品項", "Items"],
  storesTab:  ["店家", "By store"],
  settings:   ["設定", "Settings"],
  record:     ["記價", "Record"],

  // 通用動作
  save:       ["儲存", "Save"],
  cancel:     ["取消", "Cancel"],
  delete:     ["刪除", "Delete"],
  edit:       ["編輯", "Edit"],
  add:        ["新增", "Add"],
  done:       ["完成", "Done"],
  close:      ["關閉", "Close"],
  search:     ["搜尋", "Search"],
  undo:       ["復原", "Undo"],
  retry:      ["重試", "Retry"],
  confirm:    ["確認", "Confirm"],

  // 記價
  store:      ["超市", "Store"],
  photo:      ["照片", "Photo"],
  takePhoto:  ["拍標籤", "Take photo"],
  choosePhoto:["選照片", "From library"],
  batch:      ["批次匯入", "Batch import"],
  skip:       ["跳過", "Skip"],
  resume:     ["接著匯入", "Resume import"],
  recognise:  ["辨識", "Read label"],
  reading:    ["辨識中", "Reading"],
  price:      ["價格", "Price"],
  item:       ["品項", "Item"],
  brand:      ["品牌", "Brand"],
  ownLabel:   ["自有品牌", "Own label"],
  shelfName:  ["貨架名稱", "Name on shelf"],
  size:       ["容量", "Size"],
  unit:       ["單位", "Unit"],
  promo:      ["特價", "Promo"],
  promoNote:  ["特價名目", "Promo type"],
  branch:     ["分店", "Branch"],
  observedOn: ["看到的日期", "Seen on"],
  newItem:    ["新增品項", "New item"],
  pickItem:   ["選品項", "Pick an item"],
  nameZh:     ["中文名稱", "Chinese name"],
  nameEn:     ["英文名稱", "English name"],
  category:   ["分類", "Category"],
  baseUnit:   ["計價基準", "Priced by"],

  // 比價
  unitPrice:  ["單價", "Unit price"],
  cheapest:   ["最便宜", "Cheapest"],
  noData:     ["沒有資料", "No data"],
  seenDays:   ["天前看到", "days ago"],
  today:      ["今天", "today"],
  yesterday:  ["昨天", "yesterday"],
  stale:      ["資料過舊", "Out of date"],
  history:    ["價格走勢", "Price history"],
  allPrices:  ["所有紀錄", "All observations"],

  // 清單
  qty:        ["數量", "Qty"],
  total:      ["總價", "Total"],
  covered:    ["已知", "known"],
  missing:    ["缺資料", "Missing"],
  commonOnly: ["只比共同品項", "Common items only"],
  estimated:  ["以單價估算", "Estimated by unit price"],
  addToList:  ["加入清單", "Add to basket"],

  // 設定
  syncNow:    ["立即同步", "Sync now"],
  logout:     ["登出", "Sign out"],
  model:      ["辨識模型", "Vision model"],
  bakeoff:    ["模型比對", "Model bake-off"],
  clearCache: ["清除本機照片", "Clear local photos"],
  exportXlsx: ["匯出 Excel", "Export Excel"],
  stores:     ["管理店家", "Manage stores"],
  newStore:   ["新增店家", "New store"],
  storeName:  ["店名", "Store name"],
  storeNote:  ["備註", "Note"],
  colour:     ["顏色", "Colour"],
  icon:       ["圖示", "Icon"],
  auto:       ["自動判斷", "Auto"],
  tidy:       ["整理分類與圖示", "Tidy up categories"],
  group:      ["分組", "Group"],
  archive:    ["封存", "Archive"],
  showTwd:    ["顯示台幣", "Show TWD"],
  rate:       ["匯率", "Exchange rate"],
  zoom:       ["放大", "Zoom"],
  historyTab: ["紀錄", "History"],
  selected:   ["已選", "Selected"],
  clear:      ["清除", "Clear"],
  pickMany:   ["點選多個品項比整籃", "Select several to compare a basket"],
  exportCsv:  ["匯出 CSV", "Export CSV"],
  theme:      ["外觀", "Theme"],
  password:   ["密碼", "Password"],
  login:      ["登入", "Sign in"],
};

// 品項分類。跟 L 分開，因為它會出現在資料裡（items.category）。
export const CATEGORIES = [
  ["dairy",     "乳製品", "Dairy",      "🥛"],
  ["meat",      "肉類",   "Meat",       "🥩"],
  ["fish",      "海鮮",   "Fish",       "🐟"],
  ["produce",   "蔬果",   "Produce",    "🥬"],
  ["bakery",    "麵包",   "Bakery",     "🍞"],
  ["staples",   "主食",   "Staples",    "🍚"],
  ["sauce",     "調味料", "Condiments", "🫗"],
  ["tinned",    "罐頭乾貨", "Tinned",   "🥫"],
  ["frozen",    "冷凍",   "Frozen",     "🧊"],
  ["snacks",    "零食",   "Snacks",     "🍪"],
  ["drinks",    "飲料",   "Drinks",     "🧃"],
  ["alcohol",   "酒",     "Alcohol",    "🍺"],
  ["household", "家用",   "Household",  "🧻"],
  ["personal",  "個人用品", "Personal",  "🧴"],
  ["other",     "其他",   "Other",      "•"],
];

const CAT_BY_ID = new Map(CATEGORIES.map((c) => [c[0], c]));
export const category = (id) => CAT_BY_ID.get(id) || CAT_BY_ID.get("other");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const zh = (k) => (L[k] ? L[k][0] : k);
export const en = (k) => (L[k] ? L[k][1] : "");

// 兩行式
export function bi(k) {
  return `<span class="bi"><b>${esc(zh(k))}</b><i>${esc(en(k))}</i></span>`;
}

// 同一行
export function bi1(k) {
  return `${esc(zh(k))} <i class="en">${esc(en(k))}</i>`;
}

// 資料裡的中英文（品項名稱那種），兩邊都可能是空的
export function biText(zhText, enText, { block = false } = {}) {
  const a = String(zhText || "").trim();
  const b = String(enText || "").trim();
  if (!a && !b) return "";
  if (!a) return esc(b);
  if (!b) return esc(a);
  return block
    ? `<span class="bi"><b>${esc(a)}</b><i>${esc(b)}</i></span>`
    : `${esc(a)} <i class="en">${esc(b)}</i>`;
}

// 純文字版，給 aria-label、placeholder、title 這種不吃 HTML 的地方
export const plain = (k) => `${zh(k)} ${en(k)}`.trim();
