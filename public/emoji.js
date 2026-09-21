// 品項圖示。
//
// 原本 emoji 是綁在「分類」上的，所以蘋果跟青江菜都拿到 🥬、蛋拿到 🥛 ——
// 分類只有 14 個，但你買的東西有幾百種，一對一永遠對不上。
//
// 現在改成三層，由上往下找：
//   1. items.emoji —— 你自己挑的，最優先
//   2. 名稱猜的   —— 這張表，中英文都比對
//   3. 分類的     —— 都猜不到才退回去
//
// 這樣既有的品項不需要任何資料搬遷就會自己變好看：emoji 欄位是空的，
// 直接落到第 2 層。
//
// 表的順序有意義：**先寫具體的**。「雞胸肉」要排在「雞」前面，
// 「牛奶」要排在「牛」前面，否則會被吃掉。

// [emoji, 關鍵字, 建議分類]
const TABLE = [
  // ---- 蛋白質（具體的先）
  ["🍗", ["雞胸", "雞腿", "雞肉", "雞排", "chicken breast", "chicken thigh", "chicken"], "meat"],
  ["🥓", ["培根", "豬五花", "豬肉", "bacon", "pork belly", "pork"], "meat"],
  ["🥩", ["牛肉", "牛排", "羊肉", "beef", "steak", "lamb", "mince"], "meat"],
  ["🌭", ["香腸", "熱狗", "sausage", "hot dog"], "meat"],
  ["🍖", ["排骨", "肋排", "rib"], "meat"],
  ["🦃", ["火雞", "turkey"], "meat"],
  ["🥚", ["雞蛋", "鴨蛋", "蛋$", "egg"], "dairy"],
  ["🫘", ["豆腐", "豆干", "豆乾", "tofu", "bean curd"], "staples"],
  ["🐟", ["鮭魚", "鱈魚", "鯖魚", "魚", "salmon", "cod", "haddock", "mackerel", "tuna", "fish"], "fish"],
  ["🦐", ["蝦", "prawn", "shrimp"], "fish"],
  ["🦑", ["花枝", "魷魚", "透抽", "squid", "calamari"], "fish"],
  ["🦪", ["蛤蜊", "淡菜", "生蠔", "mussel", "oyster", "clam"], "fish"],

  // ---- 乳製品
  ["🥛", ["牛奶", "鮮奶", "豆漿", "milk", "soy drink"], "dairy"],
  ["🧀", ["起司", "起士", "乳酪", "cheese", "cheddar", "mozzarella", "halloumi"], "dairy"],
  ["🧈", ["奶油", "butter", "margarine"], "dairy"],
  ["🍦", ["冰淇淋", "ice cream"], "frozen"],
  ["🥣", ["優格", "優酪", "yogurt", "yoghurt"], "dairy"],
  ["🥥", ["椰奶", "椰漿", "coconut milk"], "tinned"],

  // ---- 蔬果（水果）
  ["🍎", ["蘋果", "apple"], "produce"],
  ["🍌", ["香蕉", "banana"], "produce"],
  ["🍊", ["柳橙", "橘子", "橙", "orange", "satsuma", "clementine", "mandarin"], "produce"],
  ["🍋", ["檸檬", "萊姆", "lemon", "lime"], "produce"],
  ["🍇", ["葡萄", "grape"], "produce"],
  ["🍓", ["草莓", "strawberr"], "produce"],
  ["🫐", ["藍莓", "莓果", "blueberr", "berr"], "produce"],
  ["🍑", ["水蜜桃", "桃", "peach", "nectarine"], "produce"],
  ["🍐", ["梨", "pear"], "produce"],
  ["🍍", ["鳳梨", "pineapple"], "produce"],
  ["🥝", ["奇異果", "kiwi"], "produce"],
  ["🍉", ["西瓜", "watermelon"], "produce"],
  ["🥭", ["芒果", "mango"], "produce"],
  ["🍒", ["櫻桃", "cherr"], "produce"],
  ["🥑", ["酪梨", "avocado"], "produce"],

  // ---- 蔬果（蔬菜）
  ["🥬", ["青江菜", "小白菜", "大白菜", "高麗菜", "菠菜", "白菜", "生菜", "萵苣",
          "pak choi", "bok choy", "cabbage", "spinach", "lettuce", "greens", "kale"], "produce"],
  ["🌶️", ["泡菜", "辣椒", "kimchi", "chilli", "chili"], "produce"],
  ["🥒", ["櫛瓜", "小黃瓜", "黃瓜", "courgette", "zucchini", "cucumber"], "produce"],
  ["🍅", ["番茄", "蕃茄", "tomato"], "produce"],
  ["🥕", ["紅蘿蔔", "胡蘿蔔", "carrot"], "produce"],
  ["🧅", ["洋蔥", "青蔥", "蔥", "onion", "spring onion", "leek"], "produce"],
  ["🧄", ["大蒜", "蒜", "garlic"], "produce"],
  ["🥔", ["馬鈴薯", "薯", "potato"], "produce"],
  ["🍠", ["地瓜", "番薯", "sweet potato"], "produce"],
  ["🍄", ["香菇", "菇", "mushroom"], "produce"],
  ["🌽", ["玉米", "sweetcorn", "corn"], "produce"],
  ["🫑", ["甜椒", "青椒", "pepper", "capsicum"], "produce"],
  ["🍆", ["茄子", "aubergine", "eggplant"], "produce"],
  ["🥦", ["花椰菜", "青花菜", "broccoli", "cauliflower"], "produce"],
  ["🫚", ["薑", "ginger"], "produce"],

  // ---- 主食
  ["🍚", ["白米", "米飯", "糙米", "rice"], "staples"],
  ["🍜", ["拉麵", "烏龍", "泡麵", "麵條", "麵", "noodle", "ramen", "udon", "pasta", "spaghetti"], "staples"],
  ["🥟", ["餃子", "水餃", "餛飩", "小籠包", "燒賣", "dumpling", "wonton", "gyoza"], "staples"],
  ["🫓", ["蛋餅", "餅皮", "抓餅", "tortilla", "wrap", "flatbread", "pancake"], "bakery"],
  ["🍞", ["吐司", "土司", "麵包", "bread", "loaf", "toastie"], "bakery"],
  ["🥐", ["可頌", "croissant", "pastry"], "bakery"],
  ["🥖", ["法棍", "baguette"], "bakery"],
  ["🫓", ["貝果", "bagel", "pitta", "naan"], "bakery"],
  ["🌾", ["麵粉", "燕麥", "麥片", "flour", "oat", "cereal"], "staples"],

  // ---- 調味料
  ["🫗", ["醬油", "soy sauce", "shoyu"], "sauce"],
  ["🍶", ["米酒", "料理酒", "味醂", "rice wine", "mirin", "sake"], "sauce"],
  ["🍲", ["味噌", "miso"], "sauce"],
  ["🧂", ["鹽", "胡椒", "糖", "salt", "pepper corn", "sugar"], "sauce"],
  ["🫙", ["醋", "蠔油", "豆瓣", "辣椒醬", "沙茶", "vinegar", "oyster sauce", "paste"], "sauce"],
  ["🫒", ["橄欖油", "油", "olive oil", "oil"], "sauce"],
  ["🍯", ["蜂蜜", "果醬", "honey", "jam"], "sauce"],
  ["🥫", ["罐頭", "番茄糊", "tinned", "canned", "tin of"], "tinned"],

  // ---- 零食飲料
  ["🍫", ["巧克力", "chocolate"], "snacks"],
  ["🥜", ["堅果", "杏仁", "花生", "腰果", "nut", "almond", "peanut", "cashew"], "snacks"],
  ["🍪", ["餅乾", "biscuit", "cookie"], "snacks"],
  ["🥔", ["洋芋片", "薯片", "crisps"], "snacks"],
  ["☕", ["咖啡", "coffee"], "drinks"],
  ["🍵", ["茶", "tea"], "drinks"],
  ["🧃", ["果汁", "juice"], "drinks"],
  ["🥤", ["可樂", "汽水", "cola", "soda", "lemonade"], "drinks"],
  ["💧", ["礦泉水", "water"], "drinks"],
  ["🍺", ["啤酒", "beer", "lager", "cider", "ale"], "alcohol"],
  ["🍷", ["紅酒", "白酒", "葡萄酒", "wine"], "alcohol"],

  // ---- 家用／個人
  ["🧻", ["衛生紙", "廚房紙巾", "toilet roll", "kitchen roll", "tissue"], "household"],
  ["🧽", ["洗碗", "菜瓜布", "washing up", "sponge"], "household"],
  ["🧴", ["洗髮", "沐浴", "乳液", "shampoo", "shower gel", "lotion"], "personal"],
  ["🧼", ["肥皂", "洗手", "soap", "hand wash"], "personal"],
  ["🪥", ["牙膏", "牙刷", "toothpaste", "toothbrush"], "personal"],
  ["🧺", ["洗衣", "柔軟精", "laundry", "detergent"], "household"],
];

// 挑選面板用的清單。跟 TABLE 分開，因為這裡要的是「好挑」而不是「好比對」。
export const EMOJI_GROUPS = [
  ["蔬果 Produce", "🍎🍌🍊🍋🍇🍓🫐🍑🍐🍍🥝🍉🥭🍒🥑🥬🥒🍅🥕🧅🧄🥔🍠🍄🌽🫑🍆🥦🌶️🫚"],
  ["蛋白質 Protein", "🍗🥓🥩🌭🍖🦃🥚🫘🐟🦐🦑🦪"],
  ["乳製品 Dairy", "🥛🧀🧈🥣🍦"],
  ["主食 Staples", "🍚🍜🥟🫓🍞🥐🥖🌾🥯"],
  ["調味料 Condiments", "🫗🍶🍲🧂🫙🫒🍯🥫🥥"],
  ["零食飲料 Snacks", "🍫🥜🍪🍩🍰☕🍵🧃🥤💧🍺🍷"],
  ["家用 Household", "🧻🧽🧴🧼🪥🧺🔋💡"],
  ["其他 Other", "🛒🍱🥡🧊🌮🍕🥗🫕•"],
];

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// 從名稱猜圖示與分類。回 { emoji, category } 或 null。
//
// 關鍵字結尾的 `$` 代表「整個名稱就是它」——「蛋」如果用一般比對，
// 會把「蛋餅皮」「皮蛋」通通吃掉。
export function guess(...texts) {
  const hay = texts.map(norm).filter(Boolean);
  if (!hay.length) return null;

  for (const [emoji, keys, cat] of TABLE) {
    for (const key of keys) {
      if (key.endsWith("$")) {
        const exact = key.slice(0, -1);
        if (hay.some((h) => h === exact)) return { emoji, category: cat };
      } else if (hay.some((h) => h.includes(norm(key)))) {
        return { emoji, category: cat };
      }
    }
  }
  return null;
}

export const guessEmoji = (...t) => (guess(...t) || {}).emoji || null;
export const guessCategory = (...t) => (guess(...t) || {}).category || null;
