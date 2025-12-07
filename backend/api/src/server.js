process.env.TZ = process.env.TZ || "UTC";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import crypto from "crypto";
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
const port = process.env.PORT || 4000;
const host = process.env.HOST || "0.0.0.0";
const env = process.env.NODE_ENV || "development";
const JWT_SECRET = process.env.JWT_SECRET || (env === "test" ? "dev-secret-change-me" : null);
// Force LLM lookups in non-production by default; override with FORCE_LLM env.
const FORCE_LLM = process.env.FORCE_LLM === "true" || env !== "production";
const useGroq = !!process.env.GROQ_API_KEY;
const estimateNutrition = async (name) => {
  try {
    return await estimateNutritionOllama(name);
  } catch (err) {
    if (useGroq) {
      try {
        return await estimateNutritionGroq(name);
      } catch (err2) {
        // eslint-disable-next-line no-console
        console.error("[llm] groq fallback failed", err2.message || err2);
      }
    }
    // eslint-disable-next-line no-console
    console.error("[llm] ollama failed", err.message || err);
    throw err;
  }
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
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
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

function normalizeNutrients(values = {}) {
  const normalized = {};
  for (const key of nutrientKeys) {
    const n = Number(values[key]);
    normalized[key] = Number.isFinite(n) ? n : 0;
  }
  return normalized;
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
    },
  });
  if (!user) return res.status(404).json({ error: "not_found" });
  const safeUser = { ...user };
  delete safeUser.passwordHash;
  delete safeUser.password;
  res.json({ user: safeUser });
});

app.put("/api/profile", authMiddleware, async (req, res) => {
  const { firstName, lastName, heightUnit, weightUnit, heightValue, heightFeet, heightInches, weightValue } = req.body || {};
  const parsedHeight = normalizeHeight({ heightUnit, heightValue, heightFeet, heightInches });
  const parsedWeight = normalizeWeight({ weightUnit, weightValue });
  try {
    const user = await prisma.user.update({
      where: { id: req.user.userId },
      data: {
        firstName,
        lastName,
        heightCm: parsedHeight,
        heightUnit,
        weightKg: parsedWeight,
        weightUnit,
      },
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
      },
    });
    res.json({ user });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("profile_update_error", err);
    res.status(500).json({ error: "server_error" });
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
    },
    deviceToken: issuedDeviceToken || deviceToken || null,
    ...tokens,
  });
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
  try {
    const response = await callOllama(extractPrompt);
    const cleaned = response.trim().replace(/```json\n?|```\n?/g, "");
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeExtractionItem).filter(Boolean);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("food_extraction_llm_failed", err.message);
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
  const startUtc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs);
  const endUtc = new Date(startUtc.getTime() + 86400000);
  return { startUtc, endUtc };
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

// Protected routes below.
app.post("/api/meals", authMiddleware, async (req, res) => {
  const { text = "", mealType, consumedAt = new Date().toISOString(), tzOffsetMinutes = 0, clientDateStr } = req.body || {};
  if (!text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  const userId = req.user.userId;
  const resolvedMealType = mealType && mealType !== "unspecified" ? mealType : inferMealType(text, consumedAt);

  const extracted = await extractFoodsFromLlm(text);
  const parsedTokens = extracted.length ? extracted : fallbackExtractFoods(text);
  if (!parsedTokens.length) {
    return res.status(400).json({ error: "Could not identify any foods in that description." });
  }

  const items = [];
  for (const token of parsedTokens) {
    const displayName = [token.brand, token.food].filter(Boolean).join(" ").trim() || token.food;
    const lookupKey = buildLookupKey(token);
    let base = FORCE_LLM ? null : foods.get(lookupKey);
    if (!base && !FORCE_LLM) {
      base = await findFoodFromHistory(displayName);
    }
    const needsRefresh = !base || (base.source && String(base.source).includes("fallback"));
    if (needsRefresh) {
      const estimate = await estimateNutrition(displayName);
      const normalized = normalizeNutrients(estimate);
      const id = base?.id || `food-${lookupKey.replace(/\s+/g, "-") || uuid()}`;
      base = {
        id,
        name: displayName,
        serving: { unit: token.unit || base?.serving?.unit || "serving", grams: base?.serving?.grams || 100 },
        nutrients: normalized,
        model_estimated: true,
        source: estimate.source || "llm_estimated",
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
  // Always use client-provided local date
  const dateStr = clientDateStr || new Date().toISOString().slice(0, 10);
  const createdMeal = {
    id: mealId,
    userId,
    mealType: resolvedMealType,
    consumedAt,
    text,
    items,
    total,
  };

  // Persist meal, items, and daily totals in DB.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.meal.create({
        data: {
          id: mealId,
          userId,
          mealType: resolvedMealType,
          consumedAt: new Date(consumedAt),
          text,
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
      });

      await tx.dailyTotal.upsert({
        where: { userId_date: { userId, date: new Date(dateStr) } },
        update: {
          calories: { increment: total.calories },
          protein_g: { increment: total.protein_g },
          carbs_g: { increment: total.carbs_g },
          fat_g: { increment: total.fat_g },
        },
        create: {
          userId,
          date: new Date(dateStr),
          calories: total.calories,
          protein_g: total.protein_g,
          carbs_g: total.carbs_g,
          fat_g: total.fat_g,
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

  res.json({ meal: createdMeal, day: { userId, date: resolvedDate, ...dayTotals } });
});

app.get("/api/daily", authMiddleware, (req, res) => {
  const userId = req.user.userId;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const tzOffsetMinutes = Number(req.query.tzOffsetMinutes || 0);
  const [y, m, d] = date.split("-").map(Number);
  const offsetMs = tzOffsetMinutes * 60000;
  // Local midnight converted to UTC window: subtract offset to get UTC time
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs);
  const end = new Date(start.getTime() + 86400000);
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
      await recomputeDayTotals(userId, dateStr, 0);
      res.json({ ok: true, mealTotals });
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
