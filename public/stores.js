// 超市清單 = 內建的連鎖店 + 使用者自己新增的店。
//
// 為什麼內建的不放 D1：那十幾家連鎖幾乎不會變，同步它們只是浪費，
// 而且每台裝置都要先等同步完才看得到店家，站在貨架前面很煩。
//
// 為什麼自訂的要放 D1：小店（轉角的亞洲雜貨、市集攤位）只有使用者自己知道，
// 而且必須跟價格一起同步到別台裝置，不然電腦上看到的紀錄會顯示不出店名。
//
// 店名一律用招牌上的原名，不翻譯 —— 不然在店裡對不上。
//
// ---------------------------------------------------------------- 為什麼要分組
//
// 這幾組不是同一個貨架上的競爭關係。醬油、米酒、豆瓣醬在 Aldi 根本買不到；
// 牛奶、麵包也不會特地去亞洲超市買；轉角蔬果行只賣那十幾樣但常常最便宜。
// 把它們混在同一個排行裡，會得到「Tian Tian 的牛奶比 Aldi 貴」跟
// 「蔬果行因為沒有衛生紙所以總價墊底」這兩種正確但完全沒有用的結論。
//
// 所以比價與籃子總價都**分組計算**，每一組各自算出自己的最便宜。
// 實際採買本來就是這樣：去 Aldi 買日常、去 Tian Tian 補亞洲食材、
// 順路在蔬果行買菜。

export const GROUPS = [
  { id: "uk",    zh: "一般超市", en: "Supermarkets",  icon: "🛒" },
  { id: "asian", zh: "亞洲超市", en: "Asian grocers", icon: "🥢" },
  // 獨立店家：蔬果行、肉舖、市集攤位、農場店、土耳其／中東雜貨…
  // 這一組幾乎全是自訂的，內建只給一個「沒有店名」用的收容所。
  { id: "indie", zh: "獨立店家", en: "Independent",   icon: "🏪" },
];

// 加第四組時只要往 GROUPS 加一列就好 —— 排行、籃子、店家列、店家編輯的
// 下拉選單全都是照著 GROUPS 跑的。這個集合是唯一需要一起維護的東西。
const GROUP_IDS = new Set(GROUPS.map((g) => g.id));

// 不認得的組別一律歸到一般超市。舊資料、手動改壞的資料都可能出現，
// 直接讓它從比價裡消失比顯示錯位置更糟。
export const normGroup = (g) => (GROUP_IDS.has(g) ? g : "uk");

const BUILTIN = [
  // 一般超市
  { id: "sainsburys", group: "uk", name: "Sainsbury's", short: "SB", color: "#f06c00" },
  { id: "waitrose",   group: "uk", name: "Waitrose",    short: "WR", color: "#5a8f29" },
  { id: "coop",       group: "uk", name: "Co-op",       short: "CO", color: "#00b1e7" },
  { id: "aldi",       group: "uk", name: "Aldi",        short: "AL", color: "#24387f" },
  { id: "lidl",       group: "uk", name: "Lidl",        short: "LD", color: "#0050aa" },
  { id: "tesco",      group: "uk", name: "Tesco",       short: "TE", color: "#00539f" },
  { id: "asda",       group: "uk", name: "Asda",        short: "AS", color: "#68a51c" },
  { id: "morrisons",  group: "uk", name: "Morrisons",   short: "MO", color: "#c8a200" },
  { id: "ms",         group: "uk", name: "M&S Food",    short: "MS", color: "#3d3d3d" },
  { id: "iceland",    group: "uk", name: "Iceland",     short: "IC", color: "#cc0000" },
  { id: "ocado",      group: "uk", name: "Ocado",       short: "OC", color: "#7b1fa2" },
  { id: "other",      group: "uk", name: "Other",       short: "··", color: "#737373" },

  // 亞洲超市
  { id: "tiantian",   group: "asian", name: "Tian Tian Market", short: "TT", color: "#b3121b" },
  { id: "starrymart", group: "asian", name: "Starry Mart",      short: "SM", color: "#00838f" },
  { id: "asianother", group: "asian", name: "Other Asian",      short: "··", color: "#8d6e63" },

  // 獨立店家（其餘都靠自己新增）
  { id: "indieother", group: "indie", name: "Other independent", short: "··", color: "#455a64" },
].map((s) => ({ ...s, builtin: true }));

// 自訂店家的配色。挑得開、深淺一致，而且跟內建那些不要撞得太厲害。
export const PALETTE = [
  "#e8590c", "#c2185b", "#7b1fa2", "#3949ab",
  "#0277bd", "#00897b", "#558b2f", "#8d6e63",
];

// ---------------------------------------------------------------- 執行期登錄

let custom = [];          // 使用者自訂，含已軟刪除的（名稱還要查得到）
let index = new Map();

function rebuild() {
  index = new Map();
  for (const s of BUILTIN) index.set(s.id, s);
  for (const s of custom) index.set(s.id, s);
}
rebuild();

// D1 的欄位叫 group_id（group 是 SQL 保留字），這裡轉回程式裡用的 group
function normalise(row) {
  return {
    id: row.id,
    group: normGroup(row.group_id),
    name: row.name || "",
    short: (row.name || "?").slice(0, 2).toUpperCase(),
    color: row.color || PALETTE[0],
    note: row.note || "",
    sort: Number.isFinite(row.sort) ? row.sort : 0,
    archived: !!row.archived,
    deleted_at: row.deleted_at || null,
    builtin: false,
  };
}

// app.js 每次 reload() 後呼叫一次
export function setCustomStores(rows) {
  custom = (rows || []).map(normalise);
  rebuild();
}

// 給選單／排行用：不含已刪除與已封存的
export function allStores() {
  const live = custom
    .filter((s) => !s.deleted_at && !s.archived)
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
  return [...BUILTIN, ...live];
}

// 給設定頁的管理清單用：含封存的，不含已刪除的
export function customStores() {
  return custom
    .filter((s) => !s.deleted_at)
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
}

// 查名稱／顏色時要連「已刪除的店」都查得到 —— 底下的歷史價格還掛在它身上，
// 顯示成一串 UUID 會讓人完全不知道那是什麼。
export const storeById = (id) => index.get(id) || null;
export const storeName = (id) => (index.get(id) || {}).name || id || "";
export const storeColor = (id) => (index.get(id) || {}).color || "#737373";

// 不認得的 store_id 一律歸到一般超市，比價才不會整組消失
export const storeGroup = (id) => (index.get(id) || {}).group || "uk";

export const storesOfGroup = (group) => allStores().filter((s) => s.group === group);
export const groupById = (id) => GROUPS.find((g) => g.id === id) || GROUPS[0];
