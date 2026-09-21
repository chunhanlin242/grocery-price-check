-- price-check：英國超市比價 / UK supermarket price comparison
--
-- 設計重點
-- 1. 同步表都有 id(客戶端 UUID) / created_at / updated_at / deleted_at / server_seq，
--    跟 travel-money 同一套機制（server_seq 單調遞增，客戶端靠它問「上次之後有什麼新東西」）。
-- 2. 刻意「不」加外鍵：同步時 prices 可能比 products 先到，有外鍵會直接被擋。
--    完整性由應用層負責。
-- 3. 價格一律用整數便士。籃子比價要做大量加總排序，浮點誤差在「總價差 3p」
--    這種場景會直接騙人。
-- 4. 三層結構 items → products → prices。不分層就沒辦法比價：
--    Aldi 2L 牛奶 £1.45 對上 Waitrose 1.13L £1.35，直接比數字會得到相反的結論。

CREATE TABLE IF NOT EXISTS sync_state (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sync_state (id, seq) VALUES (1, 0);

-- 品項：我心中的「同一個東西」，跨店比價的單位
-- 例：「全脂牛奶 / Whole Milk」「雞胸肉 / Chicken Breast」
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  name_zh    TEXT NOT NULL,
  name_en    TEXT NOT NULL DEFAULT '',
  base_unit  TEXT NOT NULL DEFAULT 'g',    -- 'g' | 'ml' | 'each'
  category   TEXT NOT NULL DEFAULT 'other',
  -- 使用者自己挑的圖示。空的就由 public/emoji.js 從名稱猜，再猜不到才用分類的。
  -- 既有資料庫要補這一欄：ALTER TABLE items ADD COLUMN emoji TEXT;
  emoji      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_seq ON items(server_seq);

-- 各店商品：某家店賣的具體商品，掛在一個 item 底下。
-- 同一個 item 底下各店容量可以不同 —— 這正是要分層的理由。
CREATE TABLE IF NOT EXISTS products (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  store_id   TEXT NOT NULL,                -- 對應 public/stores.js 的常數表
  brand      TEXT,                         -- 空的代表自有品牌
  name_en    TEXT NOT NULL DEFAULT '',     -- 貨架上印的原文，去店裡要靠它找
  size       REAL,                         -- 容量數值
  size_unit  TEXT NOT NULL DEFAULT 'g',    -- 'g'|'kg'|'ml'|'l'|'each'
  barcode    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_products_seq  ON products(server_seq);
CREATE INDEX IF NOT EXISTS idx_products_item ON products(item_id);

-- 價格觀測：某個 product 在某天看到的價格。
-- 一個 product 會有很多筆，最新的那筆代表現價，全部合起來就是走勢。
CREATE TABLE IF NOT EXISTS prices (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  price_pence  INTEGER NOT NULL,
  observed_on  TEXT NOT NULL,              -- 當地 YYYY-MM-DD
  is_promo     INTEGER NOT NULL DEFAULT 0,
  promo_note   TEXT,                       -- 'Nectar price' / 'Clubcard' / '黃標' …
  branch       TEXT,                       -- 哪一家分店，價格偶爾會不一樣
  photo_id     TEXT,
  source       TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'ai'
  label_unit_price TEXT,                   -- 標籤上原本印的單價字串，事後核對用
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  server_seq   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prices_seq     ON prices(server_seq);
CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id);
CREATE INDEX IF NOT EXISTS idx_prices_date    ON prices(observed_on);

-- 照片：R2 物件的對照表。二進位內容在 R2，不進 D1。
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  r2_key     TEXT NOT NULL,
  store_id   TEXT,
  taken_at   TEXT,
  width      INTEGER,
  height     INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_photos_seq ON photos(server_seq);

-- 購物清單
CREATE TABLE IF NOT EXISTS lists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);

-- 清單項目。
-- ★ 放的是 item 不是 product：比價時各店各自取自己 item 底下最新的價格，
--   這樣才不會被「我只在某家店建過商品」綁死。
-- qty 用顯示單位計（g 基底 → kg，ml 基底 → L，each → 個），
-- 換算成基底單位後乘以各店單價，才能公平比較不同包裝大小。
CREATE TABLE IF NOT EXISTS list_items (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  qty        REAL NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  checked    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_list_items_seq  ON list_items(server_seq);
CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);

-- 自訂店家。內建的連鎖店寫在 public/stores.js，不進資料庫 ——
-- 那份清單幾乎不會變，同步它只是浪費，而且會害每台裝置都要等同步完才看得到店。
-- 小店只有使用者自己知道，必須跟價格一起同步，不然別台裝置顯示不出店名。
--
-- 欄位叫 group_id 不是 group：group 是 SQL 保留字。
CREATE TABLE IF NOT EXISTS stores (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  group_id   TEXT NOT NULL DEFAULT 'uk',   -- 'uk' | 'asian'
  color      TEXT,
  note       TEXT,                          -- 地址或「哪一家」，小店常常需要
  sort       INTEGER NOT NULL DEFAULT 0,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  server_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stores_seq ON stores(server_seq);

-- 匯率快取。只需要 GBP→TWD 一組，但沿用 travel-money 的表結構，
-- 之後要加歐元之類的不用改 schema。
--
-- 注意：這裡的匯率**不會**被凍結到每一筆價格上（travel-money 才那樣做）。
-- 這個 App 問的是「這東西貴不貴」，永遠用最新匯率換算才對；台幣只是參考值，
-- 不參與任何排序或加總。
CREATE TABLE IF NOT EXISTS fx_rates (
  date        TEXT NOT NULL,      -- YYYY-MM-DD
  currency    TEXT NOT NULL,      -- 'GBP'
  rate_to_twd REAL NOT NULL,      -- 1 單位該幣 = ? TWD
  source      TEXT,
  PRIMARY KEY (date, currency)
);
CREATE INDEX IF NOT EXISTS idx_fx_date ON fx_rates(date);
