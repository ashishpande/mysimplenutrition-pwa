// Shared constants and state for the PWA
const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
export const API_BASE = window.API_BASE || (isLocalhost ? "http://localhost:4000/api" : "/api");
export const AUTH_BASE = API_BASE.replace(/\/api$/, "");

function safeStorageGet(key, fallback = "") {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (_err) {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_err) {
    // Ignore storage errors (private mode, blocked storage, etc.).
  }
}

export { safeStorageGet, safeStorageSet };

const storedDeviceToken = safeStorageGet("mfaDeviceToken", "");
const storedTheme = safeStorageGet("appTheme", "auto");
export const PIE_COLORS = ["#2563eb", "#0ea5e9", "#22c55e", "#f59e0b", "#a855f7", "#f97316"];

export const state = {
  listening: false,
  status: "idle",
  text: "",
  result: null,
  fix: { active: false, mealId: null, text: "" },
  fixTime: { active: false, mealId: null, date: "", time: "", slot: "", status: "idle" },
  editingItem: null, // { mealId, itemId, values }
  today: null, // { day, meals }
  error: null,
  updateAvailable: false,
  theme: storedTheme, // auto | light | dark
  toast: null,
  showTutorial: !safeStorageGet("tutorialSeen", ""),
  miniBarKeys: ["calories", "protein_g", "carbs_g", "fat_g", "sugars_g"],
  historyRangeDays: 7,
  loadingMore: false,
  auth: {
    mode: "login", // login | register | reset
    email: "",
    password: "",
    confirmPassword: "",
    firstName: "",
    lastName: "",
    heightValue: "",
    heightUnit: "cm",
    heightFeet: "",
    heightInches: "",
    weightValue: "",
    weightUnit: "kg",
    showOptionalMetrics: false,
    unitsDefaulted: false,
    token: "",
    accessToken: null,
    user: null,
    mfaRequired: false,
    deviceToken: storedDeviceToken,
    rememberDevice: true,
    status: "idle",
  },
  tab: "today",
  profileForm: {
    firstName: "",
    lastName: "",
    heightUnit: "cm",
    heightValue: "",
    heightFeet: "",
    heightInches: "",
    weightUnit: "kg",
    weightValue: "",
  },
  mfa: {
    otpauthUrl: "",
    base32: "",
    token: "",
  },
  days: [],
  expandedDays: new Set(),
  dayPanels: { nutrientsOpen: false, mealsOpen: false },
  loadingToday: false,
  loadingDays: false,
  summary: {
    today: { status: "idle", text: "", summaryKey: "", generatedAt: null, source: "local", open: false },
    week: {
      status: "idle",
      text: "",
      summaryKey: "",
      generatedAt: null,
      source: "local",
      open: false,
      detailsOpen: false,
      showZeros: false,
      compare: false,
    },
  },
  trends: {
    status: "idle",
    metrics: [],
    summaryText: "",
    range: null,
    confidence: null,
    showTrends: true,
    dataHash: "",
  },
  features: {
    barcode_scanning_enabled: false,
  },
  barcodeScanner: {
    active: false,
    error: null,
    streaming: false,
    retryCount: 0,
  },
  barcodeEntry: {
    open: false,
    barcode: "",
    name: "",
    fullLabel: false,
    servingSize: "100 g",
    calories: "",
    protein_g: "",
    carbs_g: "",
    fat_g: "",
    fiber_g: "",
    sugars_g: "",
    added_sugar_g: "",
    saturated_fat_g: "",
    trans_fat_g: "",
    cholesterol_mg: "",
    sodium_mg: "",
    vitamin_d_mcg: "",
    calcium_mg: "",
    iron_mg: "",
    potassium_mg: "",
  },
  trendPreferences: {
    metrics: [],
    period: "7d",
    open: false,
    saving: false,
    error: null,
  },
};

function isLikelyUsUser() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const lang = (navigator.language || "").toLowerCase();
  return tz.startsWith("America/") || lang === "en-us";
}

export function maybeDefaultRegisterUnits() {
  if (state.auth.unitsDefaulted || state.auth.mode !== "register") return;
  if (isLikelyUsUser()) {
    state.auth.heightUnit = "ftin";
    state.auth.weightUnit = "lb";
  }
  state.auth.unitsDefaulted = true;
}
