// 貨架標籤辨識。
//
// 為什麼抽成獨立檔案而不是塞進 index.js：辨識這件事一定會換 provider。
// 目前用 Workers AI（免費額度 10,000 Neurons/日），準確度不夠就改 AI_PROVIDER，
// 呼叫端（handleApi）完全不用動。
//
// 這裡回傳的東西一律只是「建議值」。它會進確認卡讓人改，不會直接寫進資料庫 ——
// 錯的價格比沒有價格更糟，它會污染之後所有的比價結論。

// Workers AI 候選模型。
//
// 2026-08-21 用一張合成的 Sainsbury's 標籤實測過，三個都能正確讀出
// 品名／容量／價格／標籤單價，差別在速度：
//   scout  1.3s   ← 預設。一樣準又最快，站在貨架前面等 10 秒是不能接受的
//   qwen   3.1s
//   gemma 10.1s   會先寫一大段 reasoning，所以 max_tokens 不能給太小
//
// 刻意沒有收錄的：
//   moondream3.1     這個帳號打過去只回 {}，186ms 根本沒跑推論
//   llama-3.2-vision 要先手動同意授權條款，而且限制歐盟用戶
export const MODELS = {
  scout: "@cf/meta/llama-4-scout-17b-16e-instruct",
  qwen:  "@cf/qwen/qwen3.8-27b",
  gemma: "@cf/google/gemma-4-26b-a4b-it",
};

export const DEFAULT_MODEL = MODELS.scout;

// 英國貨架標籤本身就印了品名、售價、以及 £/kg 或 £/100g 的單價，資訊很完整，
// 難的是叫模型「只」回 JSON。所以規則寫死、範例給滿。
const PROMPT = `You are reading a UK supermarket shelf price label from a photo.

Return ONLY a JSON object. No markdown fences, no explanation, no extra text.

{"name_en":string|null,"brand":string|null,"size":number|null,"size_unit":"g"|"kg"|"ml"|"l"|"each"|null,"price_pence":integer|null,"label_unit_price":string|null,"is_promo":boolean,"promo_note":string|null}

Rules:
- price_pence is what the customer pays TODAY, in pence. "£1.45" -> 145. "89p" -> 89. "£12" -> 1200.
- If a promo price (Nectar / Clubcard / Price Match / Aldi Price Match / yellow reduced sticker) is
  shown next to a higher regular price, use the PROMO price, set is_promo true, and put the scheme
  name in promo_note. Otherwise is_promo false and promo_note null.
- size / size_unit come from the pack size printed on the label. "2L" -> 2,"l". "500g" -> 500,"g".
  "6 x 400g" -> 2400,"g". "Each" or a single loose item -> 1,"each".
- brand is null for supermarket own-label products (by Sainsbury's, Essential Waitrose, Co-op,
  Aldi's own brands, Lidl's own brands).
- label_unit_price is the small-print unit price copied EXACTLY as shown, e.g. "£1.09/kg" or "27.5p/100g".
- If a field is not clearly visible, use null. Never guess a price.`;

// 各模型的輸入格式不同：聊天式模型吃 messages + image_url，moondream 吃 image + question。
//
// max_tokens 給到 2048 是有原因的：gemma 這類會先「想」的模型，
// 512 全部被 reasoning 吃掉，正式答案一個字都還沒寫就被截斷了
// （finish_reason: length，content 是空字串）。
function buildInput(model, dataUri) {
  // moondream 系列走另一套 schema（image + task + question），
  // 目前沒有收錄任何一個，留著這條路是為了之後要加時不用重想。
  if (/moondream/i.test(model)) {
    return { image: dataUri, task: "query", question: PROMPT, max_tokens: 2048, temperature: 0.1 };
  }
  return {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: PROMPT },
        { type: "image_url", image_url: { url: dataUri } },
      ],
    }],
    max_tokens: 2048,
    temperature: 0.1,
  };
}

// 各模型的回傳欄位也不同，全部收斂成一段文字
function readText(res) {
  if (!res) return "";
  if (typeof res === "string") return res;
  if (typeof res.response === "string" && res.response) return res.response;
  if (typeof res.answer === "string" && res.answer) return res.answer;
  if (typeof res.text === "string" && res.text) return res.text;

  const choice = res.choices && res.choices[0];
  if (choice) {
    if (typeof choice.message?.content === "string" && choice.message.content) return choice.message.content;
    if (typeof choice.text === "string" && choice.text) return choice.text;
    // 最後手段：會思考的模型偶爾把整段 JSON 留在 reasoning 裡就結束了
    if (typeof choice.message?.reasoning_content === "string") return choice.message.reasoning_content;
  }
  return "";
}

// 模型常常還是會包 ```json 或前後加一句話，所以不能直接 JSON.parse
function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

const UNITS = ["g", "kg", "ml", "l", "each"];

// 模型會回各種形狀的東西，這裡把它收斂成資料庫塞得進去的樣子。
// 寧可把不確定的欄位變成 null 讓人自己填，也不要塞一個看起來合理但錯的值。
function normalise(raw) {
  if (!raw || typeof raw !== "object") return null;

  const str = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s && s.toLowerCase() !== "null" && s.toLowerCase() !== "n/a" ? s : null;
  };

  let pence = null;
  if (typeof raw.price_pence === "number" && Number.isFinite(raw.price_pence)) {
    pence = Math.round(raw.price_pence);
  } else if (typeof raw.price_pence === "string") {
    // "145" / "£1.45" / "1.45" 都可能出現。有小數點或 £ 就當英鎊。
    const t = raw.price_pence.replace(/[,\s]/g, "");
    const num = parseFloat(t.replace(/[^\d.]/g, ""));
    if (Number.isFinite(num)) pence = /[£.]/.test(t) ? Math.round(num * 100) : Math.round(num);
  }
  // 一罐東西超過 £200 幾乎一定是辨識錯（多讀了一位數），不如不給
  if (pence !== null && (pence <= 0 || pence > 20000)) pence = null;

  let size = Number(raw.size);
  if (!Number.isFinite(size) || size <= 0) size = null;

  let unit = str(raw.size_unit);
  unit = unit && UNITS.includes(unit.toLowerCase()) ? unit.toLowerCase() : null;

  return {
    name_en: str(raw.name_en),
    brand: str(raw.brand),
    size,
    size_unit: unit,
    price_pence: pence,
    label_unit_price: str(raw.label_unit_price),
    is_promo: raw.is_promo === true || raw.is_promo === 1 || raw.is_promo === "true",
    promo_note: str(raw.promo_note),
  };
}

// 跑單一模型。回 { ok, data, raw, model, ms, error }
export async function runModel(env, model, dataUri) {
  const started = Date.now();
  if (!env.AI) return { ok: false, model, error: "這個環境沒有 AI binding", ms: 0 };

  try {
    const res = await env.AI.run(model, buildInput(model, dataUri));
    const text = readText(res);
    const data = normalise(parseJson(text));

    // 讀不出文字時把整包原始回應丟出來。模型比對的重點就是知道「為什麼失敗」——
    // 是輸入格式餵錯了，還是它真的看不懂標籤。這兩件事的處理方式完全不同。
    let raw = text.slice(0, 1200);
    if (!raw) {
      try { raw = "(未匹配的回應形狀) " + JSON.stringify(res).slice(0, 900); } catch { raw = "(無法序列化的回應)"; }
    }

    return {
      ok: !!data,
      model,
      data,
      raw,
      ms: Date.now() - started,
      error: data ? null : (text ? "模型回的不是可解析的 JSON" : "沒有從回應裡讀到任何文字"),
    };
  } catch (err) {
    return {
      ok: false,
      model,
      error: (err && err.message) || String(err),
      ms: Date.now() - started,
    };
  }
}

// 正式辨識：跑設定好的那個模型
export async function extractLabel(env, dataUri, modelOverride) {
  const model = modelOverride || env.EXTRACT_MODEL || DEFAULT_MODEL;
  return runModel(env, model, dataUri);
}

// Phase 0 用：同一張照片跑過所有候選模型，回傳結果讓人肉眼比對誰準。
// 這一步的結論決定 App 預設用哪個模型，或決定乾脆放棄 AI 只留手動輸入。
export async function bakeOff(env, dataUri) {
  const names = Object.keys(MODELS);
  const results = await Promise.all(names.map((n) => runModel(env, MODELS[n], dataUri)));
  return Object.fromEntries(names.map((n, i) => [n, results[i]]));
}
