// 本機資料層。
//
// IndexedDB 是唯一真相來源 —— 畫面只讀它，寫入也只寫它，永遠不等網路。
// 同步是背景行為：把 dirty 的列推上去、把伺服器的變更拉下來，兩件事都失敗了
// 也不影響使用。
//
// 這件事在這個 App 特別重要：超市裡面常常收不到訊號，而記價就是要在貨架前面做。

const DB_NAME = "price-check";
// 加了新的 object store 就一定要進版，否則已經在用的裝置不會觸發 onupgradeneeded，
// 開 transaction 時直接 NotFoundError 整個 App 掛掉。
//   v2：加入 stores（自訂店家）
const DB_VERSION = 2;

export const TABLES = ["stores", "items", "products", "prices", "photos", "lists", "list_items"];

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const t of TABLES) {
        if (!db.objectStoreNames.contains(t)) {
          const store = db.createObjectStore(t, { keyPath: "id" });
          store.createIndex("dirty", "dirty");
        }
      }
      // 照片的二進位內容。跟 photos 這張同步表分開放：
      // metadata 要同步到別台裝置，幾 MB 的 JPEG 不要。
      if (!db.objectStoreNames.contains("blobs")) {
        const store = db.createObjectStore("blobs", { keyPath: "id" });
        store.createIndex("uploaded", "uploaded");
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(stores, mode = "readonly") {
  return open().then((db) => db.transaction(stores, mode));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------- 基本讀寫

export async function getAll(table) {
  const t = await tx([table]);
  const rows = await wrap(t.objectStore(table).getAll());
  return rows.filter((r) => !r.deleted_at);
}

export async function getAllRaw(table) {
  const t = await tx([table]);
  return wrap(t.objectStore(table).getAll());
}

export async function get(table, id) {
  const t = await tx([table]);
  return wrap(t.objectStore(table).get(id));
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// 寫入一列。沒有 id 就當新增；一律標成 dirty 等待推送。
export async function put(table, obj) {
  const now = new Date().toISOString();
  const row = { ...obj };
  if (!row.id) row.id = uuid();
  if (!row.created_at) row.created_at = now;
  row.updated_at = now;
  row.dirty = 1;

  const t = await tx([table], "readwrite");
  await wrap(t.objectStore(table).put(row));
  queueSync();
  return row;
}

// 軟刪除：一定要留一列帶 deleted_at，否則刪除同步不到其他裝置
export async function remove(table, id) {
  const existing = await get(table, id);
  if (!existing) return;
  const now = new Date().toISOString();
  const t = await tx([table], "readwrite");
  await wrap(t.objectStore(table).put({ ...existing, deleted_at: now, updated_at: now, dirty: 1 }));
  queueSync();
}

// ---------------------------------------------------------------- 本機設定

export async function getMeta(key, fallback = null) {
  const t = await tx(["meta"]);
  const row = await wrap(t.objectStore("meta").get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const t = await tx(["meta"], "readwrite");
  await wrap(t.objectStore("meta").put({ key, value }));
}

// ---------------------------------------------------------------- 照片
//
// 拍完先存本機，之後再排隊上傳。站在 Aldi 冷凍櫃前面沒訊號是常態，
// 「拍照 → 等上傳 → 才能繼續」這種流程在那裡完全不能用。

export async function savePhotoBlob(id, blob) {
  const t = await tx(["blobs"], "readwrite");
  await wrap(t.objectStore("blobs").put({ id, blob, uploaded: 0, at: Date.now() }));
}

export async function getPhotoBlob(id) {
  const t = await tx(["blobs"]);
  const row = await wrap(t.objectStore("blobs").get(id));
  return row ? row.blob : null;
}

// 拿得到本機的就用本機的（離線也看得到），拿不到才回 R2 的網址
export async function photoUrl(id) {
  if (!id) return null;
  const blob = await getPhotoBlob(id);
  if (blob) return URL.createObjectURL(blob);
  return `/api/photo/${id}`;
}

export async function pendingPhotoCount() {
  const t = await tx(["blobs"]);
  return wrap(t.objectStore("blobs").index("uploaded").count(0));
}

async function uploadPendingPhotos() {
  const t = await tx(["blobs"]);
  const pending = await wrap(t.objectStore("blobs").index("uploaded").getAll(0));
  if (!pending.length) return 0;

  let done = 0;
  for (const row of pending) {
    try {
      const res = await fetch(`/api/photo/${row.id}`, {
        method: "PUT",
        headers: { "Content-Type": row.blob.type || "image/jpeg" },
        body: row.blob,
      });
      // 501 = 這個環境根本沒有 R2。標成已處理，不然每次同步都白試一輪。
      if (!res.ok && res.status !== 501) continue;
      const w = await tx(["blobs"], "readwrite");
      await wrap(w.objectStore("blobs").put({ ...row, uploaded: 1 }));
      done += 1;
    } catch {
      break;   // 網路斷了，剩下的下次再說
    }
  }
  return done;
}

// 本機照片會越積越多。刪掉的是已經上傳的那些，R2 上還在，需要時再抓。
export async function clearUploadedPhotos() {
  const t = await tx(["blobs"]);
  const rows = await wrap(t.objectStore("blobs").index("uploaded").getAll(1));
  const w = await tx(["blobs"], "readwrite");
  for (const r of rows) await wrap(w.objectStore("blobs").delete(r.id));
  return rows.length;
}

export async function localPhotoBytes() {
  const t = await tx(["blobs"]);
  const rows = await wrap(t.objectStore("blobs").getAll());
  return rows.reduce((n, r) => n + (r.blob ? r.blob.size : 0), 0);
}

// ---------------------------------------------------------------- 同步

let syncTimer = null;
let syncing = false;
let syncAgain = false;

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(detail) { for (const fn of listeners) { try { fn(detail); } catch (e) { console.error(e); } } }

export const syncStatus = { state: "idle", lastError: null, lastSyncAt: null, pending: 0 };

function setStatus(state, error = null) {
  syncStatus.state = state;
  syncStatus.lastError = error;
  emit({ type: "sync-status" });
}

// 變更後稍等一下再送，連續記好幾筆時只會打一次 API
export function queueSync(delay = 800) {
  emit({ type: "data" });
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { sync().catch(() => {}); }, delay);
}

async function collectDirty() {
  const changes = {};
  let count = 0;
  for (const table of TABLES) {
    const t = await tx([table]);
    const rows = await wrap(t.objectStore(table).index("dirty").getAll(1));
    if (rows.length) {
      changes[table] = rows.map(({ dirty, server_seq, ...rest }) => rest);
      count += rows.length;
    }
  }
  return { changes, count };
}

// 推送成功後才清 dirty，而且只清「這段期間沒有再被改過」的列
async function clearDirty(pushed) {
  for (const [table, rows] of Object.entries(pushed)) {
    if (!rows.length) continue;
    const t = await tx([table], "readwrite");
    const store = t.objectStore(table);
    for (const sent of rows) {
      const current = await wrap(store.get(sent.id));
      if (current && current.updated_at === sent.updated_at) {
        await wrap(store.put({ ...current, dirty: 0 }));
      }
    }
  }
}

async function applyIncoming(changes) {
  let applied = 0;
  for (const [table, rows] of Object.entries(changes || {})) {
    if (!TABLES.includes(table) || !Array.isArray(rows) || !rows.length) continue;
    const t = await tx([table], "readwrite");
    const store = t.objectStore(table);
    for (const row of rows) {
      const current = await wrap(store.get(row.id));
      // 本機有更新的版本就不要蓋掉（本機還沒推上去的編輯優先）
      if (current && current.dirty === 1 && current.updated_at >= row.updated_at) continue;
      await wrap(store.put({ ...row, dirty: 0 }));
      applied += 1;
    }
  }
  return applied;
}

export async function sync() {
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { setStatus("offline"); return; }

  syncing = true;
  setStatus("syncing");

  try {
    const { changes, count } = await collectDirty();
    syncStatus.pending = count;

    const lastSeq = await getMeta("last_seq", 0);
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ last_seq: lastSeq, changes }),
    });

    if (res.status === 401) { setStatus("unauthed"); emit({ type: "unauthed" }); return; }
    if (!res.ok) throw new Error("同步失敗 HTTP " + res.status);

    const data = await res.json();
    await clearDirty(changes);
    const applied = await applyIncoming(data.changes);
    await setMeta("last_seq", data.seq);

    // 匯率是伺服器單方面給的參考資料，不是同步表。存進 meta，
    // 離線時沿用上次那一份 —— 匯率差幾天不影響「這東西貴不貴」的判斷。
    if (data.fx && data.fx.rate) await setMeta("fx_gbp_twd", { rate: data.fx.rate, date: data.fx.date });

    // 照片放在資料之後：資料同步是分秒必爭的，照片慢一點沒關係
    const photos = await uploadPendingPhotos();

    syncStatus.pending = 0;
    syncStatus.lastSyncAt = new Date().toISOString();
    setStatus("ok");
    if (applied || photos) emit({ type: "data" });
  } catch (err) {
    console.warn("同步失敗（資料還在本機，之後會自動重試）", err);
    setStatus(navigator.onLine ? "error" : "offline", err.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; queueSync(200); }
  }
}

window.addEventListener("online", () => queueSync(300));
window.addEventListener("offline", () => setStatus("offline"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) queueSync(300); });
setInterval(() => { if (!document.hidden) sync().catch(() => {}); }, 5 * 60000);

// ---------------------------------------------------------------- 首次啟動
//
// 用固定 id，這樣多台裝置各自初始化也不會產生兩份清單。

export const DEFAULT_LIST_ID = "list-default";

export async function seedIfEmpty() {
  const lists = await getAllRaw("lists");
  if (lists.length) return;

  const now = new Date().toISOString();
  const t = await tx(["lists"], "readwrite");
  await wrap(t.objectStore("lists").put({
    id: DEFAULT_LIST_ID, name: "本週採買 This week", archived: 0,
    created_at: now, updated_at: now, deleted_at: null, dirty: 1,
  }));
}

// 開發用：清掉本機全部資料
export async function wipeLocal() {
  const db = await open();
  const stores = [...TABLES, "blobs", "meta"];
  const t = db.transaction(stores, "readwrite");
  for (const s of stores) t.objectStore(s).clear();
  return new Promise((r) => { t.oncomplete = r; });
}
