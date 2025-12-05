const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

function buildPrompt(name) {
  return `You estimate nutrition for a single food item.\nFood: "${name}"\nReturn JSON with keys: calories, protein_g, carbs_g, fat_g (per 1 serving ~100g if unspecified). No text, JSON only.`;
}

async function callOllama(prompt) {
  const url = new URL("/api/generate", OLLAMA_HOST);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("invalid_ollama_host");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
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
  try {
    const parsed = JSON.parse(text);
    const clamp = (v) => {
      const n = Number(v);
      if (Number.isNaN(n)) return 0;
      if (n < 0) return 0;
      if (n > 2000) return 2000; // bound for sanity
      return n;
    };
    return {
      calories: clamp(parsed.calories),
      protein_g: clamp(parsed.protein_g),
      carbs_g: clamp(parsed.carbs_g),
      fat_g: clamp(parsed.fat_g),
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
  };
  try {
    const raw = await callOllama(prompt);
    const parsed = safeParseNutrition(raw);
    if (!parsed) return { ...fallback, model_estimated: true, source: "llm_fallback_parse" };
    return { ...parsed, model_estimated: true, source: "llm_ollama" };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("LLM estimate failed; using fallback", err);
    return { ...fallback, model_estimated: true, source: "llm_fallback_error" };
  }
}
