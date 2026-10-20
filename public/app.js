// 畫面與互動。單一檔案，照區塊註解分段。
//
// 全 App 只有一條資料流：IndexedDB → state → 重繪。寫入只走 db.put()，
// 它自己會排隊同步。畫面永遠不等網路。

import * as db from "./db.js";
import * as u from "./units.js";
import { GROUPS, PALETTE, normGroup, allStores, customStores, setCustomStores,
         storeById, storeName, storeColor, storeGroup, storesOfGroup, groupById,
         storeLogo, storeMark, inkOn } from "./stores.js";
import { bi, bi1, biText, zh, en, plain, CATEGORIES, category } from "./i18n.js";
import * as xport from "./export.js";
import * as fx from "./fx.js";
import { EMOJI_GROUPS, guess, guessEmoji, guessCategory } from "./emoji.js";
import { PRESETS } from "./presets.js";

const app = document.getElementById("app");

const state = {
  route: "compare",
  ready: false,
  items: [],
  products: [],
  prices: [],
  photos: [],
  lists: [],
  list_items: [],
  stores: [],
  item_views: [],
  storeFocus: null,   // 店家頁目前展開哪一家；null = 總覽
  listId: db.DEFAULT_LIST_ID,
  showTwd: true,
  query: "",
  homeSort: "cat",     // 首頁排法：cat 照分類分段／recent 最近碰過／new 最近新增
  homeOrder: null,     // 最近碰過的順序快照，見 homeList()
  commonOnly: false,
  lastStore: "sainsburys",
};

// ---------------------------------------------------------------- 小工具

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };

const itemById = (id) => state.items.find((i) => i.id === id);
const productById = (id) => state.products.find((p) => p.id === id);

const productsOfItem = (itemId) => state.products.filter((p) => p.item_id === itemId);

// 某個商品最新的那筆價格。同一天記兩次就用後記的那筆（多半是前一筆打錯回來補的）。
function latestPrice(productId) {
  let best = null;
  for (const p of state.prices) {
    if (p.product_id !== productId) continue;
    if (!best) { best = p; continue; }
    if (p.observed_on > best.observed_on) best = p;
    else if (p.observed_on === best.observed_on && p.created_at > best.created_at) best = p;
  }
  return best;
}

// 某個品項在某家店的最佳選擇。
// 同一家店可能有 1L 跟 2L 兩種包裝，要比的是單價 —— 你會買划算的那個。
function bestAtStore(itemId, storeId) {
  const item = itemById(itemId);
  if (!item) return null;

  let best = null;
  for (const product of productsOfItem(itemId)) {
    if (product.store_id !== storeId) continue;
    const price = latestPrice(product.id);
    if (!price) continue;
    const unit = u.unitPricePence(price.price_pence, product);
    if (unit === null) continue;
    if (!best || unit < best.unit) best = { product, price, unit };
  }
  return best;
}

// 一個品項在所有店的排行，便宜的在前面
function rankItem(itemId) {
  const rows = [];
  for (const s of allStores()) {
    const hit = bestAtStore(itemId, s.id);
    if (hit) rows.push({ store: s, ...hit, fresh: u.freshness(hit.price.observed_on, { promo: !!hit.price.is_promo }) });
  }
  rows.sort((a, b) => a.unit - b.unit);
  return rows;
}


// 每個品項「最近一次被碰到」的時間：點開看過、剛建立、剛記（或改）了價格，取最新的。
//
// 首頁要把你正在處理的東西放最上面。只看記價日期的話，你昨天點開研究了半天的東西
// 今天還是沉在下面；只看「看過」的話，剛新增的品項又會找不到。三個都算才對。
//
// 用 updated_at 而不是 observed_on：observed_on 是貨架上的日期，
// 回家批次補登上週的照片時它是舊的，但那筆明明是你剛剛才輸入的。
function recentMap() {
  const at = new Map();
  const bump = (id, t) => { if (id && t && t > (at.get(id) || "")) at.set(id, t); };

  for (const i of state.items) bump(i.id, i.created_at);
  for (const v of state.item_views) bump(v.id, v.viewed_at);

  const itemOfProduct = new Map(state.products.map((p) => [p.id, p.item_id]));
  for (const pr of state.prices) bump(itemOfProduct.get(pr.product_id), pr.updated_at);
  return at;
}

// 記下「看過」。一個品項一列（id = item_id），所以跨裝置自動就是最後一次看的時間。
// 一分鐘內重複點開不再寫，免得來回切換時每一下都產生一筆要同步的資料。
async function markViewed(itemId) {
  const prev = state.item_views.find((v) => v.id === itemId);
  const now = new Date().toISOString();
  if (prev && Date.parse(now) - Date.parse(prev.viewed_at) < 60000) return;
  const row = await db.put("item_views", { ...(prev || {}), id: itemId, viewed_at: now, deleted_at: null });
  state.item_views = [...state.item_views.filter((v) => v.id !== itemId), row];
}

// 品項的計價基準決定顯示單位：g → 每公斤，ml → 每公升，each → 每個
const displayUnitOf = (base) => (base === "ml" ? "l" : base === "each" ? "each" : "kg");

function matchesQuery(item, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  if ((item.name_zh || "").toLowerCase().includes(s)) return true;
  if ((item.name_en || "").toLowerCase().includes(s)) return true;
  // 貨架上的英文名也要能搜到 —— 常常只記得包裝上寫什麼
  return productsOfItem(item.id).some((p) =>
    (p.name_en || "").toLowerCase().includes(s) || (p.brand || "").toLowerCase().includes(s));
}


// 台幣只是給你一個「這貴不貴」的量級感，所以：
//   1. 一律加 ≈，它是參考值不是精確金額
//   2. 不參與任何排序或加總 —— 比價的真相永遠是英鎊那一欄
//   3. 拿不到匯率就回空字串，呼叫端直接接在後面不用判斷
function twd(pence, { prefix = " ≈ " } = {}) {
  if (!state.showTwd) return "";
  const label = fx.twdLabel(pence, { prefix: "" });
  return label ? prefix + label : "";
}

// 店家圖示（商標圖或品牌色字章）。size：sm 用在膠囊與選單裡，lg 用在店家頁標題。
function storeBadge(store, size = "") {
  if (!store) return "";
  const logo = storeLogo(store);
  const cls = `sbadge${size ? " " + size : ""}${store.mark && store.mark.length > 1 ? " wide" : ""}`;
  return logo
    ? `<span class="${cls} logo" aria-hidden="true"><img src="${esc(logo)}" alt=""></span>`
    : `<span class="${cls}" aria-hidden="true" style="background:${store.color};color:${inkOn(store.color)}">${esc(storeMark(store))}</span>`;
}

// 品項圖示：自己挑的 → 名稱猜的 → 分類的。
//
// 分類只有十幾個但你買的東西有幾百種，一對一永遠對不上 ——
// 「蘋果」跟「青江菜」都是蔬果，但不該長一樣。
const itemEmoji = (item) => !item ? "•"
  : item.emoji || guessEmoji(item.name_zh, item.name_en) || category(item.category)[3];

// ---------------------------------------------------------------- 資料載入

async function reload() {
  const [stores, items, products, prices, photos, lists, list_items, item_views] = await Promise.all(
    ["stores", "items", "products", "prices", "photos", "lists", "list_items", "item_views"].map((t) => db.getAll(t))
  );
  Object.assign(state, { stores, items, products, prices, photos, lists, list_items, item_views });

  // stores.js 是同步的（畫面到處都在呼叫 storeName），所以自訂店家要先推進去，
  // 之後任何 render 才查得到名字與顏色
  setCustomStores(stores);

  if (!state.lists.some((l) => l.id === state.listId)) {
    state.listId = state.lists.length ? state.lists[0].id : db.DEFAULT_LIST_ID;
  }
}

// ---------------------------------------------------------------- 提示條

let toastTimer = null;

function toast(message, { action = null, actionLabel = "復原", warn = false, ms = 5000 } = {}) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);

  const el = document.createElement("div");
  el.className = "toast" + (warn ? " warn" : "");
  el.innerHTML = `<span>${message}</span>` +
    (action ? `<button class="act">${esc(actionLabel)}</button>` : "");
  document.body.appendChild(el);

  if (action) {
    el.querySelector(".act").onclick = async () => { el.remove(); await action(); };
  }
  toastTimer = setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- 面板
//
// 開面板時推一筆瀏覽紀錄，這樣手機上的返回鍵是關面板，不是直接離開 App。

const openSheets = [];

// 所有按鈕都在底部那一條：單手拿手機時，右上角的「儲存」跟左上角的「✕」
// 都要換手才按得到。上面只留標題。
//   saveLabel —— 有的話最右邊是主要按鈕，左邊是「取消」
//   actions   —— 夾在中間的其他按鈕（品項明細的「編輯」「加入清單」）
function sheet(titleHtml, bodyHtml, { saveLabel = null, actions = "", closeLabel = null } = {}) {
  const el = document.createElement("div");
  el.className = "sheet";
  el.innerHTML = `
    <div class="sheet-head"><h2>${titleHtml}</h2></div>
    <div class="sheet-body">${bodyHtml}</div>
    <div class="sheet-foot">
      <button class="btn-foot" data-close>${esc(closeLabel || (saveLabel ? "取消" : "‹ 返回"))}</button>
      ${actions}
      ${saveLabel ? `<button class="btn-foot primary" data-save>${saveLabel}</button>` : ""}
    </div>`;
  document.body.appendChild(el);

  el.querySelector("[data-close]").onclick = () => closeSheet(el);
  openSheets.push(el);
  pushSheetState();
  return el;
}

// 從底部滑上來的選單（記價方式、選店家）。不蓋滿整個畫面，點旁邊的暗處就關掉。
// 跟 sheet 共用同一套返回鍵處理。
function menuSheet(bodyHtml) {
  const el = document.createElement("div");
  el.className = "menu-wrap";
  el.innerHTML = `<div class="menu-backdrop" data-close></div>
    <div class="menu" role="dialog">${bodyHtml}
      <button class="menu-row cancel" data-close>取消</button></div>`;
  document.body.appendChild(el);
  el.querySelectorAll("[data-close]").forEach((b) => { b.onclick = () => closeSheet(el); });
  openSheets.push(el);
  pushSheetState();
  return el;
}

// 推一筆瀏覽紀錄，手機的返回鍵才會是「關掉這一層」而不是離開 App。
// 抽出來是因為照片檢視器不是用 sheet() 建的，但要有一樣的返回行為。
function pushSheetState() {
  history.pushState({ sheet: openSheets.length }, "");
}

// 用計數而不是布林旗標：連續關兩層面板（選單裡新增品項再選它）會連按兩次 back，
// 兩個 popstate 都必須被吃掉，否則第二個會把底下那層也關掉。
let pendingBacks = 0;

function closeSheet(el) {
  const i = openSheets.indexOf(el);
  if (i === -1) return;
  openSheets.splice(i, 1);
  el.remove();
  // 面板已經自己關掉了，這裡只是把剛才推的那筆紀錄收回來
  pendingBacks += 1;
  history.back();
}

// 安卓返回鍵一層一層退：面板 → 店家展開 → 其他分頁回首頁 → 首頁再按一次才離開。
//
// 以前切分頁不留紀錄，人在「店家」或「紀錄」頁按返回，App 就整個關掉了。
// 瀏覽紀錄由下往上長這樣：[進來] [防誤觸] [分頁] [店家展開] [面板…]
//   tabEntry  —— 不在首頁時多一筆，返回就是回首頁；分頁之間切換不再推
//   trapArmed —— 首頁底下墊一筆，返回先提示「再按一次離開」而不是直接關掉。
//                它要在第一次觸碰時才推：Chrome 會跳過沒有使用者動作就推的紀錄，
//                開機時推了等於沒推。
let tabEntry = false;
let trapArmed = false;
let subEntry = false;   // 設定 → 所有紀錄：多一層，返回回到設定

document.addEventListener("pointerdown", () => {
  if (trapArmed || tabEntry || state.storeFocus || openSheets.length) return;
  history.pushState({ trap: true }, "");
  trapArmed = true;
}, { capture: true });

window.addEventListener("popstate", () => {
  if (pendingBacks > 0) { pendingBacks -= 1; return; }
  const el = openSheets.pop();
  if (el) { el.remove(); return; }
  // 店家頁展開某一家時也推了一筆紀錄：安卓的返回鍵／手勢要回到總覽，不是離開 App
  if (state.storeFocus) { state.storeFocus = null; render(); return; }
  if (subEntry) { subEntry = false; state.route = "settings"; render(); return; }
  if (tabEntry) { tabEntry = false; state.route = "compare"; state.query = ""; state.homeOrder = null; render(); return; }
  if (trapArmed) { trapArmed = false; toast("再按一次返回就會離開", { ms: 2500 }); }
});

// 切分頁。要退掉的紀錄一次用 go(-n) 退完 —— 連叫兩次 back() 會被瀏覽器合併成一次。
function goRoute(route) {
  let backs = 0;
  if (state.storeFocus) { state.storeFocus = null; backs += 1; }
  if (subEntry) { subEntry = false; backs += 1; }
  if (route === "compare" && tabEntry) { tabEntry = false; backs += 1; }
  if (backs) { pendingBacks += 1; history.go(-backs); }
  if (route !== "compare" && !tabEntry) { history.pushState({ tab: true }, ""); tabEntry = true; }
  state.route = route;
  state.query = "";
  state.homeOrder = null;   // 回到首頁時「最近看過」重新排一次
  render();
}

// ---------------------------------------------------------------- 照片
//
// 原圖動輒 4MB，傳上去慢、辨識也不會更準。縮到長邊 1600 已經看得很清楚。

async function shrink(file, max = 1600, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
  return { blob, width: w, height: h };
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// camera:true  → 直接開後鏡頭（手機）。桌面瀏覽器忽略這個屬性，退回選檔案。
// camera:false → 不加 capture，才選得到「已經拍好的照片」。
//                iOS 這時會跳出 照片圖庫／拍照／瀏覽 的選單，Android 開檔案選擇器。
//                這是重點：加了 capture 就只剩相機，相簿裡那疊照片永遠選不到。
function pickImage({ camera = false, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (camera) input.capture = "environment";
    if (multiple) input.multiple = true;
    input.onchange = () => {
      const files = [...(input.files || [])];
      resolve(multiple ? files : (files[0] || null));
    };
    input.click();
  });
}

// ---------------------------------------------------------------- 批次匯入
//
// 手上已經有一疊拍好的照片時，一張一張「選檔案 → 辨識 → 存 → 再開一次」太痛苦。
// 這裡把它們排成佇列，存完一張自動跳下一張，只要一直確認就好。
//
// 佇列存在 meta 裡而不是只放記憶體：匯入 20 張走到第 12 張時手機切掉、
// App 被系統回收，回來還能接著做。照片本身在匯入的當下就已經寫進 IndexedDB 了。

const queue = { ids: [], index: 0 };

async function loadQueue() {
  const saved = await db.getMeta("photo_queue", null);
  if (saved && Array.isArray(saved.ids)) { queue.ids = saved.ids; queue.index = saved.index || 0; }
}

const saveQueue = () => db.setMeta("photo_queue", { ids: queue.ids, index: queue.index });

async function clearQueue() {
  queue.ids = [];
  queue.index = 0;
  await saveQueue();
}

// 開下一張。走完了就收工。
async function nextInQueue() {
  if (queue.index >= queue.ids.length) {
    const n = queue.ids.length;
    await clearQueue();
    await refresh();
    if (n) toast(`批次匯入完成，共 ${n} 張`);
    return;
  }
  openRecord({ photoId: queue.ids[queue.index], fromQueue: true });
}

async function openBatchImport() {
  const files = await pickImage({ multiple: true });
  if (!files || !files.length) return;

  const el = sheet(bi("batch"), `<div class="empty"><div class="big">🖼</div>
    <p data-progress>準備中… Preparing…</p></div>`);
  const progress = el.querySelector("[data-progress]");

  const ids = [];
  for (let i = 0; i < files.length; i++) {
    progress.innerHTML = `處理第 ${i + 1} / ${files.length} 張`;
    try {
      const { blob, width, height } = await shrink(files[i]);
      const id = db.uuid();
      await db.savePhotoBlob(id, blob);
      await db.put("photos", {
        id, r2_key: `labels/${id}.jpg`, store_id: null,
        taken_at: new Date(files[i].lastModified || Date.now()).toISOString(), width, height,
      });
      ids.push(id);
    } catch (err) {
      // 一張壞掉不該讓整批都不能匯入
      console.warn("這張照片讀不進來，跳過", files[i].name, err);
    }
  }

  closeSheet(el);

  if (!ids.length) return toast("這些檔案都讀不進來", { warn: true });

  queue.ids = ids;
  queue.index = 0;
  await saveQueue();
  await refresh();
  nextInQueue();
}

// ---------------------------------------------------------------- 記價
//
// 這是整個 App 的主要動作，所以它的規則是：任何一步都可以跳過。
// 沒拍照可以記、沒選品項可以先建、沒網路可以存 —— 站在貨架前面卡住是最糟的事。

// 同一張表單負責「新增」與「編輯」。
//
// 為什麼不另外寫一個編輯畫面：欄位一模一樣，兩份表單遲早會走鐘 ——
// 一邊加了驗證另一邊沒加、一邊改了單位限制另一邊沒改。這種不一致最難查。
function openRecord({ itemId = null, storeId = null, photoId = null, fromQueue = false, editPriceId = null } = {}) {
  const editing = editPriceId ? state.prices.find((p) => p.id === editPriceId) : null;
  const editProduct = editing ? productById(editing.product_id) : null;

  const draft = editing ? {
    item_id: editProduct ? editProduct.item_id : null,
    store_id: editProduct ? editProduct.store_id : state.lastStore,
    price_text: u.penceToInput(editing.price_pence),
    name_en: editProduct ? (editProduct.name_en || "") : "",
    brand: editProduct ? (editProduct.brand || "") : "",
    size: editProduct && editProduct.size != null ? String(editProduct.size) : "",
    size_unit: editProduct ? (editProduct.size_unit || "") : "",
    is_promo: !!editing.is_promo,
    promo_note: editing.promo_note || "",
    branch: editing.branch || "",
    observed_on: editing.observed_on,
    photo_id: editing.photo_id,
    source: editing.source,
    label_unit_price: editing.label_unit_price,
    // 這些值是使用者當初自己填的，換店家時不要拿別家的規格蓋掉
    _prefilled: false,
    _editId: editPriceId,
  } : {
    item_id: itemId,
    store_id: storeId || state.lastStore,
    price_text: "",
    name_en: "",
    brand: "",
    size: "",
    size_unit: "",
    is_promo: false,
    promo_note: "",
    branch: "",
    observed_on: u.localDate(),
    photo_id: photoId,
    source: "manual",
    label_unit_price: null,
    _fromQueue: fromQueue,
  };

  // 已經指定品項時，沿用這家店上次記過的規格，少打好幾個欄位
  if (!editing && itemId && draft.store_id) prefillFromLast(draft);

  const title = editing ? bi("edit")
    : fromQueue
      ? `${esc(zh("batch"))} ${queue.index + 1}/${queue.ids.length}`
      : bi("record");

  const el = sheet(title, recordBody(draft), {
    saveLabel: bi1("save"),
    actions: fromQueue ? `<button class="btn-foot" data-skip>${bi1("skip")}</button>` : "",
  });
  wireRecord(el, draft);

  // 佇列裡的照片已經在 IndexedDB 了，直接掛上去並自動開始辨識，
  // 不要再叫使用者按一次「辨識」——批次的重點就是少按幾下。
  //
  // 編輯時**不能**自動辨識：那會把使用者剛剛要來修正的值又用 AI 的猜測蓋掉。
  if (draft.photo_id) attachStoredPhoto(el, draft, { autoRead: !editing });

  return el;
}

async function attachStoredPhoto(el, draft, { autoRead = false } = {}) {
  const blob = await db.getPhotoBlob(draft.photo_id);
  // 照片可能只存在另一台裝置上（R2 沒開通時），這時就沒有預覽可看
  if (!blob) return;
  draft._blobUrl = URL.createObjectURL(blob);
  renderPhotoSlot(el, draft);
  if (!autoRead) return;
  const body = el.querySelector(".sheet-body");
  const refreshHint = () => body.querySelector("[data-price]").dispatchEvent(new Event("input"));
  readLabel(el, draft, refreshHint);
}

// 這張跳過，直接看下一張。壞掉的、拍糊的、重複的照片都用這個。
async function skipQueued(el) {
  queue.index += 1;
  await saveQueue();
  closeSheet(el);
  nextInQueue();
}

// 同一家店的同一個品項，上次是什麼包裝、什麼名字，這次多半一樣。
//
// 找不到就把欄位「清空」，不是原封不動 —— 從 Aldi 切到 Lidl 時留著
// "Cowbelle Whole Milk 2L" 只會害你把 Aldi 的規格存成 Lidl 的商品。
function prefillFromLast(draft) {
  // 挑「真的買過的那個規格」：有容量、有價格的優先。
  // 只照 updated_at 排會挑到還沒填完就放棄的半成品，等於什麼都沒帶入。
  const score = (p) => (p.size ? 2 : 0) + (latestPrice(p.id) ? 1 : 0);

  const prev = productsOfItem(draft.item_id)
    .filter((p) => p.store_id === draft.store_id)
    .sort((a, b) => (score(b) - score(a)) || (a.updated_at < b.updated_at ? 1 : -1))[0];

  draft.name_en = prev ? (prev.name_en || "") : "";
  draft.brand = prev ? (prev.brand || "") : "";
  draft.size = prev && prev.size ? String(prev.size) : "";
  draft.size_unit = prev ? (prev.size_unit || "") : "";
  draft._prefilled = !!prev;
}

// 把 draft 的商品欄位寫回畫面。選品項、換店家都會用到。
function syncProductFields(body, draft) {
  body.querySelector("[data-f='size_unit']").innerHTML = unitOptions(draft);
  body.querySelector("[data-f='name_en']").value = draft.name_en || "";
  body.querySelector("[data-f='brand']").value = draft.brand || "";
  body.querySelector("[data-f='size']").value = draft.size || "";
  draft.size_unit = body.querySelector("[data-f='size_unit']").value;
}

// 標籤（或你自己選的單位）跟品項的計價基準對不上時怎麼辦。
//
// 以前的做法是讓單位選單只剩品項允許的那幾個，選單的值就默默變成 g ——
// 標籤寫「10 each」的蛋，就這樣被存成 10 g，算出 £400/kg。
// 這種錯最糟：數字看起來很合理，畫面上完全看不出來。
//
// 現在的規則：
//   品項底下還沒有任何商品 → 基準還沒被用過，直接改成標籤的（多半是剛建的品項，
//                           建立時留著預設的「重量」沒改）
//   已經有商品            → 不能改（見 openItemEditor 的鎖），清掉容量讓你自己看，
//                           並且明講對不上，不要替你換算
// 回傳 "switched" / "conflict" / null（沒事）。
async function reconcileUnit(draft) {
  const item = draft.item_id ? itemById(draft.item_id) : null;
  const want = draft._labelBase || (draft._unitTouched && draft.size_unit ? u.baseOfUnit(draft.size_unit) : null);
  if (!item || !want || want === item.base_unit) return null;

  if (!productsOfItem(item.id).length) {
    const saved = await db.put("items", { ...item, base_unit: want });
    state.items = state.items.map((i) => (i.id === saved.id ? saved : i));
    toast(`「${item.name_zh || item.name_en}」改成${want === "each" ? "按個" : want === "ml" ? "按容量" : "按重量"}計價，跟標籤一致`);
    return "switched";
  }

  draft.size = "";
  draft.size_unit = "";
  draft._prefilled = false;
  toast(`標籤是${want === "each" ? "按個" : want === "ml" ? "按容量" : "按重量"}計價，但「${item.name_zh || item.name_en}」不是 —— 容量請自己確認`, { warn: true, ms: 8000 });
  return "conflict";
}

function unitOptions(draft) {
  const item = draft.item_id ? itemById(draft.item_id) : null;
  // 選了品項就只給同一個基準的單位。
  // 讓「全脂牛奶」底下冒出一筆 500g 的商品，比價立刻就壞掉了。
  const allowed = !item ? u.SIZE_UNITS
    : item.base_unit === "ml" ? ["ml", "l"]
    : item.base_unit === "each" ? ["each"]
    : ["g", "kg"];

  return allowed.map((x) =>
    `<option value="${x}"${draft.size_unit === x ? " selected" : ""}>${x === "each" ? "個" : x}</option>`
  ).join("");
}

// 選店家：從底部滑上來的清單，一組一段。
//
// 原本三組店家各一排 chip 擺在記價表單最上面，佔掉半個畫面，而且多半用不到 ——
// 你通常整趟都在同一家店，預設就是上次那家。要換的時候再點開這份清單。
function openStorePicker(current, onPick) {
  // 最上面放「最近去過」：內建連鎖就有十幾家，真正會去的只有幾家
  const lastAt = new Map();
  for (const pr of state.prices) {
    const p = productById(pr.product_id);
    if (p && (pr.observed_on > (lastAt.get(p.store_id) || ""))) lastAt.set(p.store_id, pr.observed_on);
  }
  const recent = allStores().filter((s) => lastAt.has(s.id))
    .sort((a, b) => (lastAt.get(a.id) < lastAt.get(b.id) ? 1 : -1)).slice(0, 5);
  const row = (s) => `
      <button class="menu-row${current === s.id ? " on" : ""}" data-store="${esc(s.id)}">
        ${storeBadge(s, "sm")}<span>${esc(s.name)}</span>
        ${current === s.id ? `<span class="check">✓</span>` : ""}</button>`;

  const el = menuSheet((recent.length ? `<div class="menu-group">最近去過</div>${recent.map(row).join("")}` : "")
    + GROUPS.map((g) => `
    <div class="menu-group">${g.icon} ${esc(g.zh)}</div>
    ${storesOfGroup(g.id).map(row).join("")}
    <button class="menu-row add" data-new-store="${g.id}">＋ ${esc(zh("newStore"))}</button>`).join(""));

  el.querySelector(".menu").addEventListener("click", (e) => {
    const pick = e.target.closest("[data-store]");
    const add = e.target.closest("[data-new-store]");
    if (pick) { closeSheet(el); onPick(pick.dataset.store); }
    // 站在清單裡沒有的小店，當場加，存完直接選中它
    if (add) { closeSheet(el); openStoreEditor(null, (saved) => onPick(saved.id), add.dataset.newStore); }
  });
}

function storeRowHtml(storeId) {
  const s = storeId ? storeById(storeId) : null;
  return s ? `${storeBadge(s, "sm")}${esc(s.name)} ›`
    : `<span style="color:var(--accent-ink)">選店家 ›</span>`;
}

// 記價表單 = 一張確認卡。
//
// 順序照「站在貨架前」的思考：照片 → 價格 → 這包多大、每公斤多少 → 是什麼、在哪家。
// 貨架名稱、品牌、特價、日期大部分時候不用動（AI 讀了、日期是今天），收進「更多」。
function recordBody(draft) {
  const item = draft.item_id ? itemById(draft.item_id) : null;

  return `
    <div class="photo-slot" data-photo>
      <div class="photo-sources">
        <button class="photo-drop" data-act="take-photo">
          <span class="ic">${ICON.camera}</span><span>${bi1("takePhoto")}</span>
        </button>
        <button class="photo-drop" data-act="choose-photo">
          <span class="ic">${ICON.image}</span><span>${bi1("choosePhoto")}</span>
        </button>
      </div>
    </div>

    <div class="price-area">
      <span class="cur">£</span>
      <input class="big-input num" data-price type="text" inputmode="decimal"
             placeholder="0.00" value="${esc(draft.price_text)}" autocomplete="off">
    </div>
    <div class="unit-hint" data-hint></div>

    <div class="rows">
      <button class="row" data-act="pick-item">
        <span class="k">${bi1("item")}</span>
        <span class="v" data-item-label>${item ? biText(item.name_zh, item.name_en) : `<span style="color:var(--accent-ink)">${bi1("pickItem")} ›</span>`}</span>
      </button>

      <button class="row" data-act="pick-store">
        <span class="k">${bi1("store")}</span>
        <span class="v" data-store-label>${storeRowHtml(draft.store_id)}</span>
      </button>

      <div class="row">
        <span class="k">${bi1("size")}</span>
        <input class="inp num" data-f="size" type="text" inputmode="decimal" placeholder="2"
               style="max-width:5.5em" value="${esc(draft.size)}">
        <select class="sel" data-f="size_unit" style="max-width:6em">${unitOptions(draft)}</select>
      </div>
    </div>

    <details class="more"${draft.is_promo ? " open" : ""}>
      <summary>更多：貨架名稱、品牌、特價、日期</summary>
      <div class="rows">
        <label class="row">
          <span class="k">${bi1("shelfName")}</span>
          <input class="inp grow" data-f="name_en" type="text" placeholder="Whole Milk 2L"
                 value="${esc(draft.name_en)}" autocomplete="off">
        </label>
        <label class="row">
          <span class="k">${bi1("brand")}</span>
          <input class="inp grow" data-f="brand" type="text" placeholder="${plain("ownLabel")}"
                 value="${esc(draft.brand)}" autocomplete="off">
        </label>
        <label class="row">
          <span class="k">${bi1("promo")}</span>
          <input class="chk" data-f="is_promo" type="checkbox"${draft.is_promo ? " checked" : ""}>
        </label>
        <label class="row${draft.is_promo ? "" : " hidden"}" data-promo-row>
          <span class="k">${bi1("promoNote")}</span>
          <input class="inp grow" data-f="promo_note" type="text" placeholder="Nectar price"
                 value="${esc(draft.promo_note)}" autocomplete="off">
        </label>
        <label class="row">
          <span class="k">${bi1("branch")}</span>
          <input class="inp grow" data-f="branch" type="text" placeholder="Camden"
                 value="${esc(draft.branch)}" autocomplete="off">
        </label>
        <label class="row">
          <span class="k">${bi1("observedOn")}</span>
          <input class="inp" data-f="observed_on" type="date" value="${esc(draft.observed_on)}">
        </label>
        ${draft._editId && draft.label_unit_price ? `<div class="row"><span class="k">標籤上寫</span>
          <span class="v num">${esc(draft.label_unit_price)}</span></div>` : ""}
        ${draft._editId ? `<div class="row"><span class="k">來源</span>
          <span class="v">${draft.source === "ai" ? "AI 辨識 + 人工確認" : "手動輸入"}</span></div>` : ""}
      </div>
    </details>

    ${draft._editId ? `<div class="rows"><button class="row danger" data-del-price>
        <span class="k">${bi1("delete")}</span></button></div>` : ""}`;
}

function wireRecord(el, draft) {
  const body = el.querySelector(".sheet-body");
  const priceInput = body.querySelector("[data-price]");
  const hint = body.querySelector("[data-hint]");

  const refreshHint = () => {
    const pence = u.inputToPence(priceInput.value);
    const item = draft.item_id ? itemById(draft.item_id) : null;
    const size = u.toBase(draft.size, draft.size_unit);

    // 這一行就是記價的目的：這包多大、換算起來每公斤／每個多少
    const sizeText = u.formatSize(draft.size, draft.size_unit);
    if (pence === null) { hint.innerHTML = sizeText ? `<span style="color:var(--faint)">${esc(sizeText)}</span>` : ""; return; }
    const money = `<span class="twd">${esc(twd(pence, { prefix: "≈ " }))}</span>`;
    if (!size || !item) { hint.innerHTML = `<span style="color:var(--faint)">${esc(sizeText || "填份量才算得出單價")}</span> ${money}`; return; }

    const unit = pence / size;
    hint.innerHTML = `${esc(sizeText)} · <b>${esc(u.formatUnitPrice(unit, item.base_unit))}</b> ${money}`;
  };

  priceInput.oninput = refreshHint;

  // 只在「欄位還是自動帶入的、或本來就空的」時候才重新帶入。
  // 你自己打過的東西，不該因為多按一下店家就被蓋掉。
  const canPrefill = () => draft.item_id && (draft._prefilled || (!draft.name_en && !draft.size));

  // 店家：底部選單。換店家也要重帶規格 —— 少了這一步，「先選店再選品項」
  // 就會存出一筆沒有容量的商品，算不出單價，比價時直接消失。
  body.querySelector("[data-act='pick-store']").onclick = () => {
    openStorePicker(draft.store_id, async (storeId) => {
      draft.store_id = storeId;
      state.lastStore = storeId;
      await db.setMeta("last_store", storeId);
      body.querySelector("[data-store-label]").innerHTML = storeRowHtml(storeId);
      if (canPrefill()) { prefillFromLast(draft); syncProductFields(body, draft); }
      refreshHint();
      buzz();
    });
  };

  // 一般欄位
  body.querySelectorAll("[data-f]").forEach((input) => {
    const key = input.dataset.f;
    const handler = () => {
      draft[key] = input.type === "checkbox" ? input.checked : input.value;
      // 一旦動手改過商品欄位，就不再自動覆蓋
      if (["name_en", "brand", "size", "size_unit"].includes(key)) draft._prefilled = false;
      // 自己挑過的單位要當真：之後選的品項基準不同時，不能默默換掉它
      if (key === "size_unit") draft._unitTouched = true;
      if (key === "is_promo") body.querySelector("[data-promo-row]").classList.toggle("hidden", !input.checked);
      if (key === "size" || key === "size_unit") refreshHint();
    };
    input.oninput = handler;
    input.onchange = handler;
  });

  // 選品項
  body.querySelector("[data-act='pick-item']").onclick = () => {
    openItemPicker(async (item) => {
      draft.item_id = item.id;
      body.querySelector("[data-item-label]").innerHTML = biText(item.name_zh, item.name_en);
      await reconcileUnit(draft);
      if (canPrefill()) prefillFromLast(draft);
      syncProductFields(body, draft);
      refreshHint();
    });
  };

  // 照片
  body.querySelector("[data-photo]").onclick = (e) => {
    if (e.target.closest("[data-act='take-photo']"))   attachPhoto(el, draft, refreshHint, { camera: true });
    if (e.target.closest("[data-act='choose-photo']")) attachPhoto(el, draft, refreshHint, { camera: false });
    if (e.target.closest("[data-act='read-label']"))   readLabel(el, draft, refreshHint);
    if (e.target.closest("[data-act='zoom-photo']"))   showPhoto(draft.photo_id);
  };

  el.querySelector("[data-skip]")?.addEventListener("click", () => skipQueued(el));

  body.querySelector("[data-del-price]")?.addEventListener("click", async () => {
    await deletePrice(draft._editId);
    closeSheet(el);
    await refresh();
    toast("已刪除");
  });

  el.querySelector("[data-save]").onclick = async () => {
    draft.price_text = priceInput.value;
    await saveRecord(el, draft);
  };

  draft.size_unit = body.querySelector("[data-f='size_unit']").value;
  refreshHint();
  // 有照片時 AI 會填價格，先不要叫出鍵盤蓋住半個畫面；手動輸入才直接聚焦
  if (!draft.photo_id) setTimeout(() => priceInput.focus(), 60);
}

// 縮圖、存進本機、登記到 photos 表。回傳照片 id。
async function storePhotoFile(file, storeId = null) {
  const { blob, width, height } = await shrink(file);
  const id = db.uuid();
  await db.savePhotoBlob(id, blob);
  await db.put("photos", {
    id, r2_key: `labels/${id}.jpg`, store_id: storeId,
    taken_at: new Date(file.lastModified || Date.now()).toISOString(), width, height,
  });
  return { id, blob };
}

async function attachPhoto(el, draft, refreshHint, { camera = false } = {}) {
  const file = await pickImage({ camera });
  if (!file) return;

  const slot = el.querySelector("[data-photo]");
  slot.innerHTML = `<div class="ai-note">處理中…</div>`;

  try {
    const { id, blob } = await storePhotoFile(file, draft.store_id);
    draft.photo_id = id;
    draft._blobUrl = URL.createObjectURL(blob);
    renderPhotoSlot(el, draft);
    refreshHint();
    // 拍了照就是要辨識，不用再多按一下「辨識」。編輯時例外（見 attachStoredPhoto）。
    if (!draft._editId) readLabel(el, draft, refreshHint);
  } catch (err) {
    slot.innerHTML = `<div class="ai-note warn">照片處理失敗 ${esc(err.message)}</div>`;
  }
}

// 按「記價」先問怎麼記。站在貨架前是拍照，回家補登是從相簿選 ——
// 兩種都很常見，直接開相機會讓後者每次都要先關掉相機。
function openRecordMenu() {
  const el = menuSheet(`
    <button class="menu-row big" data-m="camera">${ICON.camera}<span>拍標籤</span></button>
    <button class="menu-row big" data-m="library">${ICON.image}<span>從相簿選</span></button>
    <button class="menu-row big" data-m="batch">${ICON.stack}<span>一次匯入多張</span></button>
    <button class="menu-row big" data-m="manual">${ICON.pencil}<span>手動輸入</span></button>`);

  el.querySelector(".menu").addEventListener("click", async (e) => {
    const m = e.target.closest("[data-m]")?.dataset.m;
    if (!m) return;
    closeSheet(el);
    if (m === "manual") return openRecord();
    if (m === "batch") return openBatchImport();
    // pickImage 要在這次點擊裡同步呼叫，iPhone 才肯開相機／相簿
    const file = await pickImage({ camera: m === "camera" });
    if (!file) return;
    try {
      const { id } = await storePhotoFile(file, state.lastStore);
      openRecord({ photoId: id });
    } catch (err) {
      toast("照片處理失敗 " + err.message, { warn: true });
    }
  });
}

// 貨架標籤上的字本來就小，96px 的縮圖根本讀不出價格。
// 要能點開看原圖，而且要能再放大 —— 這張照片存在的唯一理由就是事後核對。
function openPhotoViewer(url) {
  const el = document.createElement("div");
  el.className = "sheet viewer";
  el.innerHTML = `
    <div class="viewer-stage" data-stage>
      <img src="${esc(url)}" alt="貨架標籤">
    </div>
    <div class="viewer-bar">
      <button class="btn-foot" data-close>‹ 返回</button>
      <button class="btn-foot" data-zoom>🔍 ${bi1("zoom")}</button>
    </div>`;
  document.body.appendChild(el);

  const stage = el.querySelector("[data-stage]");
  const img = el.querySelector("img");

  // 放大時把「剛才點的位置」捲到中間，不然放大後看到的永遠是左上角，
  // 而價格通常印在標籤下半部。
  const toggleZoom = (clientX, clientY) => {
    const wasZoomed = stage.classList.toggle("zoomed");
    if (!wasZoomed) return;
    const rect = img.getBoundingClientRect();
    const rx = clientX === undefined ? 0.5 : (clientX - rect.left) / rect.width;
    const ry = clientY === undefined ? 0.5 : (clientY - rect.top) / rect.height;
    requestAnimationFrame(() => {
      stage.scrollLeft = rx * stage.scrollWidth - stage.clientWidth / 2;
      stage.scrollTop = ry * stage.scrollHeight - stage.clientHeight / 2;
    });
  };

  img.onclick = (e) => toggleZoom(e.clientX, e.clientY);
  el.querySelector("[data-zoom]").onclick = () => toggleZoom();
  el.querySelector("[data-close]").onclick = () => closeSheet(el);

  openSheets.push(el);
  pushSheetState();
  return el;
}

async function showPhoto(photoId) {
  if (!photoId) return;
  const url = await db.photoUrl(photoId);
  if (url) openPhotoViewer(url);
}

function renderPhotoSlot(el, draft, { busy = false, message = "" } = {}) {
  const slot = el.querySelector("[data-photo]");
  slot.innerHTML = `
    <div class="photo-preview">
      <button class="thumb" data-act="zoom-photo" aria-label="${plain("zoom")}">
        <img src="${esc(draft._blobUrl || "")}" alt="貨架標籤 shelf label">
        <span class="thumb-badge">🔍</span>
      </button>
      <div class="side">
        <button class="btn-small primary" data-act="read-label"${busy ? " disabled" : ""}>
          ${busy ? bi1("reading") + " …" : "✨ " + bi1("recognise")}
        </button>
        <div class="btn-row">
          <button class="btn-small" data-act="take-photo">重拍</button>
          <button class="btn-small" data-act="choose-photo">換一張</button>
        </div>
        ${message ? `<div class="ai-note${message.startsWith("!") ? " warn" : ""}">${esc(message.replace(/^!/, ""))}</div>` : ""}
      </div>
    </div>`;
}

// AI 讀出來的東西一律只是「建議值」，直接填進表單讓人看、讓人改。
// 不會跳過確認直接寫進資料庫 —— 錯的價格比沒有價格更糟，
// 它會污染之後所有的比價結論，而且你根本不會發現。
async function readLabel(el, draft, refreshHint) {
  if (!draft.photo_id) return;
  renderPhotoSlot(el, draft, { busy: true });

  try {
    const blob = await db.getPhotoBlob(draft.photo_id);
    const body = blob
      ? { image: await blobToDataUri(blob) }
      : { photo_id: draft.photo_id };

    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json();

    if (!res.ok || !out.ok || !out.data) {
      renderPhotoSlot(el, draft, { message: "!辨識失敗，手動填就好 " + (out.error || res.status) });
      return;
    }

    await applyExtraction(el, draft, out.data);
    refreshHint();

    const filled = ["price_pence", "name_en", "size"].filter((k) => out.data[k] !== null).length;
    renderPhotoSlot(el, draft, { message: `已填 ${filled} 個欄位，請核對` });
    buzz(20);
  } catch (err) {
    renderPhotoSlot(el, draft, { message: "!" + err.message });
  }
}

async function applyExtraction(el, draft, data) {
  const body = el.querySelector(".sheet-body");
  const set = (key, value) => {
    if (value === null || value === undefined || value === "") return;
    draft[key] = value;
    const input = body.querySelector(`[data-f='${key}']`);
    if (input) { if (input.type === "checkbox") input.checked = !!value; else input.value = value; }
  };

  if (data.price_pence !== null) {
    draft.price_text = u.penceToInput(data.price_pence);
    body.querySelector("[data-price]").value = draft.price_text;
  }
  set("name_en", data.name_en);
  set("brand", data.brand);
  // 計價基準：標籤上的單價小字最可靠（店家印的），其次是包裝容量的單位
  draft._labelBase = u.baseFromLabel(data.label_unit_price)
    || (data.size_unit ? u.baseOfUnit(data.size_unit) : null);

  if (data.size !== null && data.size_unit) {
    draft.size = String(data.size);
    draft.size_unit = data.size_unit;
    draft._prefilled = false;
  }

  // 已經選好品項的話，先對一次基準：合不上就改品項（還沒用過時）或清掉容量，
  // 絕對不讓選單把 each 默默變成 g
  await reconcileUnit(draft);
  syncProductFields(body, draft);
  if (draft.size_unit) {
    const select = body.querySelector("[data-f='size_unit']");
    if ([...select.options].some((o) => o.value === draft.size_unit)) select.value = draft.size_unit;
  }

  if (data.is_promo) {
    draft.is_promo = true;
    body.querySelector("[data-f='is_promo']").checked = true;
    body.querySelector("[data-promo-row]").classList.remove("hidden");
    set("promo_note", data.promo_note);
  }

  draft.label_unit_price = data.label_unit_price || null;
  draft.source = "ai";
}

async function saveRecord(el, draft) {
  const pence = u.inputToPence(draft.price_text);

  if (!draft.item_id) return toast("還沒選品項", { warn: true });
  if (pence === null || pence <= 0) return toast("價格沒填", { warn: true });
  if (!draft.store_id) return toast("還沒選超市", { warn: true });

  // 同一家店的同一個品項、同一個容量 → 視為同一個商品，價格接在它後面變成走勢。
  // 容量不同就是不同商品（2L 跟 1L 是兩件事），各自留一條線。
  const raw = draft.size === "" || draft.size === undefined ? NaN : Number(draft.size);
  const size = Number.isFinite(raw) && raw > 0 ? raw : null;
  // 比對與建立用的必須是同一個值，不然每存一次就多一個「同規格但單位空白」的商品
  const sizeUnit = draft.size_unit || "each";

  let product = productsOfItem(draft.item_id).find((p) =>
    p.store_id === draft.store_id &&
    (p.size ?? null) === size &&
    (p.size_unit || "each") === sizeUnit);

  if (product) {
    // 名字或品牌補得比上次完整就順手更新
    if ((draft.name_en && draft.name_en !== product.name_en) || (draft.brand !== (product.brand || ""))) {
      product = await db.put("products", { ...product, name_en: draft.name_en, brand: draft.brand || null });
    }
  } else {
    product = await db.put("products", {
      item_id: draft.item_id,
      store_id: draft.store_id,
      brand: draft.brand || null,
      name_en: draft.name_en || "",
      size,
      size_unit: sizeUnit,
      barcode: null,
    });
  }

  const before = draft._editId ? state.prices.find((p) => p.id === draft._editId) : null;

  const price = await db.put("prices", {
    ...(before || {}),
    product_id: product.id,
    price_pence: pence,
    observed_on: draft.observed_on || u.localDate(),
    is_promo: draft.is_promo ? 1 : 0,
    promo_note: draft.is_promo ? (draft.promo_note || null) : null,
    branch: draft.branch || null,
    photo_id: draft.photo_id,
    source: draft.source,
    label_unit_price: draft.label_unit_price,
  });

  // 改了容量或換了店家，這筆就掛到另一個商品底下了。原本那個如果沒有價格了
  // 就一起收掉 —— 留著會在下次記價時被當成「上次的規格」帶出來，
  // 剛剛才修正掉的錯誤又會跑回來。
  if (before && before.product_id !== product.id) {
    const left = state.prices.filter((p) => p.product_id === before.product_id && p.id !== before.id);
    if (!left.length) await db.remove("products", before.product_id);
  }

  // 照片是批次匯入時掛上去的，這時才知道它屬於哪家店，補回去
  if (draft.photo_id) {
    const photo = state.photos.find((p) => p.id === draft.photo_id);
    if (photo && !photo.store_id) await db.put("photos", { ...photo, store_id: draft.store_id });
  }

  closeSheet(el);
  await refresh();

  const item = itemById(draft.item_id);
  const unit = u.unitPricePence(pence, product);
  const detail = unit !== null ? " · " + u.formatUnitPrice(unit, item.base_unit) : "";

  // 編輯不提供「復原」：要還原成什麼值並不明確（改了三個欄位要還原哪一個？），
  // 而且再點進去改回來就好。新增才給復原，那個語意很清楚 —— 就是整筆拿掉。
  if (before) {
    toast(`已更新 ${esc(u.formatPence(pence))}${esc(detail)} Updated`);
    buzz(18);
    return;
  }

  toast(`已記下 ${esc(u.formatPence(pence))}${esc(detail)}`, {
    action: async () => { await db.remove("prices", price.id); await refresh(); },
    ms: draft._fromQueue ? 2500 : 5000,
  });
  buzz(18);

  // 批次模式：存完直接開下一張，不要讓人回到清單再按一次
  if (draft._fromQueue) {
    queue.index += 1;
    await saveQueue();
    nextInQueue();
  }
}

// ---------------------------------------------------------------- 品項選單

function openItemPicker(onPick) {
  const el = sheet(bi("pickItem"), `
    <div class="searchbar">
      <input type="search" data-q placeholder="${plain("search")}… 牛奶 / milk" autocomplete="off">
    </div>
    <div data-results></div>`);

  const input = el.querySelector("[data-q]");
  const results = el.querySelector("[data-results]");

  const draw = () => {
    const q = input.value.trim();
    const list = state.items
      .filter((i) => matchesQuery(i, q))
      .sort((a, b) => (a.name_zh || "").localeCompare(b.name_zh || "", "zh-Hant"));

    const create = `
      <div class="itemrow"><button class="open" data-new>
        <span class="ic" style="color:var(--accent-ink)">＋</span>
        <span class="body"><span class="nm">${bi1("newItem")}${q ? `：${esc(q)}` : ""}</span></span>
      </button></div>`;

    results.innerHTML = create + (list.length
      ? list.map((i) => itemRowHtml(i, { compact: true })).join("")
      : q ? "" : `<div class="empty"><p>還沒有品項</p></div>`) + presetsHtml(q);
  };

  input.oninput = draw;
  draw();

  results.onclick = async (e) => {
    const preset = e.target.closest("[data-preset]");
    if (preset) {
      const [name_zh, name_en, base_unit, cat] = PRESETS[Number(preset.dataset.preset)];
      const item = await db.put("items", { name_zh, name_en, base_unit, category: cat, emoji: null, note: "" });
      closeSheet(el);
      await refresh();
      toast(`已新增「${esc(name_zh)}」`);
      await onPick(item);
      return;
    }
    if (e.target.closest("[data-new]")) {
      openItemEditor(null, async (item) => { closeSheet(el); await onPick(item); }, input.value.trim());
      return;
    }
    const row = e.target.closest("[data-item]");
    if (!row) return;
    const item = itemById(row.dataset.item);
    closeSheet(el);
    await onPick(item);
  };

  setTimeout(() => input.focus(), 60);
}

// 常用品項：還沒建過的照分類列出來，點一下就建立。
// 已經有同名品項的不列 —— 不然點了會建出兩個「牛奶」，比價就分成兩半了。
function presetsHtml(q) {
  const have = new Set(state.items.flatMap((i) =>
    [i.name_zh, (i.name_en || "").toLowerCase()].filter(Boolean)));
  const ql = q.toLowerCase();
  const left = PRESETS
    .map((p, n) => ({ p, n }))
    .filter(({ p }) => !have.has(p[0]) && !have.has(p[1].toLowerCase()))
    .filter(({ p }) => !q || p[0].includes(q) || p[1].toLowerCase().includes(ql));
  if (!left.length) return "";

  const byCat = new Map();
  for (const r of left) {
    if (!byCat.has(r.p[3])) byCat.set(r.p[3], []);
    byCat.get(r.p[3]).push(r);
  }
  return `<div class="section-head"><h2>常用品項・點一下就新增</h2></div>
    ${[...byCat.entries()].map(([cat, rows]) => `
      <div class="preset-cat">${category(cat)[3]} ${esc(category(cat)[1])}</div>
      <div class="preset-chips">${rows.map(({ p, n }) =>
        `<button class="chip" data-preset="${n}">${esc(p[0])}</button>`).join("")}</div>`).join("")}`;
}

// ---------------------------------------------------------------- 品項編輯

function openItemEditor(existing, onSaved, seedText = "") {
  // 打中文就當中文名，打英文就當英文名 —— 從選單搜尋直接跳過來的時候很有用
  const isAscii = /^[\x20-\x7E]+$/.test(seedText);

  const draft = existing ? { ...existing } : {
    name_zh: isAscii ? "" : seedText,
    name_en: isAscii ? seedText : "",
    base_unit: "g",
    // 從搜尋框帶過來的字就先猜一次分類，省得每次都要自己選
    category: guessCategory(isAscii ? "" : seedText, isAscii ? seedText : "") || "other",
    emoji: null,
    note: "",
  };

  // 已經有商品掛在底下就不能再換計價基準：那些商品的 size_unit 是照現在這個
  // 基準填的，改掉會讓 500g 被當成 500ml，所有單價默默算錯而且看不出來。
  const productCount = existing ? productsOfItem(existing.id).length : 0;
  const lockedBase = productCount > 0;

  const el = sheet(existing ? bi("edit") : bi("newItem"), `
    <div class="rows">
      <label class="row">
        <span class="k">${bi1("nameZh")}</span>
        <input class="inp grow" data-f="name_zh" type="text" placeholder="全脂牛奶" value="${esc(draft.name_zh)}">
      </label>
      <label class="row">
        <span class="k">${bi1("nameEn")}</span>
        <input class="inp grow" data-f="name_en" type="text" placeholder="Whole Milk" value="${esc(draft.name_en)}">
      </label>
      <button class="row" data-act="pick-emoji">
        <span class="k">${bi1("icon")}</span>
        <span class="v"><span class="emoji-now" data-emoji-now>${
          draft.emoji || guessEmoji(draft.name_zh, draft.name_en) || category(draft.category)[3]
        }</span> <i class="en" data-auto-hint>${draft.emoji ? "" : esc(plain("auto"))}</i></span>
      </button>
      <label class="row">
        <span class="k">${bi1("category")}</span>
        <select class="sel" data-f="category">
          ${CATEGORIES.filter((c) => c[0] !== "produce" || draft.category === "produce").map(([id, z, e2, ic]) =>
            `<option value="${id}"${draft.category === id ? " selected" : ""}>${ic} ${z} ${e2}</option>`).join("")}
        </select>
      </label>
      <label class="row">
        <span class="k">${bi1("baseUnit")}</span>
        <select class="sel" data-f="base_unit"${lockedBase ? " disabled" : ""}>
          <option value="g"${draft.base_unit === "g" ? " selected" : ""}>按重量（每公斤）</option>
          <option value="ml"${draft.base_unit === "ml" ? " selected" : ""}>按容量（每公升）</option>
          <option value="each"${draft.base_unit === "each" ? " selected" : ""}>按個</option>
        </select>
      </label>
    </div>
    ${lockedBase ? `<p class="note">底下已經有 ${productCount} 筆商品，計價基準鎖住了（改掉單價會全部算錯）。</p>` : ""}
    ${existing ? `<div class="rows"><button class="row danger" data-del><span class="k">${bi1("delete")}</span></button></div>` : ""}
  `, { saveLabel: bi1("save") });

  const redrawEmoji = () => {
    const cell = el.querySelector("[data-emoji-now]");
    if (cell) cell.textContent = draft.emoji
      || guessEmoji(draft.name_zh, draft.name_en) || category(draft.category)[3];
  };

  el.querySelectorAll("[data-f]").forEach((input) => {
    input.oninput = input.onchange = () => {
      draft[input.dataset.f] = input.value;
      // 打名字的當下就換圖示，讓人看得出「它會自己判斷」
      if (!draft.emoji) redrawEmoji();
    };
  });

  el.querySelector("[data-act='pick-emoji']").onclick = () => {
    openEmojiPicker(draft.emoji, (picked) => {
      draft.emoji = picked;          // null = 回到自動判斷
      redrawEmoji();
      const hint = el.querySelector("[data-auto-hint]");
      if (hint) hint.textContent = picked ? "" : plain("auto");
    });
  };

  el.querySelector("[data-save]").onclick = async () => {
    if (!draft.name_zh.trim() && !draft.name_en.trim()) {
      return toast("至少填一個名稱", { warn: true });
    }
    const saved = await db.put("items", {
      ...(existing || {}),
      name_zh: draft.name_zh.trim(),
      name_en: draft.name_en.trim(),
      base_unit: draft.base_unit,
      category: draft.category,
      emoji: draft.emoji || null,
    });
    closeSheet(el);
    await refresh();
    if (onSaved) await onSaved(saved);
  };

  el.querySelector("[data-del]")?.addEventListener("click", async () => {
    const n = productsOfItem(existing.id).length;
    if (n && !confirm(`這個品項底下還有 ${n} 家店的商品紀錄，一起刪掉？\nThis will also hide ${n} product records.`)) return;
    await db.remove("items", existing.id);
    closeSheet(el);
    await refresh();
    toast("已刪除");
  });
}

// ---------------------------------------------------------------- 自訂店家
//
// 轉角的亞洲雜貨、市集攤位、只有一家的小超市 —— 這些只有使用者自己知道，
// 但它們常常才是最便宜的地方，不能因為清單裡沒有就記不了。

function openStoreEditor(existing, onSaved, presetGroup = "uk") {
  const draft = existing ? { ...existing } : {
    name: "",
    group_id: presetGroup,
    color: PALETTE[0],
    note: "",
    archived: 0,
    sort: (customStores().length + 1) * 10,
  };
  const usedCount = existing ? state.products.filter((p) => p.store_id === existing.id).length : 0;

  const el = sheet(existing ? bi("edit") : bi("newStore"), `
    <div class="rows">
      <label class="row">
        <span class="k">${bi1("storeName")}</span>
        <input class="inp grow" data-f="name" type="text" placeholder="Loon Fung / 街角雜貨"
               value="${esc(draft.name)}" autocomplete="off">
      </label>
      <label class="row">
        <span class="k">${bi1("group")}</span>
        <select class="sel" data-f="group_id">
          ${GROUPS.map((g) => `<option value="${g.id}"${draft.group_id === g.id ? " selected" : ""}>
            ${g.icon} ${esc(g.zh)} ${esc(g.en)}</option>`).join("")}
        </select>
      </label>
      <label class="row">
        <span class="k">${bi1("storeNote")}</span>
        <input class="inp grow" data-f="note" type="text" placeholder="Chinatown 那家"
               value="${esc(draft.note || "")}" autocomplete="off">
      </label>
      <div class="row block">
        <span class="k" style="display:block;margin-bottom:10px">${bi1("colour")}</span>
        <div class="swatches" data-swatches>
          ${PALETTE.map((c) => `<button class="swatch-btn${draft.color === c ? " on" : ""}"
            data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join("")}
        </div>
      </div>
      ${existing ? `<label class="row">
        <span class="k">${bi1("archive")}</span>
        <input class="chk" data-f="archived" type="checkbox"${draft.archived ? " checked" : ""}>
      </label>` : ""}
    </div>


    ${existing ? `<div class="rows"><button class="row danger" data-del>
      <span class="k">${bi1("delete")}</span></button></div>` : ""}
  `, { saveLabel: bi1("save") });

  el.querySelectorAll("[data-f]").forEach((input) => {
    input.oninput = input.onchange = () => {
      draft[input.dataset.f] = input.type === "checkbox" ? (input.checked ? 1 : 0) : input.value;
    };
  });

  el.querySelector("[data-swatches]").onclick = (e) => {
    const btn = e.target.closest("[data-color]");
    if (!btn) return;
    draft.color = btn.dataset.color;
    el.querySelectorAll("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === draft.color));
  };

  el.querySelector("[data-save]").onclick = async () => {
    if (!String(draft.name).trim()) return toast("店名沒填", { warn: true });
    const saved = await db.put("stores", {
      ...(existing || {}),
      name: String(draft.name).trim(),
      group_id: normGroup(draft.group_id),
      color: draft.color,
      note: String(draft.note || "").trim() || null,
      archived: draft.archived ? 1 : 0,
      sort: draft.sort,
    });
    closeSheet(el);
    await refresh();
    if (onSaved) await onSaved(saved);
  };

  el.querySelector("[data-del]")?.addEventListener("click", async () => {
    if (usedCount && !confirm(
      `這家店底下還有 ${usedCount} 筆商品紀錄。\n刪掉之後那些價格會變成「查不到是哪家店」。\n` +
      `只是不想再看到它的話，用「封存」比較好。\n\n確定要刪除嗎？`)) return;
    await db.remove("stores", existing.id);
    closeSheet(el);
    await refresh();
    toast("已刪除");
  });
}

function openStoreList() {
  const rows = customStores();
  const el = sheet(bi("stores"), `
    <div class="storebar" style="border-bottom:1px solid var(--line-soft)">
      <button class="chip" data-act="new-store">＋ ${bi1("newStore")}</button>
    </div>

    ${rows.length ? GROUPS.map((g) => {
      const mine = rows.filter((r) => r.group === g.id);
      if (!mine.length) return "";
      return `<div class="section-head"><h2>${g.icon} ${esc(g.zh)}
</h2></div>
        <div class="rows">${mine.map((s) => {
          const n = state.products.filter((p) => p.store_id === s.id).length;
          return `<button class="row" data-store-edit="${esc(s.id)}">
            ${storeBadge(s)}
            <span class="k" style="flex:1;min-width:0">${esc(s.name)}${s.archived ? `` : ""}
              ${s.note ? `<i class="en">${esc(s.note)}</i>` : ""}</span>
            <span class="v num">${n ? `${n} 項` : ""}</span>
          </button>`;
        }).join("")}</div>`;
    }).join("") : `<div class="empty"><div class="big">🏪</div>
      <p>還沒有自訂店家<br><br>
      轉角的雜貨店、市集攤位這種<br>清單裡沒有的地方，加進來就能記價<br>
</p></div>`}

  `);

  el.querySelector(".sheet-body").addEventListener("click", (e) => {
    if (e.target.closest("[data-act='new-store']")) {
      openStoreEditor(null, () => { closeSheet(el); openStoreList(); });
      return;
    }
    const row = e.target.closest("[data-store-edit]");
    if (!row) return;
    const store = storeById(row.dataset.storeEdit);
    openStoreEditor(store ? { ...store, group_id: store.group } : null,
      () => { closeSheet(el); openStoreList(); });
  });
}

// 用名稱重新判斷分類，把有出入的列出來讓你逐條確認。
//
// 刻意不自動改：分類是你的判斷，不是我的。像「蛋」在英國超市歸乳製品區、
// 「豆腐」你可能想放主食也可能想放蛋白質 —— 這種事只有你能決定。
function openTidy() {
  const changes = state.items.map((item) => {
    const g = guessCategory(item.name_zh, item.name_en);
    if (!g || g === item.category) return null;
    return { item, from: item.category, to: g };
  }).filter(Boolean);

  const el = sheet(bi("tidy"), changes.length ? `
    <div class="rows">
      ${changes.map(({ item, from, to }) => `
        <label class="row">
          <span class="ic" style="width:26px;text-align:center;flex:none">${itemEmoji(item)}</span>
          <span class="k" style="flex:1;min-width:0">
            ${esc(item.name_zh || item.name_en)}
            <i class="en">${category(from)[3]} ${esc(category(from)[1])} → ${category(to)[3]} ${esc(category(to)[1])}</i>
          </span>
          <input class="chk" type="checkbox" data-fix="${esc(item.id)}" data-to="${esc(to)}" checked>
        </label>`).join("")}
    </div>` : `<div class="empty"><div class="big">✨</div>
      <p>分類看起來都對</p></div>`,
    changes.length ? { saveLabel: bi1("save") } : {});

  el.querySelector("[data-save]")?.addEventListener("click", async () => {
    const boxes = [...el.querySelectorAll("[data-fix]:checked")];
    for (const box of boxes) {
      const item = itemById(box.dataset.fix);
      if (item) await db.put("items", { ...item, category: box.dataset.to });
    }
    closeSheet(el);
    await refresh();
    toast(`已整理 ${boxes.length} 個品項`);
  });
}

function openEmojiPicker(current, onPick) {
  const el = sheet(bi("icon"), `
    <div class="rows">
      <button class="row" data-auto>
        <span class="k">✨ ${bi1("auto")}</span>
        <span class="v">${current ? "" : "✓"} 依名稱判斷 ›</span>
      </button>
    </div>
    ${EMOJI_GROUPS.map(([label, chars]) => `
      <div class="section-head"><h2>${esc(label)}</h2></div>
      <div class="emoji-grid">
        ${[...chars].filter((c) => c.trim()).map((c) =>
          `<button class="emoji-btn${c === current ? " on" : ""}" data-emoji="${esc(c)}">${c}</button>`).join("")}
      </div>`).join("")}`);

  el.querySelector(".sheet-body").addEventListener("click", (e) => {
    if (e.target.closest("[data-auto]")) { closeSheet(el); onPick(null); return; }
    const btn = e.target.closest("[data-emoji]");
    if (!btn) return;
    closeSheet(el);
    onPick(btn.dataset.emoji);
  });
}

// ---------------------------------------------------------------- 品項明細

async function openItemDetail(itemId) {
  const item = itemById(itemId);
  if (!item) return;
  markViewed(itemId);   // 不 await：面板先開，寫入在背景

  // 同一樣東西，所有有賣的店排在一起，只有一個「最便宜」。
  //
  // 以前照店家分組各排各的，櫛瓜在 Baleys（一般超市）和 Fulham Greens（獨立店家）
  // 各自是「最便宜」，兩個綠標並排，看不出到底哪家便宜。分組的理由（Aldi 買不到醬油）
  // 只對整籃總價成立 —— 那取決於店裡有沒有賣；同一樣東西兩家都有賣時，直接比就對了。
  const rows = rankItem(itemId);
  const multiGroup = new Set(rows.map((r) => r.store.group)).size > 1;
  const inList = state.list_items.some((li) => li.list_id === state.listId && li.item_id === itemId);

  const el = sheet(biText(item.name_zh, item.name_en, { block: true }), `
    ${rows.length
      ? `<div class="rank">${rows.map((r, i) => rankRowHtml(r, i === 0, item, { multiGroup })).join("")}</div>`
      : `<div class="empty"><div class="big">${itemEmoji(item)}</div><p>還沒有價格</p></div>`}

    ${historySection(itemId, item)}
    ${observationsSection(itemId)}
  `, {
    closeLabel: "‹ 返回",
    actions: `<button class="btn-foot" data-act="edit">${bi1("edit")}</button>
      <button class="btn-foot" data-act="list">${inList ? "移出清單" : bi1("addToList")}</button>`,
    saveLabel: `＋ ${bi1("record")}`,
  });

  el.querySelector(".sheet-foot").addEventListener("click", async (e) => {
    if (e.target.closest("[data-save]")) { closeSheet(el); openRecord({ itemId }); }
    if (e.target.closest("[data-act='edit']")) { closeSheet(el); openItemEditor(item, () => refresh()); }
    if (e.target.closest("[data-act='list']")) {
      closeSheet(el);
      await toggleSelected(itemId);
      toast(inList ? "已移出清單" : "已加入清單");
    }
  });

  // 排行列與紀錄列都能點開編輯，所以綁在整個面板上
  el.querySelector(".sheet-body").addEventListener("click", (e) => {
    const row = e.target.closest("[data-price-id]");
    if (!row) return;
    closeSheet(el);
    openRecord({ editPriceId: row.dataset.priceId });
  });
}

// 一家店一行：店名、這包多大、多久以前；右邊是單價（大）與包裝價（小）。
function rankRowHtml(r, isBest, item, { multiGroup = false } = {}) {
  const p = r.product;
  const g = groupById(r.store.group);
  const detail = [p.name_en, u.formatSize(p.size, p.size_unit), r.fresh.label].filter(Boolean).join(" · ");
  // 排行列可以直接點開編輯：看到明顯不對的數字時，第一個反應就是去戳它。
  return `<button class="rankrow${isBest ? " best" : ""}${r.fresh.stale ? " stale" : ""}"
      data-price-id="${esc(r.price.id)}">
    ${storeBadge(r.store)}
    <span class="body">
      <span class="store">${esc(r.store.name)}${isBest ? `<span class="tag win">${esc(zh("cheapest"))}</span>` : ""}${
        r.price.is_promo ? `<span class="tag promo">${esc(r.price.promo_note || "特價")}</span>` : ""}${
        r.fresh.stale ? `<span class="tag old">舊</span>` : ""}${
        multiGroup ? `<span class="tag grp">${esc(g.zh)}</span>` : ""}</span>
      <span class="detail">${esc(detail || "—")}</span>
    </span>
    <span class="fig">
      <span class="a num">${esc(u.formatUnitPrice(r.unit, item.base_unit))}</span>
      <span class="b num">${esc(u.formatPence(r.price.price_pence, { alwaysPounds: true }))}${esc(twd(r.price.price_pence))}</span>
    </span>
  </button>`;
}

// 走勢：把每家店的單價各畫一條線。手寫 SVG，不引圖表庫。
function historySection(itemId, item) {
  const points = [];
  for (const p of productsOfItem(itemId)) {
    for (const pr of state.prices) {
      if (pr.product_id !== p.id) continue;
      const unit = u.unitPricePence(pr.price_pence, p);
      if (unit === null) continue;
      points.push({ store: p.store_id, date: pr.observed_on, unit });
    }
  }
  if (points.length < 3) return "";

  const dates = [...new Set(points.map((p) => p.date))].sort();
  if (dates.length < 2) return "";

  const W = 320, H = 110, padL = 6, padR = 6, padT = 8, padB = 18;
  const t0 = new Date(dates[0]).getTime();
  const t1 = new Date(dates[dates.length - 1]).getTime();
  const span = Math.max(t1 - t0, 1);

  const vals = points.map((p) => p.unit);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const range = Math.max(hi - lo, hi * 0.08, 0.0001);

  const x = (d) => padL + ((new Date(d).getTime() - t0) / span) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / range) * (H - padT - padB);

  const byStore = new Map();
  for (const p of points) {
    if (!byStore.has(p.store)) byStore.set(p.store, []);
    byStore.get(p.store).push(p);
  }

  const lines = [...byStore.entries()].map(([store, ps]) => {
    ps.sort((a, b) => (a.date < b.date ? -1 : 1));
    const d = ps.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.unit).toFixed(1)}`).join(" ");
    const dots = ps.map((p) => `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.unit).toFixed(1)}" r="2.4" fill="${storeColor(store)}"/>`).join("");
    return `<path class="seg" d="${d}" stroke="${storeColor(store)}"/>${dots}`;
  }).join("");

  const legend = [...byStore.keys()].map((s) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px">
       <span style="width:10px;height:2px;background:${storeColor(s)};display:inline-block"></span>
       <span style="font-size:11px;color:var(--muted)">${esc(storeName(s))}</span></span>`).join("");

  return `
    <div class="section-head"><h2>${esc(zh("history"))}</h2></div>
    <figure class="chart">
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="各店單價走勢 unit price over time">
        <line class="grid" x1="${padL}" y1="${y(lo).toFixed(1)}" x2="${W - padR}" y2="${y(lo).toFixed(1)}"/>
        <line class="grid" x1="${padL}" y1="${y(hi).toFixed(1)}" x2="${W - padR}" y2="${y(hi).toFixed(1)}"/>
        ${lines}
      </svg>
      <figcaption style="display:flex;flex-wrap:wrap;padding-top:8px">
        ${legend}
        <span style="margin-left:auto;font-size:11px;color:var(--faint)" class="num">
          ${esc(u.formatUnitPrice(lo, item.base_unit))} – ${esc(u.formatUnitPrice(hi, item.base_unit))}
        </span>
      </figcaption>
    </figure>`;
}

function observationsSection(itemId) {
  const rows = [];
  for (const p of productsOfItem(itemId)) {
    for (const pr of state.prices) {
      if (pr.product_id === p.id) rows.push({ product: p, price: pr });
    }
  }
  if (!rows.length) return "";
  rows.sort((a, b) => (a.price.observed_on < b.price.observed_on ? 1 : -1));

  return `
    <div class="section-head"><h2>${esc(zh("allPrices"))}</h2></div>
    <div class="rows" data-obs>
      ${rows.map(({ product, price }) => `
        <button class="row" data-price-id="${esc(price.id)}">
          <span class="swatch" style="width:3px;height:26px;border-radius:2px;background:${storeColor(product.store_id)};flex:none"></span>
          <span class="k" style="flex:1;min-width:0">
            ${esc(storeName(product.store_id))}
            <i class="en">${esc(u.formatSize(product.size, product.size_unit))}${price.branch ? " · " + esc(price.branch) : ""}</i>
          </span>
          <span class="v num">${esc(u.formatPence(price.price_pence, { alwaysPounds: true }))}
            <i class="en">${esc(u.freshness(price.observed_on).label)}${esc(twd(price.price_pence))}</i></span>
        </button>`).join("")}
    </div>`;
}

// 刪一筆價格，順便收掉因此變成孤兒的商品。
//
// 留著一個沒有價格的商品，畫面上完全看不到它，卻會在下次記價時被當成
// 「上次的規格」帶出來，害你存出一筆算不出單價的紀錄。
async function deletePrice(priceId) {
  const price = state.prices.find((p) => p.id === priceId);
  if (!price) return;

  await db.remove("prices", price.id);

  const others = state.prices.filter((p) => p.product_id === price.product_id && p.id !== price.id);
  if (!others.length) await db.remove("products", price.product_id);
}

// ---------------------------------------------------------------- 清單
//
// 清單存的是 list_items，份量、同步、跨裝置全部照舊。
// 入口在品項明細底部的「加入清單」；首頁上方的整籃面板照這份清單算。

function selectedItemIds() {
  return new Set(state.list_items
    .filter((li) => li.list_id === state.listId)
    .map((li) => li.item_id));
}

async function toggleSelected(itemId) {
  const existing = state.list_items.find(
    (li) => li.list_id === state.listId && li.item_id === itemId);
  if (existing) {
    await db.remove("list_items", existing.id);
  } else {
    await db.put("list_items", {
      list_id: state.listId, item_id: itemId, qty: 1,
      sort: state.list_items.length * 10, checked: 0,
    });
  }
  await refresh();
  buzz();
}

async function clearSelected() {
  const mine = state.list_items.filter((li) => li.list_id === state.listId);
  for (const li of mine) await db.remove("list_items", li.id);
  await refresh();
  toast(`已清除 ${mine.length} 項`);
}

// 一籃子在各店要多少錢。
//
// 誠實規則：某家店缺某個品項的資料時，不補值、不當成 0，
// 直接標示「15 項中已知 12 項」並列出缺哪幾項。
// 偷偷補值會讓資料最少的那家店看起來最便宜，剛好得到相反的結論。
function basketLines() {
  return state.list_items
    .filter((li) => li.list_id === state.listId)
    .map((li) => ({ li, item: itemById(li.item_id) }))
    .filter((r) => r.item)
    .sort((a, b) => a.li.sort - b.li.sort);
}

// 一組（一般超市 or 亞洲超市）內部的籃子分析。
//
// 為什麼分組算而不是全部一起排：你沒辦法在 Aldi 買醬油。把亞洲超市丟進同一個
// 排行，它會因為缺一堆日常品項而永遠敬陪末座，而那不是你想知道的事。
// 真正的採買是「先去 Aldi 買日常，再去 Tian Tian 補亞洲食材」，所以要分開算。
function basketAnalysis(groupId) {
  const lines = basketLines();

  // 每個品項在每家店的單價
  const grid = new Map();          // itemId -> Map(storeId -> {unit, fresh, product, price})
  for (const { item } of lines) {
    const m = new Map();
    for (const r of rankItem(item.id)) {
      if (r.store.group === groupId) m.set(r.store.id, r);
    }
    grid.set(item.id, m);
  }

  const activeStores = storesOfGroup(groupId)
    .filter((s) => lines.some(({ item }) => grid.get(item.id).has(s.id)));

  // 「共同品項」＝ 這一組裡每一家有資料的店都有的品項。
  // 這是唯一真正公平的比較，但常常會是空的，所以只當成一個開關。
  const common = lines.filter(({ item }) =>
    activeStores.length > 0 && activeStores.every((s) => grid.get(item.id).has(s.id)));

  const useLines = state.commonOnly && common.length ? common : lines;

  const results = activeStores.map((store) => {
    let pence = 0;
    // 用每一項自己的 stale 判斷，不拿天數比門檻 —— 促銷價的門檻比一般價短
    let stale = false;
    const missing = [];

    for (const { li, item } of useLines) {
      const hit = grid.get(item.id).get(store.id);
      if (!hit) { missing.push(item); continue; }
      const qtyBase = u.toBase(li.qty, displayUnitOf(item.base_unit));
      if (qtyBase === null) { missing.push(item); continue; }
      pence += qtyBase * hit.unit;
      if (hit.fresh.stale) stale = true;
    }

    return {
      store, pence, missing,
      covered: useLines.length - missing.length,
      total: useLines.length,
      stale,
    };
  }).filter((r) => r.covered > 0);

  results.sort((a, b) => {
    // 涵蓋率一樣才比總價；涵蓋率不同時比總價根本沒有意義
    if (b.covered !== a.covered) return b.covered - a.covered;
    return a.pence - b.pence;
  });

  return { lines, useLines, results, common, activeStores };
}

// 每一組都算一遍，只回傳真的有資料的組
function basketByGroup() {
  return GROUPS
    .map((g) => ({ group: g, ...basketAnalysis(g.id) }))
    .filter((r) => r.results.length);
}

// ---------------------------------------------------------------- 畫面元件

function syncBadge() {
  const s = db.syncStatus.state;
  const label = {
    idle: "", syncing: "同步中", ok: "已同步",
    offline: "離線 offline", error: "待同步", unauthed: "請重新登入",
  }[s] || "";
  return `<span class="sync-dot" data-state="${s}"></span><span class="sync-label">${esc(label)}</span>`;
}

// below：跟著標題一起黏在上面的第二列（店家頁的店家切換列）
function topbar(key, extra = "", below = "") {
  return `<div class="topbar"><div class="topbar-inner">
    <h1>${bi(key)}</h1><div class="spacer"></div>${extra}${syncBadge()}
  </div>${below}</div>`;
}

// 底部選單的圖示用自己畫的線條，不用 emoji。
// emoji 由系統字型畫：同一個 🏬 在 iPhone 跟安卓長得完全不一樣，
// ⚙ 在部分安卓機上還會掉成黑白文字。品項的 emoji 是內容（每樣東西自己的臉），
// 各平台長得不同無所謂；導覽圖示是介面，兩邊要一樣。
const svg = (d) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  compare:  svg(`<path d="M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4"/>`),
  stores:   svg(`<path d="M4 10v10h16V10"/><path d="M3 10 5 4h14l2 6z"/><path d="M10 20v-5h4v5"/>`),
  camera:   svg(`<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>`),
  history:  svg(`<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>`),
  image:    svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9 9"/>`),
  stack:    svg(`<rect x="7" y="7" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>`),
  pencil:   svg(`<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>`),
  settings: svg(`<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>`),
};

function tabbar() {
  const tab = (route, key) =>
    `<button class="tab" data-route="${route}"${state.route === route
      || (route === "settings" && state.route === "history") ? ' aria-current="page"' : ""}>
       <span class="ic">${ICON[route]}</span><span class="nm">${esc(zh(key))}</span></button>`;

  return `<nav class="tabbar"><div class="tabbar-inner">
    ${tab("compare", "compare")}
    ${tab("stores", "storesTab")}
    <div class="fab-slot">
      <button class="fab" data-act="add" aria-label="${plain("record")}">
        <span class="ic">${ICON.camera}</span><span class="nm">${esc(zh("record"))}</span>
      </button>
    </div>
    ${tab("settings", "settings")}
  </div></nav>`;
}

// 一列只回答一件事：這樣東西最便宜多少、在哪家。其他的點進去再看。
function itemRowHtml(item, { compact = false } = {}) {
  const best = compact ? null : rankItem(item.id)[0];

  const open = `<button class="open" data-item="${esc(item.id)}">
    <span class="ic">${itemEmoji(item)}</span>
    <span class="body">
      <span class="nm">${esc(item.name_zh || item.name_en)}
        ${item.name_zh && item.name_en ? `<i class="en">${esc(item.name_en)}</i>` : ""}</span>
    </span>
    ${best ? `<span class="best">
      <span class="up num">${esc(u.formatUnitPrice(best.unit, item.base_unit))}</span>
      <span class="who">${storeBadge(best.store, "xs")}${esc(best.store.name)}${best.fresh.stale ? " · 舊" : ""}</span>
    </span>` : compact ? "" : `<span class="best"><span class="who">還沒有價格</span></span>`}
  </button>`;

  // 整列只有一個動作：點開看哪家最便宜。以前左邊有個勾選圈圈（加進整籃），
  // 但它跟「點開」擠在同一列，常常按錯，而且看不出圈圈是做什麼的。
  // 加進整籃改在明細面板底部做。
  return `<div class="itemrow cat-${category(item.category)[0]}${best && best.fresh.stale ? " dim" : ""}">${open}</div>`;
}

// ---------------------------------------------------------------- 頁面

// 首頁：搜尋 → 點名字看哪家便宜 → 勾選多個就直接算整籃。
//
// 原本「比價」與「清單」是兩頁，但它們做的是同一件事的兩半：都在列品項。
// 分開之後你得先在比價頁找到東西、記住它、再去清單頁加一次。合成一頁之後，
// 勾選就是加入，總價直接長在上面。
function renderCompare() {
  const q = state.query.trim();
  const picked = selectedItemIds();
  const list = homeList(q);

  // 加進清單的排最前面，不然選了幾樣之後要往回捲才找得到自己選了什麼
  const chosen = list.filter((i) => picked.has(i.id));
  const rest = list.filter((i) => !picked.has(i.id));

  const sortBtn = (id, label) => `<button class="chip${state.homeSort === id ? " on" : ""}"
    data-home-sort="${id}" aria-pressed="${state.homeSort === id}">${label}</button>`;

  let body = "";
  if (state.homeSort === "cat" && !q) {
    body = categorySections(rest).map(({ cat, items }) => `
      <section class="catsec cat-${cat[0]}" id="sec-${cat[0]}">
        <div class="catsec-head"><span class="e">${cat[3]}</span><h2>${esc(cat[1])}</h2>
          ${cat[0] === "produce"
            ? `<button class="more" data-act="tidy">分成蔬菜／水果</button>`
            : `<span class="more num">${items.length}</span>`}</div>
        <div class="catsec-rows">${items.map((i) => itemRowHtml(i)).join("")}</div>
      </section>`).join("");
  } else if (rest.length) {
    body = `<div class="section-head"><h2>${q ? "搜尋結果" : state.homeSort === "new" ? "最近新增" : "最近看過"}</h2>
        <span class="more num">${rest.length}</span></div>
      <div class="plainrows">${rest.map((i) => itemRowHtml(i)).join("")}</div>`;
  }

  // 一打開就看得到所有分類，點一格跳到那一段。搜尋時收起來，只留結果。
  const cats = !q && state.items.length ? categorySections(state.items) : [];
  const grid = cats.length ? `<div class="catgrid">${cats.map(({ cat, items }) => `
      <button class="cattile cat-${cat[0]}" data-jump="${cat[0]}">
        <span class="e">${cat[3]}</span><span class="n">${esc(cat[1])}</span>
        <span class="k num">${items.length} 樣</span></button>`).join("")}</div>` : "";
  // 往下捲過格子之後出現在底部的同一組分類，大拇指搆得到（見 syncCatDock）
  const dock = cats.length ? `<div class="catdock" hidden><div class="catdock-inner">${cats.map(({ cat }) => `
      <button class="catchip cat-${cat[0]}" data-jump="${cat[0]}">${cat[3]} ${esc(cat[1])}</button>`).join("")}
    </div></div>` : "";

  return `
    ${topbar("compare")}
    <main class="screen${dock ? " has-dock" : ""}">
      <div class="searchbar">
        <input type="search" data-q value="${esc(state.query)}"
               placeholder="搜尋… 牛奶 / milk" autocomplete="off">
      </div>

      ${grid}

      ${state.items.length ? (q ? "" : `<div class="sortbar" role="group" aria-label="排序">
        <span class="lb">排序</span>
        ${sortBtn("cat", "分類")}${sortBtn("recent", "最近看過")}${sortBtn("new", "最近新增")}
      </div>`) : `<div class="empty">
        <div class="big">🛒</div>
        <p>還沒有任何紀錄<br>按下面的<b>記價</b>拍一張貨架標籤開始</p>
      </div>`}

      ${picked.size ? basketPanelHtml() : ""}

      ${chosen.length ? `
        <div class="section-head"><h2>✓ ${esc(zh("selected"))}</h2>
          <span class="more num">${chosen.length}</span></div>
        <div class="plainrows">${chosen.map((i) => itemRowHtml(i)).join("")}</div>` : ""}

      ${body}
    </main>
    ${dock}
    ${tabbar()}`;
}

// 分類格子捲出畫面之後，底部才出現分類膠囊。只看格子有沒有被頂端列蓋住。
function syncCatDock() {
  const dock = app.querySelector(".catdock");
  const grid = app.querySelector(".catgrid");
  if (!dock || !grid) return;
  const top = app.querySelector(".topbar")?.getBoundingClientRect().bottom || 0;
  dock.hidden = grid.getBoundingClientRect().bottom > top + 8;
}
window.addEventListener("scroll", syncCatDock, { passive: true });

// 跳到某個分類。在「最近看過／最近新增」時沒有分段，先切回分類排法再跳。
function jumpToCategory(id) {
  if (state.homeSort !== "cat") {
    state.homeSort = "cat";
    state.homeOrder = null;
    db.setMeta("home_sort", "cat");
    render();
  }
  const sec = document.getElementById("sec-" + id);
  if (!sec) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  sec.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
}

const byName = (a, b) => (a.name_zh || a.name_en || "").localeCompare(b.name_zh || b.name_en || "", "zh-Hant");

// 首頁要列哪些、照什麼順序。
//
// 「最近看過」用的是快照：進首頁或切換排法時排一次，之後點開看過不再重排。
// 不然你點開一樣、關掉，它就跳到最上面，原本在看的那一串全部往下移一格 ——
// 使用者的原話是「點了之後順序就亂掉，找不到東西」。
function homeList(q) {
  const items = state.items.filter((i) => matchesQuery(i, q));
  if (state.homeSort === "new") {
    return items.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "") || byName(a, b));
  }
  if (state.homeSort === "recent") {
    if (!state.homeOrder) {
      const recent = recentMap();
      state.homeOrder = [...state.items]
        .sort((a, b) => {
          const x = recent.get(a.id) || "", y = recent.get(b.id) || "";
          return x === y ? byName(a, b) : (x < y ? 1 : -1);
        })
        .map((i) => i.id);
    }
    // 快照之後才建的品項（剛記價時當場新增的）放最上面，不然會找不到
    const pos = new Map(state.homeOrder.map((id, n) => [id, n]));
    return items.sort((a, b) => (pos.get(a.id) ?? -1) - (pos.get(b.id) ?? -1));
  }
  return items;
}

// 照分類分段。段落裡照名稱排，點開看過、記了價格都不會跑位。
//
// 分類的先後照「有幾筆價格」：記得最多的就是你最在意的東西，放最上面。
// 價格數一樣再比品項數，再照 CATEGORIES 的順序。沒有品項的分類不出現。
function categorySections(items) {
  const itemOfProduct = new Map(state.products.map((p) => [p.id, p.item_id]));
  const catOfItem = new Map(state.items.map((i) => [i.id, category(i.category)[0]]));
  const weight = new Map();
  for (const pr of state.prices) {
    const c = catOfItem.get(itemOfProduct.get(pr.product_id));
    if (c) weight.set(c, (weight.get(c) || 0) + 1);
  }

  const groups = new Map();
  for (const i of items) {
    const c = category(i.category)[0];
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  }
  const order = CATEGORIES.map((c) => c[0]);
  return [...groups.entries()]
    .map(([id, list]) => ({ cat: category(id), items: list.sort(byName), w: weight.get(id) || 0 }))
    .sort((a, b) => (b.w - a.w) || (b.items.length - a.items.length)
      || (order.indexOf(a.cat[0]) - order.indexOf(b.cat[0])));
}

// 已選品項的整籃比較。原本是獨立的一頁，現在長在首頁上方 ——
// 你勾了什麼、那些東西加起來各店多少，本來就該在同一個畫面上看到。
function basketPanelHtml() {
  const lines = basketLines();
  if (!lines.length) return "";

  const groups = basketByGroup();
  // 開關只在「有東西可切」的時候才顯示：任何一組裡共同品項比全部少
  const canCommon = groups.some((g) => g.common.length && g.common.length < lines.length);

  const rows = lines.map(({ li, item }) => {
    const unit = displayUnitOf(item.base_unit);
    const unitLabel = unit === "each" ? "個" : unit === "l" ? "L" : "kg";
    return `<div class="row">
      <span class="k" style="flex:1;min-width:0">
        ${esc(item.name_zh || item.name_en)}
        ${item.name_zh && item.name_en ? `<i class="en">${esc(item.name_en)}</i>` : ""}
      </span>
      <input class="inp num qty" data-qty="${esc(li.id)}" type="text" inputmode="decimal"
             value="${esc(String(li.qty))}" style="max-width:4.5em"
             aria-label="${plain("qty")}">
      <span class="v" style="margin-left:0;flex:none;width:2.2em;text-align:left">${esc(unitLabel)}</span>
      <button class="icon-btn" data-remove="${esc(li.id)}" aria-label="${plain("delete")}">✕</button>
    </div>`;
  }).join("");

  return `<section class="basket-panel">
    <div class="section-head">
      <h2>🧺 ${esc(zh("total"))}</h2>
      <span class="more num">${lines.length} 項</span>
      <button class="linkbtn" data-act="clear-basket">${bi1("clear")}</button>
    </div>

    ${groups.map(({ group, results, useLines, common }) => `
      <div class="grouphead">${group.icon} ${esc(group.zh)}

        <span class="num">${state.commonOnly && common.length
          ? `${common.length} 項共同` : `${useLines.length} 項`}</span></div>
      <div class="rank">${results.map((r, i) => basketRowHtml(r, i === 0)).join("")}</div>`).join("")}

    ${canCommon ? `<div class="storebar" style="border-bottom:0;padding-top:10px">
      <button class="chip${state.commonOnly ? " on" : ""}" data-act="common">
        ${bi1("commonOnly")}</button></div>` : ""}

    <details class="basket-lines">
      <summary>調整份量（${lines.length}）</summary>
      <div class="rows" data-lines>${rows}</div>
    </details>

    ${groups.length ? "" : `<p class="note">選到的品項還沒有任何價格紀錄
</p>`}
  </section>`;
}

function basketRowHtml(r, isBest) {
  const missingNames = r.missing.slice(0, 3).map((i) => i.name_zh || i.name_en).join("、");
  const more = r.missing.length > 3 ? ` 等 ${r.missing.length} 項` : "";

  return `<div class="rankrow${isBest ? " best" : ""}${r.stale ? " stale" : ""}">
    ${storeBadge(r.store)}
    <span class="body">
      <span class="store">${esc(r.store.name)}${isBest ? `<span class="tag win">${esc(zh("cheapest"))}</span>` : ""}</span>
      <span class="detail">${esc(zh("covered"))} ${r.covered} / ${r.total}
${r.stale ? ` · <span class="tag old">${esc(zh("stale"))}</span>` : ""}</span>
      ${r.missing.length ? `<span class="detail">${esc(zh("missing"))}：${esc(missingNames)}${esc(more)}</span>` : ""}
    </span>
    <span class="fig">
      <span class="a num">${esc(u.formatPence(r.pence, { alwaysPounds: true }))}</span>
      <span class="b num">${esc(twd(r.pence, { prefix: "≈ " }))}</span>
      ${r.missing.length ? `<span class="b">不含缺項</span>` : ""}
    </span>
  </div>`;
}

// 紀錄：所有價格觀測，最新在上面。
//
// 沒有這一頁的話，要修一筆打錯的價格得先想起它是哪個品項、點進去、再往下捲 ——
// 但你通常只記得「剛剛那筆」。
function renderHistory() {
  const rows = [];
  for (const price of state.prices) {
    const product = productById(price.product_id);
    const item = product ? itemById(product.item_id) : null;
    if (!product || !item) continue;
    rows.push({ price, product, item });
  }
  rows.sort((a, b) => (a.price.observed_on === b.price.observed_on
    ? (a.price.created_at < b.price.created_at ? 1 : -1)
    : (a.price.observed_on < b.price.observed_on ? 1 : -1)));

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.price.observed_on)) byDate.set(r.price.observed_on, []);
    byDate.get(r.price.observed_on).push(r);
  }

  return `
    <div class="topbar"><div class="topbar-inner">
      <button class="icon-btn back" data-act="history-back" aria-label="返回設定">‹</button>
      <h1>所有紀錄</h1><div class="spacer"></div>${syncBadge()}
    </div></div>
    <main class="screen">
      ${rows.length ? [...byDate.entries()].map(([date, group]) => `
        <div class="section-head"><h2>${esc(date)}
          <i class="en">${esc(u.freshness(date).label)}</i></h2>
          <span class="more num">${group.length}</span></div>
        <div class="rows">
          ${group.map(({ price, product, item }) => `
            <button class="row" data-price-id="${esc(price.id)}">
              <span class="swatch" style="width:3px;height:30px;border-radius:2px;background:${storeColor(product.store_id)};flex:none"></span>
              <span class="k" style="flex:1;min-width:0">
                ${esc(item.name_zh || item.name_en)}
                <i class="en">${esc(storeName(product.store_id))}${
                  product.size ? " · " + esc(u.formatSize(product.size, product.size_unit)) : ""}</i>
              </span>
              <span class="v num">${esc(u.formatPence(price.price_pence, { alwaysPounds: true }))}
                <i class="en">${esc(u.formatUnitPrice(u.unitPricePence(price.price_pence, product), item.base_unit))}${esc(twd(price.price_pence))}</i></span>
            </button>`).join("")}
        </div>`).join("") : `<div class="empty"><div class="big">🧾</div>
        <p>還沒有任何價格紀錄</p></div>`}
    </main>
    ${tabbar()}`;
}

// ---------------------------------------------------------------- 以店家看
//
// 「這東西哪家便宜」是首頁在回答的。這一頁回答的是相反方向的問題：
// **我人在 Aldi，這裡有什麼東西值得買？**
//
// 判斷「值得買」的標準是：在所有有賣它的店裡是不是最便宜的、便宜多少。
// 跟品項明細用同一套排行，兩頁的「最便宜」才不會互相矛盾。

function storeReport(storeId) {
  const wins = [];
  const only = [];
  const loses = [];
  let newest = "";

  for (const item of state.items) {
    // 跟品項明細同一套：所有有賣的店一起比。這裡如果還分組，
    // 櫛瓜在品項明細說 Fulham Greens 最便宜、店家頁卻說 Baleys 贏，兩頁會打架。
    const rank = rankItem(item.id);
    const mine = rank.find((r) => r.store.id === storeId);
    if (!mine) continue;
    if (mine.price.observed_on > newest) newest = mine.price.observed_on;

    const isBest = rank[0].store.id === storeId;
    // 贏的時候跟第二名比（省多少），輸的時候跟第一名比（貴多少）
    const rival = isBest ? rank[1] : rank[0];

    if (!rival) { only.push({ item, mine }); continue; }
    const pct = ((mine.unit - rival.unit) / rival.unit) * 100;
    (isBest ? wins : loses).push({ item, mine, rival, pct });
  }

  wins.sort((a, b) => a.pct - b.pct);        // 省最多的排前面（pct 是負的）
  loses.sort((a, b) => b.pct - a.pct);       // 貴最多的排前面
  only.sort((a, b) => (a.item.name_zh || "").localeCompare(b.item.name_zh || "", "zh-Hant"));

  return { wins, only, loses, newest, total: wins.length + only.length + loses.length };
}

// 卡片本身就要回答「這家店買什麼划算」，不能只給一個數字叫人點進去 ——
// 站在店門口滑手機的時候，多按一下就是多一次分心。
// 所以直接把最划算的前三樣攤在卡片上，含省多少。
const CARD_WINS = 3;

function storeCardHtml(store, report) {
  const fresh = report.newest ? u.freshness(report.newest) : null;
  const shown = report.wins.slice(0, CARD_WINS);
  const more = report.wins.length - shown.length;

  const winLine = (w) => `<span class="win">
    <span class="ic">${itemEmoji(w.item)}</span>
    <span class="nm">${esc(w.item.name_zh || w.item.name_en)}
      ${w.item.name_zh && w.item.name_en ? `<i class="en">${esc(w.item.name_en)}</i>` : ""}</span>
    <span class="up num">${esc(u.formatUnitPrice(w.mine.unit, w.item.base_unit))}</span>
    <span class="delta save">省 ${Math.round(Math.abs(w.pct))}%</span>
  </span>`;

  const foot = [
    more > 0 ? `還有 ${more} 樣` : null,
    `${report.total} 樣有紀錄`,
    fresh ? fresh.label : null,
  ].filter(Boolean).join(" · ");

  return `<button class="storecard${shown.length ? " has-wins" : ""}"
      data-focus-store="${esc(store.id)}" style="--c:${store.color}">
    <span class="sc-head">
      ${storeBadge(store)}<span class="sc-name">${esc(store.name)}</span>
      ${shown.length
        ? `<span class="sc-badge">${report.wins.length} 樣最便宜</span>`
        : `<span class="sc-badge muted">沒有最便宜的</span>`}
    </span>

    ${shown.length ? `<span class="sc-wins">${shown.map(winLine).join("")}</span>` : `
      <span class="sc-none">這裡的東西別家都更便宜，或還沒有對照組
</span>`}

    <span class="sc-foot">${esc(foot)}</span>
  </button>`;
}

// 有紀錄的店，照分組排：同組裡贏最多的在前。店家頁的總覽與上方切換列共用這個順序。
function storesWithReports() {
  const reports = new Map();
  for (const st of allStores()) {
    const r = storeReport(st.id);
    if (r.total) reports.set(st.id, r);
  }
  const groups = GROUPS.map((g) => ({
    group: g,
    stores: allStores()
      .filter((s) => s.group === g.id && reports.has(s.id))
      .sort((a, b) => reports.get(b.id).wins.length - reports.get(a.id).wins.length
        || reports.get(b.id).total - reports.get(a.id).total),
  })).filter((g) => g.stores.length);
  return { reports, groups };
}

// 店家頁有兩種狀態：
//   總覽     —— 每家店最划算的幾樣攤在卡片上；一樣都沒贏的店縮成一行
//   展開一家 —— 上方切換列點一家，就在同一頁攤開它的完整清單
//
// 為什麼不再開一層面板：站在店門口的情境是「我人在這家店」，一點就要看到，
// 而且要能直接換到隔壁那家比。面板開了要關、關了再找，多一層就多一次分心。
function renderStores() {
  const { reports, groups } = storesWithReports();
  const focus = state.storeFocus && reports.has(state.storeFocus) ? state.storeFocus : null;

  // 切換店家的那一排放在底部、貼著選單列：單手拿手機時大拇指搆得到
  const chips = groups.length ? `<div class="storebar storefocus" role="tablist">
    <button class="chip${focus ? "" : " on"}" data-focus-store="" role="tab"
      aria-selected="${!focus}">全部</button>
    ${groups.flatMap(({ stores }) => stores).map((st) => `
      <button class="chip${focus === st.id ? " on" : ""}" data-focus-store="${esc(st.id)}" role="tab"
        aria-selected="${focus === st.id}">
        ${storeBadge(st, "sm")}${esc(st.name)}</button>`).join("")}
  </div>` : "";

  const body = !groups.length ? `<div class="empty"><div class="big">🏬</div>
      <p>還沒有任何價格紀錄<br>記幾筆之後，這裡會告訴你<br>每一家店有什麼東西最便宜</p></div>`
    : focus ? storeDetailHtml(focus, reports.get(focus))
    : storesOverviewHtml(groups, reports);

  return `
    ${topbar("storesTab")}
    <main class="screen${chips ? " has-dock" : ""}">${body}</main>
    ${chips ? `<div class="storedock">${chips}</div>` : ""}
    ${tabbar()}`;
}

function storesOverviewHtml(groups, reports) {
  return groups.map(({ group, stores }) => {
    // 有贏的才值得一整張卡；一樣都沒贏的店，卡片上只會寫「沒有」，
    // 佔一整塊只是讓你多滑幾下。縮成一行，要看再點。
    const winners = stores.filter((st) => reports.get(st.id).wins.length);
    const others = stores.filter((st) => !reports.get(st.id).wins.length);
    return `
      <div class="section-head"><h2>${group.icon} ${esc(group.zh)}
</h2>
        <span class="more num">${stores.length}</span></div>
      ${winners.length ? `<div class="storelist">
        ${winners.map((st) => storeCardHtml(st, reports.get(st.id))).join("")}</div>` : ""}
      ${others.length ? `
        <div class="storemini-head">${winners.length ? "其他店家 · " : ""}目前沒有最便宜的
</div>
        <div class="storemini-list">${others.map((st) => storeMiniHtml(st, reports.get(st.id))).join("")}</div>` : ""}`;
  }).join("");
}

function storeMiniHtml(store, report) {
  const fresh = report.newest ? u.freshness(report.newest) : null;
  return `<button class="storemini" data-focus-store="${esc(store.id)}" style="--c:${store.color}">
    ${storeBadge(store, "sm")}<span class="sm-name">${esc(store.name)}</span>
    <span class="sm-meta">${report.total} 樣有紀錄${fresh ? " · " + esc(fresh.label) : ""}</span>
    <span class="sm-go" aria-hidden="true">›</span>
  </button>`;
}

// 「在這裡順手拍」：同組別家記過、這家還沒記的品項。
//
// 比價要成立，同一樣東西至少要有兩家的價格。正式資料裡 19 樣只有 5 樣做得到，
// 另外 12 樣只在一家記過 —— 不是你不想比，是站在店裡的時候想不起來該拍什麼。
// 所以直接列給你，點一下就開記價、品項和店家都帶好。
//
// 排序：目前只有一家有紀錄的排前面（補這一張就從「比不了」變成「比得了」），
// 同樣條件再照最近碰過排。
function snapCandidates(storeId) {
  const group = storeGroup(storeId);
  const recent = recentMap();
  const out = [];
  for (const item of state.items) {
    const rank = rankItem(item.id);
    if (rank.some((r) => r.store.id === storeId)) continue;
    // 「這家可能有賣」用同組判斷（Aldi 不會有醬油）；顯示的家數與最低價用全部的排行，
    // 跟品項明細講的一致
    if (!rank.some((r) => r.store.group === group)) continue;
    out.push({ item, best: rank[0], stores: rank.length, at: recent.get(item.id) || "" });
  }
  out.sort((a, b) => (a.stores === 1) !== (b.stores === 1) ? (a.stores === 1 ? -1 : 1)
    : (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out;
}

const SNAP_SHOWN = 8;

function snapSectionHtml(storeId) {
  const list = snapCandidates(storeId);
  if (!list.length) return "";
  const shown = list.slice(0, SNAP_SHOWN);
  return `<div class="section-head"><h2>📸 在這裡順手拍
</h2><span class="more num">${list.length}</span></div>
    ${shown.map(({ item, best, stores }) => `
      <button class="itemrow snaprow" data-snap="${esc(item.id)}" style="width:100%">
        <span class="open" style="padding-left:18px">
          <span class="ic">${itemEmoji(item)}</span>
          <span class="body">
            <span class="nm">${esc(item.name_zh || item.name_en)}
              ${item.name_zh && item.name_en ? `<i class="en">${esc(item.name_en)}</i>` : ""}</span>
            <span class="meta">${stores === 1
              ? `只有 ${esc(best.store.name)} 記過，拍了就能比`
              : `${stores} 家記過，最便宜 ${esc(best.store.name)}`}</span>
          </span>
          <span class="best">
            <span class="up num">${esc(u.formatUnitPrice(best.unit, item.base_unit))}</span>
            <span class="who"><span class="delta only">＋ 記價</span></span>
          </span>
        </span>
      </button>`).join("")}
    ${list.length > shown.length ? `<p class="note" style="padding-bottom:4px">還有 ${list.length - shown.length} 樣</p>` : ""}`;
}

// 一家店的明細：這裡買什麼划算、什麼別買。
function storeDetailHtml(storeId, r) {
  const store = storeById(storeId);
  const g = groupById(store.group);
  const fresh = r.newest ? u.freshness(r.newest) : null;

  const line = (row, kind) => {
    const item = row.item;
    const pct = row.pct === undefined ? null : Math.round(Math.abs(row.pct));
    const badge = kind === "win"
      ? `<span class="delta save">省 ${pct}%</span>`
      : kind === "lose" ? `<span class="delta over">貴 ${pct}%</span>`
      : `<span class="delta only">只有這裡有</span>`;
    return `<button class="itemrow" data-item="${esc(item.id)}" style="width:100%">
      <span class="open" style="padding-left:18px">
        <span class="ic">${itemEmoji(item)}</span>
        <span class="body">
          <span class="nm">${esc(item.name_zh || item.name_en)}
            ${item.name_zh && item.name_en ? `<i class="en">${esc(item.name_en)}</i>` : ""}</span>
          <span class="meta">${esc(u.formatPence(row.mine.price.price_pence, { alwaysPounds: true }))}${
            esc(twd(row.mine.price.price_pence))}${
            row.rival ? ` · vs ${esc(row.rival.store.name)}` : ""}</span>
        </span>
        <span class="best">
          <span class="up num">${esc(u.formatUnitPrice(row.mine.unit, item.base_unit))}</span>
          <span class="who">${badge}</span>
        </span>
      </span>
    </button>`;
  };

  return `
    <section class="storehead" style="--c:${store.color}">
      <h2 class="sh-name">${storeBadge(store, "lg")}${esc(store.name)}</h2>
      <p class="sh-meta">${g.icon} ${esc(g.zh)}${
        fresh ? ` · 最近記價 ${esc(fresh.label)}` : ""}</p>
    </section>
    <div class="scoreline" style="--c:${store.color}">
      <div><span class="n num">${r.wins.length}</span><span class="l">最便宜</span></div>
      <div><span class="n num">${r.only.length}</span><span class="l">獨有</span></div>
      <div><span class="n num">${r.loses.length}</span><span class="l">較貴</span></div>
    </div>

    ${r.wins.length ? `<div class="section-head"><h2>🥇 這裡買最划算
</h2><span class="more num">${r.wins.length}</span></div>
      ${r.wins.map((x) => line(x, "win")).join("")}` : ""}

    ${snapSectionHtml(storeId)}

    ${r.only.length ? `<div class="section-head"><h2>🧭 只有這裡有紀錄
</h2><span class="more num">${r.only.length}</span></div>
      ${r.only.map((x) => line(x, "only")).join("")}` : ""}

    ${r.loses.length ? `<div class="section-head"><h2>💸 別在這裡買
</h2><span class="more num">${r.loses.length}</span></div>
      ${r.loses.map((x) => line(x, "lose")).join("")}` : ""}
`;
}

// 展開／收起某一家。第一次展開推一筆瀏覽紀錄，安卓的返回鍵才會回到總覽；
// 在店家之間切換不再推，不然看了五家要按五次返回。
function focusStore(id) {
  if (!id) {
    if (state.storeFocus) history.back();   // popstate 會負責清掉並重繪
    return;
  }
  if (!state.storeFocus) history.pushState({ storeFocus: true }, "");
  state.storeFocus = id;
  render();
  window.scrollTo(0, 0);
  app.querySelector(".storefocus .chip.on")?.scrollIntoView({ inline: "center", block: "nearest" });
}

function renderSettings() {
  const s = db.syncStatus;
  const lastSync = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString("zh-TW") : "—";

  return `
    ${topbar("settings")}
    <main class="screen">
      <div class="section-head"><h2>同步</h2></div>
      <div class="rows">
        <div class="row"><span class="k">狀態</span><span class="v">${syncBadge()}</span></div>
        <div class="row"><span class="k">上次同步</span><span class="v num">${esc(lastSync)}</span></div>
        <button class="row" data-act="sync"><span class="k">${bi1("syncNow")}</span><span class="v">›</span></button>
        <div class="row"><span class="k">待上傳照片</span><span class="v num" data-pending>—</span></div>
      </div>

      <div class="section-head"><h2>紀錄</h2></div>
      <div class="rows">
        <button class="row" data-act="open-history"><span class="k">🧾 所有紀錄</span>
          <span class="v">${state.prices.length} 筆，最新在上面 ›</span></button>
      </div>

      <div class="section-head"><h2>照片</h2></div>
      <div class="rows">
        <button class="row" data-act="batch"><span class="k">${bi1("batch")}</span>
          <span class="v">一次選多張，逐張確認 ›</span></button>
        ${queue.ids.length && queue.index < queue.ids.length ? `
          <button class="row" data-act="resume-batch">
            <span class="k" style="color:var(--accent-ink)">${bi1("resume")}</span>
            <span class="v">還剩 ${queue.ids.length - queue.index} 張 ›</span></button>
          <button class="row danger" data-act="drop-batch"><span class="k">放棄這批</span></button>` : ""}
      </div>

      <div class="section-head"><h2>品項</h2></div>
      <div class="rows">
        <button class="row" data-act="tidy">
          <span class="k">✨ ${bi1("tidy")}</span>
          <span class="v">用名稱重新判斷 ›</span></button>
      </div>

      <div class="section-head"><h2>${esc(zh("stores"))}</h2></div>
      <div class="rows">
        <button class="row" data-act="stores">
          <span class="k">🏪 ${bi1("stores")}</span>
          <span class="v">自訂 ${customStores().length} 家 ›</span></button>
      </div>

      <div class="section-head"><h2>台幣</h2></div>
      <div class="rows">
        <label class="row">
          <span class="k">${bi1("showTwd")}</span>
          <input class="chk" data-act="twd-toggle" type="checkbox"${state.showTwd ? " checked" : ""}>
        </label>
        <div class="row"><span class="k">${bi1("rate")}</span>
          <span class="v num" data-rate>—</span></div>
      </div>

      <div class="section-head"><h2>匯出</h2></div>
      <div class="rows">
        <button class="row" data-act="export-xlsx">
          <span class="k">📊 ${bi1("exportXlsx")}</span>
          <span class="v">三張工作表 ›</span></button>
        <button class="row" data-act="export-csv">
          <span class="k">📄 ${bi1("exportCsv")}</span>
          <span class="v">價格流水帳 ›</span></button>
      </div>

      <div class="section-head"><h2>標籤辨識</h2></div>
      <div class="rows">
        <div class="row"><span class="k">${bi1("model")}</span><span class="v num" data-model style="font-size:12px">—</span></div>
        <button class="row" data-act="bakeoff"><span class="k">${bi1("bakeoff")}</span>
          <span class="v">拿一張照片比三個模型 ›</span></button>
      </div>

      <div class="section-head"><h2>本機</h2></div>
      <div class="rows">
        <div class="row"><span class="k">照片快取</span><span class="v num" data-bytes>—</span></div>
        <button class="row" data-act="clear-photos"><span class="k">${bi1("clearCache")}</span>
          <span class="v">已上傳的才會刪 ›</span></button>
        <label class="row">
          <span class="k">${bi1("theme")}</span>
          <select class="sel" data-act="theme">
            <option value="auto">跟隨系統</option>
            <option value="light">淺色</option>
            <option value="dark">深色</option>
          </select>
        </label>
      </div>

      <div class="rows" style="margin-top:22px">
        <button class="row danger" data-act="logout"><span class="k">${bi1("logout")}</span></button>
      </div>

      <p class="note">
        ${esc(state.items.length)} 個品項 · ${esc(state.products.length)} 筆商品 · ${esc(state.prices.length)} 筆價格<br>
      </p>
    </main>
    ${tabbar()}`;
}

// ---------------------------------------------------------------- 模型比對
//
// Phase 0：決定要不要用 AI、用哪個模型。三個模型跑同一張照片，人肉比對誰準。

async function openBakeOff() {
  const el = sheet(bi("bakeoff"), `
    <div class="photo-slot" data-photo>
      <button class="photo-drop" data-act="pick-photo">
        <span style="font-size:22px">📷</span><span>選一張貨架標籤</span>
      </button>
    </div>
    <div data-results></div>
    <p class="note">
      同一張照片同時丟給三個 Workers AI 視覺模型，把它們讀出來的東西並排給你看。<br>
      對照實際標籤，看哪一個抓得準，再決定 App 預設用哪個 —— 或決定乾脆放棄 AI 只留手動輸入。<br>

    </p>`);

  el.querySelector("[data-photo]").onclick = async (e) => {
    if (!e.target.closest("[data-act='pick-photo']")) return;

    const file = await pickImage();
    if (!file) return;

    const slot = el.querySelector("[data-photo]");
    const results = el.querySelector("[data-results]");
    const { blob } = await shrink(file);
    const url = URL.createObjectURL(blob);

    slot.innerHTML = `<img src="${url}" alt="" style="width:100%;border-radius:var(--r);border:1px solid var(--line)">`;
    results.innerHTML = `<div class="empty"><p>三個模型跑中…</p></div>`;

    try {
      const res = await fetch("/api/extract/bakeoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: await blobToDataUri(blob) }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || res.status);
      results.innerHTML = bakeOffHtml(out.results);
    } catch (err) {
      results.innerHTML = `<div class="empty"><p style="color:var(--danger)">${esc(err.message)}</p></div>`;
    }
  };
}

function bakeOffHtml(results) {
  return Object.entries(results).map(([name, r]) => {
    const d = r.data;
    const body = r.ok && d ? `
      <div class="row"><span class="k">名稱</span><span class="v">${esc(d.name_en ?? "—")}</span></div>
      <div class="row"><span class="k">品牌</span><span class="v">${esc(d.brand ?? "自有品牌 own label")}</span></div>
      <div class="row"><span class="k">容量</span><span class="v num">${esc(u.formatSize(d.size, d.size_unit) || "—")}</span></div>
      <div class="row"><span class="k">價格</span><span class="v num" style="color:var(--accent-ink);font-weight:650">${esc(u.formatPence(d.price_pence, { alwaysPounds: true }))}</span></div>
      <div class="row"><span class="k">標籤單價</span><span class="v num">${esc(d.label_unit_price ?? "—")}</span></div>
      <div class="row"><span class="k">特價</span><span class="v">${d.is_promo ? esc(d.promo_note || "是 yes") : "—"}</span></div>`
      : `<div class="row"><span class="k" style="color:var(--danger)">${esc(r.error || "失敗")}</span></div>
         ${r.raw ? `<div class="row block"><span class="k" style="font-size:12px;color:var(--faint);word-break:break-all">${esc(r.raw)}</span></div>` : ""}`;

    return `
      <div class="section-head">
        <h2>${esc(name)} <i class="en">${esc(r.model)}</i></h2>
        <span class="more num">${r.ms}ms</span>
      </div>
      <div class="rows">${body}</div>`;
  }).join("");
}

// ---------------------------------------------------------------- 繪製與事件

function render() {
  const html = {
    compare: renderCompare,
    stores: renderStores,
    history: renderHistory,
    settings: renderSettings,
  }[state.route]();

  const scroll = app.querySelector(".screen")?.scrollTop;
  app.innerHTML = html;
  if (scroll) app.querySelector(".screen").scrollTop = scroll;

  bindScreen();
  syncCatDock();
}

function bindScreen() {
  app.querySelector("[data-q]")?.addEventListener("input", (e) => {
    state.query = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const next = app.querySelector("[data-q]");
    next.focus();
    next.setSelectionRange(pos, pos);
  });

  if (state.route === "settings") fillSettingsAsync();

  app.querySelector("[data-lines]")?.addEventListener("change", async (e) => {
    const input = e.target.closest("[data-qty]");
    if (!input) return;
    const li = state.list_items.find((r) => r.id === input.dataset.qty);
    const qty = Number(input.value);
    if (!li || !Number.isFinite(qty) || qty <= 0) return render();
    await db.put("list_items", { ...li, qty });
    await refresh();
  });
}

async function fillSettingsAsync() {
  const pending = app.querySelector("[data-pending]");
  const bytes = app.querySelector("[data-bytes]");
  const model = app.querySelector("[data-model]");
  const theme = app.querySelector("[data-act='theme']");

  const rateEl = app.querySelector("[data-rate]");
  if (rateEl) {
    const cached = await db.getMeta("fx_gbp_twd", null);
    rateEl.textContent = cached && cached.rate
      ? `1 GBP = ${cached.rate.toFixed(2)} TWD` + (cached.date ? `（${cached.date}）` : "")
      : "還沒拿到 not fetched yet";
  }

  if (theme) theme.value = localStorage.getItem("theme") || "auto";
  if (pending) pending.textContent = String(await db.pendingPhotoCount());
  if (bytes) {
    const n = await db.localPhotoBytes();
    bytes.textContent = n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
  }
  if (model) {
    try {
      const res = await fetch("/api/models");
      const out = await res.json();
      model.textContent = out.ai ? String(out.current).replace(/^@cf\//, "") : "此環境沒有 AI binding";
    } catch { model.textContent = "—"; }
  }
}

// iPhone 的 Safari 沒有任何 touchstart 監聽時，:active 樣式不會出現 ——
// 按下去完全沒回饋，安卓則正常。掛一個空的就好。
document.addEventListener("touchstart", () => {}, { passive: true });

// 全域委派。畫面重繪很頻繁，每次都重綁事件太容易漏。
document.addEventListener("click", async (e) => {
  const routeBtn = e.target.closest("[data-route]");
  if (routeBtn) {
    goRoute(routeBtn.dataset.route);
    return;
  }

  const jump = e.target.closest("[data-jump]");
  if (jump) { jumpToCategory(jump.dataset.jump); return; }

  const sortBtn = e.target.closest("[data-home-sort]");
  if (sortBtn) {
    state.homeSort = sortBtn.dataset.homeSort;
    state.homeOrder = null;
    db.setMeta("home_sort", state.homeSort);
    render();
    return;
  }

  const act = e.target.closest("[data-act]")?.dataset.act;

  if (act === "add") { openRecordMenu(); return; }
  // 「紀錄」很少用，從底部選單移進設定。多推一層，返回鍵回到設定而不是首頁
  if (act === "open-history") {
    history.pushState({ sub: true }, "");
    subEntry = true;
    state.route = "history";
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (act === "history-back") { history.back(); return; }
  if (act === "batch") { openBatchImport(); return; }
  if (act === "resume-batch") { nextInQueue(); return; }
  if (act === "drop-batch") {
    // 照片本身留著（在 photos 表裡），只是不再逐張問你。要用隨時可以再挑。
    await clearQueue();
    render();
    toast("已放棄這批，照片還在本機");
    return;
  }
  if (act === "new-item") { openItemEditor(null, () => refresh()); return; }
  if (act === "common") { state.commonOnly = !state.commonOnly; render(); return; }
  if (act === "bakeoff") { openBakeOff(); return; }

  if (act === "stores") { openStoreList(); return; }
  if (act === "tidy") { openTidy(); return; }

  // 順手拍：品項跟店家都帶好，直接開記價
  const snap = e.target.closest("[data-snap]");
  if (snap && app.contains(snap)) { openRecord({ itemId: snap.dataset.snap, storeId: state.storeFocus }); return; }

  const focus = e.target.closest("[data-focus-store]");
  if (focus && app.contains(focus)) { focusStore(focus.dataset.focusStore); return; }
  if (act === "clear-basket") { await clearSelected(); return; }
  if (act === "sync") { await db.sync(); render(); toast("同步完成"); return; }

  if (act === "export-xlsx" || act === "export-csv") {
    if (!state.prices.length) return toast("還沒有資料可以匯出", { warn: true });

    // 比價邏輯用傳的，不要在 export.js 裡重寫一份 ——
    // 匯出的數字跟畫面上不一樣是最難發現的 bug
    const ctx = { items: state.items, products: state.products, prices: state.prices, rankItem };
    const all = xport.sheets(ctx);

    if (act === "export-xlsx") {
      xport.download(xport.xlsxBlob(all), `price-check-${xport.stamp()}.xlsx`);
      toast(`已匯出 ${all.length} 張工作表`);
    } else {
      const prices = all.find((s) => s.name.startsWith("價格紀錄"));
      xport.download(xport.csvBlob(prices), `price-check-${xport.stamp()}.csv`);
      toast(`已匯出 ${prices.rows.length} 筆價格`);
    }
    return;
  }

  if (act === "clear-photos") {
    const n = await db.clearUploadedPhotos();
    render();
    toast(`已清除 ${n} 張本機照片 Cleared ${n} local photos`);
    return;
  }

  if (act === "logout") {
    await fetch("/api/logout", { method: "POST" });
    location.reload();
    return;
  }

  // 紀錄頁的每一列直接開編輯（品項明細裡的那些由面板自己處理）
  const priceRow = e.target.closest("[data-price-id]");
  if (priceRow && app.contains(priceRow)) { openRecord({ editPriceId: priceRow.dataset.priceId }); return; }

  const remove = e.target.closest("[data-remove]");
  if (remove) {
    const li = state.list_items.find((r) => r.id === remove.dataset.remove);
    await db.remove("list_items", remove.dataset.remove);
    await refresh();
    toast("已從清單移除", {
      action: async () => { await db.put("list_items", { ...li, deleted_at: null }); await refresh(); },
    });
    return;
  }

  // 品項列：清單頁與選單裡的不算，那兩個地方有自己的處理
  const itemBtn = e.target.closest("[data-item]");
  if (itemBtn && app.contains(itemBtn)) { openItemDetail(itemBtn.dataset.item); }
});

document.addEventListener("change", async (e) => {
  if (e.target.dataset && e.target.dataset.act === "twd-toggle") {
    state.showTwd = e.target.checked;
    await db.setMeta("show_twd", state.showTwd ? 1 : 0);
    render();
    return;
  }
  if (e.target.dataset && e.target.dataset.act === "theme") {
    const v = e.target.value;
    localStorage.setItem("theme", v);
    if (v === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", v);
  }
});

async function refresh() {
  await reload();
  // 同步可能帶回了新的匯率（db.js 寫進 meta），這裡接上去。
  // 放在 refresh 而不是 sync 裡面，是因為只有畫面在乎它。
  const cached = await db.getMeta("fx_gbp_twd", null);
  if (cached) fx.setRate(cached.rate, cached.date);
  render();
}

// ---------------------------------------------------------------- 登入

function renderLogin(message = "") {
  app.innerHTML = `
    <div class="login">
      <div class="mark">🛒</div>
      <h1>${bi("app")}</h1>
      <p>英國超市比價<br></p>
      <input type="password" data-pw placeholder="${plain("password")}" autocomplete="current-password">
      <p class="err" data-err>${esc(message)}</p>
      <button data-go>${bi1("login")}</button>
    </div>`;

  const pw = app.querySelector("[data-pw]");
  const go = app.querySelector("[data-go]");
  const err = app.querySelector("[data-err]");

  const submit = async () => {
    if (!pw.value) return;
    go.disabled = true;
    err.textContent = "";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw.value }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || "登入失敗");
      await start();
    } catch (e2) {
      err.textContent = e2.message;
      go.disabled = false;
      pw.select();
    }
  };

  go.onclick = submit;
  pw.onkeydown = (e) => { if (e.key === "Enter") submit(); };
  setTimeout(() => pw.focus(), 60);
}

// ---------------------------------------------------------------- 啟動

async function start() {
  await db.seedIfEmpty();
  // 記住「這台裝置登入過」。下次連不上伺服器時，靠它決定要不要直接進去，
  // 而不是把人擋在登入畫面外（見 boot()）。
  await db.setMeta("signed_in", 1);
  state.lastStore = await db.getMeta("last_store", "sainsburys");
  state.showTwd = (await db.getMeta("show_twd", 1)) ? true : false;
  state.homeSort = await db.getMeta("home_sort", "cat");

  // 先用上次快取的匯率把畫面畫出來，不要等網路。
  // 同步回來如果有新的，db.js 會寫回 meta，下面那個 onChange 再更新。
  const cachedFx = await db.getMeta("fx_gbp_twd", null);
  if (cachedFx) fx.setRate(cachedFx.rate, cachedFx.date);

  await loadQueue();
  await reload();
  state.ready = true;
  render();
  db.sync().catch(() => {});

  // 上次批次匯入沒走完（手機切掉、App 被回收都會這樣），主動提一下再繼續
  const left = queue.ids.length - queue.index;
  if (left > 0) {
    toast(`還有 ${left} 張照片沒處理 ${left} photos left`, {
      action: () => nextInQueue(),
      actionLabel: zh("resume"),
      ms: 9000,
    });
  }
}

async function boot() {
  const theme = localStorage.getItem("theme");
  if (theme && theme !== "auto") document.documentElement.setAttribute("data-theme", theme);

  db.onChange((detail) => {
    if (detail.type === "unauthed") { renderLogin("請重新登入"); return; }
    if (!state.ready) return;
    // 背景同步完成剛好撞上你正在打字時，重繪會把游標吃掉。搜尋框有焦點就先不畫。
    if (document.activeElement?.matches?.("[data-q], .sheet input, .sheet select")) return;
    if (detail.type === "data" || detail.type === "sync-status") refresh();
  });

  // 離線也要能開。
  //
  // 不要用 navigator.onLine 判斷：超市地下室最常見的狀況是「連得上 Wi-Fi
  // 但出不去」，這時 onLine 是 true、fetch 卻直接失敗，人就被鎖在登入畫面外，
  // 偏偏那正是最需要記價的時候。改用「這台裝置上次成功登入過」。
  // Cookie 真的失效的話，背景同步會回 401，那時再要求重新登入。
  let authed = false;
  try {
    const res = await fetch("/api/session");
    authed = (await res.json()).authed;
    await db.setMeta("signed_in", authed ? 1 : 0);
  } catch {
    authed = !!(await db.getMeta("signed_in", 0));
  }

  if (authed) await start();
  else renderLogin();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

boot();
