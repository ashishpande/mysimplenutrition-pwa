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
import { estimateNutrition } from "./llm.js";

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
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:4000,http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (!JWT_SECRET || JWT_SECRET === "dev-secret-change-me") {
  // eslint-disable-next-line no-console
  console.error("Refusing to start without a secure JWT_SECRET");
  if (env !== "test") {
    process.exit(1);
  }
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

// Seed foods (placeholder).
foods.set("egg", {
  id: "food-egg",
  name: "Egg, whole",
  serving: { unit: "piece", grams: 50 },
  nutrients: { calories: 72, protein_g: 6, carbs_g: 0.4, fat_g: 4.8 },
});
foods.set("toast", {
  id: "food-toast",
  name: "Toast, white bread slice",
  serving: { unit: "slice", grams: 30 },
  nutrients: { calories: 80, protein_g: 3, carbs_g: 14, fat_g: 1 },
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
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

// Protected routes below.
app.post("/api/meals", authMiddleware, async (req, res) => {
  const { text = "", mealType, consumedAt = new Date().toISOString() } = req.body || {};
  if (!text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  const userId = req.user.userId;
  const resolvedMealType = mealType && mealType !== "unspecified" ? mealType : inferMealType(text, consumedAt);

  const tokens = text
    .toLowerCase()
    .split(/,| and |\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const matched = tokens
    .map((token) => {
      const hit = foods.get(token);
      if (!hit) return null;
      const quantity = 1;
      return {
        foodId: hit.id,
        name: hit.name,
        quantity,
        unit: hit.serving.unit,
        grams: quantity * hit.serving.grams,
        nutrients: hit.nutrients,
        source: "catalog",
      };
    })
    .filter(Boolean);

  const missing = tokens.filter((token) => !foods.has(token));
  const llmGenerated = [];
  for (const token of missing) {
    const estimate = await estimateNutrition(token);
    const id = `food-${token.replace(/\s+/g, "-")}`;
    foods.set(token, {
      id,
      name: token,
      serving: { unit: "item", grams: 100 },
      nutrients: estimate,
      model_estimated: true,
    });
    llmGenerated.push({
      foodId: id,
      name: token,
      quantity: 1,
      unit: "item",
      grams: 100,
      nutrients: estimate,
      source: estimate.source || "llm_local",
    });
  }

  const items = [...matched, ...llmGenerated];
  const total = items.reduce(
    (acc, item) => ({
      calories: acc.calories + (item.nutrients.calories || 0),
      protein_g: acc.protein_g + (item.nutrients.protein_g || 0),
      carbs_g: acc.carbs_g + (item.nutrients.carbs_g || 0),
      fat_g: acc.fat_g + (item.nutrients.fat_g || 0),
    }),
    { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }
  );

  const mealId = uuid();
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
  const dateStr = consumedAt.slice(0, 10);
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

  res.json({ meal: createdMeal, day: { userId, date: dateStr, ...total } });
});

app.get("/api/daily", authMiddleware, (req, res) => {
  const userId = req.user.userId;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  prisma.dailyTotal
    .findUnique({ where: { userId_date: { userId, date: new Date(date) } } })
    .then((day) =>
      prisma.meal.findMany({
        where: { userId, consumedAt: { gte: new Date(`${date}T00:00:00Z`), lt: new Date(`${date}T23:59:59Z`) } },
        include: { items: true },
        orderBy: { consumedAt: "desc" },
      }).then((dayMeals) =>
        res.json({
          day: day || { userId, date, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
          meals: dayMeals,
        })
      )
    )
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      res.status(500).json({ error: "server_error" });
    });
});

// Range of days for trend charts.
app.get("/api/days", authMiddleware, (req, res) => {
  const userId = req.user.userId;
  const end = req.query.end || new Date().toISOString().slice(0, 10);
  const start = req.query.start;
  if (!start) return res.status(400).json({ error: "start required (YYYY-MM-DD)" });
  prisma.dailyTotal
    .findMany({
      where: {
        userId,
        date: { gte: new Date(start), lte: new Date(end) },
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
