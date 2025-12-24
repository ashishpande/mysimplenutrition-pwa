process.env.TZ = process.env.TZ || "UTC";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import * as chrono from "chrono-node";
import { fileURLToPath } from "url";
import { v4 as uuid } from "uuid";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import speakeasy from "speakeasy";
import rateLimit from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
// Prefer Groq if an API key is available; otherwise use local Ollama.
import { estimateNutrition as estimateNutritionOllama } from "./llm.js";
import { estimateNutrition as estimateNutritionGroq } from "./llm-groq.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// From backend/api/src -> repo root -> frontend/pwa
const pwaDir = path.resolve(__dirname, "../../..", "frontend/pwa");
const servePwa = process.env.SERVE_PWA !== "false" && fs.existsSync(path.join(pwaDir, "index.html"));
const prisma = new PrismaClient();

const app = express();
// Fly expects 8080; keep 4000 for local dev unless PORT is set.
const port = process.env.PORT || (process.env.FLY_APP_NAME ? 8080 : 4000);
const host = process.env.HOST || "0.0.0.0";
const env = process.env.NODE_ENV || "development";
const JWT_SECRET = process.env.JWT_SECRET || (env === "test" ? "dev-secret-change-me" : null);
const APP_BASE_URL = process.env.APP_BASE_URL || "http://localhost:5173";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "";
// Force LLM lookups in non-production by default; override with FORCE_LLM env.
const FORCE_LLM = process.env.FORCE_LLM === "true" || env !== "production";
const useGroq = !!process.env.GROQ_API_KEY;
const hasOllama = !!process.env.OLLAMA_HOST;
const SKIP_LLM = process.env.SKIP_LLM === "true";
const BARCODE_SCANNING_ENABLED = process.env.BARCODE_SCANNING_ENABLED === "true";
const estimateNutrition = async (name) => {
  if (hasOllama) {
    try {
      return await estimateNutritionOllama(name);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[llm] ollama failed, trying groq", err.message || err);
      if (useGroq) {
        return estimateNutritionGroq(name);
      }
      throw err;
    }
  }
  if (useGroq) {
    return estimateNutritionGroq(name);
  }
  throw new Error("no_llm_available");
};

// Debug info on startup for LLM selection.
// eslint-disable-next-line no-console
console.log(
  "[llm] useGroq:",
  useGroq,
  "forceLLM:",
  FORCE_LLM,
  "GROQ_API_KEY set:",
  !!process.env.GROQ_API_KEY,
  "OLLAMA_HOST set:",
  hasOllama,
  "OLLAMA_HOST:",
  process.env.OLLAMA_HOST || "default"
);
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS ||
  "http://localhost:4000,http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (env !== "test" && (!JWT_SECRET || JWT_SECRET === "dev-secret-change-me")) {
  // eslint-disable-next-line no-console
  console.error("Refusing to start without a secure JWT_SECRET");
  process.exit(1);
}

app.use(
  cors({
    // For admin dashboard and broad client access, allow all origins.
    origin: (_origin, cb) => cb(null, true),
    credentials: true,
  })
);
app.use(bodyParser.json());
app.use(morgan("dev"));

// Basic rate limits to slow brute-force on auth endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});

// In-memory food catalog; meals & users now stored in DB.
const foods = new Map();
const meals = [];
const dailyTotals = new Map(); // kept for compatibility with local llm stub paths, not used for persistence

// Ensure every nutrient object has the same shape.
const emptyNutrients = {
  calories: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
  fiber_g: 0,
  sugars_g: 0,
  saturated_fat_g: 0,
  trans_fat_g: 0,
  cholesterol_mg: 0,
  sodium_mg: 0,
  vitamin_d_mcg: 0,
  calcium_mg: 0,
  iron_mg: 0,
  potassium_mg: 0,
};

const nutrientKeys = Object.keys(emptyNutrients);
const trendMetricKeys = ["calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium", "consistency"];
const trendPeriodOptions = ["7d", "30d", "90d", "1y"];
const defaultTrendMetrics = ["calories", "protein", "consistency"];
const defaultTrendPeriod = "7d";
const trendSummaryCache = new Map();
const trendMetricConfig = {
  calories: { label: "Calories", unit: "kcal", nutrientKey: "calories" },
  protein: { label: "Protein", unit: "g", nutrientKey: "protein_g" },
  carbs: { label: "Carbs", unit: "g", nutrientKey: "carbs_g" },
  fat: { label: "Fat", unit: "g", nutrientKey: "fat_g" },
  fiber: { label: "Fiber", unit: "g", nutrientKey: "fiber_g" },
  sugar: { label: "Sugar", unit: "g", nutrientKey: "sugars_g" },
  sodium: { label: "Sodium", unit: "mg", nutrientKey: "sodium_mg" },
  consistency: { label: "Consistency", unit: "days", nutrientKey: null },
};

function normalizeNutrients(values = {}) {
  const normalized = {};
  for (const key of nutrientKeys) {
    const n = Number(values[key]);
    normalized[key] = Number.isFinite(n) ? n : 0;
  }
  return normalized;
}

function normalizeTrendPreferences(preferences) {
  if (!preferences || !Array.isArray(preferences.metrics)) return undefined;
  const metrics = Array.from(new Set(preferences.metrics)).filter((metric) => trendMetricKeys.includes(metric));
  const period = trendPeriodOptions.includes(preferences.period) ? preferences.period : defaultTrendPeriod;
  return { metrics: metrics.slice(0, 3), period };
}

function getTrendPeriodDays(period) {
  switch (period) {
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "1y":
      return 365;
    default:
      return 7;
  }
}

function getTrendPeriodLabel(period) {
  switch (period) {
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "1y":
      return "Last year";
    default:
      return "Last 7 days";
  }
}

function buildTrendsPrompt(metricsStats, periodLabel) {
  const dataBlocks = metricsStats
    .map(
      (metric) =>
        `${metric.label}:\n  Current avg: ${metric.last7Avg.toFixed(1)} ${metric.unit}\n  Previous avg: ${metric.prev7Avg.toFixed(1)} ${metric.unit}`
    )
    .join("\n\n");
  return `Summarize nutrition trends for the selected time range.

Time range: ${periodLabel} (compared to previous equivalent period)

Rules:
- Use 1 sentence total
- Mention only provided metrics
- Use natural, conversational phrasing
- No advice, recommendations, or goals
- Neutral tone
- Do not repeat "average" excessively

Metrics:
${dataBlocks}

End with:
"Trends are based on logged meals."`;
}

function getTrendDirection(lastAvg, prevAvg) {
  if (!prevAvg && !lastAvg) return "about the same";
  if (!prevAvg && lastAvg) return "higher";
  const delta = lastAvg - prevAvg;
  const changeRatio = Math.abs(delta) / Math.max(prevAvg, 1);
  if (changeRatio < 0.05) return "about the same";
  return delta > 0 ? "higher" : "lower";
}

function buildTrendSummaryText(metricsStats, periodLabel) {
  const directionPhrase = (direction, metricKey) => {
    if (metricKey === "consistency") {
      if (direction === "higher") return "logging consistency increased";
      if (direction === "lower") return "logging consistency decreased";
      return "logging consistency stayed about the same";
    }
    if (direction === "higher") return "increased";
    if (direction === "lower") return "decreased";
    return "stayed about the same";
  };
  const leadInByPeriod = {
    "Last 7 days": "Compared to the previous week,",
    "Last 30 days": "Over the past 30 days,",
    "Last 90 days": "Over the past 90 days,",
    "Last year": "Over the past year,",
  };
  const leadIn = leadInByPeriod[periodLabel] || "Compared to the previous period,";
  const phrases = metricsStats.map((metric) => {
    const direction = getTrendDirection(metric.last7Avg, metric.prev7Avg);
    if (metric.key === "consistency") {
      return directionPhrase(direction, metric.key);
    }
    return `${metric.label.toLowerCase()} ${directionPhrase(direction, metric.key)}`;
  });
  if (!phrases.length) return "Trends are based on logged meals.";
  const joined = phrases.length === 1 ? phrases[0] : `${phrases.slice(0, -1).join(", ")} and ${phrases.slice(-1)}`;
  return `${leadIn} ${joined}. Trends are based on logged meals.`;
}

function scaleNutrients(nutrients, factor = 1) {
  const scaled = {};
  for (const key of nutrientKeys) {
    scaled[key] = (nutrients[key] || 0) * factor;
  }
  return scaled;
}

function accumulateNutrients(target, source) {
  const next = { ...target };
  for (const key of nutrientKeys) {
    next[key] = (next[key] || 0) + (source[key] || 0);
  }
  return next;
}

function hashPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function formatMacroSummary({ calories, protein_g, carbs_g, fat_g }) {
  return `${Math.round(calories)} kcal, P ${Math.round(protein_g)}g, C ${Math.round(carbs_g)}g, F ${Math.round(fat_g)}g`;
}

function normalizeSummaryTotals(totals = {}) {
  const rounded = {};
  for (const key of nutrientKeys) {
    rounded[key] = Math.round(totals[key] || 0);
  }
  return rounded;
}

function buildNutritionSummaryText(rangeLabel, totals) {
  const t = normalizeSummaryTotals(totals);
  const prefix = rangeLabel ? `${rangeLabel}: ` : "";
  return `${prefix}${t.calories} kcal with macros P ${t.protein_g}g, C ${t.carbs_g}g, F ${t.fat_g}g, plus fiber ${t.fiber_g}g, sugar ${t.sugars_g}g, sodium ${t.sodium_mg} mg, potassium ${t.potassium_mg} mg, calcium ${t.calcium_mg} mg, iron ${t.iron_mg} mg, vitamin D ${t.vitamin_d_mcg} mcg. This summary is based on logged meals and values are approximate.`;
}

function buildSummaryPrompt(rangeLabel, totals, mealsLogged = 0) {
  const t = normalizeSummaryTotals(totals);
  const lowDensity = mealsLogged < 2 || t.calories < 300;
  return `You are summarizing nutrition data for ${rangeLabel}.

Rules:
- Keep it short (2–3 sentences)
- Be neutral and factual
- No advice, coaching, or recommendations
- No goals or judgments
- Assume estimates may be imperfect
- Friendly, conversational tone
${lowDensity ? "- Note: Data is limited. Phrase the summary carefully and avoid strong conclusions. Use language like \"so far\" or \"based on what's logged\"." : ""}

Context:
${rangeLabel} nutrition totals:
Calories: ${t.calories} kcal
Protein: ${t.protein_g} g
Carbs: ${t.carbs_g} g
Fat: ${t.fat_g} g
Fiber: ${t.fiber_g} g
Sugar: ${t.sugars_g} g
Sodium: ${t.sodium_mg} mg
Potassium: ${t.potassium_mg} mg
Calcium: ${t.calcium_mg} mg
Iron: ${t.iron_mg} mg
Vitamin D: ${t.vitamin_d_mcg} mcg

End with:
"This summary is based on logged meals and values are approximate."`;
}

function computeBarcodeConfidence(source) {
  if (source === "local") return 1.0;
  if (source === "openfoodfacts") return 1.0;
  return 0.4;
}

async function lookupOpenFoodFacts(barcode) {
  const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.status === 1 ? data.product : null;
}

function normalizeOpenFoodFacts(product) {
  const n = product?.nutriments || {};
  return {
    name: product.product_name || "Packaged food",
    brand: product.brands || "",
    servingSize: product.serving_size || "100g",
    nutrients: {
      calories: n["energy-kcal_100g"] || 0,
      protein_g: n["proteins_100g"] || 0,
      carbs_g: n["carbohydrates_100g"] || 0,
      fat_g: n["fat_100g"] || 0,
      fiber_g: n["fiber_100g"] || 0,
      sugars_g: n["sugars_100g"] || 0,
      sodium_mg: (n["sodium_100g"] || 0) * 1000,
      potassium_mg: (n["potassium_100g"] || 0) * 1000,
      calcium_mg: (n["calcium_100g"] || 0) * 1000,
      iron_mg: (n["iron_100g"] || 0) * 1000,
      vitamin_d_mcg: n["vitamin-d_100g"] || 0,
      cholesterol_mg: (n["cholesterol_100g"] || 0) * 1000,
      saturated_fat_g: n["saturated-fat_100g"] || 0,
      trans_fat_g: n["trans-fat_100g"] || 0,
    },
    source: "openfoodfacts",
    verified: true,
  };
}

function parseServingSizeGrams(servingSize) {
  if (!servingSize || typeof servingSize !== "string") return null;
  const match = servingSize.match(/(\d+(?:\.\d+)?)\s*(g|ml)\b/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return value;
}

function computeManualConfidence(nutrients = {}) {
  let confidence = 0.4;
  if (Object.prototype.hasOwnProperty.call(nutrients, "calories")) confidence += 0.2;
  if (
    Object.prototype.hasOwnProperty.call(nutrients, "protein_g") &&
    Object.prototype.hasOwnProperty.call(nutrients, "carbs_g") &&
    Object.prototype.hasOwnProperty.call(nutrients, "fat_g")
  ) {
    confidence += 0.2;
  }
  const advancedKeys = [
    "fiber_g",
    "sugars_g",
    "added_sugar_g",
    "saturated_fat_g",
    "trans_fat_g",
    "cholesterol_mg",
    "sodium_mg",
  ];
  const advancedCount = advancedKeys.filter((key) => Object.prototype.hasOwnProperty.call(nutrients, key)).length;
  if (advancedCount >= 3) confidence += 0.1;
  const micronutrientKeys = ["vitamin_d_mcg", "calcium_mg", "iron_mg", "potassium_mg"];
  const hasMicros = micronutrientKeys.some((key) => Object.prototype.hasOwnProperty.call(nutrients, key));
  if (hasMicros) confidence += 0.1;
  return Math.min(confidence, 0.85);
}

function extractEnteredNutrients(values = {}) {
  const manualKeys = [
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "fiber_g",
    "sugars_g",
    "added_sugar_g",
    "saturated_fat_g",
    "trans_fat_g",
    "cholesterol_mg",
    "sodium_mg",
    "vitamin_d_mcg",
    "calcium_mg",
    "iron_mg",
    "potassium_mg",
  ];
  const entered = {};
  for (const key of manualKeys) {
    const raw = values[key];
    if (raw === "" || raw === null || raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    entered[key] = n;
  }
  return entered;
}

async function resolveBarcode(barcode, { allowLlm = true } = {}) {
  const cached = await prisma.barcodeCache.findUnique({ where: { barcode } });
  if (cached) {
    return {
      name: cached.name,
      brand: cached.brand || "",
      servingSize: cached.servingSize || "100g",
      nutrients: cached.nutrients || {},
      source: "local",
      verified: cached.verified,
      confidence: computeBarcodeConfidence("local"),
    };
  }
  const product = await lookupOpenFoodFacts(barcode);
  if (product) {
    const normalized = normalizeOpenFoodFacts(product);
    const confidence = computeBarcodeConfidence("openfoodfacts");
    await prisma.barcodeCache.upsert({
      where: { barcode },
      create: {
        barcode,
        name: normalized.name,
        brand: normalized.brand || "",
        servingSize: normalized.servingSize || "100g",
        nutrients: normalized.nutrients,
        source: "openfoodfacts",
        verified: true,
        confidence,
      },
      update: {
        name: normalized.name,
        brand: normalized.brand || "",
        servingSize: normalized.servingSize || "100g",
        nutrients: normalized.nutrients,
        source: "openfoodfacts",
        verified: true,
        confidence,
      },
    });
    return { ...normalized, confidence, source: "openfoodfacts" };
  }
  if (!allowLlm) {
    return null;
  }
  const estimate = await estimateNutrition(`packaged food with barcode ${barcode}`);
  const normalized = normalizeNutrients(estimate);
  const confidence = computeBarcodeConfidence("llm");
  const fallback = {
    name: `Barcode ${barcode}`,
    brand: "",
    servingSize: "100g",
    nutrients: normalized,
    source: "llm",
    verified: false,
    confidence,
  };
  await prisma.barcodeCache.upsert({
    where: { barcode },
    create: {
      barcode,
      name: fallback.name,
      brand: "",
      servingSize: "100g",
      nutrients: fallback.nutrients,
      source: "llm",
      verified: false,
      confidence,
    },
    update: {
      name: fallback.name,
      brand: "",
      servingSize: "100g",
      nutrients: fallback.nutrients,
      source: "llm",
      verified: false,
      confidence,
    },
  });
  return fallback;
}

async function generateGroqSummary(prompt) {
  if (!useGroq || SKIP_LLM) return null;
  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 160,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`groq_summary_${response.status}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  return text || null;
}

function parseSummaryJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed.body !== "string") return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: parsed.body.trim(),
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 2).map((h) => String(h)) : [],
    };
  } catch (_err) {
    return null;
  }
}

function normalizeDigits(value) {
  return String(value).replace(/,/g, "");
}

function summaryBodyIncludesFacts(body, facts) {
  if (!body) return false;
  const normalized = body.replace(/,/g, "");
  const required = [
    String(facts.calories),
    String(facts.protein_g),
    String(facts.carbs_g),
    String(facts.fat_g),
  ];
  if (!required.every((part) => normalized.includes(normalizeDigits(part)))) {
    return false;
  }
  const secondary = [
    facts.fiber_g,
    facts.sugars_g,
    facts.sodium_mg,
    facts.potassium_mg,
    facts.calcium_mg,
    facts.iron_mg,
    facts.vitamin_d_mcg,
  ];
  const nonZeroSecondary = secondary.filter((val) => Number(val) > 0);
  const hasSecondary = nonZeroSecondary.length
    ? nonZeroSecondary.some((val) => normalized.includes(normalizeDigits(String(val))))
    : true;
  return hasSecondary && normalized.toLowerCase().includes("approximate");
}

async function sendResetEmail(email, token) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    // eslint-disable-next-line no-console
    console.warn("[reset] resend not configured; logging link");
    // eslint-disable-next-line no-console
    console.log("[reset] link:", `${APP_BASE_URL}/?resetToken=${token}&email=${encodeURIComponent(email)}`);
    return;
  }
  const link = `${APP_BASE_URL}/?resetToken=${token}&email=${encodeURIComponent(email)}`;
  const body = {
    from: RESEND_FROM_EMAIL,
    to: email,
    subject: "Reset your password",
    html: `<p>You requested a password reset.</p><p>Click <a href="${link}">reset password</a> or copy the link: ${link}</p>`,
  };
  // eslint-disable-next-line no-console
  console.log("[reset] sending via Resend to", email);
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`resend_failed_${resp.status}: ${txt}`);
  }
  // eslint-disable-next-line no-console
  console.log("[reset] email sent via Resend");
}

async function recomputeDayTotals(userId, dateStr, tzOffsetMinutes = 0) {
  const { startUtc, endUtc } = computeLocalDayWindow(dateStr, tzOffsetMinutes);
  const mealsForDay = await prisma.meal.findMany({
    where: { userId, consumedAt: { gte: startUtc, lt: endUtc } },
    include: { items: true },
  });
  const totals = mealsForDay.reduce((acc, meal) => {
    const sum = meal.items.reduce(
      (mAcc, item) =>
        accumulateNutrients(mAcc, {
          calories: item.calories,
          protein_g: item.protein_g,
          carbs_g: item.carbs_g,
          fat_g: item.fat_g,
          fiber_g: item.fiber_g,
          sugars_g: item.sugars_g,
          saturated_fat_g: item.saturated_fat_g,
          trans_fat_g: item.trans_fat_g,
          cholesterol_mg: item.cholesterol_mg,
          sodium_mg: item.sodium_mg,
          vitamin_d_mcg: item.vitamin_d_mcg,
          calcium_mg: item.calcium_mg,
          iron_mg: item.iron_mg,
          potassium_mg: item.potassium_mg,
        }),
      { ...emptyNutrients }
    );
    return accumulateNutrients(acc, sum);
  }, { ...emptyNutrients });

  await prisma.dailyTotal.upsert({
    where: { userId_date: { userId, date: new Date(dateStr) } },
    update: {
      calories: totals.calories,
      protein_g: totals.protein_g,
      carbs_g: totals.carbs_g,
      fat_g: totals.fat_g,
    },
    create: {
      userId,
      date: new Date(dateStr),
      calories: totals.calories,
      protein_g: totals.protein_g,
      carbs_g: totals.carbs_g,
      fat_g: totals.fat_g,
    },
  });
  return totals;
}

function buildLookupKey({ food, brand }) {
  return `${(brand || "").trim()} ${food.trim()}`.trim().toLowerCase();
}

function defaultNutritionFallback() {
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
  };
}

function hasNonZeroNutrients(nutrients = {}) {
  return Object.values(nutrients).some((value) => Number(value) > 0);
}

// Seed foods (placeholder).
foods.set("egg", {
  id: "food-egg",
  name: "Egg, whole",
  serving: { unit: "piece", grams: 50 },
  nutrients: normalizeNutrients({ calories: 72, protein_g: 6, carbs_g: 0.4, fat_g: 4.8 }),
  source: "catalog",
});
foods.set("toast", {
  id: "food-toast",
  name: "Toast, white bread slice",
  serving: { unit: "slice", grams: 30 },
  nutrients: normalizeNutrients({ calories: 80, protein_g: 3, carbs_g: 14, fat_g: 1 }),
  source: "catalog",
});

function signTokens(user) {
  const accessToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "1h" });
  return { accessToken };
}

function inferMealType(text = "", consumedAt) {
  const lower = text.toLowerCase();
  if (lower.includes("breakfast")) return "breakfast";
  if (lower.includes("lunch")) return "lunch";
  if (lower.includes("dinner")) return "dinner";
  if (lower.includes("snack")) return "snack";
  const date = consumedAt ? new Date(consumedAt) : new Date();
  const hour = date.getUTCHours();
  if (hour < 11) return "breakfast";
  if (hour < 17) return "lunch";
  return "dinner";
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "invalid_token" });
  }
}

app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError) return res.status(400).json({ error: "invalid_json" });
  return next(err);
});

// Final error handler to avoid leaking stack traces
app.use((err, _req, res, _next) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled error", err);
  return res.status(500).json({ error: "server_error" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Basic admin stats (no auth applied; restrict upstream if needed).
app.options("/api/admin/stats", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res.sendStatus(204);
});

app.get("/api/admin/stats", async (req, res) => {
  // Allow dashboard to call from any origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  try {
    const tzOffsetMinutes = Number(req.query.tzOffsetMinutes || 0);
    const todayStr = new Date().toISOString().slice(0, 10);
    const { startUtc: todayStart, endUtc: todayEnd } = computeLocalDayWindow(todayStr, tzOffsetMinutes);

    const totalUsersPromise = prisma.user.count();
    const newUsersTodayPromise = prisma.user.count({
      where: { createdAt: { gte: todayStart, lt: todayEnd } },
    });
    const totalMealsPromise = prisma.meal.count();
    const mealsTodayPromise = prisma.meal.count({
      where: { consumedAt: { gte: todayStart, lt: todayEnd } },
    });

    // Trends for last 7 days
    const days = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0, 10);
      const { startUtc, endUtc } = computeLocalDayWindow(ymd, tzOffsetMinutes);
      days.push({ ymd, startUtc, endUtc });
    }

    const dauTrend = [];
    const newUsersTrend = [];
    const activityTrend = [];
    for (const d of days) {
      const dayMeals = await prisma.meal.findMany({
        where: { consumedAt: { gte: d.startUtc, lt: d.endUtc } },
        select: { userId: true },
      });
      const uniqueUsers = new Set(dayMeals.map((m) => m.userId)).size;
      dauTrend.push({ date: d.ymd, count: uniqueUsers });
      const newUsersCount = await prisma.user.count({ where: { createdAt: { gte: d.startUtc, lt: d.endUtc } } });
      newUsersTrend.push({ date: d.ymd, count: newUsersCount });
      activityTrend.push({ date: d.ymd, count: dayMeals.length });
    }

    // Top users by meal count (simple in-memory aggregation)
    const allMeals = await prisma.meal.findMany({ select: { userId: true, consumedAt: true } });
    const counts = new Map();
    const lastActiveMap = new Map();
    for (const m of allMeals) {
      counts.set(m.userId, (counts.get(m.userId) || 0) + 1);
      const prev = lastActiveMap.get(m.userId);
      if (!prev || new Date(m.consumedAt) > new Date(prev)) {
        lastActiveMap.set(m.userId, m.consumedAt);
      }
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topUserIds = sorted.map(([id]) => id);
    const topUsersRaw = topUserIds.length
      ? await prisma.user.findMany({
          where: { id: { in: topUserIds } },
          select: { id: true, email: true, mfaEnabled: true, createdAt: true },
        })
      : [];
    const topUsers = topUsersRaw.map((u) => ({
      email: u.email,
      mealCount: counts.get(u.id) || 0,
      lastActive: lastActiveMap.get(u.id) || u.createdAt || new Date(),
      mfaEnabled: u.mfaEnabled,
    }));

    const [totalUsers, newUsersToday, totalMeals, mealsToday] = await Promise.all([
      totalUsersPromise,
      newUsersTodayPromise,
      totalMealsPromise,
      mealsTodayPromise,
    ]);

    res.json({
      totalUsers,
      newUsersToday,
      totalMeals,
      mealsToday,
      llmCallsMonth: 0,
      dbSize: "-",
      flyHours: 0,
      pageViews: 0,
      topUsers,
      dauTrend,
      newUsersTrend,
      activityTrend,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("admin_stats_failed", err);
    res.status(500).json({ error: "server_error", detail: err?.message });
  }
});

// LLM health check: verifies the configured provider responds.
app.get("/api/health/llm", async (_req, res) => {
  const timeoutMs = 5000;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (useGroq) {
      const resp = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY || ""}` },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      if (!resp.ok) throw new Error(`groq_status_${resp.status}`);
      const data = await resp.json();
      return res.json({ ok: true, provider: "groq", model: process.env.GROQ_MODEL, models: data?.data?.length || 0 });
    }
    const resp = await fetch(`${process.env.OLLAMA_HOST || "http://ollama:11434"}/api/tags`, { signal: controller.signal }).finally(() =>
      clearTimeout(timeout)
    );
    if (!resp.ok) throw new Error(`ollama_status_${resp.status}`);
    const data = await resp.json();
    return res.json({ ok: true, provider: "ollama", model: process.env.OLLAMA_MODEL, models: data?.models?.length || 0 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("llm_health_failed", err);
    return res.status(503).json({ ok: false, error: "llm_unavailable" });
  }
});

app.get("/api/config", authMiddleware, async (_req, res) => {
  res.json({
    features: {
      barcode_scanning_enabled: BARCODE_SCANNING_ENABLED,
    },
  });
});

app.post("/api/metrics", authMiddleware, async (req, res) => {
  const { event, payload } = req.body || {};
  if (!event) return res.status(400).json({ error: "event_required" });
  // eslint-disable-next-line no-console
  console.log("metric_event", {
    event,
    payload: payload || {},
    userId: req.user.userId,
    timestamp: new Date().toISOString(),
  });
  return res.json({ ok: true });
});

// Profile endpoints
app.get("/api/profile", authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      heightCm: true,
      heightUnit: true,
      weightKg: true,
      weightUnit: true,
      mfaEnabled: true,
      trendPreferences: true,
    },
  });
  if (!user) return res.status(404).json({ error: "not_found" });
  const safeUser = { ...user };
  delete safeUser.passwordHash;
  delete safeUser.password;
  res.json({ user: safeUser });
});

app.put("/api/profile", authMiddleware, async (req, res) => {
  const { firstName, lastName, heightUnit, weightUnit, heightValue, heightFeet, heightInches, weightValue, trendPreferences } = req.body || {};
  const hasHeightFields =
    [heightUnit, heightValue, heightFeet, heightInches].some((val) => val !== undefined);
  const hasWeightFields = [weightUnit, weightValue].some((val) => val !== undefined);
  const parsedHeight = hasHeightFields ? normalizeHeight({ heightUnit, heightValue, heightFeet, heightInches }) : undefined;
  const parsedWeight = hasWeightFields ? normalizeWeight({ weightUnit, weightValue }) : undefined;
  const hasTrendPreferences = Object.prototype.hasOwnProperty.call(req.body || {}, "trendPreferences");
  const normalizedTrendPreferences = trendPreferences === null ? null : normalizeTrendPreferences(trendPreferences);
  try {
    const data = {
      firstName,
      lastName,
    };
    if (hasHeightFields) {
      data.heightCm = parsedHeight;
      data.heightUnit = heightUnit;
    }
    if (hasWeightFields) {
      data.weightKg = parsedWeight;
      data.weightUnit = weightUnit;
    }
    if (hasTrendPreferences) {
      data.trendPreferences = normalizedTrendPreferences;
    }
    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        heightCm: true,
        heightUnit: true,
        weightKg: true,
        weightUnit: true,
        mfaEnabled: true,
        trendPreferences: true,
      },
    });
    res.json({ user });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("profile_update_error", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/barcode/lookup", authMiddleware, async (req, res) => {
  if (!BARCODE_SCANNING_ENABLED) {
    return res.status(403).json({ error: "barcode_scanning_disabled" });
  }
  const { barcode } = req.body || {};
  if (!barcode) return res.status(400).json({ error: "barcode_required" });
  const startedAt = Date.now();
  try {
    const result = await resolveBarcode(barcode, { allowLlm: false });
    if (!result) {
      return res.status(404).json({ error: "barcode_not_found" });
    }
    const lookupMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log("barcode_lookup_source", {
      barcode,
      source: result.source,
      userId: req.user.userId,
      timestamp: new Date().toISOString(),
      lookupMs,
    });
    return res.json({ ...result, lookupMs });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("barcode_lookup_failed", err);
    return res.status(500).json({ error: "barcode_lookup_failed" });
  }
});

app.post("/api/barcode/consume", authMiddleware, async (req, res) => {
  if (!BARCODE_SCANNING_ENABLED) {
    return res.status(403).json({ error: "barcode_scanning_disabled" });
  }
  const { barcode, mealType, consumedAt = null, tzOffsetMinutes = 0 } = req.body || {};
  if (!barcode) return res.status(400).json({ error: "barcode_required" });

  const userId = req.user.userId;
  const resolvedMealType = mealType && mealType !== "unspecified" ? mealType : "snack";
  const mealConsumedAt = consumedAt ? new Date(consumedAt) : new Date();
  const dateStr = formatLocalYMD(mealConsumedAt, tzOffsetMinutes);

  try {
    const result = await resolveBarcode(barcode, { allowLlm: false });
    if (!result) {
      return res.status(404).json({ error: "barcode_not_found" });
    }
    const servingGrams = parseServingSizeGrams(result.servingSize) || 100;
    const nutrientFactor = servingGrams / 100;
    const nutrients = scaleNutrients(normalizeNutrients(result.nutrients), nutrientFactor);
    const mealTotals = accumulateNutrients({ ...emptyNutrients }, nutrients);
    const mealId = uuid();
    let createdMeal = null;

    await prisma.$transaction(async (tx) => {
      const mealRecord = await tx.meal.create({
        data: {
          id: mealId,
          userId,
          mealType: resolvedMealType,
          consumedAt: mealConsumedAt,
          text: result.name || `Barcode ${barcode}`,
          items: {
            create: [
              {
                id: uuid(),
                foodId: `barcode-${barcode}`,
                name: result.name || `Barcode ${barcode}`,
                quantity: 1,
                unit: result.servingSize || "serving",
                grams: servingGrams,
                source: result.source || "barcode",
                calories: nutrients.calories || 0,
                protein_g: nutrients.protein_g || 0,
                carbs_g: nutrients.carbs_g || 0,
                fat_g: nutrients.fat_g || 0,
                fiber_g: nutrients.fiber_g || 0,
                sugars_g: nutrients.sugars_g || 0,
                saturated_fat_g: nutrients.saturated_fat_g || 0,
                trans_fat_g: nutrients.trans_fat_g || 0,
                cholesterol_mg: nutrients.cholesterol_mg || 0,
                sodium_mg: nutrients.sodium_mg || 0,
                vitamin_d_mcg: nutrients.vitamin_d_mcg || 0,
                calcium_mg: nutrients.calcium_mg || 0,
                iron_mg: nutrients.iron_mg || 0,
                potassium_mg: nutrients.potassium_mg || 0,
              },
            ],
          },
        },
        include: { items: true },
      });

      const itemConfidence = result.confidence || computeBarcodeConfidence(result.source);
      createdMeal = {
        ...mealRecord,
        items: mealRecord.items.map((i) => ({
          ...i,
          confidence: itemConfidence,
          nutrients: normalizeNutrients({
            calories: i.calories,
            protein_g: i.protein_g,
            carbs_g: i.carbs_g,
            fat_g: i.fat_g,
            fiber_g: i.fiber_g,
            sugars_g: i.sugars_g,
            saturated_fat_g: i.saturated_fat_g,
            trans_fat_g: i.trans_fat_g,
            cholesterol_mg: i.cholesterol_mg,
            sodium_mg: i.sodium_mg,
            vitamin_d_mcg: i.vitamin_d_mcg,
            calcium_mg: i.calcium_mg,
            iron_mg: i.iron_mg,
            potassium_mg: i.potassium_mg,
          }),
        })),
        total: mealTotals,
      };

      await tx.dailyTotal.upsert({
        where: { userId_date: { userId, date: new Date(dateStr) } },
        update: {
          calories: { increment: mealTotals.calories },
          protein_g: { increment: mealTotals.protein_g },
          carbs_g: { increment: mealTotals.carbs_g },
          fat_g: { increment: mealTotals.fat_g },
        },
        create: {
          userId,
          date: new Date(dateStr),
          calories: mealTotals.calories,
          protein_g: mealTotals.protein_g,
          carbs_g: mealTotals.carbs_g,
          fat_g: mealTotals.fat_g,
        },
      });
    });

    const dayTotals = await recomputeDayTotals(userId, dateStr, tzOffsetMinutes);
    return res.json({
      meal: { ...createdMeal, mealType: resolvedMealType, consumedAt: mealConsumedAt },
      day: { userId, date: dateStr, ...dayTotals },
      barcode: {
        source: result.source,
        confidence: result.confidence || computeBarcodeConfidence(result.source),
      },
      clampedFuture: false,
    });
  } catch (err) {
    console.error("barcode_consume_failed", err);
    return res.status(500).json({ error: "barcode_consume_failed" });
  }
});

app.post("/api/barcode/manual", authMiddleware, async (req, res) => {
  if (!BARCODE_SCANNING_ENABLED) {
    return res.status(403).json({ error: "barcode_scanning_disabled" });
  }
  const { barcode, name = "", servingSize = "100 g", nutrients = {}, tzOffsetMinutes = 0 } = req.body || {};
  if (!barcode) return res.status(400).json({ error: "barcode_required" });
  const entered = extractEnteredNutrients(nutrients);
  if (!Number(entered?.calories)) return res.status(400).json({ error: "calories_required" });

  const userId = req.user.userId;
  const mealConsumedAt = new Date();
  const dateStr = formatLocalYMD(mealConsumedAt, tzOffsetMinutes);
  const normalized = normalizeNutrients(entered);
  const confidence = computeManualConfidence(entered);
  const displayName = name || `Barcode ${barcode}`;

  try {
    await prisma.barcodeCache.upsert({
      where: { barcode },
      create: {
        barcode,
        name: displayName,
        brand: "",
        servingSize,
        nutrients: entered,
        source: "user_entered",
        verified: false,
        confidence,
      },
      update: {
        name: displayName,
        brand: "",
        servingSize,
        nutrients: entered,
        source: "user_entered",
        verified: false,
        confidence,
      },
    });

    const servingGrams = parseServingSizeGrams(servingSize) || 100;
    const nutrientFactor = servingGrams / 100;
    const scaled = scaleNutrients(normalized, nutrientFactor);
    const mealTotals = accumulateNutrients({ ...emptyNutrients }, scaled);
    const mealId = uuid();
    let createdMeal = null;

    await prisma.$transaction(async (tx) => {
      const mealRecord = await tx.meal.create({
        data: {
          id: mealId,
          userId,
          mealType: "snack",
          consumedAt: mealConsumedAt,
          text: displayName,
          items: {
            create: [
              {
                id: uuid(),
                foodId: `barcode-${barcode}`,
                name: displayName,
                quantity: 1,
                unit: servingSize,
                grams: servingGrams,
                source: "user_entered",
                calories: scaled.calories || 0,
                protein_g: scaled.protein_g || 0,
                carbs_g: scaled.carbs_g || 0,
                fat_g: scaled.fat_g || 0,
                fiber_g: scaled.fiber_g || 0,
                sugars_g: scaled.sugars_g || 0,
                saturated_fat_g: scaled.saturated_fat_g || 0,
                trans_fat_g: scaled.trans_fat_g || 0,
                cholesterol_mg: scaled.cholesterol_mg || 0,
                sodium_mg: scaled.sodium_mg || 0,
                vitamin_d_mcg: scaled.vitamin_d_mcg || 0,
                calcium_mg: scaled.calcium_mg || 0,
                iron_mg: scaled.iron_mg || 0,
                potassium_mg: scaled.potassium_mg || 0,
              },
            ],
          },
        },
        include: { items: true },
      });

      createdMeal = {
        ...mealRecord,
        items: mealRecord.items.map((i) => ({
          ...i,
          nutrients: normalizeNutrients({
            calories: i.calories,
            protein_g: i.protein_g,
            carbs_g: i.carbs_g,
            fat_g: i.fat_g,
            fiber_g: i.fiber_g,
            sugars_g: i.sugars_g,
            saturated_fat_g: i.saturated_fat_g,
            trans_fat_g: i.trans_fat_g,
            cholesterol_mg: i.cholesterol_mg,
            sodium_mg: i.sodium_mg,
            vitamin_d_mcg: i.vitamin_d_mcg,
            calcium_mg: i.calcium_mg,
            iron_mg: i.iron_mg,
            potassium_mg: i.potassium_mg,
          }),
        })),
        total: mealTotals,
      };

      await tx.dailyTotal.upsert({
        where: { userId_date: { userId, date: new Date(dateStr) } },
        update: {
          calories: { increment: mealTotals.calories },
          protein_g: { increment: mealTotals.protein_g },
          carbs_g: { increment: mealTotals.carbs_g },
          fat_g: { increment: mealTotals.fat_g },
        },
        create: {
          userId,
          date: new Date(dateStr),
          calories: mealTotals.calories,
          protein_g: mealTotals.protein_g,
          carbs_g: mealTotals.carbs_g,
          fat_g: mealTotals.fat_g,
        },
      });
    });

    const dayTotals = await recomputeDayTotals(userId, dateStr, tzOffsetMinutes);
    return res.json({
      meal: { ...createdMeal, mealType: "snack", consumedAt: mealConsumedAt },
      day: { userId, date: dateStr, ...dayTotals },
      barcode: { source: "user_entered", confidence },
      clampedFuture: false,
    });
  } catch (err) {
    console.error("barcode_manual_failed", err);
    return res.status(500).json({ error: "barcode_manual_failed" });
  }
});

app.post("/api/barcode/skip", authMiddleware, async (req, res) => {
  if (!BARCODE_SCANNING_ENABLED) {
    return res.status(403).json({ error: "barcode_scanning_disabled" });
  }
  const { barcode, name = "", tzOffsetMinutes = 0 } = req.body || {};
  if (!barcode) return res.status(400).json({ error: "barcode_required" });
  const userId = req.user.userId;
  const mealConsumedAt = new Date();
  const dateStr = formatLocalYMD(mealConsumedAt, tzOffsetMinutes);
  const displayName = name || `Barcode ${barcode}`;
  const mealId = uuid();
  let createdMeal = null;

  try {
    await prisma.$transaction(async (tx) => {
      const mealRecord = await tx.meal.create({
        data: {
          id: mealId,
          userId,
          mealType: "snack",
          consumedAt: mealConsumedAt,
          text: displayName,
          items: {
            create: [
              {
                id: uuid(),
                foodId: `barcode-${barcode}`,
                name: displayName,
                quantity: 1,
                unit: "serving",
                grams: 0,
                source: "unknown",
                calories: 0,
                protein_g: 0,
                carbs_g: 0,
                fat_g: 0,
                fiber_g: 0,
                sugars_g: 0,
                saturated_fat_g: 0,
                trans_fat_g: 0,
                cholesterol_mg: 0,
                sodium_mg: 0,
                vitamin_d_mcg: 0,
                calcium_mg: 0,
                iron_mg: 0,
                potassium_mg: 0,
              },
            ],
          },
        },
        include: { items: true },
      });

      createdMeal = {
        ...mealRecord,
        items: mealRecord.items.map((i) => ({
          ...i,
          nutrients: normalizeNutrients({
            calories: i.calories,
            protein_g: i.protein_g,
            carbs_g: i.carbs_g,
            fat_g: i.fat_g,
            fiber_g: i.fiber_g,
            sugars_g: i.sugars_g,
            saturated_fat_g: i.saturated_fat_g,
            trans_fat_g: i.trans_fat_g,
            cholesterol_mg: i.cholesterol_mg,
            sodium_mg: i.sodium_mg,
            vitamin_d_mcg: i.vitamin_d_mcg,
            calcium_mg: i.calcium_mg,
            iron_mg: i.iron_mg,
            potassium_mg: i.potassium_mg,
          }),
        })),
        total: { ...emptyNutrients },
      };
    });

    const dayTotals = await recomputeDayTotals(userId, dateStr, tzOffsetMinutes);
    return res.json({
      meal: { ...createdMeal, mealType: "snack", consumedAt: mealConsumedAt },
      day: { userId, date: dateStr, ...dayTotals },
      barcode: { source: "unknown", confidence: 0 },
      clampedFuture: false,
    });
  } catch (err) {
    console.error("barcode_skip_failed", err);
    return res.status(500).json({ error: "barcode_skip_failed" });
  }
});

app.post("/auth/register", authLimiter, async (req, res) => {
  const { email, password, firstName, lastName, heightUnit, weightUnit, heightValue, heightFeet, heightInches, weightValue } =
    req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "email_taken" });
  const passwordHash = await bcrypt.hash(password, 10);
  const parsedHeight = normalizeHeight({ heightUnit, heightValue, heightFeet, heightInches });
  const parsedWeight = normalizeWeight({ weightUnit, weightValue });
  const user = await prisma.user.create({
    data: {
      id: uuid(),
      email,
      passwordHash,
      mfaEnabled: false,
      mfaSecret: null,
      firstName,
      lastName,
      heightCm: parsedHeight,
      heightUnit,
      weightKg: parsedWeight,
      weightUnit,
      trendPreferences: null,
    },
  });
  const tokens = signTokens(user);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      heightCm: user.heightCm,
      weightKg: user.weightKg,
      mfaEnabled: user.mfaEnabled,
      trendPreferences: user.trendPreferences,
    },
    ...tokens,
  });
});

app.post("/auth/login", authLimiter, async (req, res) => {
  const { email, password, token: mfaToken, deviceToken, rememberDevice } = req.body || {};
  const user = await prisma.user.findUnique({ where: { email }, include: { trustedDevices: true } });
  if (!user) return res.status(401).json({ error: "invalid_credentials" });
  const ok = await bcrypt.compare(password || "", user.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  let issuedDeviceToken = null;

  if (user.mfaEnabled) {
    const deviceTrusted =
      deviceToken &&
      user.trustedDevices.some((d) => {
        try {
          return bcrypt.compareSync(deviceToken, d.deviceToken);
        } catch {
          return false;
        }
      });
    if (!deviceTrusted) {
      if (!mfaToken) return res.status(206).json({ mfaRequired: true, error: "mfa_required" });
      const verified = speakeasy.totp.verify({ secret: user.mfaSecret, encoding: "base32", token: mfaToken, window: 1 });
      if (!verified) return res.status(401).json({ error: "invalid_mfa" });
      if (rememberDevice) {
        issuedDeviceToken = crypto.randomBytes(32).toString("base64url");
        const hashed = await bcrypt.hash(issuedDeviceToken, 10);
        await prisma.trustedDevice.create({
          data: { id: uuid(), userId: user.id, deviceToken: hashed },
        });
      }
    }
  }

  const tokens = signTokens(user);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      heightCm: user.heightCm,
      heightUnit: user.heightUnit,
      weightKg: user.weightKg,
      weightUnit: user.weightUnit,
      mfaEnabled: user.mfaEnabled,
      trendPreferences: user.trendPreferences,
    },
    deviceToken: issuedDeviceToken || deviceToken || null,
    ...tokens,
  });
});

// Request password reset: generates a token and logs the link (placeholder for email).
app.post("/auth/forgot", authLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "email_required" });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.json({ ok: true }); // don't reveal user existence
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await prisma.passwordReset.create({
    data: { id: uuid(), userId: user.id, token, expiresAt },
  });
  try {
    await sendResetEmail(email, token);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("reset_email_failed", err);
  }
  res.json({ ok: true });
});

// Reset password using token
app.post("/auth/reset", authLimiter, async (req, res) => {
  const { email, token, password, confirmPassword } = req.body || {};
  if (!email || !token || !password) return res.status(400).json({ error: "missing_fields" });
  if (password !== confirmPassword) return res.status(400).json({ error: "password_mismatch" });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(400).json({ error: "invalid_token" });
  const reset = await prisma.passwordReset.findFirst({
    where: { token, userId: user.id, used: false, expiresAt: { gt: new Date() } },
  });
  if (!reset) return res.status(400).json({ error: "invalid_token" });
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
    prisma.passwordReset.update({ where: { id: reset.id }, data: { used: true } }),
  ]);
  res.json({ ok: true });
});

// Begin MFA setup: returns a secret to be confirmed.
app.post("/auth/mfa/setup", authLimiter, authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(401).json({ error: "unauthorized" });
  const secret = speakeasy.generateSecret({ length: 20, name: `NutritionApp (${user.email})` });
  app.locals.mfaTempSecrets ||= new Map();
  app.locals.mfaTempSecrets.set(userId, { secret: secret.base32, expiresAt: Date.now() + 10 * 60 * 1000 });
  res.json({ otpauth_url: secret.otpauth_url, base32: secret.base32 });
});

// Confirm MFA setup with a TOTP code.
app.post("/auth/mfa/verify", authLimiter, authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  const { token } = req.body || {};
  const temp = app.locals.mfaTempSecrets?.get(userId);
  if (!token || !temp) return res.status(400).json({ error: "token_required" });
  if (temp.expiresAt < Date.now()) {
    app.locals.mfaTempSecrets.delete(userId);
    return res.status(400).json({ error: "token_expired" });
  }
  const verified = speakeasy.totp.verify({ secret: temp.secret, encoding: "base32", token, window: 1 });
  if (!verified) return res.status(401).json({ error: "invalid_mfa" });
  await prisma.user.update({
    where: { id: userId },
    data: { mfaSecret: temp.secret, mfaEnabled: true },
  });
  app.locals.mfaTempSecrets.delete(userId);
  res.json({ ok: true, mfaEnabled: true });
});

// Disable MFA
app.post("/auth/mfa/disable", authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  const { token } = req.body || {};
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.mfaEnabled) return res.status(400).json({ error: "mfa_not_enabled" });
  if (!token) return res.status(400).json({ error: "token_required" });
  const verified = speakeasy.totp.verify({ secret: user.mfaSecret, encoding: "base32", token, window: 1 });
  if (!verified) return res.status(401).json({ error: "invalid_mfa" });
  await prisma.user.update({
    where: { id: userId },
    data: { mfaSecret: null, mfaEnabled: false },
  });
  await prisma.trustedDevice.deleteMany({ where: { userId } });
  res.json({ ok: true, mfaEnabled: false });
});

function normalizeHeight({ heightUnit, heightValue, heightFeet, heightInches }) {
  const unit = (heightUnit || "").toLowerCase();
  if (unit === "cm") {
    const val = Number(heightValue);
    return Number.isFinite(val) ? val : null;
  }
  if (unit === "in" || unit === "inch" || unit === "inches") {
    const val = Number(heightValue);
    return Number.isFinite(val) ? val * 2.54 : null;
  }
  if (unit === "ft" || unit === "feet" || unit === "ftin") {
    const ft = Number(heightFeet);
    const inch = Number(heightInches);
    const totalInches = (Number.isFinite(ft) ? ft : 0) * 12 + (Number.isFinite(inch) ? inch : 0);
    return totalInches > 0 ? totalInches * 2.54 : null;
  }
  return null;
}

function normalizeWeight({ weightUnit, weightValue }) {
  const unit = (weightUnit || "").toLowerCase();
  if (unit === "kg" || unit === "kgs" || unit === "kilograms") {
    const val = Number(weightValue);
    return Number.isFinite(val) ? val : null;
  }
  if (unit === "lb" || unit === "lbs" || unit === "pounds") {
    const val = Number(weightValue);
    return Number.isFinite(val) ? val * 0.453592 : null;
  }
  return null;
}

async function findFoodFromHistory(displayName) {
  const lookup = displayName.trim().toLowerCase();
  if (!lookup) return null;
  if (foods.has(lookup)) return foods.get(lookup);
  try {
    const fromDb = await prisma.mealItem.findFirst({
      where: { name: { equals: displayName, mode: "insensitive" } },
    });
    if (!fromDb) return null;
    const baseQuantity = Number(fromDb.quantity) || 1;
    const baseGrams = Number(fromDb.grams) && baseQuantity ? fromDb.grams / baseQuantity : 100;
    const entry = {
      id: fromDb.foodId || `food-${lookup.replace(/\s+/g, "-")}`,
      name: fromDb.name,
      serving: { unit: fromDb.unit || "serving", grams: baseGrams },
      nutrients: normalizeNutrients({
        calories: (fromDb.calories || 0) / baseQuantity,
        protein_g: (fromDb.protein_g || 0) / baseQuantity,
        carbs_g: (fromDb.carbs_g || 0) / baseQuantity,
        fat_g: (fromDb.fat_g || 0) / baseQuantity,
        fiber_g: (fromDb.fiber_g || 0) / baseQuantity,
        sugars_g: (fromDb.sugars_g || 0) / baseQuantity,
        saturated_fat_g: (fromDb.saturated_fat_g || 0) / baseQuantity,
        trans_fat_g: (fromDb.trans_fat_g || 0) / baseQuantity,
        cholesterol_mg: (fromDb.cholesterol_mg || 0) / baseQuantity,
        sodium_mg: (fromDb.sodium_mg || 0) / baseQuantity,
        vitamin_d_mcg: (fromDb.vitamin_d_mcg || 0) / baseQuantity,
        calcium_mg: (fromDb.calcium_mg || 0) / baseQuantity,
        iron_mg: (fromDb.iron_mg || 0) / baseQuantity,
        potassium_mg: (fromDb.potassium_mg || 0) / baseQuantity,
      }),
      source: "history",
    };
    foods.set(lookup, entry);
    return entry;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("history_lookup_failed", err);
    return null;
  }
}

function servingToGrams(size, unit) {
  const amount = Number(size);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cleanedUnit = String(unit || "").trim().toLowerCase();
  if (["g", "gm", "gram", "grams"].includes(cleanedUnit)) return amount;
  if (["ml", "milliliter", "milliliters"].includes(cleanedUnit)) return amount;
  if (["oz", "ounce", "ounces"].includes(cleanedUnit)) return amount * 28.3495;
  return null;
}

async function findFoodFromBarcodeCacheByName(displayName) {
  const lookup = String(displayName || "").trim();
  if (!lookup) return null;
  try {
    const cached = await prisma.barcodeCache.findFirst({
      where: { name: { equals: lookup, mode: "insensitive" } },
    });
    if (!cached) return null;
    const servingSize = cached.servingSize || "100 g";
    const baseGrams = parseServingSizeGrams(servingSize) || 100;
    return {
      id: cached.barcode ? `barcode-${cached.barcode}` : `food-${lookup.toLowerCase().replace(/\s+/g, "-")}`,
      name: cached.name,
      serving: { unit: servingSize, grams: baseGrams },
      nutrients: normalizeNutrients(cached.nutrients || {}),
      source: "barcode_cache",
    };
  } catch (err) {
    console.error("barcode_cache_lookup_failed", err);
    return null;
  }
}

async function findFoodFromFoodTable({ food, brand }) {
  const name = String(food || "").trim();
  if (!name) return null;
  try {
    let row = null;
    if (brand) {
      const brandName = String(brand).trim();
      if (brandName) {
        const rows = await prisma.$queryRaw`
          SELECT
            id, name, "brandName", "servingSize", "servingUnit",
            calories, "totalFat", "saturatedFat", "transFat", cholesterol,
            sodium, "totalCarbs", "dietaryFiber", sugars, protein,
            "vitaminD", calcium, iron, potassium, caffeine
          FROM public."Food"
          WHERE lower(name) = lower(${name}) AND lower("brandName") = lower(${brandName})
          LIMIT 1
        `;
        row = rows?.[0] || null;
      }
    }
    if (!row) {
      const rows = await prisma.$queryRaw`
        SELECT
          id, name, "brandName", "servingSize", "servingUnit",
          calories, "totalFat", "saturatedFat", "transFat", cholesterol,
          sodium, "totalCarbs", "dietaryFiber", sugars, protein,
          "vitaminD", calcium, iron, potassium, caffeine
        FROM public."Food"
        WHERE lower(name) = lower(${name})
        LIMIT 1
      `;
      row = rows?.[0] || null;
    }
    if (!row) return null;
    const servingUnit = row.servingUnit || "serving";
    const servingGrams = servingToGrams(row.servingSize, servingUnit) || 100;
    return {
      id: row.id || `food-${name.toLowerCase().replace(/\s+/g, "-")}`,
      name: row.brandName ? `${row.brandName} ${row.name}` : row.name,
      serving: { unit: `${row.servingSize || ""} ${servingUnit}`.trim(), grams: servingGrams },
      nutrients: normalizeNutrients({
        calories: row.calories,
        protein_g: row.protein,
        carbs_g: row.totalCarbs,
        fat_g: row.totalFat,
        fiber_g: row.dietaryFiber,
        sugars_g: row.sugars,
        saturated_fat_g: row.saturatedFat,
        trans_fat_g: row.transFat,
        cholesterol_mg: row.cholesterol,
        sodium_mg: row.sodium,
        vitamin_d_mcg: row.vitaminD,
        calcium_mg: row.calcium,
        iron_mg: row.iron,
        potassium_mg: row.potassium,
      }),
      source: "food_table",
    };
  } catch (err) {
    console.error("food_table_lookup_failed", err);
    return null;
  }
}

async function resolveFoodBase({ food, brand, displayName }) {
  const lookup = String(displayName || food || "").trim().toLowerCase();
  if (!lookup) return null;
  if (foods.has(lookup)) return foods.get(lookup);
    const fromFoodTable = await findFoodFromFoodTable({ food, brand });
  if (fromFoodTable && hasNonZeroNutrients(fromFoodTable.nutrients)) {
    foods.set(lookup, fromFoodTable);
    return fromFoodTable;
  }
  const fromBarcodeCache = await findFoodFromBarcodeCacheByName(displayName || food || "");
  if (fromBarcodeCache) {
    foods.set(lookup, fromBarcodeCache);
    return fromBarcodeCache;
  }
  const fromHistory = await findFoodFromHistory(displayName || food || "");
  if (fromHistory) {
    foods.set(lookup, fromHistory);
    return fromHistory;
  }
  return null;
}

function normalizeExtractionItem(raw) {
  if (!raw) return null;
  const food = String(raw.food || raw.name || "").trim();
  if (!food) return null;
  const brand = raw.brand ? String(raw.brand).trim() : "";
  const quantity = Number(raw.quantity);
  return {
    food,
    brand,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    unit: String(raw.unit || raw.serving || "serving").trim() || "serving",
  };
}

async function extractFoodsFromLlm(text) {
  const extractPrompt = `Identify distinct foods in this meal description: "${text}".
Return JSON ONLY as an array of objects with keys:
- food (string, the food name without brand words)
- brand (string|null, brand or restaurant if mentioned)
- quantity (number, default 1)
- unit (string, like "serving","cup","oz","g","slice","bottle")
Examples (input -> output):
  "I had a large Starbucks latte and a croissant" ->
  [{"food":"latte","brand":"Starbucks","quantity":1,"unit":"serving"},{"food":"croissant","brand":null,"quantity":1,"unit":"serving"}]
  "2 cups of cooked brown rice with 5 oz grilled chicken" ->
  [{"food":"cooked brown rice","brand":null,"quantity":2,"unit":"cup"},{"food":"grilled chicken","brand":null,"quantity":5,"unit":"oz"}]
Only return the JSON array. If nothing is found return [] with no extra text.`;
  if (SKIP_LLM) return [];
  try {
    if (hasOllama) {
      const response = await callOllama(extractPrompt);
      const cleaned = response.trim().replace(/```json\n?|```\n?/g, "");
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeExtractionItem).filter(Boolean);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("food_extraction_llm_failed", err.message);
  }
  if (!useGroq) return [];
  try {
    const response = await callGroqExtractFoods(extractPrompt);
    const cleaned = response.trim().replace(/```json\n?|```\n?/g, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeExtractionItem).filter(Boolean);
  } catch (err) {
    console.error("food_extraction_groq_failed", err.message);
    return [];
  }
}

function fallbackExtractFoods(text) {
  const cleaned = text
    .replace(/\b(i\s+ate|i\s+had|i\s+drank|for\s+breakfast|for\s+lunch|for\s+dinner|for\s+snack|today|this\s+morning|this\s+evening|for\s+snack)\b/gi, "")
    .trim();
  if (!cleaned) return [];
  // Split on commas or " and " as coarse phrases.
  const phrases = cleaned
    .split(/[,;]/)
    .flatMap((chunk) => chunk.split(/\s+\band\b\s+/i))
    .flatMap((chunk) => chunk.split(/\s+\bwith\b\s+/i));
  const unitPattern =
    /\b(\d+(?:\.\d+)?)\s*(cups?|cup|tbsp|tablespoons?|tsp|teaspoons?|slice|slices|oz|ounce|ounces|g|gram|grams|ml|bottle|bottles|can|cans|pack|piece|pieces|serving|servings)\b/i;
  return phrases
    .map((raw) => {
      const chunk = raw.trim();
      if (!chunk) return null;
      const unitMatch = chunk.match(unitPattern);
      let quantity = 1;
      let unit = "serving";
      let food = chunk;
      if (unitMatch) {
        quantity = Number(unitMatch[1]) || 1;
        unit = unitMatch[2].toLowerCase();
        food = chunk.replace(unitMatch[0], "").replace(/\bof\b/i, "").trim();
      }
      // Detect "from <brand>" pattern.
      let brand = null;
      const fromMatch = food.match(/\bfrom\s+([A-Za-z0-9'’\-\s]+)$/i);
      if (fromMatch) {
        brand = fromMatch[1].trim();
        food = food.replace(fromMatch[0], "").trim();
      }
      // Detect leading brand e.g., "Starbucks latte"
      const words = food.split(/\s+/);
      if (!brand && words.length > 2 && /^[A-Z]/.test(words[0])) {
        brand = words.shift();
        food = words.join(" ").trim();
      }
      return normalizeExtractionItem({ food, brand, quantity, unit });
    })
    .filter(Boolean);
}

function computeLocalDayWindow(dateStr, tzOffsetMinutes) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const offsetMs = tzOffsetMinutes * 60000;
  // Convert local midnight to the corresponding UTC instant by ADDING the offset.
  // Example: PST offset 480 -> local midnight is 08:00 UTC the same day.
  const startUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + offsetMs);
  const endUtc = new Date(startUtc.getTime() + 86400000);
  return { startUtc, endUtc };
}

function formatLocalYMD(date, tzOffsetMinutes = 0) {
  const d = new Date(date.getTime() - tzOffsetMinutes * 60000);
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function detectMealSlot(text) {
  if (!text) return "snack";
  const lower = text.toLowerCase();
  const matches = [
    { slot: "breakfast", keywords: ["breakfast", "morning"] },
    { slot: "lunch", keywords: ["lunch", "noon"] },
    { slot: "dinner", keywords: ["dinner", "evening"] },
    { slot: "snack", keywords: ["snack"] },
  ];
  let first = { slot: "snack", idx: Infinity };
  for (const group of matches) {
    for (const kw of group.keywords) {
      const idx = lower.indexOf(kw);
      if (idx !== -1 && idx < first.idx) {
        first = { slot: group.slot, idx };
      }
    }
  }
  return first.idx === Infinity ? "snack" : first.slot;
}

function defaultTimeForSlot(slot) {
  switch (slot) {
    case "breakfast":
      return { hours: 8, minutes: 0 };
    case "lunch":
      return { hours: 13, minutes: 0 };
    case "dinner":
      return { hours: 19, minutes: 0 };
    case "snack":
    default:
      return { hours: 15, minutes: 0 };
  }
}

function parseMealText(text, tzOffsetMinutes = 0) {
  // Represent "now" in the user's local time by shifting from UTC.
  const nowLocal = new Date(Date.now() - tzOffsetMinutes * 60000);
  const slot = detectMealSlot(text);
  const daysAgoMatch = text.match(/(\d+)\s+days?\s+ago/i);
  if (daysAgoMatch) {
    const days = Number(daysAgoMatch[1]);
    const baseLocal = new Date(nowLocal);
    baseLocal.setDate(baseLocal.getDate() - (Number.isFinite(days) ? days : 0));
    const def = defaultTimeForSlot(slot);
    baseLocal.setHours(def.hours, def.minutes, 0, 0);
    const cleanedText = text.replace(daysAgoMatch[0], "").replace(/\s+/g, " ").trim();
    const utcDate = new Date(baseLocal.getTime() + tzOffsetMinutes * 60000);
    return { foodText: cleanedText || text.trim(), mealSlot: slot, consumedAt: utcDate, clampedFuture: false };
  }
  const parsed = chrono.parse(text, nowLocal, { forwardDate: false });
  let consumedAt = new Date(nowLocal.getTime() + tzOffsetMinutes * 60000);
  let cleanedText = text;
  let clampedFuture = false;
  if (parsed.length) {
    const first = parsed[0];
    const startDate = first.start?.date();
    if (startDate) {
      const localDate = new Date(startDate);
      const idx = first.index ?? -1;
      const len = first.text?.length ?? 0;
      if (idx !== -1 && len) {
        cleanedText = (text.slice(0, idx) + text.slice(idx + len))
          .replace(/\b(yesterday|today|last\s+\w+|on|at)\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
      }
      consumedAt = new Date(localDate.getTime() + tzOffsetMinutes * 60000);
    }
  }
  if (parsed.length && parsed[0].start && parsed[0].start.isCertain("day") && !parsed[0].start.isCertain("hour")) {
    const d = new Date(consumedAt.getTime() - tzOffsetMinutes * 60000);
    const def = defaultTimeForSlot(slot);
    d.setHours(def.hours, def.minutes, 0, 0);
    consumedAt = new Date(d.getTime() + tzOffsetMinutes * 60000);
  }
  const now = new Date();
  if (consumedAt.getTime() > now.getTime()) {
    clampedFuture = true;
    consumedAt = now;
  }
  return { foodText: cleanedText.trim() || text.trim(), mealSlot: slot, consumedAt, clampedFuture };
}

async function callOllama(prompt) {
  const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://ollama:11434";
  const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";
  const url = `${OLLAMA_HOST}/api/generate`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.2 },
    }),
  });
  const data = await resp.json();
  return data.response;
}

async function callGroqExtractFoods(prompt) {
  if (!useGroq) throw new Error("groq_unavailable");
  const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
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
  return data.choices?.[0]?.message?.content || "[]";
}

// Protected routes below.
app.post("/api/meals", authMiddleware, async (req, res) => {
  const { text = "", mealType, consumedAt = null, tzOffsetMinutes = 0, clientDateStr } = req.body || {};
  if (!text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  const parsed = parseMealText(text, tzOffsetMinutes);
  const userId = req.user.userId;
  const resolvedMealType = mealType && mealType !== "unspecified" ? mealType : parsed.mealSlot || inferMealType(text, parsed.consumedAt);
  const mealConsumedAt = consumedAt ? new Date(consumedAt) : parsed.consumedAt || new Date();
  const targetDateStr = clientDateStr || formatLocalYMD(mealConsumedAt, tzOffsetMinutes);

  const extracted = await extractFoodsFromLlm(parsed.foodText);
  const parsedTokens = extracted.length ? extracted : fallbackExtractFoods(parsed.foodText);
  if (!parsedTokens.length) {
    return res.status(400).json({ error: "Could not identify any foods in that description." });
  }

  const items = [];
  for (const token of parsedTokens) {
    const displayName = [token.brand, token.food].filter(Boolean).join(" ").trim() || token.food;
    const lookupKey = buildLookupKey(token);
    let base = FORCE_LLM ? null : foods.get(lookupKey);
    if (!base && !FORCE_LLM) {
      base = await resolveFoodBase({ food: token.food, brand: token.brand, displayName });
    }
    const needsRefresh = !base || (base.source && String(base.source).includes("fallback"));
    if (needsRefresh) {
      let estimate = null;
      try {
        estimate = await estimateNutrition(displayName);
      } catch (err) {
        console.error("llm_food_estimate_failed", err?.message || err, {
          provider: useGroq ? "groq" : hasOllama ? "ollama" : "none",
        });
      }
      const normalized = normalizeNutrients(estimate || defaultNutritionFallback());
      const id = base?.id || `food-${lookupKey.replace(/\s+/g, "-") || uuid()}`;
      base = {
        id,
        name: displayName,
        serving: { unit: token.unit || base?.serving?.unit || "serving", grams: base?.serving?.grams || 100 },
        nutrients: normalized,
        model_estimated: Boolean(estimate),
        source: estimate?.source || "default",
      };
      foods.set(lookupKey, base);
    }
    const portion = Number(token.quantity) && Number(token.quantity) > 0 ? Number(token.quantity) : 1;
    const nutrients = scaleNutrients(base.nutrients, portion);
    const grams = portion * (base.serving?.grams || 100);
    items.push({
      foodId: base.id,
      name: displayName,
      quantity: portion,
      unit: token.unit || base.serving?.unit || "serving",
      grams,
      nutrients,
      source: base.source || "history",
    });
  }

  const total = items.reduce((acc, item) => accumulateNutrients(acc, item.nutrients), { ...emptyNutrients });

  const mealId = uuid();
  const dateStr = targetDateStr || new Date().toISOString().slice(0, 10);
  let createdMeal = null;

  // Persist meal, items, and daily totals in DB.
  try {
    await prisma.$transaction(async (tx) => {
      const mealRecord = await tx.meal.create({
        data: {
          id: mealId,
          userId,
          mealType: resolvedMealType,
          consumedAt: new Date(mealConsumedAt),
          text: parsed.foodText,
          items: {
            create: items.map((i) => ({
              id: uuid(),
              foodId: i.foodId,
              name: i.name,
              quantity: i.quantity,
              unit: i.unit,
              grams: i.grams,
              calories: i.nutrients.calories || 0,
              protein_g: i.nutrients.protein_g || 0,
              carbs_g: i.nutrients.carbs_g || 0,
              fat_g: i.nutrients.fat_g || 0,
              fiber_g: i.nutrients.fiber_g || 0,
              sugars_g: i.nutrients.sugars_g || 0,
              saturated_fat_g: i.nutrients.saturated_fat_g || 0,
              trans_fat_g: i.nutrients.trans_fat_g || 0,
              cholesterol_mg: i.nutrients.cholesterol_mg || 0,
              sodium_mg: i.nutrients.sodium_mg || 0,
              vitamin_d_mcg: i.nutrients.vitamin_d_mcg || 0,
              calcium_mg: i.nutrients.calcium_mg || 0,
              iron_mg: i.nutrients.iron_mg || 0,
              potassium_mg: i.nutrients.potassium_mg || 0,
              source: i.source,
            })),
          },
        },
        include: { items: true },
      });
      const mealItems = mealRecord.items || [];
      const mealTotals = mealItems.reduce(
        (acc, itm) =>
          accumulateNutrients(
            acc,
            normalizeNutrients({
              calories: itm.calories,
              protein_g: itm.protein_g,
              carbs_g: itm.carbs_g,
              fat_g: itm.fat_g,
              fiber_g: itm.fiber_g,
              sugars_g: itm.sugars_g,
              saturated_fat_g: itm.saturated_fat_g,
              trans_fat_g: itm.trans_fat_g,
              cholesterol_mg: itm.cholesterol_mg,
              sodium_mg: itm.sodium_mg,
              vitamin_d_mcg: itm.vitamin_d_mcg,
              calcium_mg: itm.calcium_mg,
              iron_mg: itm.iron_mg,
              potassium_mg: itm.potassium_mg,
            })
          ),
        { ...emptyNutrients }
      );
      createdMeal = {
        id: mealRecord.id,
        userId,
        mealType: resolvedMealType,
        consumedAt: mealConsumedAt,
        text: parsed.foodText,
        items: mealItems.map((itm) => ({
          id: itm.id,
          foodId: itm.foodId,
          name: itm.name,
          quantity: itm.quantity,
          unit: itm.unit,
          grams: itm.grams,
          nutrients: normalizeNutrients({
            calories: itm.calories,
            protein_g: itm.protein_g,
            carbs_g: itm.carbs_g,
            fat_g: itm.fat_g,
            fiber_g: itm.fiber_g,
            sugars_g: itm.sugars_g,
            saturated_fat_g: itm.saturated_fat_g,
            trans_fat_g: itm.trans_fat_g,
            cholesterol_mg: itm.cholesterol_mg,
            sodium_mg: itm.sodium_mg,
            vitamin_d_mcg: itm.vitamin_d_mcg,
            calcium_mg: itm.calcium_mg,
            iron_mg: itm.iron_mg,
            potassium_mg: itm.potassium_mg,
          }),
          source: itm.source,
        })),
        total: mealTotals,
      };

      await tx.dailyTotal.upsert({
        where: { userId_date: { userId, date: new Date(dateStr) } },
        update: {
          calories: { increment: mealTotals.calories },
          protein_g: { increment: mealTotals.protein_g },
          carbs_g: { increment: mealTotals.carbs_g },
          fat_g: { increment: mealTotals.fat_g },
        },
        create: {
          userId,
          date: new Date(dateStr),
          calories: mealTotals.calories,
          protein_g: mealTotals.protein_g,
          carbs_g: mealTotals.carbs_g,
          fat_g: mealTotals.fat_g,
        },
      });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to create meal", err);
    return res.status(500).json({ error: "server_error" });
  }

  let dayTotals = { ...emptyNutrients };
  const resolvedDate = dateStr || new Date().toISOString().slice(0, 10);
  try {
    dayTotals = await recomputeDayTotals(userId, resolvedDate, tzOffsetMinutes);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("day_totals_failed", err);
    dayTotals = { ...emptyNutrients, ...total };
  }

  res.json({
    meal: { ...createdMeal, mealType: resolvedMealType, consumedAt: mealConsumedAt },
    day: { userId, date: resolvedDate, ...dayTotals },
    clampedFuture: parsed.clampedFuture || false,
  });
});

// Update meal metadata (consumedAt, mealType)
app.patch("/api/meals/:mealId", authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const mealId = req.params.mealId;
  const { consumedAt, mealType } = req.body || {};
  const tzOffsetMinutes = Number(req.body?.tzOffsetMinutes || 0);
  if (!mealId) return res.status(400).json({ error: "meal_id_required" });
  const meal = await prisma.meal.findUnique({ where: { id: mealId } });
  if (!meal || meal.userId !== userId) return res.status(404).json({ error: "not_found" });
  const newConsumedAt = consumedAt ? new Date(consumedAt) : new Date();
  const prevDateStr = formatLocalYMD(meal.consumedAt, tzOffsetMinutes);
  const newDateStr = formatLocalYMD(newConsumedAt, tzOffsetMinutes);
  const slot = mealType || meal.mealType || "snack";
  const updated = await prisma.meal.update({
    where: { id: mealId },
    data: { consumedAt: newConsumedAt, mealType: slot },
    include: { items: true },
  });
  if (prevDateStr !== newDateStr) {
    await recomputeDayTotals(userId, prevDateStr, tzOffsetMinutes);
  }
  const newDay = await recomputeDayTotals(userId, newDateStr, tzOffsetMinutes);
  res.json({ ok: true, day: { userId, date: newDateStr, ...newDay }, meal: updated });
});

// Delete a meal and recompute day totals
app.delete("/api/meals/:mealId", authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const mealId = req.params.mealId;
  const tzOffsetMinutes = Number(req.query.tzOffsetMinutes || 0);
  if (!mealId) return res.status(400).json({ error: "meal_id_required" });
  const meal = await prisma.meal.findUnique({ where: { id: mealId }, include: { items: true } });
  if (!meal || meal.userId !== userId) return res.status(404).json({ error: "not_found" });
  const localDate = new Date(meal.consumedAt.getTime() - tzOffsetMinutes * 60000).toISOString().slice(0, 10);
  await prisma.$transaction([
    prisma.mealItem.deleteMany({ where: { mealId } }),
    prisma.meal.delete({ where: { id: mealId } }),
  ]);
  const dayTotals = await recomputeDayTotals(userId, localDate, tzOffsetMinutes);
  res.json({ ok: true, day: { userId, date: localDate, ...dayTotals } });
});

app.get("/api/daily", authMiddleware, (req, res) => {
  const userId = req.user.userId;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const tzOffsetMinutes = Number(req.query.tzOffsetMinutes || 0);
  const { startUtc: start, endUtc: end } = computeLocalDayWindow(date, tzOffsetMinutes);
  prisma.meal
    .findMany({
      where: { userId, consumedAt: { gte: start, lt: end } },
      include: { items: true },
      orderBy: { consumedAt: "desc" },
    })
    .then(async (dayMeals) => {
      const totals = dayMeals.reduce(
        (acc, meal) =>
          accumulateNutrients(
            acc,
            meal.items.reduce(
              (mAcc, item) =>
                accumulateNutrients(mAcc, {
                  calories: item.calories,
                  protein_g: item.protein_g,
                  carbs_g: item.carbs_g,
                  fat_g: item.fat_g,
                  fiber_g: item.fiber_g,
                  sugars_g: item.sugars_g,
                  saturated_fat_g: item.saturated_fat_g,
                  trans_fat_g: item.trans_fat_g,
                  cholesterol_mg: item.cholesterol_mg,
                  sodium_mg: item.sodium_mg,
                  vitamin_d_mcg: item.vitamin_d_mcg,
                  calcium_mg: item.calcium_mg,
                  iron_mg: item.iron_mg,
                  potassium_mg: item.potassium_mg,
                }),
              { ...emptyNutrients }
            )
          ),
        { ...emptyNutrients }
      );
      res.json({
        day: { userId, date, ...totals },
        meals: dayMeals,
      });
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      res.status(500).json({ error: "server_error" });
    });
});

// Range of days for trend charts.
app.get("/api/days", authMiddleware, (req, res) => {
  const userId = req.user.userId;
  const tzOffsetMinutes = Number(req.query.tzOffsetMinutes || 0);
  const end = req.query.end || new Date().toISOString().slice(0, 10);
  const start = req.query.start;
  if (!start) return res.status(400).json({ error: "start required (YYYY-MM-DD)" });
  const offsetMs = tzOffsetMinutes * 60000;
  const startDate = new Date(new Date(`${start}T00:00:00Z`).getTime() + offsetMs);
  const endDate = new Date(new Date(`${end}T00:00:00Z`).getTime() + offsetMs);
  prisma.dailyTotal
    .findMany({
      where: {
        userId,
        date: { gte: startDate, lte: endDate },
      },
      orderBy: { date: "asc" },
    })
    .then((days) => res.json({ days }))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      res.status(500).json({ error: "server_error" });
    });
});

app.get("/api/summary", authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const range = String(req.query.range || "").toLowerCase();
  const tzOffsetMinutes = Number(req.query.tzOffsetMinutes || 0);
  const days = Math.max(1, Number(req.query.days || 7));
  if (!["today", "week"].includes(range)) {
    return res.status(400).json({ error: "range must be today or week" });
  }

  try {
    if (range === "today") {
      const dateStr = formatLocalYMD(new Date(), tzOffsetMinutes);
      const { startUtc, endUtc } = computeLocalDayWindow(dateStr, tzOffsetMinutes);
      const mealsForDay = await prisma.meal.findMany({
        where: { userId, consumedAt: { gte: startUtc, lt: endUtc } },
        include: { items: true },
        orderBy: { consumedAt: "desc" },
      });
      const totals = mealsForDay.reduce(
        (acc, meal) =>
          accumulateNutrients(
            acc,
            meal.items.reduce(
              (mAcc, item) =>
                accumulateNutrients(mAcc, {
                  calories: item.calories,
                  protein_g: item.protein_g,
                  carbs_g: item.carbs_g,
                  fat_g: item.fat_g,
                  fiber_g: item.fiber_g,
                  sugars_g: item.sugars_g,
                  saturated_fat_g: item.saturated_fat_g,
                  trans_fat_g: item.trans_fat_g,
                  cholesterol_mg: item.cholesterol_mg,
                  sodium_mg: item.sodium_mg,
                  vitamin_d_mcg: item.vitamin_d_mcg,
                  calcium_mg: item.calcium_mg,
                  iron_mg: item.iron_mg,
                  potassium_mg: item.potassium_mg,
                }),
              { ...emptyNutrients }
            )
          ),
        { ...emptyNutrients }
      );
      const mealCount = mealsForDay.length;
      const summaryTotals = normalizeSummaryTotals(totals);
      const summaryKey = hashPayload({
        dateStr,
        nutrientTotalsHash: hashPayload(summaryTotals),
      });

      const cached = await prisma.summary.findFirst({
        where: { userId, range, summaryKey },
        orderBy: { createdAt: "desc" },
      });
      const ttlMs = 6 * 60 * 60 * 1000;
      if (cached && Date.now() - cached.createdAt.getTime() < ttlMs) {
        return res.json({
          text: cached.text,
          aiSummary: null,
          summaryKey,
          generatedAt: cached.createdAt.toISOString(),
          cached: true,
        });
      }

      const baseline = buildNutritionSummaryText("Today", summaryTotals);
      let text = baseline;
      let model = null;
      if (useGroq && !SKIP_LLM) {
        const prompt = buildSummaryPrompt("Today", summaryTotals, mealCount);
        const aiText = await generateGroqSummary(prompt);
        if (aiText && summaryBodyIncludesFacts(aiText, summaryTotals)) {
          text = aiText.trim();
          model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
        }
      }

      const created = await prisma.summary.create({
        data: {
          userId,
          range,
          startDate: new Date(dateStr),
          endDate: new Date(dateStr),
          summaryKey,
          text,
          model,
        },
      });
      return res.json({
        text,
        summaryKey,
        generatedAt: created.createdAt.toISOString(),
        cached: false,
      });
    }

    const endDate = new Date();
    const endStr = formatLocalYMD(endDate, tzOffsetMinutes);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (days - 1));
    const startStr = formatLocalYMD(startDate, tzOffsetMinutes);
    const offsetMs = tzOffsetMinutes * 60000;
    const startWindow = new Date(new Date(`${startStr}T00:00:00Z`).getTime() + offsetMs);
    const endWindow = new Date(new Date(`${endStr}T00:00:00Z`).getTime() + offsetMs);

    const [dailyTotals, mealsInRange] = await Promise.all([
      prisma.dailyTotal.findMany({
        where: { userId, date: { gte: startWindow, lte: endWindow } },
        orderBy: { date: "asc" },
      }),
      prisma.meal.findMany({
        where: { userId, consumedAt: { gte: computeLocalDayWindow(startStr, tzOffsetMinutes).startUtc, lt: computeLocalDayWindow(endStr, tzOffsetMinutes).endUtc } },
        select: { consumedAt: true },
      }),
    ]);

    const dayTotalsByDate = new Map();
    dailyTotals.forEach((day) => {
      dayTotalsByDate.set(formatLocalYMD(day.date, tzOffsetMinutes), day);
    });
    const mealCountByDate = new Map();
    mealsInRange.forEach((meal) => {
      const key = formatLocalYMD(meal.consumedAt, tzOffsetMinutes);
      mealCountByDate.set(key, (mealCountByDate.get(key) || 0) + 1);
    });

    const daysList = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const key = formatLocalYMD(d, tzOffsetMinutes);
      const totals = dayTotalsByDate.get(key) || { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
      daysList.push({
        date: key,
        totals: {
          calories: totals.calories,
          protein_g: totals.protein_g,
          carbs_g: totals.carbs_g,
          fat_g: totals.fat_g,
        },
        meals: mealCountByDate.get(key) || 0,
      });
    }

    const totals = dailyTotals.reduce((acc, day) => {
      return accumulateNutrients(acc, normalizeNutrients(day));
    }, { ...emptyNutrients });
    const summaryTotals = normalizeSummaryTotals(totals);
    const mealCount = mealsInRange.length;
    const summaryKey = hashPayload({
      dateStr: endStr,
      nutrientTotalsHash: hashPayload(summaryTotals),
    });

    const cached = await prisma.summary.findFirst({
      where: { userId, range, summaryKey },
      orderBy: { createdAt: "desc" },
    });
    const ttlMs = 24 * 60 * 60 * 1000;
    if (cached && Date.now() - cached.createdAt.getTime() < ttlMs) {
      return res.json({
        text: cached.text,
        aiSummary: null,
        summaryKey,
        generatedAt: cached.createdAt.toISOString(),
        cached: true,
      });
    }

    const baseline = buildNutritionSummaryText("Last 7 days", summaryTotals);
    let text = baseline;
    let model = null;
    if (useGroq && !SKIP_LLM) {
      const prompt = buildSummaryPrompt("Last 7 days", summaryTotals, mealCount);
      const aiText = await generateGroqSummary(prompt);
      if (aiText && summaryBodyIncludesFacts(aiText, summaryTotals)) {
        text = aiText.trim();
        model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
      }
    }

    const created = await prisma.summary.create({
      data: {
        userId,
        range,
        startDate: new Date(startStr),
        endDate: new Date(endStr),
        summaryKey,
        text,
        model,
      },
    });
    return res.json({
      text,
      summaryKey,
      generatedAt: created.createdAt.toISOString(),
      cached: false,
    });
  } catch (err) {
    console.error("summary_error", err);
    return res.status(500).json({ error: "summary_failed" });
  }
});

app.get("/api/trends", authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const tzOffsetMinutes = Number(req.query.tzOffsetMinutes || 0);
  const metricsParam = String(req.query.metrics || "");
  const periodParam = String(req.query.period || "");
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { trendPreferences: true },
    });
    const period = trendPeriodOptions.includes(periodParam)
      ? periodParam
      : user?.trendPreferences?.period || defaultTrendPeriod;
    const requestedMetrics = metricsParam
      ? metricsParam.split(",").map((metric) => metric.trim()).filter(Boolean)
      : user?.trendPreferences?.metrics || [];
    const metrics = (requestedMetrics.length ? requestedMetrics : defaultTrendMetrics)
      .filter((metric) => trendMetricKeys.includes(metric))
      .slice(0, 3);

    const periodDays = getTrendPeriodDays(period);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (periodDays * 2 - 1));
    const startStr = formatLocalYMD(startDate, tzOffsetMinutes);
    const endStr = formatLocalYMD(endDate, tzOffsetMinutes);
    const { startUtc } = computeLocalDayWindow(startStr, tzOffsetMinutes);
    const { endUtc } = computeLocalDayWindow(endStr, tzOffsetMinutes);

    const dayKeys = [];
    for (let i = 0; i < periodDays * 2; i += 1) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      dayKeys.push(formatLocalYMD(d, tzOffsetMinutes));
    }
    const buckets = new Map();
    dayKeys.forEach((key) => {
      buckets.set(key, { totals: { ...emptyNutrients }, meals: 0 });
    });

    const mealsInRange = await prisma.meal.findMany({
      where: { userId, consumedAt: { gte: startUtc, lt: endUtc } },
      include: { items: true },
      orderBy: { consumedAt: "asc" },
    });

    mealsInRange.forEach((meal) => {
      const key = formatLocalYMD(meal.consumedAt, tzOffsetMinutes);
      const bucket = buckets.get(key);
      if (!bucket) return;
      bucket.meals += 1;
      bucket.totals = meal.items.reduce((acc, item) => {
        return accumulateNutrients(acc, {
          calories: item.calories,
          protein_g: item.protein_g,
          carbs_g: item.carbs_g,
          fat_g: item.fat_g,
          fiber_g: item.fiber_g,
          sugars_g: item.sugars_g,
          sodium_mg: item.sodium_mg,
          potassium_mg: item.potassium_mg,
          calcium_mg: item.calcium_mg,
          iron_mg: item.iron_mg,
          vitamin_d_mcg: item.vitamin_d_mcg,
          cholesterol_mg: item.cholesterol_mg,
          saturated_fat_g: item.saturated_fat_g,
          trans_fat_g: item.trans_fat_g,
        });
      }, bucket.totals);
    });

    const prevKeys = dayKeys.slice(0, periodDays);
    const lastKeys = dayKeys.slice(periodDays);
    const todayKey = formatLocalYMD(new Date(), tzOffsetMinutes);
    const lastKeysFiltered = lastKeys.filter((key) => key !== todayKey);
    const countLoggedDays = (keys) =>
      keys.filter((key) => key !== todayKey).filter((key) => {
        const bucket = buckets.get(key);
        return bucket?.meals || (bucket?.totals?.calories || 0) > 0;
      }).length;
    const lastLoggedDays = countLoggedDays(lastKeysFiltered);
    const prevLoggedDays = countLoggedDays(prevKeys);
    const totalDays = lastKeysFiltered.length;
    const dataHashPayload = lastKeysFiltered.map((key) => {
      const bucket = buckets.get(key);
      const totals = bucket?.totals || {};
      return {
        day: key,
        meals: bucket?.meals || 0,
        calories: totals.calories || 0,
        protein_g: totals.protein_g || 0,
        carbs_g: totals.carbs_g || 0,
        fat_g: totals.fat_g || 0,
      };
    });
    const dataHash = hashPayload(dataHashPayload);
    const showTrends = lastLoggedDays >= 2;

    const metricsStats = metrics.map((metric) => {
      const config = trendMetricConfig[metric];
      if (!config) return null;
      if (metric === "consistency") {
        return {
          key: metric,
          label: config.label,
          unit: config.unit,
          last7Avg: lastLoggedDays,
          prev7Avg: prevLoggedDays,
          delta: lastLoggedDays - prevLoggedDays,
        };
      }
      const sumForKeys = (keys) =>
        keys.filter((key) => key !== todayKey).reduce((sum, key) => {
          const bucket = buckets.get(key);
          return sum + (bucket?.totals?.[config.nutrientKey] || 0);
        }, 0);
      const lastSum = sumForKeys(lastKeysFiltered);
      const prevSum = sumForKeys(prevKeys);
      const last7Avg = lastLoggedDays ? lastSum / lastLoggedDays : 0;
      const prev7Avg = prevLoggedDays ? prevSum / prevLoggedDays : 0;
      return {
        key: metric,
        label: config.label,
        unit: config.unit,
        last7Avg,
        prev7Avg,
        delta: last7Avg - prev7Avg,
      };
    }).filter(Boolean);

    const periodLabel = getTrendPeriodLabel(period);
    let summaryText = "";
    let model = null;
    if (showTrends && metricsStats.length) {
      const cacheKey = hashPayload({ userId, period, metrics, dataHash });
      const cached = trendSummaryCache.get(cacheKey);
      if (cached?.summaryText) {
        summaryText = cached.summaryText;
        model = cached.model || null;
      } else {
        summaryText = buildTrendSummaryText(metricsStats, periodLabel);
        if (useGroq && !SKIP_LLM) {
          const prompt = buildTrendsPrompt(metricsStats, periodLabel);
          const aiText = await generateGroqSummary(prompt);
          if (aiText && aiText.includes("Trends are based on logged meals")) {
            summaryText = aiText.trim();
            model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
          }
        }
        trendSummaryCache.set(cacheKey, { summaryText, model, dataHash, createdAt: new Date().toISOString() });
      }
    }

    res.json({
      metrics: showTrends ? metricsStats : [],
      summaryText,
      model,
      range: { start: startStr, end: endStr, period, periodLabel },
      confidence: { daysWithMeals: lastLoggedDays, totalDays },
      dataHash,
      showTrends,
    });
  } catch (err) {
    console.error("trend_error", err);
    res.status(500).json({ error: "trend_failed" });
  }
});

// Allow users to edit nutrient info for a logged meal item.
app.patch("/api/meals/:mealId/items/:itemId", authMiddleware, async (req, res) => {
  const userId = req.user.userId;
  const { mealId, itemId } = req.params;
  const {
    calories,
    protein_g,
    carbs_g,
    fat_g,
    fiber_g,
    sugars_g,
    saturated_fat_g,
    trans_fat_g,
    cholesterol_mg,
    sodium_mg,
    vitamin_d_mcg,
    calcium_mg,
    iron_mg,
    potassium_mg,
  } = req.body || {};
  try {
    const meal = await prisma.meal.findUnique({ where: { id: mealId, userId }, include: { items: true } });
    if (!meal) return res.status(404).json({ error: "meal_not_found" });
    const item = meal.items.find((i) => i.id === itemId);
    if (!item) return res.status(404).json({ error: "item_not_found" });

    const data = normalizeNutrients({
      calories,
      protein_g,
      carbs_g,
      fat_g,
      fiber_g,
      sugars_g,
      saturated_fat_g,
      trans_fat_g,
      cholesterol_mg,
      sodium_mg,
      vitamin_d_mcg,
      calcium_mg,
      iron_mg,
      potassium_mg,
    });

    await prisma.$transaction(async (tx) => {
      await tx.mealItem.update({
        where: { id: itemId },
        data: { ...data, userEdited: true },
      });
      // Recompute meal totals by reading back items
      const items = await tx.mealItem.findMany({ where: { mealId } });
      const mealTotals = items.reduce(
        (acc, itm) =>
          accumulateNutrients(
            acc,
            normalizeNutrients({
              calories: itm.calories,
              protein_g: itm.protein_g,
              carbs_g: itm.carbs_g,
              fat_g: itm.fat_g,
              fiber_g: itm.fiber_g,
              sugars_g: itm.sugars_g,
              saturated_fat_g: itm.saturated_fat_g,
              trans_fat_g: itm.trans_fat_g,
              cholesterol_mg: itm.cholesterol_mg,
              sodium_mg: itm.sodium_mg,
              vitamin_d_mcg: itm.vitamin_d_mcg,
              calcium_mg: itm.calcium_mg,
              iron_mg: itm.iron_mg,
              potassium_mg: itm.potassium_mg,
            })
          ),
        { ...emptyNutrients }
      );
      // Update daily totals to reflect change
      const dateStr = new Date(meal.consumedAt).toISOString().slice(0, 10);
      const dayTotals = await recomputeDayTotals(userId, dateStr, 0);
      res.json({ ok: true, mealTotals, dayTotals });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("update_item_failed", err);
    res.status(500).json({ error: "server_error" });
  }
});

// Generic error handler for CORS and uncaught errors.
app.use((err, _req, res, _next) => {
  if (err?.message === "Not allowed by CORS") return res.status(403).json({ error: "cors_denied" });
  // eslint-disable-next-line no-console
  console.error("Unhandled error", err);
  return res.status(500).json({ error: "server_error" });
});

// Serve the PWA statically for local testing if present.
if (servePwa) {
  app.use(express.static(pwaDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(pwaDir, "index.html"));
  });
} else {
  // eslint-disable-next-line no-console
  console.warn("PWA assets not found; static serving is disabled. Set SERVE_PWA=true and ensure frontend/pwa is present.");
}

if (process.env.NODE_ENV !== "test") {
  app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`API listening on http://${host}:${port}`);
  });
}

export default app;
