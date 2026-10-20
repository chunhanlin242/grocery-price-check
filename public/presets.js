// 常用品項。新增品項的選單裡照分類列出來，點一下就建立，不用打字。
//
// 只是起點：還沒建過的東西（像羊肉片）也點得到，建了之後就是普通的品項，
// 名稱、分類都能改。已經有同名品項的不會再列出來。
//
// 計價基準只是猜測。猜錯也沒關係 —— 品項底下還沒有商品時，第一次記價的標籤
// 會把它改對（見 app.js reconcileUnit()），所以這裡寧可照「英國超市標籤最常寫什麼」填。

// [中文名, 英文名, 計價基準 g/ml/each, 分類]
export const PRESETS = [
  // 蔬菜
  ["櫛瓜", "Courgette", "g", "veg"],
  ["青江菜", "Pak choi", "g", "veg"],
  ["大白菜", "Chinese leaf", "g", "veg"],
  ["高麗菜", "Cabbage", "each", "veg"],
  ["菠菜", "Spinach", "g", "veg"],
  ["生菜", "Lettuce", "each", "veg"],
  ["豆芽菜", "Beansprouts", "g", "veg"],
  ["洋蔥", "Onions", "g", "veg"],
  ["青蔥", "Spring onions", "each", "veg"],
  ["大蒜", "Garlic", "each", "veg"],
  ["薑", "Ginger", "g", "veg"],
  ["紅蘿蔔", "Carrots", "g", "veg"],
  ["馬鈴薯", "Potatoes", "g", "veg"],
  ["地瓜", "Sweet potatoes", "g", "veg"],
  ["番茄", "Tomatoes", "g", "veg"],
  ["小黃瓜", "Cucumber", "each", "veg"],
  ["甜椒", "Peppers", "each", "veg"],
  ["茄子", "Aubergine", "each", "veg"],
  ["香菇", "Mushrooms", "g", "veg"],
  ["花椰菜", "Broccoli", "g", "veg"],

  // 水果
  ["蘋果", "Apples", "each", "fruit"],
  ["香蕉", "Bananas", "each", "fruit"],
  ["柳橙", "Oranges", "each", "fruit"],
  ["檸檬", "Lemons", "each", "fruit"],
  ["奇異果", "Kiwi", "each", "fruit"],
  ["酪梨", "Avocado", "each", "fruit"],
  ["芒果", "Mango", "each", "fruit"],
  ["葡萄", "Grapes", "g", "fruit"],
  ["草莓", "Strawberries", "g", "fruit"],
  ["藍莓", "Blueberries", "g", "fruit"],

  // 肉類
  ["雞腿排", "Chicken thigh fillets", "g", "meat"],
  ["雞胸肉", "Chicken breast", "g", "meat"],
  ["雞翅", "Chicken wings", "g", "meat"],
  ["豬五花", "Pork belly", "g", "meat"],
  ["豬肉片", "Pork slices", "g", "meat"],
  ["豬絞肉", "Pork mince", "g", "meat"],
  ["牛肉片", "Beef slices", "g", "meat"],
  ["牛絞肉", "Beef mince", "g", "meat"],
  ["牛排", "Steak", "g", "meat"],
  ["羊肉片", "Lamb slices", "g", "meat"],
  ["羊肉", "Lamb", "g", "meat"],
  ["培根", "Bacon", "g", "meat"],
  ["香腸", "Sausages", "g", "meat"],

  // 海鮮
  ["鮭魚", "Salmon", "g", "fish"],
  ["鱈魚", "Cod", "g", "fish"],
  ["鯖魚", "Mackerel", "g", "fish"],
  ["蝦仁", "Prawns", "g", "fish"],
  ["魷魚", "Squid", "g", "fish"],

  // 乳製品
  ["牛奶", "Milk", "ml", "dairy"],
  ["雞蛋", "Eggs", "each", "dairy"],
  ["優格", "Yoghurt", "g", "dairy"],
  ["起司", "Cheddar", "g", "dairy"],
  ["奶油", "Butter", "g", "dairy"],
  ["豆漿", "Soy drink", "ml", "dairy"],

  // 主食
  ["白米", "Rice", "g", "staples"],
  ["烏龍麵", "Udon", "g", "staples"],
  ["拉麵", "Ramen noodles", "g", "staples"],
  ["泡麵", "Instant noodles", "each", "staples"],
  ["義大利麵", "Pasta", "g", "staples"],
  ["豆腐", "Tofu", "g", "staples"],
  ["麵粉", "Flour", "g", "staples"],
  ["燕麥", "Oats", "g", "staples"],

  // 麵包
  ["吐司", "Bread", "g", "bakery"],
  ["貝果", "Bagels", "each", "bakery"],

  // 調味料
  ["醬油", "Soy sauce", "ml", "sauce"],
  ["米酒", "Rice wine", "ml", "sauce"],
  ["蠔油", "Oyster sauce", "ml", "sauce"],
  ["麻油", "Sesame oil", "ml", "sauce"],
  ["食用油", "Vegetable oil", "ml", "sauce"],
  ["橄欖油", "Olive oil", "ml", "sauce"],
  ["醋", "Vinegar", "ml", "sauce"],
  ["味噌", "Miso", "g", "sauce"],
  ["鹽", "Salt", "g", "sauce"],
  ["糖", "Sugar", "g", "sauce"],

  // 罐頭乾貨
  ["椰奶", "Coconut milk", "ml", "tinned"],
  ["番茄罐頭", "Chopped tomatoes", "g", "tinned"],
  ["鮪魚罐頭", "Tinned tuna", "g", "tinned"],

  // 冷凍
  ["冷凍水餃", "Frozen dumplings", "g", "frozen"],
  ["冷凍蔬菜", "Frozen vegetables", "g", "frozen"],
  ["冰淇淋", "Ice cream", "ml", "frozen"],

  // 零食
  ["洋芋片", "Crisps", "g", "snacks"],
  ["餅乾", "Biscuits", "g", "snacks"],
  ["巧克力", "Chocolate", "g", "snacks"],
  ["堅果", "Nuts", "g", "snacks"],

  // 飲料
  ["礦泉水", "Water", "ml", "drinks"],
  ["果汁", "Juice", "ml", "drinks"],
  ["咖啡", "Coffee", "g", "drinks"],
  ["茶包", "Tea bags", "each", "drinks"],
  ["可樂", "Cola", "ml", "drinks"],

  // 酒
  ["啤酒", "Beer", "ml", "alcohol"],
  ["葡萄酒", "Wine", "ml", "alcohol"],

  // 家用
  ["衛生紙", "Toilet roll", "each", "household"],
  ["廚房紙巾", "Kitchen roll", "each", "household"],
  ["洗碗精", "Washing up liquid", "ml", "household"],
  ["洗衣精", "Laundry detergent", "ml", "household"],
  ["垃圾袋", "Bin bags", "each", "household"],

  // 個人用品
  ["洗髮精", "Shampoo", "ml", "personal"],
  ["沐浴乳", "Shower gel", "ml", "personal"],
  ["牙膏", "Toothpaste", "ml", "personal"],
];
