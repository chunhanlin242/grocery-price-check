// Service Worker：讓 App 在超市裡完全沒訊號時也能瞬間打開。
//
// 規則：
//   /api/*  → 只走網路，絕不快取（資料由 IndexedDB 負責，照片有自己的快取策略）
//   導覽    → 直接給快取的 app shell，同時背景更新
//   靜態檔  → 同上（stale-while-revalidate）
//
// 導覽為什麼是「快取優先」而不是「網路優先」：
// 超市裡最麻煩的不是完全沒網路，而是連得上卻慢得要命。網路優先會讓開啟 App
// 卡在等逾時；反正資料在 IndexedDB，shell 拿舊的也無所謂。

const VERSION = "v10";
const CACHE = "pc-shell-" + VERSION;

// 注意：不要放 "/index.html"。
// 靜態資源伺服器會把 /index.html 轉址到 /，快取到的會是一個 redirected 回應，
// 而帶 redirected 標記的回應不能拿來回應導覽請求，會直接變成網路錯誤。
const SHELL = [
  "/",
  "/app.css",
  "/app.js",
  "/db.js",
  "/units.js",
  "/stores.js",
  "/emoji.js",
  "/export.js",
  "/fx.js",
  "/i18n.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // 逐一加入：某一支失敗不該讓整批都不見（addAll 是全有全無）
      .then((cache) => Promise.all(
        SHELL.map((url) =>
          fetch(url, { cache: "reload" })
            .then((res) => (res.ok && !res.redirected ? cache.put(url, res) : null))
            .catch(() => null)
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function refresh(request, cache) {
  return fetch(request)
    .then((res) => {
      if (res && res.ok && !res.redirected) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;   // 交給瀏覽器直接處理

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match("/");
      if (cached) {
        event.waitUntil(refresh(new Request("/"), cache));
        return cached;
      }
      const live = await fetch(request).catch(() => null);
      return live || new Response(
        "<meta charset=utf-8><p style=font-family:sans-serif>離線中，且尚未快取此頁。連上網路後再開一次即可。",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) {
      event.waitUntil(refresh(request, cache));
      return cached;
    }
    const live = await refresh(request, cache);
    return live || new Response("", { status: 504 });
  })());
});
