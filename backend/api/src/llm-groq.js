// Groq API integration (free tier: 30 req/min)
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const SKIP_LLM = process.env.SKIP_LLM === "true";

function parseNutrition(text) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    // Try to salvage truncated JSON by slicing to the last brace.
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace > 0) {
      try {
        return JSON.parse(text.slice(0, lastBrace + 1));
      } catch (_err2) {
        return null;
      }
    }
    return null;
  }
}

function parseNutritionLoosely(text) {
  const result = {};
  const grab = (key) => {
    const re = new RegExp(`"${key}"\\s*:\\s*([-\\d\\.]+)`, "i");
    const m = text.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const keys = [
    "calories",
    "protein_g",
    "total_carbs_g",
    "fiber_g",
    "sugars_g",
    "total_fat_g",
    "saturated_fat_g",
    "trans_fat_g",
    "cholesterol_mg",
    "sodium_mg",
    "vitamin_d_mcg",
    "calcium_mg",
    "iron_mg",
    "potassium_mg",
  ];
  keys.forEach((k) => {
    const v = grab(k);
    if (Number.isFinite(v)) result[k] = v;
  });
  return Object.keys(result).length ? result : null;
}

export async function estimateNutrition(foodName) {
  if (SKIP_LLM || !GROQ_API_KEY) {
    return { calories: 100, protein_g: 5, carbs_g: 15, fat_g: 3, source: `llm_groq_${GROQ_MODEL}_fallback_disabled` };
  }

  // Match the Ollama prompt: label-style values per single serving.
  const prompt = `Extract nutrition label values for a single typical serving of: "${foodName}".
If the name includes a quantity (e.g., "2 servings" or "2 cups"), keep values per ONE serving only.
Return JSON only with these exact keys (per serving): calories, protein_g, total_carbs_g, fiber_g, sugars_g, total_fat_g, saturated_fat_g, trans_fat_g, cholesterol_mg, sodium_mg, vitamin_d_mcg, calcium_mg, iron_mg, potassium_mg.
No text, only JSON.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 400,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const data = await response.json();
    if (data?.error?.code === "model_decommissioned") {
      throw new Error(`groq_model_decommissioned_${GROQ_MODEL}`);
    }
    const text = data.choices?.[0]?.message?.content || "{}";
    const loose = parseNutritionLoosely(text) || {};
    const strict =
      parseNutrition(text.match(/\{[^}]+\}/)?.[0] || "{}") ||
      parseNutrition(text) ||
      {};
    const parsed = { ...loose, ...strict };

    const clamp = (v, max = 2000) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return 0;
      return n > max ? max : n;
    };

    const defaults = {
      calories: 150,
      protein_g: 20,
      total_carbs_g: 0,
      fiber_g: 0,
      sugars_g: 0,
      total_fat_g: 8,
      saturated_fat_g: 1,
      trans_fat_g: 0,
      cholesterol_mg: 50,
      sodium_mg: 60,
      vitamin_d_mcg: 0,
      calcium_mg: 20,
      iron_mg: 0.5,
      potassium_mg: 300,
    };

    const result = {
      calories: clamp(parsed.calories ?? defaults.calories),
      protein_g: clamp(parsed.protein_g ?? defaults.protein_g),
      carbs_g: clamp(parsed.total_carbs_g ?? parsed.carbs_g ?? defaults.total_carbs_g),
      fat_g: clamp(parsed.total_fat_g ?? parsed.fat_g ?? defaults.total_fat_g),
      fiber_g: clamp(parsed.fiber_g ?? defaults.fiber_g),
      sugars_g: clamp(parsed.sugars_g ?? defaults.sugars_g),
      saturated_fat_g: clamp(parsed.saturated_fat_g ?? defaults.saturated_fat_g),
      trans_fat_g: clamp(parsed.trans_fat_g ?? defaults.trans_fat_g),
      cholesterol_mg: clamp(parsed.cholesterol_mg ?? defaults.cholesterol_mg, 1000),
      sodium_mg: clamp(parsed.sodium_mg ?? defaults.sodium_mg, 10000),
      vitamin_d_mcg: clamp(parsed.vitamin_d_mcg ?? defaults.vitamin_d_mcg, 200),
      calcium_mg: clamp(parsed.calcium_mg ?? defaults.calcium_mg, 5000),
      iron_mg: clamp(parsed.iron_mg ?? defaults.iron_mg, 100),
      potassium_mg: clamp(parsed.potassium_mg ?? defaults.potassium_mg, 10000),
      source: `llm_groq_${GROQ_MODEL}`,
    };
    return result;
  } catch (err) {
    console.error("Groq API error:", err);
    return {
      calories: 150,
      protein_g: 5,
      carbs_g: 20,
      fat_g: 5,
      fiber_g: 2,
      sugars_g: 5,
      saturated_fat_g: 1,
      trans_fat_g: 0,
      cholesterol_mg: 10,
      sodium_mg: 100,
      vitamin_d_mcg: 0,
      calcium_mg: 50,
      iron_mg: 1,
      potassium_mg: 200,
      source: `llm_groq_${GROQ_MODEL}_fallback_error`,
    };
  }
}
