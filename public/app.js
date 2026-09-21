// 畫面與互動。單一檔案，照區塊註解分段。
//
// 全 App 只有一條資料流：IndexedDB → state → 重繪。寫入只走 db.put()，
// 它自己會排隊同步。畫面永遠不等網路。

import * as db from "./db.js";
import * as u from "./units.js";
import { GROUPS, PALETTE, normGroup, allStores, customStores, setCustomStores,
         storeById, storeName, storeColor, storeGroup, storesOfGroup, groupById } from "./stores.js";
import { bi, bi1, biText, zh, en, plain, CATEGORIES, category } from "./i18n.js";
import * as xport from "./export.js";
import * as fx from "./fx.js";
import { EMOJI_GROUPS, guess, guessEmoji, guessCategory } from "./emoji.js";

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
  listId: db.DEFAULT_LIST_ID,
  showTwd: true,
  query: "",
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
    if (hit) rows.push({ store: s, ...hit, fresh: u.freshness(hit.price.observed_on) });
  }
  rows.sort((a, b) => a.unit - b.unit);
  return rows;
}

// 依組別切開的排行。
//
// 為什麼不混在一起排：一般超市與亞洲超市不是同一個貨架上的競爭關係。
// 醬油在 Aldi 買不到，牛奶你也不會特地去 Tian Tian 買。混排會得到
// 「Tian Tian 的米比 Aldi 貴」這種正確但沒有用的結論。
function rankByGroup(itemId) {
  const all = rankItem(itemId);
  return GROUPS
    .map((g) => ({ group: g, rows: all.filter((r) => r.store.group === g.id) }))
    .filter((g) => g.rows.length);
}

// 品項最後一次被記到價格是什麼時候，用來排「最近在看的東西」
function lastSeenOf(itemId) {
  let latest = "";
  for (const p of productsOfItem(itemId)) {
    for (const pr of state.prices) {
      if (pr.product_id === p.id && pr.observed_on > latest) latest = pr.observed_on;
    }
  }
  return latest;
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

// 品項圖示：自己挑的 → 名稱猜的 → 分類的。
//
// 分類只有十幾個但你買的東西有幾百種，一對一永遠對不上 ——
// 「蘋果」跟「青江菜」都是蔬果，但不該長一樣。
const itemEmoji = (item) => !item ? "•"
  : item.emoji || guessEmoji(item.name_zh, item.name_en) || category(item.category)[3];

// ---------------------------------------------------------------- 資料載入

async function reload() {
  const [stores, items, products, prices, photos, lists, list_items] = await Promise.all(
    ["stores", "items", "products", "prices", "photos", "lists", "list_items"].map((t) => db.getAll(t))
  );
  Object.assign(state, { stores, items, products, prices, photos, lists, list_items });

  // stores.js 是同步的（畫面到處都在呼叫 storeName），所以自訂店家要先推進去，
  // 之後任何 render 才查得到名字與顏色
  setCustomStores(stores);

  if (!state.lists.some((l) => l.id === state.listId)) {
    state.listId = state.lists.length ? state.lists[0].id : db.DEFAULT_LIST_ID;
  }
}

// ---------------------------------------------------------------- 提示條

let toastTimer = null;

function toast(message, { action = null, actionLabel = "復原 Undo", warn = false, ms = 5000 } = {}) {
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

function sheet(titleHtml, bodyHtml, { saveLabel = null, extraHead = "" } = {}) {
  const el = document.createElement("div");
  el.className = "sheet";
  el.innerHTML = `
    <div class="sheet-head">
      <button class="x" data-close aria-label="${plain("close")}">✕</button>
      <h2>${titleHtml}</h2>
      <div class="spacer"></div>
      ${extraHead}
      ${saveLabel ? `<button class="go" data-save>${saveLabel}</button>` : ""}
    </div>
    <div class="sheet-body">${bodyHtml}</div>`;
  document.body.appendChild(el);

  el.querySelector("[data-close]").onclick = () => closeSheet(el);
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

window.addEventListener("popstate", () => {
  if (pendingBacks > 0) { pendingBacks -= 1; return; }
  const el = openSheets.pop();
  if (el) el.remove();
});

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
    if (n) toast(`批次匯入完成，共 ${n} 張 Batch import done`);
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
    progress.innerHTML = `處理第 ${i + 1} / ${files.length} 張<br><i class="en">Processing ${i + 1} of ${files.length}</i>`;
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

  if (!ids.length) return toast("這些檔案都讀不進來 Could not read any of these", { warn: true });

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
      ? `<span class="bi"><b>${esc(zh("record"))} ${queue.index + 1}/${queue.ids.length}</b><i>${esc(en("batch"))}</i></span>`
      : bi("record");

  const el = sheet(title, recordBody(draft), {
    saveLabel: bi1("save"),
    extraHead: fromQueue ? `<button class="btn-small" data-skip>${bi1("skip")}</button>` : "",
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

function unitOptions(draft) {
  const item = draft.item_id ? itemById(draft.item_id) : null;
  // 選了品項就只給同一個基準的單位。
  // 讓「全脂牛奶」底下冒出一筆 500g 的商品，比價立刻就壞掉了。
  const allowed = !item ? u.SIZE_UNITS
    : item.base_unit === "ml" ? ["ml", "l"]
    : item.base_unit === "each" ? ["each"]
    : ["g", "kg"];

  return allowed.map((x) =>
    `<option value="${x}"${draft.size_unit === x ? " selected" : ""}>${x === "each" ? "個 each" : x}</option>`
  ).join("");
}

// 抽出來是為了「當場新增店家」之後可以只重畫這一塊，不用整張表單重建
// （重建會把使用者已經打好的價格、容量全部弄丟）。
function storeGroupsHtml(draft) {
  // 每一組各自一列。亞洲超市或小店混在 12 家英國連鎖後面的話，每次都要橫捲到底才找得到。
  return GROUPS.map((g) => `
    <div class="storegroup">
      <span class="storegroup-label">${g.icon} ${esc(g.zh)} <i class="en">${esc(g.en)}</i></span>
      <div class="storebar" data-storebar>
        ${storesOfGroup(g.id).map((s) =>
          `<button class="chip${draft.store_id === s.id ? " on" : ""}" data-store="${s.id}">
             <span class="dot" style="background:${s.color}"></span>${esc(s.name)}</button>`).join("")}
        <button class="chip ghost" data-new-store="${g.id}"
          aria-label="${plain("newStore")}">＋</button>
      </div>
    </div>`).join("");
}

function recordBody(draft) {
  const item = draft.item_id ? itemById(draft.item_id) : null;

  return `
    <div class="storegroups">${storeGroupsHtml(draft)}</div>

    <div class="photo-slot" data-photo>
      <div class="photo-sources">
        <button class="photo-drop" data-act="take-photo">
          <span class="ic">📷</span><span>${bi1("takePhoto")}</span>
        </button>
        <button class="photo-drop" data-act="choose-photo">
          <span class="ic">🖼</span><span>${bi1("choosePhoto")}</span>
        </button>
      </div>
      ${draft._fromQueue ? "" : `<button class="btn-small batch-link" data-act="batch">
        📚 ${bi1("batch")}</button>`}
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

      <div class="row">
        <span class="k">${bi1("size")}</span>
        <input class="inp num" data-f="size" type="text" inputmode="decimal" placeholder="2"
               style="max-width:5.5em" value="${esc(draft.size)}">
        <select class="sel" data-f="size_unit" style="max-width:6em">${unitOptions(draft)}</select>
      </div>

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
    </div>

    <p class="note">
      <b>沒填容量也存得起來</b> Size can be left blank —— 但沒有容量就算不出單價，
      這筆就只會出現在紀錄裡，不會參與比價。<br>
      Without a size we cannot work out a unit price, so it will not join the comparison.
      ${draft._editId ? `<br><br><b>改容量會連帶修正單價</b> —— 這筆紀錄會重新掛到符合新規格的商品底下，
      同一家店同一個容量的其他紀錄不受影響。<br>
      <i class="en">Changing the size re-files this observation under the matching product.</i>` : ""}
    </p>

    ${draft._editId ? `
      <div class="rows">
        ${draft.label_unit_price ? `<div class="row"><span class="k">標籤上寫 <i class="en">On the label</i></span>
          <span class="v num">${esc(draft.label_unit_price)}</span></div>` : ""}
        <div class="row"><span class="k">來源 <i class="en">Source</i></span>
          <span class="v">${draft.source === "ai" ? "AI 辨識 + 人工確認" : "手動輸入 manual"}</span></div>
      </div>
      <div class="rows"><button class="row danger" data-del-price>
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

    if (pence === null) { hint.textContent = ""; return; }
    const money = esc(u.formatPence(pence)) + `<i class="en">${esc(twd(pence))}</i>`;
    if (!size || !item) { hint.innerHTML = `<span style="color:var(--faint)">${money}</span>`; return; }

    const unit = pence / size;
    hint.innerHTML = `${money} · <b>${esc(u.formatUnitPrice(unit, item.base_unit))}</b>`;
  };

  priceInput.oninput = refreshHint;

  // 只在「欄位還是自動帶入的、或本來就空的」時候才重新帶入。
  // 你自己打過的東西，不該因為多按一下店家就被蓋掉。
  const canPrefill = () => draft.item_id && (draft._prefilled || (!draft.name_en && !draft.size));

  // 店家 chip（每一組共用同一個處理，所以綁在外層容器上）
  body.querySelector(".storegroups").onclick = (e) => {
    const btn = e.target.closest("[data-store]");
    if (!btn) return;
    draft.store_id = btn.dataset.store;
    state.lastStore = draft.store_id;
    db.setMeta("last_store", draft.store_id);
    body.querySelectorAll("[data-store]").forEach((b) => b.classList.toggle("on", b.dataset.store === draft.store_id));

    // 換店家也要重帶規格。少了這一步，「先選店再選品項」就會存出一筆
    // 沒有容量的商品，算不出單價，比價時直接消失。
    if (canPrefill()) { prefillFromLast(draft); syncProductFields(body, draft); }
    refreshHint();
    buzz();
  };

  // 站在一家清單裡沒有的小店，當場加。存完直接選中它，不用再找一次。
  body.querySelector(".storegroups").addEventListener("click", (e) => {
    const add = e.target.closest("[data-new-store]");
    if (!add) return;
    e.stopPropagation();
    openStoreEditor(null, async (saved) => {
      draft.store_id = saved.id;
      state.lastStore = saved.id;
      await db.setMeta("last_store", saved.id);
      body.querySelector(".storegroups").innerHTML = storeGroupsHtml(draft);
      refreshHint();
    }, add.dataset.newStore);
  });

  // 一般欄位
  body.querySelectorAll("[data-f]").forEach((input) => {
    const key = input.dataset.f;
    const handler = () => {
      draft[key] = input.type === "checkbox" ? input.checked : input.value;
      // 一旦動手改過商品欄位，就不再自動覆蓋
      if (["name_en", "brand", "size", "size_unit"].includes(key)) draft._prefilled = false;
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
    if (e.target.closest("[data-act='batch']"))        { closeSheet(el); openBatchImport(); }
  };

  el.querySelector("[data-skip]")?.addEventListener("click", () => skipQueued(el));

  body.querySelector("[data-del-price]")?.addEventListener("click", async () => {
    await deletePrice(draft._editId);
    closeSheet(el);
    await refresh();
    toast("已刪除 Deleted");
  });

  el.querySelector("[data-save]").onclick = async () => {
    draft.price_text = priceInput.value;
    await saveRecord(el, draft);
  };

  draft.size_unit = body.querySelector("[data-f='size_unit']").value;
  refreshHint();
  setTimeout(() => priceInput.focus(), 60);
}

async function attachPhoto(el, draft, refreshHint, { camera = false } = {}) {
  const file = await pickImage({ camera });
  if (!file) return;

  const slot = el.querySelector("[data-photo]");
  slot.innerHTML = `<div class="ai-note">處理中… Processing…</div>`;

  try {
    const { blob, width, height } = await shrink(file);
    const id = db.uuid();
    await db.savePhotoBlob(id, blob);
    await db.put("photos", {
      id, r2_key: `labels/${id}.jpg`, store_id: draft.store_id,
      taken_at: new Date().toISOString(), width, height,
    });

    draft.photo_id = id;
    draft._blobUrl = URL.createObjectURL(blob);
    renderPhotoSlot(el, draft);
    refreshHint();
  } catch (err) {
    slot.innerHTML = `<div class="ai-note warn">照片處理失敗 ${esc(err.message)}</div>`;
  }
}

// 貨架標籤上的字本來就小，96px 的縮圖根本讀不出價格。
// 要能點開看原圖，而且要能再放大 —— 這張照片存在的唯一理由就是事後核對。
function openPhotoViewer(url) {
  const el = document.createElement("div");
  el.className = "sheet viewer";
  el.innerHTML = `
    <div class="viewer-bar">
      <button class="x" data-close aria-label="${plain("close")}">✕</button>
      <div class="spacer"></div>
      <button class="btn-small" data-zoom>🔍 ${bi1("zoom")}</button>
    </div>
    <div class="viewer-stage" data-stage>
      <img src="${esc(url)}" alt="貨架標籤 shelf label">
    </div>
    <p class="viewer-hint">點圖片可放大縮小 <i class="en">Tap the image to zoom</i></p>`;
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
          <button class="btn-small" data-act="take-photo">📷 重拍 Retake</button>
          <button class="btn-small" data-act="choose-photo">🖼 換一張 Change</button>
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

    applyExtraction(el, draft, out.data);
    refreshHint();

    const filled = ["price_pence", "name_en", "size"].filter((k) => out.data[k] !== null).length;
    renderPhotoSlot(el, draft, { message: `已填 ${filled} 個欄位，請核對 Check before saving` });
    buzz(20);
  } catch (err) {
    renderPhotoSlot(el, draft, { message: "!" + err.message });
  }
}

function applyExtraction(el, draft, data) {
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
  set("size", data.size !== null ? String(data.size) : null);

  // 單位要合得上品項的計價基準，合不上就別填，讓人自己選
  if (data.size_unit) {
    const select = body.querySelector("[data-f='size_unit']");
    if ([...select.options].some((o) => o.value === data.size_unit)) {
      select.value = data.size_unit;
      draft.size_unit = data.size_unit;
    }
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

  if (!draft.item_id) return toast("還沒選品項 Pick an item first", { warn: true });
  if (pence === null || pence <= 0) return toast("價格沒填 Enter a price", { warn: true });
  if (!draft.store_id) return toast("還沒選超市 Pick a store", { warn: true });

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
      <button class="itemrow" data-new>
        <span class="ic" style="color:var(--accent-ink)">＋</span>
        <span class="body"><span class="nm">${bi1("newItem")}${q ? `：${esc(q)}` : ""}</span></span>
      </button>`;

    results.innerHTML = create + (list.length
      ? list.map((i) => itemRowHtml(i, { compact: true })).join("")
      : `<div class="empty"><p>還沒有品項<br>No items yet</p></div>`);
  };

  input.oninput = draw;
  draw();

  results.onclick = async (e) => {
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
          ${CATEGORIES.map(([id, z, e2, ic]) =>
            `<option value="${id}"${draft.category === id ? " selected" : ""}>${ic} ${z} ${e2}</option>`).join("")}
        </select>
      </label>
      <label class="row">
        <span class="k">${bi1("baseUnit")}</span>
        <select class="sel" data-f="base_unit"${lockedBase ? " disabled" : ""}>
          <option value="g"${draft.base_unit === "g" ? " selected" : ""}>重量 by weight (kg)</option>
          <option value="ml"${draft.base_unit === "ml" ? " selected" : ""}>容量 by volume (L)</option>
          <option value="each"${draft.base_unit === "each" ? " selected" : ""}>計個 per item</option>
        </select>
      </label>
    </div>
    <p class="note">
      <b>計價基準決定怎麼比</b> —— 選「重量」就一律換算成每公斤，選「容量」就是每公升。
      這樣 Aldi 的 2L 才比得過 Waitrose 的 1.13L。<br>
      This is what makes different pack sizes comparable.
      ${lockedBase ? `<br><br><b>底下已經有 ${productCount} 筆商品，所以這一項鎖住了。</b>
      它們的容量單位都是照現在這個基準填的，改掉會讓單價全部算錯單位
      （500g 會被當成 500ml）。真的要換就把這個品項刪掉重建。<br>
      <i class="en">Locked because ${productCount} product(s) already use this unit.</i>` : ""}
    </p>
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
      return toast("至少填一個名稱 Enter a name", { warn: true });
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
    toast("已刪除 Deleted");
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
        <span class="k">${bi1("archive")} <i class="en">hide from pickers</i></span>
        <input class="chk" data-f="archived" type="checkbox"${draft.archived ? " checked" : ""}>
      </label>` : ""}
    </div>

    <p class="note">
      分組決定它跟誰比。街角的亞洲雜貨選「亞洲超市」，它就只會跟 Tian Tian、
      Starry Mart 排在一起，不會拿去跟 Aldi 比牛奶。<br>
      <i class="en">The group decides which stores it is ranked against.</i>
      ${usedCount ? `<br><br>目前有 <b>${usedCount}</b> 筆商品記在這家店。
      封存只是從選單裡收起來，已經記的價格照常出現在比價裡。` : ""}
    </p>

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
    if (!String(draft.name).trim()) return toast("店名沒填 Enter a store name", { warn: true });
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
    toast("已刪除 Deleted");
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
          <i class="en">${esc(g.en)}</i></h2></div>
        <div class="rows">${mine.map((s) => {
          const n = state.products.filter((p) => p.store_id === s.id).length;
          return `<button class="row" data-store-edit="${esc(s.id)}">
            <span class="swatch" style="width:4px;height:26px;border-radius:2px;background:${s.color};flex:none"></span>
            <span class="k" style="flex:1;min-width:0">${esc(s.name)}${s.archived ? ` <i class="en">已封存 archived</i>` : ""}
              ${s.note ? `<i class="en">${esc(s.note)}</i>` : ""}</span>
            <span class="v num">${n ? `${n} 項` : ""}</span>
          </button>`;
        }).join("")}</div>`;
    }).join("") : `<div class="empty"><div class="big">🏪</div>
      <p>還沒有自訂店家<br>No custom stores yet<br><br>
      轉角的雜貨店、市集攤位這種<br>清單裡沒有的地方，加進來就能記價<br>
      <i class="en">Add the corner shop or market stall you actually buy from</i></p></div>`}

    <p class="note">
      內建的連鎖店（Sainsbury's、Aldi、Tian Tian…）寫在程式裡，不會出現在這份清單，
      也不能刪 —— 它們幾乎不會變，同步它們只是浪費。這裡只放你自己加的。<br>
      <i class="en">Built-in chains are not listed here; this is only what you added.</i>
    </p>
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
    </div>
    <p class="note">
      勾起來的會改分類。<b>圖示不用改</b> —— 它已經自己從名稱判斷了，
      這裡只處理分類。<br>
      <i class="en">Only categories are written; icons resolve from the name automatically.</i>
    </p>` : `<div class="empty"><div class="big">✨</div>
      <p>分類看起來都對<br>Categories look fine</p></div>`,
    changes.length ? { saveLabel: bi1("save") } : {});

  el.querySelector("[data-save]")?.addEventListener("click", async () => {
    const boxes = [...el.querySelectorAll("[data-fix]:checked")];
    for (const box of boxes) {
      const item = itemById(box.dataset.fix);
      if (item) await db.put("items", { ...item, category: box.dataset.to });
    }
    closeSheet(el);
    await refresh();
    toast(`已整理 ${boxes.length} 個品項 Tidied ${boxes.length} items`);
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
      </div>`).join("")}
    <p class="note">
      不挑的話會<b>從名稱自動判斷</b>（「蘋果」→ 🍎、「醬油」→ 🫗），
      判斷不出來才用分類的圖示。<br>
      <i class="en">Left on auto, the icon is guessed from the name.</i>
    </p>`);

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

  const groups = rankByGroup(itemId);
  const cat = category(item.category);
  const inList = state.list_items.some((li) => li.list_id === state.listId && li.item_id === itemId);

  // 只有一組有資料時就不必再標組名了，那只是噪音
  const showGroupHeads = groups.length > 1;

  const el = sheet(biText(item.name_zh, item.name_en, { block: true }), `
    <div class="storebar" style="border-bottom:0;padding-bottom:4px">
      <button class="chip" data-act="record">＋ ${bi1("record")}</button>
      <button class="chip" data-act="list">${inList ? "✓ 已在清單 In basket" : bi1("addToList")}</button>
      <button class="chip" data-act="edit">${bi1("edit")}</button>
    </div>

    <div class="section-head"><h2>${itemEmoji(item)} ${esc(cat[1])} <i class="en">${esc(cat[2])}</i></h2></div>

    ${groups.length ? groups.map(({ group, rows }) => `
      ${showGroupHeads ? `<div class="section-head"><h2>${group.icon} ${esc(group.zh)}
        <i class="en">${esc(group.en)}</i></h2></div>` : ""}
      <div class="rank">${rows.map((r, i) => rankRowHtml(r, i === 0, item)).join("")}</div>`).join("")
      : `<div class="empty"><div class="big">◌</div><p>還沒有可比較的價格<br>No comparable prices yet</p></div>`}

    ${groups.length ? `<p class="note">
      比的是<b>單價</b>，不是包裝價 —— 包裝大小不一樣，只比標價會得到相反的結論。<br>
      Ranked by unit price, not pack price.
      ${showGroupHeads ? `<br><br><b>分組排，各組各自有自己的最便宜</b> ——
      這幾種店不是同一個貨架上的競爭關係，混在一起排會得到
      「亞洲超市的牛奶比較貴」這種正確但沒有用的結論。<br>
      <i class="en">Ranked within each group: they are not substitutes for each other.</i>` : ""}
    </p>` : ""}

    ${historySection(itemId, item)}
    ${observationsSection(itemId)}
  `);

  el.querySelector(".storebar").onclick = async (e) => {
    if (e.target.closest("[data-act='record']")) { closeSheet(el); openRecord({ itemId }); }
    if (e.target.closest("[data-act='edit']")) { closeSheet(el); openItemEditor(item, () => refresh()); }
    if (e.target.closest("[data-act='list']")) { closeSheet(el); await addToList(itemId); }
  };

  // 排行列與紀錄列都能點開編輯，所以綁在整個面板上
  el.querySelector(".sheet-body").addEventListener("click", (e) => {
    const row = e.target.closest("[data-price-id]");
    if (!row) return;
    closeSheet(el);
    openRecord({ editPriceId: row.dataset.priceId });
  });
}

function rankRowHtml(r, isBest, item) {
  const p = r.product;
  const packLabel = [p.brand, u.formatSize(p.size, p.size_unit)].filter(Boolean).join(" · ");
  // 排行列可以直接點開編輯：看到「米 1.9p/kg」這種明顯不對的數字時，
  // 第一個反應就是去戳它，不該還要先捲到最底下的紀錄列表才找得到入口。
  return `<button class="rankrow${isBest ? " best" : ""}${r.fresh.stale ? " stale" : ""}"
      data-price-id="${esc(r.price.id)}">
    <span class="swatch" style="background:${r.store.color}"></span>
    <span class="body">
      <span class="store">${esc(r.store.name)}${isBest ? `<span class="tag win">${esc(zh("cheapest"))}</span>` : ""}${r.price.is_promo ? `<span class="tag promo">${esc(r.price.promo_note || "特價 promo")}</span>` : ""}</span>
      <span class="detail">${esc([p.name_en, packLabel].filter(Boolean).join(" · ") || "—")}</span>
      <span class="detail">${esc(r.fresh.label)}${r.fresh.stale ? ` · <span class="tag old">${esc(zh("stale"))}</span>` : ""}</span>
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
    <div class="section-head"><h2>${esc(zh("history"))} <i class="en">${esc(en("history"))}</i></h2></div>
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
    <div class="section-head"><h2>${esc(zh("allPrices"))} <i class="en">${esc(en("allPrices"))}</i></h2></div>
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
// 「勾選」跟「加入清單」是同一件事 —— 存的還是 list_items，
// 所以份量、同步、跨裝置全部照舊，只是入口從另一頁變成首頁上的圈圈。

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
  toast(`已清除 ${mine.length} 項 Cleared`);
}

async function addToList(itemId) {
  const existing = state.list_items.find((li) => li.list_id === state.listId && li.item_id === itemId);
  if (existing) { toast("已經在清單裡 Already in basket"); return; }

  // 預設 1（1 公斤 / 1 公升 / 1 個）。單位由品項的計價基準決定，見 displayUnitOf()。
  await db.put("list_items", {
    list_id: state.listId,
    item_id: itemId,
    qty: 1,
    sort: state.list_items.length * 10,
    checked: 0,
  });
  await refresh();
  toast(`已加入清單 Added to basket`);
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
    let oldest = 0;
    const missing = [];

    for (const { li, item } of useLines) {
      const hit = grid.get(item.id).get(store.id);
      if (!hit) { missing.push(item); continue; }
      const qtyBase = u.toBase(li.qty, displayUnitOf(item.base_unit));
      if (qtyBase === null) { missing.push(item); continue; }
      pence += qtyBase * hit.unit;
      oldest = Math.max(oldest, hit.fresh.days ?? 999);
    }

    return {
      store, pence, missing,
      covered: useLines.length - missing.length,
      total: useLines.length,
      oldest,
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

function topbar(key, extra = "") {
  return `<div class="topbar"><div class="topbar-inner">
    <h1>${bi(key)}</h1><div class="spacer"></div>${extra}${syncBadge()}
  </div></div>`;
}

function tabbar() {
  const tab = (route, ic, key) =>
    `<button class="tab" data-route="${route}"${state.route === route ? ' aria-current="page"' : ""}>
       <span class="ic">${ic}</span><span class="nm">${esc(zh(key))}</span><span class="en">${esc(en(key))}</span></button>`;

  return `<nav class="tabbar"><div class="tabbar-inner">
    ${tab("compare", "⇅", "compare")}
    ${tab("stores", "🏬", "storesTab")}
    <div class="fab-slot">
      <button class="fab" data-act="add" aria-label="${plain("record")}">
        <span class="ic">📷</span><span class="nm">${esc(zh("record"))}</span>
      </button>
    </div>
    ${tab("history", "🧾", "historyTab")}
    ${tab("settings", "⚙", "settings")}
  </div></nav>`;
}

function itemRowHtml(item, { compact = false, pick = false } = {}) {
  const cat = category(item.category);
  const rows = compact ? [] : rankItem(item.id);
  const best = rows[0];
  const stores = compact ? 0 : rows.length;

  const meta = compact ? ""
    : (stores
        ? `${stores} 家有資料 <i class="en">${stores} store${stores > 1 ? "s" : ""}</i>`
        : `還沒有價格 <i class="en">no prices yet</i>`);

  const open = `<button class="open" data-item="${esc(item.id)}">
    <span class="ic">${itemEmoji(item)}</span>
    <span class="body">
      <span class="nm">${esc(item.name_zh || item.name_en)}
        ${item.name_zh && item.name_en ? `<i class="en">${esc(item.name_en)}</i>` : ""}</span>
      ${meta ? `<span class="meta">${meta}</span>` : ""}
    </span>
    ${best ? `<span class="best">
      <span class="up num">${esc(u.formatUnitPrice(best.unit, item.base_unit))}</span>
      <span class="who">${esc(best.store.name)}${best.fresh.stale ? " · 舊" : ""}</span>
    </span>` : ""}
  </button>`;

  // 勾選與打開是兩件事，所以是兩個按鈕 —— 按鈕不能巢狀在按鈕裡面。
  // 沒有 pick 的地方（選單裡）就整列都是 open。
  if (!pick) return `<div class="itemrow${best && best.fresh.stale ? " dim" : ""}">${open}</div>`;

  const on = selectedItemIds().has(item.id);
  return `<div class="itemrow${best && best.fresh.stale ? " dim" : ""}${on ? " picked" : ""}">
    <button class="pick" data-pick="${esc(item.id)}" role="checkbox" aria-checked="${on}"
      aria-label="${plain("addToList")}">${on ? "✓" : ""}</button>
    ${open}
  </div>`;
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

  const list = state.items
    .filter((i) => matchesQuery(i, q))
    .map((i) => ({ item: i, seen: lastSeenOf(i.id) }))
    .sort((a, b) => (a.seen === b.seen
      ? (a.item.name_zh || "").localeCompare(b.item.name_zh || "", "zh-Hant")
      : (a.seen < b.seen ? 1 : -1)));

  // 勾起來的排最前面，不然選了幾樣之後要往回捲才找得到自己選了什麼
  const chosen = list.filter((r) => picked.has(r.item.id));
  const rest = list.filter((r) => !picked.has(r.item.id));
  const withPrices = rest.filter((r) => r.seen);
  const without = rest.filter((r) => !r.seen);

  return `
    ${topbar("compare", `<button class="icon-btn" data-act="new-item" aria-label="${plain("newItem")}">＋</button>`)}
    <main class="screen">
      <div class="searchbar">
        <input type="search" data-q value="${esc(state.query)}"
               placeholder="${plain("search")}… 牛奶 / milk / chicken" autocomplete="off">
      </div>

      ${!state.items.length ? `<div class="empty">
        <div class="big">🛒</div>
        <p>還沒有任何紀錄<br>Nothing recorded yet<br><br>
        按下面的 <b>📷 記價</b> 拍一張貨架標籤開始<br>
        Tap <b>Record</b> to photograph a shelf label</p>
      </div>` : ""}

      ${picked.size ? basketPanelHtml() : ""}

      ${chosen.length ? `
        <div class="section-head"><h2>✓ ${esc(zh("selected"))}
          <i class="en">${esc(en("selected"))}</i></h2>
          <span class="more num">${chosen.length}</span></div>
        ${chosen.map((r) => itemRowHtml(r.item, { pick: true })).join("")}` : ""}

      ${withPrices.length ? `
        <div class="section-head"><h2>最近記的 <i class="en">Recently recorded</i></h2></div>
        ${withPrices.map((r) => itemRowHtml(r.item, { pick: true })).join("")}` : ""}

      ${without.length ? `
        <div class="section-head"><h2>還沒有價格 <i class="en">No prices yet</i></h2></div>
        ${without.map((r) => itemRowHtml(r.item, { pick: true })).join("")}` : ""}

      ${state.items.length ? `<p class="note">
        點<b>名字</b>看那一樣哪家便宜，點左邊的<b>圈圈</b>把它加進整籃比較。<br>
        <i class="en">Tap the name for one item, tap the circle to add it to the basket.</i><br><br>
        排行看的是<b>單價</b>（每公斤／每公升），不是架上的標價 ——
        Aldi 2L 賣 £1.45、Waitrose 1.13L 賣 £1.35，便宜的其實是前者。<br>
        <i class="en">Ranked by unit price, because pack sizes differ between stores.</i>
      </p>` : ""}
    </main>
    ${tabbar()}`;
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
      <h2>🧺 ${esc(zh("total"))} <i class="en">${esc(en("total"))}</i></h2>
      <span class="more num">${lines.length} 項</span>
      <button class="linkbtn" data-act="clear-basket">${bi1("clear")}</button>
    </div>

    ${groups.map(({ group, results, useLines, common }) => `
      <div class="grouphead">${group.icon} ${esc(group.zh)}
        <i class="en">${esc(group.en)}</i>
        <span class="num">${state.commonOnly && common.length
          ? `${common.length} 項共同` : `${useLines.length} 項`}</span></div>
      <div class="rank">${results.map((r, i) => basketRowHtml(r, i === 0)).join("")}</div>`).join("")}

    ${canCommon ? `<div class="storebar" style="border-bottom:0;padding-top:10px">
      <button class="chip${state.commonOnly ? " on" : ""}" data-act="common">
        ${bi1("commonOnly")}</button></div>` : ""}

    <details class="basket-lines">
      <summary>調整份量 <i class="en">Adjust quantities</i>（${lines.length}）</summary>
      <div class="rows" data-lines>${rows}</div>
    </details>

    ${groups.length ? `<p class="note">
      <b>分組分開算</b> —— 你沒辦法在 Aldi 買醬油，轉角蔬果行也沒有衛生紙。
      把它們排在一起，只賣少數品項的店會因為缺一堆東西而永遠墊底。<br>
      <b>${esc(zh("estimated"))}</b> —— 用各店單價乘上份量，所以包裝大小不同也比得出來，
      但你只能買整包，結帳金額會有出入。<br>
      <b>缺資料不補值</b>：「已知 N / M」就是這家店真正能算的品項數。<br>
      <i class="en">Each group ranked on its own; estimated by unit price; missing items are
      never filled in with another store's price.</i>
    </p>` : `<p class="note">選到的品項還沒有任何價格紀錄
      <i class="en">Nothing priced among the selected items yet</i></p>`}
  </section>`;
}

function basketRowHtml(r, isBest) {
  const missingNames = r.missing.slice(0, 3).map((i) => i.name_zh || i.name_en).join("、");
  const more = r.missing.length > 3 ? ` 等 ${r.missing.length} 項` : "";

  return `<div class="rankrow${isBest ? " best" : ""}${r.oldest > u.STALE_DAYS ? " stale" : ""}">
    <span class="swatch" style="background:${r.store.color}"></span>
    <span class="body">
      <span class="store">${esc(r.store.name)}${isBest ? `<span class="tag win">${esc(zh("cheapest"))}</span>` : ""}</span>
      <span class="detail">${esc(zh("covered"))} ${r.covered} / ${r.total}
        <i class="en">items priced</i>${r.oldest > u.STALE_DAYS ? ` · <span class="tag old">${esc(zh("stale"))}</span>` : ""}</span>
      ${r.missing.length ? `<span class="detail">${esc(zh("missing"))}：${esc(missingNames)}${esc(more)}</span>` : ""}
    </span>
    <span class="fig">
      <span class="a num">${esc(u.formatPence(r.pence, { alwaysPounds: true }))}</span>
      <span class="b num">${esc(twd(r.pence, { prefix: "≈ " }))}</span>
      ${r.missing.length ? `<span class="b">不含缺項 <i class="en">partial</i></span>` : ""}
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
    ${topbar("historyTab")}
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
        <p>還沒有任何價格紀錄<br>No price records yet</p></div>`}
      ${rows.length ? `<p class="note">點任何一筆可以修改或刪除
        <i class="en">Tap any row to edit or delete it</i></p>` : ""}
    </main>
    ${tabbar()}`;
}

// ---------------------------------------------------------------- 以店家看
//
// 「這東西哪家便宜」是首頁在回答的。這一頁回答的是相反方向的問題：
// **我人在 Aldi，這裡有什麼東西值得買？**
//
// 判斷「值得買」的標準是：在同一組裡它是不是最便宜的、便宜多少。
// 跨組不比（見 stores.js 的分組理由），所以 Aldi 只跟其他一般超市比。

function storeReport(storeId) {
  const group = storeGroup(storeId);
  const wins = [];
  const only = [];
  const loses = [];
  let newest = "";

  for (const item of state.items) {
    const rank = rankItem(item.id).filter((r) => r.store.group === group);
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
      data-store-report="${esc(store.id)}" style="--c:${store.color}">
    <span class="sc-head">
      <span class="sc-name">${esc(store.name)}</span>
      ${shown.length
        ? `<span class="sc-badge">${report.wins.length} 樣最便宜</span>`
        : `<span class="sc-badge muted">沒有最便宜的</span>`}
    </span>

    ${shown.length ? `<span class="sc-wins">${shown.map(winLine).join("")}</span>` : `
      <span class="sc-none">這裡的東西別家都更便宜，或還沒有對照組
        <i class="en">Nothing here is the cheapest yet</i></span>`}

    <span class="sc-foot">${esc(foot)}</span>
  </button>`;
}

function renderStores() {
  // 只列出真的有紀錄的店 —— 空的卡片除了佔位置沒有任何用處
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

  return `
    ${topbar("storesTab")}
    <main class="screen">
      ${groups.length ? groups.map(({ group, stores }) => `
        <div class="section-head"><h2>${group.icon} ${esc(group.zh)}
          <i class="en">${esc(group.en)}</i></h2>
          <span class="more num">${stores.length}</span></div>
        <div class="storelist">
          ${stores.map((st) => storeCardHtml(st, reports.get(st.id))).join("")}
        </div>`).join("") : `<div class="empty"><div class="big">🏬</div>
        <p>還沒有任何價格紀錄<br>Nothing recorded yet<br><br>
        記幾筆之後，這裡會告訴你<br>每一家店有什麼東西最便宜<br>
        <i class="en">Once you record a few prices, this shows what each store wins on</i></p></div>`}

      ${groups.length ? `<p class="note">
        卡片上直接列出<b>這家店最划算的前 ${CARD_WINS} 樣</b>（省最多的在最前面），
        點卡片看完整清單。<br>
        「省 N%」比的是<b>單價</b>，而且只跟<b>同一組</b>的店比 ——
        Aldi 只跟其他一般超市比，不會拿去跟蔬果行比。<br>
        <i class="en">Each card lists that store's best buys, ranked by how much you save.</i>
      </p>` : ""}
    </main>
    ${tabbar()}`;
}

// 一家店的明細：這裡買什麼划算、什麼別買。
function openStoreReport(storeId) {
  const store = storeById(storeId);
  if (!store) return;
  const r = storeReport(storeId);
  const g = groupById(store.group);

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

  const el = sheet(`<span class="bi"><b>${esc(store.name)}</b><i>${g.icon} ${esc(g.zh)}</i></span>`, `
    <div class="scoreline" style="--c:${store.color}">
      <div><span class="n num">${r.wins.length}</span><span class="l">最便宜<i class="en">cheapest</i></span></div>
      <div><span class="n num">${r.only.length}</span><span class="l">獨有<i class="en">only here</i></span></div>
      <div><span class="n num">${r.loses.length}</span><span class="l">較貴<i class="en">pricier</i></span></div>
    </div>

    ${r.wins.length ? `<div class="section-head"><h2>🥇 這裡買最划算
      <i class="en">Best buys here</i></h2><span class="more num">${r.wins.length}</span></div>
      ${r.wins.map((x) => line(x, "win")).join("")}` : ""}

    ${r.only.length ? `<div class="section-head"><h2>🧭 只有這裡有紀錄
      <i class="en">Only recorded here</i></h2><span class="more num">${r.only.length}</span></div>
      ${r.only.map((x) => line(x, "only")).join("")}` : ""}

    ${r.loses.length ? `<div class="section-head"><h2>💸 別在這裡買
      <i class="en">Cheaper elsewhere</i></h2><span class="more num">${r.loses.length}</span></div>
      ${r.loses.map((x) => line(x, "lose")).join("")}` : ""}

    <p class="note">
      百分比比的是<b>單價</b>（每公斤／每公升），而且只跟<b>同一組</b>的店比 ——
      ${esc(g.zh)}只跟${esc(g.zh)}比。<br>
      「只有這裡有紀錄」不代表它便宜，只代表<b>沒有對照組</b>；
      去別家記一筆同樣的東西就會知道了。<br>
      <i class="en">Percentages compare unit prices within ${esc(g.en)} only.</i>
    </p>
  `);

  el.querySelector(".sheet-body").addEventListener("click", (e) => {
    const row = e.target.closest("[data-item]");
    if (!row) return;
    closeSheet(el);
    openItemDetail(row.dataset.item);
  });
}

function renderSettings() {
  const s = db.syncStatus;
  const lastSync = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString("zh-TW") : "—";

  return `
    ${topbar("settings")}
    <main class="screen">
      <div class="section-head"><h2>同步 <i class="en">Sync</i></h2></div>
      <div class="rows">
        <div class="row"><span class="k">狀態 <i class="en">Status</i></span><span class="v">${syncBadge()}</span></div>
        <div class="row"><span class="k">上次同步 <i class="en">Last sync</i></span><span class="v num">${esc(lastSync)}</span></div>
        <button class="row" data-act="sync"><span class="k">${bi1("syncNow")}</span><span class="v">›</span></button>
        <div class="row"><span class="k">待上傳照片 <i class="en">Photos queued</i></span><span class="v num" data-pending>—</span></div>
      </div>

      <div class="section-head"><h2>照片 <i class="en">Photos</i></h2></div>
      <div class="rows">
        <button class="row" data-act="batch"><span class="k">${bi1("batch")}</span>
          <span class="v">一次選多張，逐張確認 ›</span></button>
        ${queue.ids.length && queue.index < queue.ids.length ? `
          <button class="row" data-act="resume-batch">
            <span class="k" style="color:var(--accent-ink)">${bi1("resume")}</span>
            <span class="v">還剩 ${queue.ids.length - queue.index} 張 ›</span></button>
          <button class="row danger" data-act="drop-batch"><span class="k">放棄這批 Discard batch</span></button>` : ""}
      </div>

      <div class="section-head"><h2>品項 <i class="en">Items</i></h2></div>
      <div class="rows">
        <button class="row" data-act="tidy">
          <span class="k">✨ ${bi1("tidy")}</span>
          <span class="v">用名稱重新判斷 ›</span></button>
      </div>

      <div class="section-head"><h2>${esc(zh("stores"))} <i class="en">${esc(en("stores"))}</i></h2></div>
      <div class="rows">
        <button class="row" data-act="stores">
          <span class="k">🏪 ${bi1("stores")}</span>
          <span class="v">自訂 ${customStores().length} 家 ›</span></button>
      </div>

      <div class="section-head"><h2>台幣 <i class="en">TWD</i></h2></div>
      <div class="rows">
        <label class="row">
          <span class="k">${bi1("showTwd")}</span>
          <input class="chk" data-act="twd-toggle" type="checkbox"${state.showTwd ? " checked" : ""}>
        </label>
        <div class="row"><span class="k">${bi1("rate")}</span>
          <span class="v num" data-rate>—</span></div>
      </div>
      <p class="note">
        台幣是<b>參考值</b>，用今天的匯率換算，只是讓你對得上物價感覺 ——
        它不參與任何排序或加總，比價的真相永遠是英鎊那一欄。<br>
        <i class="en">TWD is indicative only and never affects ranking.</i>
      </p>

      <div class="section-head"><h2>匯出 <i class="en">Export</i></h2></div>
      <div class="rows">
        <button class="row" data-act="export-xlsx">
          <span class="k">📊 ${bi1("exportXlsx")}</span>
          <span class="v">三張工作表 ›</span></button>
        <button class="row" data-act="export-csv">
          <span class="k">📄 ${bi1("exportCsv")}</span>
          <span class="v">價格流水帳 ›</span></button>
      </div>
      <p class="note">
        Excel 檔有三張表：<b>比價總表</b>（一個品項一列、每家店一欄）、
        <b>價格紀錄</b>（每一筆觀測的流水帳）、<b>品項</b>。
        CSV 只有價格紀錄那一張。<br>
        <i class="en">CSV is UTF-8 with BOM so Excel opens Chinese correctly.</i>
      </p>

      <div class="section-head"><h2>標籤辨識 <i class="en">Label recognition</i></h2></div>
      <div class="rows">
        <div class="row"><span class="k">${bi1("model")}</span><span class="v num" data-model style="font-size:12px">—</span></div>
        <button class="row" data-act="bakeoff"><span class="k">${bi1("bakeoff")}</span>
          <span class="v">拿一張照片比三個模型 ›</span></button>
      </div>
      <p class="note">
        目前用 Cloudflare Workers AI（免費額度每天 10,000 Neurons）。
        辨識結果一律要你確認過才會存 —— 錯的價格比沒有價格更糟。<br>
        <i class="en">AI suggestions always go through your confirmation. A wrong price is worse than no price.</i>
      </p>

      <div class="section-head"><h2>本機 <i class="en">This device</i></h2></div>
      <div class="rows">
        <div class="row"><span class="k">照片快取 <i class="en">Photo cache</i></span><span class="v num" data-bytes>—</span></div>
        <button class="row" data-act="clear-photos"><span class="k">${bi1("clearCache")}</span>
          <span class="v">已上傳的才會刪 ›</span></button>
        <label class="row">
          <span class="k">${bi1("theme")}</span>
          <select class="sel" data-act="theme">
            <option value="auto">跟隨系統 Auto</option>
            <option value="light">淺色 Light</option>
            <option value="dark">深色 Dark</option>
          </select>
        </label>
      </div>

      <div class="rows" style="margin-top:22px">
        <button class="row danger" data-act="logout"><span class="k">${bi1("logout")}</span></button>
      </div>

      <p class="note">
        ${esc(state.items.length)} 個品項 · ${esc(state.products.length)} 筆商品 · ${esc(state.prices.length)} 筆價格<br>
        <i class="en">${esc(state.items.length)} items · ${esc(state.products.length)} products · ${esc(state.prices.length)} price observations</i>
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
        <span style="font-size:22px">📷</span><span>選一張貨架標籤 Pick a shelf label</span>
      </button>
    </div>
    <div data-results></div>
    <p class="note">
      同一張照片同時丟給三個 Workers AI 視覺模型，把它們讀出來的東西並排給你看。<br>
      對照實際標籤，看哪一個抓得準，再決定 App 預設用哪個 —— 或決定乾脆放棄 AI 只留手動輸入。<br>
      <i class="en">Runs one photo through all three candidate models so you can judge accuracy yourself.</i>
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
    results.innerHTML = `<div class="empty"><p>三個模型跑中…<br>Running three models…</p></div>`;

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
      <div class="row"><span class="k">名稱 <i class="en">Name</i></span><span class="v">${esc(d.name_en ?? "—")}</span></div>
      <div class="row"><span class="k">品牌 <i class="en">Brand</i></span><span class="v">${esc(d.brand ?? "自有品牌 own label")}</span></div>
      <div class="row"><span class="k">容量 <i class="en">Size</i></span><span class="v num">${esc(u.formatSize(d.size, d.size_unit) || "—")}</span></div>
      <div class="row"><span class="k">價格 <i class="en">Price</i></span><span class="v num" style="color:var(--accent-ink);font-weight:650">${esc(u.formatPence(d.price_pence, { alwaysPounds: true }))}</span></div>
      <div class="row"><span class="k">標籤單價 <i class="en">Unit price</i></span><span class="v num">${esc(d.label_unit_price ?? "—")}</span></div>
      <div class="row"><span class="k">特價 <i class="en">Promo</i></span><span class="v">${d.is_promo ? esc(d.promo_note || "是 yes") : "—"}</span></div>`
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

// 全域委派。畫面重繪很頻繁，每次都重綁事件太容易漏。
document.addEventListener("click", async (e) => {
  const routeBtn = e.target.closest("[data-route]");
  if (routeBtn) {
    state.route = routeBtn.dataset.route;
    state.query = "";
    render();
    return;
  }

  const act = e.target.closest("[data-act]")?.dataset.act;

  if (act === "add") { openRecord(); return; }
  if (act === "batch") { openBatchImport(); return; }
  if (act === "resume-batch") { nextInQueue(); return; }
  if (act === "drop-batch") {
    // 照片本身留著（在 photos 表裡），只是不再逐張問你。要用隨時可以再挑。
    await clearQueue();
    render();
    toast("已放棄這批，照片還在本機 Batch dropped, photos kept");
    return;
  }
  if (act === "new-item") { openItemEditor(null, () => refresh()); return; }
  if (act === "common") { state.commonOnly = !state.commonOnly; render(); return; }
  if (act === "bakeoff") { openBakeOff(); return; }

  if (act === "stores") { openStoreList(); return; }
  if (act === "tidy") { openTidy(); return; }

  const report = e.target.closest("[data-store-report]");
  if (report) { openStoreReport(report.dataset.storeReport); return; }
  if (act === "clear-basket") { await clearSelected(); return; }
  if (act === "sync") { await db.sync(); render(); toast("同步完成 Synced"); return; }

  if (act === "export-xlsx" || act === "export-csv") {
    if (!state.prices.length) return toast("還沒有資料可以匯出 Nothing to export yet", { warn: true });

    // 比價邏輯用傳的，不要在 export.js 裡重寫一份 ——
    // 匯出的數字跟畫面上不一樣是最難發現的 bug
    const ctx = { items: state.items, products: state.products, prices: state.prices, rankItem };
    const all = xport.sheets(ctx);

    if (act === "export-xlsx") {
      xport.download(xport.xlsxBlob(all), `price-check-${xport.stamp()}.xlsx`);
      toast(`已匯出 ${all.length} 張工作表 Exported`);
    } else {
      const prices = all.find((s) => s.name.startsWith("價格紀錄"));
      xport.download(xport.csvBlob(prices), `price-check-${xport.stamp()}.csv`);
      toast(`已匯出 ${prices.rows.length} 筆價格 Exported`);
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

  const pick = e.target.closest("[data-pick]");
  if (pick && app.contains(pick)) { await toggleSelected(pick.dataset.pick); return; }

  // 紀錄頁的每一列直接開編輯（品項明細裡的那些由面板自己處理）
  const priceRow = e.target.closest("[data-price-id]");
  if (priceRow && app.contains(priceRow)) { openRecord({ editPriceId: priceRow.dataset.priceId }); return; }

  const remove = e.target.closest("[data-remove]");
  if (remove) {
    const li = state.list_items.find((r) => r.id === remove.dataset.remove);
    await db.remove("list_items", remove.dataset.remove);
    await refresh();
    toast("已從清單移除 Removed", {
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
      <p>英國超市比價<br><i class="en">UK supermarket price tracker</i></p>
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
    if (detail.type === "unauthed") { renderLogin("請重新登入 Please sign in again"); return; }
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
