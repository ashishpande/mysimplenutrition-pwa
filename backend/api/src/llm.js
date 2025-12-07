const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

function buildPrompt(name) {
  return `Extract nutrition label values for a single typical serving of: "${name}".
If the name includes a quantity (e.g., "2 servings" or "2 cups"), keep values per ONE serving only.
Return JSON only with these exact keys (per serving): calories, protein_g, total_carbs_g, fiber_g, sugars_g, total_fat_g, saturated_fat_g, trans_fat_g, cholesterol_mg, sodium_mg, vitamin_d_mcg, calcium_mg, iron_mg, potassium_mg.
No text, only JSON.`;
}

async function callOllama(prompt) {
  const url = new URL("/api/generate", OLLAMA_HOST);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("invalid_ollama_host");
  }
  const controller = new AbortController();
  // Allow more time for slower local models.
  const timeout = setTimeout(() => controller.abort(), 30000);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.2 },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (!resp.ok) throw new Error(`ollama_error_${resp.status}`);
  const data = await resp.json();
  return data.response;
}

function safeParseNutrition(text) {
  const clamp = (v, max = 2000) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n > max ? max : n;
  };
  const parseLoose = (input) => {
    const result = {};
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
      const re = new RegExp(`${k}["']?\\s*:\\s*([-\\d\\.]+)`, "i");
      const m = input.match(re);
      if (m) result[k] = Number(m[1]);
    });
    return Object.keys(result).length ? result : null;
  };

  try {
    // Strip markdown code blocks and extract JSON
    let cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
    // Extract just the JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }

    const maybeJson = (() => {
      try {
        const parsed = JSON.parse(cleaned);
        return parsed;
      } catch (err) {
        return null;
      }
    })();
    const loose = parseLoose(cleaned) || {};

    const parsed = { ...(maybeJson || {}), ...loose };
    if (!Object.keys(parsed).length) return null;
    return {
      calories: clamp(parsed.calories),
      protein_g: clamp(parsed.protein_g),
      carbs_g: clamp(parsed.total_carbs_g || parsed.carbs_g),
      fat_g: clamp(parsed.total_fat_g || parsed.fat_g),
      fiber_g: clamp(parsed.fiber_g),
      sugars_g: clamp(parsed.sugars_g),
      saturated_fat_g: clamp(parsed.saturated_fat_g),
      trans_fat_g: clamp(parsed.trans_fat_g),
      cholesterol_mg: clamp(parsed.cholesterol_mg, 1000),
      sodium_mg: clamp(parsed.sodium_mg, 10000),
      vitamin_d_mcg: clamp(parsed.vitamin_d_mcg, 200),
      calcium_mg: clamp(parsed.calcium_mg, 5000),
      iron_mg: clamp(parsed.iron_mg, 100),
      potassium_mg: clamp(parsed.potassium_mg, 10000),
    };
  } catch (_err) {
    return null;
  }
}

export async function estimateNutrition(name) {
  const prompt = buildPrompt(name);
  const fallback = {
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
  };
  try {
    const raw = await callOllama(prompt);
    const parsed = safeParseNutrition(raw);
    if (!parsed) return { ...fallback, model_estimated: true, source: `llm_ollama_${OLLAMA_MODEL}_fallback_parse` };
    return { ...parsed, model_estimated: true, source: `llm_ollama_${OLLAMA_MODEL}` };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("LLM estimate failed; using fallback", err);
    return { ...fallback, model_estimated: true, source: `llm_ollama_${OLLAMA_MODEL}_fallback_error` };
  }
}
