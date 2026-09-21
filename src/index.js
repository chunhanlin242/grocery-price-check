// price-check Worker
//   /api/*  → JSON API（登入、同步、照片、標籤辨識）
//   其他     → public/ 靜態檔，找不到就回 index.html（SPA）
//
// 靜態檔（app shell）本身是公開的，那只是程式碼；資料一律要通過驗證。

import { extractLabel, bakeOff, MODELS, DEFAULT_MODEL } from "./extract.js";

const COOKIE_NAME = "pc_auth";
const SESSION_DAYS = 365;

// 可同步的表與其欄位白名單。欄位名會直接進 SQL，必須來自這裡，不能來自請求。
const SYNC_TABLES = {
  // 只有「自訂」店家會進資料庫。內建連鎖店寫死在 public/stores.js。
  stores:     ["id", "name", "group_id", "color", "note", "sort", "archived", "created_at", "updated_at", "deleted_at"],
  items:      ["id", "name_zh", "name_en", "base_unit", "category", "emoji", "note", "created_at", "updated_at", "deleted_at"],
  products:   ["id", "item_id", "store_id", "brand", "name_en", "size", "size_unit", "barcode", "created_at", "updated_at", "deleted_at"],
  prices:     ["id", "product_id", "price_pence", "observed_on", "is_promo", "promo_note", "branch", "photo_id", "source", "label_unit_price", "created_at", "updated_at", "deleted_at"],
  photos:     ["id", "r2_key", "store_id", "taken_at", "width", "height", "created_at", "updated_at", "deleted_at"],
  lists:      ["id", "name", "archived", "created_at", "updated_at", "deleted_at"],
  list_items: ["id", "list_id", "item_id", "qty", "sort", "checked", "created_at", "updated_at", "deleted_at"],
};

// ---------------------------------------------------------------- 工具

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

// 常數時間比較，避免用回應時間猜出正確值
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

function secrets(env) {
  const password = env.APP_PASSWORD;
  // 沒另外設 SESSION_SECRET 就從密碼衍生，至少不會裸奔；設了才能單獨換掉踢登入
  const sessionSecret = env.SESSION_SECRET || (password ? "derived:" + password : null);
  return { password, sessionSecret };
}

async function makeToken(env) {
  const { sessionSecret } = secrets(env);
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return exp + "." + (await hmac(sessionSecret, exp));
}

async function isAuthed(request, env) {
  const { password, sessionSecret } = secrets(env);
  if (!password) return false;

  const raw = getCookie(request, COOKIE_NAME)
    || (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!raw) return false;

  const dot = raw.lastIndexOf(".");
  if (dot < 1) return false;
  const exp = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;

  return timingSafeEqual(sig, await hmac(sessionSecret, exp));
}

// 登入失敗節流。存在 isolate 記憶體裡，重啟就清空 —— 對個人用途夠了，
// 目的只是讓自動化猜密碼變得不划算。
const loginFails = new Map();

function loginDelay(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.at > 15 * 60000) { loginFails.delete(ip); return 0; }
  return Math.min(2 ** rec.n * 250, 8000);
}

function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { n: 0, at: 0 };
  loginFails.set(ip, { n: rec.n + 1, at: Date.now() });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 匯率
//
// 只需要 1 GBP = ? TWD。台幣在這個 App 裡是參考值（讓人對得上物價感覺），
// 不參與任何排序或加總，所以**不凍結**到每一筆價格上 —— 永遠用最新的換算。
// 這跟 travel-money 刻意相反，那邊是記帳，必須凍結才對得起來。

async function fetchGbpToTwd() {
  // 主來源以 TWD 為基準，值是 1 TWD = ? GBP，取倒數
  try {
    const r = await fetch(
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/twd.json",
      { cf: { cacheTtl: 3600 } }
    );
    if (r.ok) {
      const data = await r.json();
      const gbp = data && data.twd && data.twd.gbp;
      if (typeof gbp === "number" && gbp > 0) {
        return { rate: 1 / gbp, source: "fawazahmed0", date: data.date || null };
      }
    }
  } catch { /* 換備援 */ }

  const r2 = await fetch("https://open.er-api.com/v6/latest/TWD");
  if (!r2.ok) throw new Error("兩個匯率來源都失敗了");
  const d2 = await r2.json();
  const gbp = d2 && d2.rates && d2.rates.GBP;
  if (d2.result !== "success" || typeof gbp !== "number" || gbp <= 0) {
    throw new Error("備援匯率來源回傳異常");
  }
  return { rate: 1 / gbp, source: "er-api", date: null };
}

async function storeRate(env, date) {
  const { rate, source } = await fetchGbpToTwd();
  await env.DB.prepare(
    "INSERT INTO fx_rates (date, currency, rate_to_twd, source) VALUES (?, 'GBP', ?, ?) " +
    "ON CONFLICT(date, currency) DO UPDATE SET rate_to_twd = excluded.rate_to_twd, source = excluded.source"
  ).bind(date, rate, source).run();
  return rate;
}

// 今天的還沒抓就即時補；抓不到就退回最近一天有資料的。
// 退回舊的比完全不顯示好 —— 匯率一兩天內的變動對「貴不貴」的判斷沒有影響。
async function currentRate(env) {
  const today = new Date().toISOString().slice(0, 10);

  const hit = await env.DB
    .prepare("SELECT rate_to_twd FROM fx_rates WHERE date = ? AND currency = 'GBP'")
    .bind(today).first();
  if (hit) return { rate: hit.rate_to_twd, date: today };

  try {
    return { rate: await storeRate(env, today), date: today };
  } catch { /* 往下退回舊資料 */ }

  const near = await env.DB
    .prepare("SELECT date, rate_to_twd FROM fx_rates WHERE currency = 'GBP' ORDER BY date DESC LIMIT 1")
    .first();
  if (!near) return { rate: null, date: null };
  return { rate: near.rate_to_twd, date: near.date, stale: true };
}

// ---------------------------------------------------------------- 同步

function sqlValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return String(v);
}

async function handleSync(request, env) {
  const body = await request.json().catch(() => ({}));
  const lastSeq = Number.isFinite(body.last_seq) ? body.last_seq : 0;
  const incoming = body.changes && typeof body.changes === "object" ? body.changes : {};

  const state = await env.DB.prepare("SELECT seq FROM sync_state WHERE id = 1").first();
  let seq = state ? state.seq : 0;

  // ---- 推：客戶端的變更寫進 D1
  const statements = [];
  const pushedIds = {};

  for (const [table, cols] of Object.entries(SYNC_TABLES)) {
    const rows = Array.isArray(incoming[table]) ? incoming[table] : [];
    if (!rows.length) continue;
    pushedIds[table] = new Set();

    for (const row of rows) {
      if (!row || typeof row.id !== "string" || !row.id) continue;
      if (typeof row.updated_at !== "string" || !row.updated_at) continue;

      seq += 1;
      pushedIds[table].add(row.id);

      const allCols = [...cols, "server_seq"];
      const values = cols.map((c) => sqlValue(row[c]));
      values.push(seq);

      // 只有比資料庫裡更新的版本才蓋過去（last-write-wins）
      const setClause = allCols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");
      const sql =
        `INSERT INTO ${table} (${allCols.join(", ")}) VALUES (${allCols.map(() => "?").join(", ")}) ` +
        `ON CONFLICT(id) DO UPDATE SET ${setClause} WHERE excluded.updated_at > ${table}.updated_at`;

      statements.push(env.DB.prepare(sql).bind(...values));
    }
  }

  if (statements.length) {
    statements.push(env.DB.prepare("UPDATE sync_state SET seq = ? WHERE id = 1").bind(seq));
    await env.DB.batch(statements);
  }

  // ---- 拉：伺服器上比 last_seq 新的東西（排掉剛剛自己推上去的，省流量）
  const outgoing = {};
  for (const [table, cols] of Object.entries(SYNC_TABLES)) {
    const { results } = await env.DB
      .prepare(`SELECT ${[...cols, "server_seq"].join(", ")} FROM ${table} WHERE server_seq > ? ORDER BY server_seq`)
      .bind(lastSeq).all();
    const mine = pushedIds[table];
    const rows = (results || []).filter((r) => !mine || !mine.has(r.id));
    if (rows.length) outgoing[table] = rows;
  }

  // 匯率搭同步的順風車回去。它不是同步表（伺服器單方面提供的參考資料），
  // 但每次同步都帶最新的，客戶端就不必另外排一次請求。
  // 抓不到就回 null，客戶端沿用上次快取的，離線也還有東西可以換算。
  let fx = null;
  try { fx = await currentRate(env); } catch { /* 沒有匯率不該讓同步失敗 */ }

  return json({ ok: true, seq, changes: outgoing, fx, server_time: new Date().toISOString() });
}

// ---------------------------------------------------------------- 照片

const PHOTO_ID = /^[A-Za-z0-9_-]{6,64}$/;

// 上傳用 PUT + 客戶端自己給的 id：同一張重試不會在 R2 留下兩份
async function handlePhotoPut(request, env, id) {
  if (!PHOTO_ID.test(id)) return json({ error: "照片 id 格式不對" }, 400);
  if (!env.PHOTOS) return json({ error: "這個環境沒有 R2 binding，照片無法上傳" }, 501);

  const type = request.headers.get("Content-Type") || "image/jpeg";
  if (!type.startsWith("image/")) return json({ error: "只接受圖片" }, 415);

  const key = `labels/${id}.jpg`;
  await env.PHOTOS.put(key, request.body, { httpMetadata: { contentType: type } });
  return json({ ok: true, id, r2_key: key });
}

async function handlePhotoGet(env, id) {
  if (!PHOTO_ID.test(id)) return json({ error: "照片 id 格式不對" }, 400);
  if (!env.PHOTOS) return json({ error: "這個環境沒有 R2 binding" }, 501);

  const obj = await env.PHOTOS.get(`labels/${id}.jpg`);
  if (!obj) return json({ error: "找不到這張照片" }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  // 照片內容不會變，但它是私人資料，只能存在瀏覽器自己的快取裡
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------- 辨識

// 接受 { image: dataURI } 或 { photo_id }（已經上傳到 R2 的就不必再傳一次）
async function imageFromBody(env, body) {
  if (typeof body.image === "string" && body.image.startsWith("data:image/")) return body.image;

  if (typeof body.photo_id === "string" && PHOTO_ID.test(body.photo_id) && env.PHOTOS) {
    const obj = await env.PHOTOS.get(`labels/${body.photo_id}.jpg`);
    if (!obj) return null;
    const buf = new Uint8Array(await obj.arrayBuffer());
    let s = "";
    // 分段轉：一次把整個陣列展開丟進 fromCharCode 會爆掉呼叫堆疊
    for (let i = 0; i < buf.length; i += 8192) {
      s += String.fromCharCode(...buf.subarray(i, i + 8192));
    }
    return "data:image/jpeg;base64," + btoa(s);
  }

  return null;
}

// ---------------------------------------------------------------- API 路由

async function handleApi(request, env, path) {
  const method = request.method;

  if (path === "/api/login" && method === "POST") {
    const { password } = await request.json().catch(() => ({}));
    const ip = request.headers.get("CF-Connecting-IP") || "local";

    const wait = loginDelay(ip);
    if (wait) await sleep(wait);

    const expected = secrets(env).password;
    if (!expected) return json({ error: "伺服器還沒設定密碼（wrangler secret put APP_PASSWORD）" }, 500);
    if (typeof password !== "string" || !timingSafeEqual(password, expected)) {
      noteLoginFail(ip);
      return json({ error: "密碼錯誤 Wrong password" }, 401);
    }

    loginFails.delete(ip);
    const token = await makeToken(env);
    return json({ ok: true }, 200, {
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
    });
  }

  if (path === "/api/session" && method === "GET") {
    return json({ authed: await isAuthed(request, env) });
  }

  if (!(await isAuthed(request, env))) return json({ error: "未登入 Not signed in" }, 401);

  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  if (path === "/api/sync" && method === "POST") {
    return handleSync(request, env);
  }

  const photo = path.match(/^\/api\/photo\/([^/]+)$/);
  if (photo) {
    if (method === "PUT") return handlePhotoPut(request, env, photo[1]);
    if (method === "GET") return handlePhotoGet(env, photo[1]);
  }

  if (path === "/api/extract" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const image = await imageFromBody(env, body);
    if (!image) return json({ error: "沒有拿到圖片" }, 400);

    const model = typeof body.model === "string" && body.model ? (MODELS[body.model] || body.model) : null;
    return json(await extractLabel(env, image, model));
  }

  // Phase 0：同一張照片跑過所有候選模型，人肉比對誰準
  if (path === "/api/extract/bakeoff" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const image = await imageFromBody(env, body);
    if (!image) return json({ error: "沒有拿到圖片" }, 400);
    return json({ default: DEFAULT_MODEL, results: await bakeOff(env, image) });
  }

  if (path === "/api/fx" && method === "GET") {
    return json(await currentRate(env));
  }

  if (path === "/api/models" && method === "GET") {
    return json({ models: MODELS, current: env.EXTRACT_MODEL || DEFAULT_MODEL, ai: !!env.AI, r2: !!env.PHOTOS });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------- 進入點

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url.pathname);
      } catch (err) {
        console.error("API error", err);
        return json({ error: "伺服器錯誤：" + (err && err.message ? err.message : String(err)) }, 500);
      }
    }

    // 找不到對應檔案時回 app shell 這件事，交給 wrangler.toml 的
    // not_found_handling = "single-page-application" 處理
    return env.ASSETS.fetch(request);
  },

  // 每天更新一次匯率。沒有這個 cron 也不會壞 —— currentRate() 在當天沒資料時
  // 會自己即時抓一次，cron 只是讓第一個打開 App 的人不必等那一下。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      storeRate(env, new Date().toISOString().slice(0, 10))
        .then((r) => console.log("匯率已更新 1 GBP =", r, "TWD"))
        .catch((e) => console.error("匯率更新失敗", e))
    );
  },
};
