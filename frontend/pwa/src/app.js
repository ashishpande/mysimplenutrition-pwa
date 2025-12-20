import { API_BASE, AUTH_BASE, PIE_COLORS, state, maybeDefaultRegisterUnits } from "./state.js";
import { authRequest, requestResetLink, resetPasswordApi, createMeal, fetchDaysApi, fetchDailyApi, fetchTodayApi, deleteMeal, patchMealMeta, fetchSummary } from "./api.js";
import { formatWhen, buildConsumedAtFromInputs } from "./time.js";

const appEl = document.getElementById("app");

function maybeInitResetFromUrl() {
  if (state.auth.mode === "reset" && state.auth.token) return;
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get("resetToken");
  const email = params.get("email");
  if (resetToken || email) {
    state.auth.mode = "reset";
    state.auth.accessToken = null;
    if (resetToken) state.auth.token = resetToken;
    if (email) state.auth.email = decodeURIComponent(email);
    params.delete("resetToken");
    params.delete("email");
    const newUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState({}, "", newUrl);
  }
}

function isDesktopLike() {
  return window.matchMedia ? window.matchMedia("(pointer: fine)").matches : true;
}

function showToast(message, type = "success") {
  state.toast = { message, type };
  render();
  setTimeout(() => {
    state.toast = null;
    render();
  }, 3000);
}

function dismissTutorial() {
  state.showTutorial = false;
  localStorage.setItem("tutorialSeen", "true");
  render();
}

function renderTodaySection(result, today) {
  const mealToShow = result?.meal;
  const dayTotals = null;
  const formatSource = (src) => (src ? `source: ${src}` : "");
  const mealSection = mealToShow
    ? `
      <div class="meal meal-result">
        <div class="tag">${mealToShow?.mealType || "unspecified"}</div>
        <div class="meal-text-line">
          ${
            state.fix.active && state.fix.mealId === mealToShow?.id
              ? `
                <label class="fix-inline">
                  <span>You said:</span>
                  <input id="fixText" type="text" value="${state.fix.text || ""}" />
                </label>
                <div class="fix-actions">
                  <button id="fixUpdateBtn" class="primary small">Update</button>
                  <button id="fixCancelBtn" class="ghost small">Cancel</button>
                </div>
              `
              : `
                <strong>You said:</strong> “${mealToShow?.text || "Logged meal"}”
                <button class="ghost small inline-edit" data-fix-text="${mealToShow?.text || ""}" data-fix-meal="${mealToShow?.id || ""}">✏️ Fix</button>
              `
          }
        </div>
        <div class="when-line">
          ${
            state.fixTime.active && state.fixTime.mealId === mealToShow?.id
              ? `
                <div class="fix-inline">
                  <span>When:</span>
                  <input type="date" id="fix-date" value="${state.fixTime.date || formatLocalYMD(new Date(mealToShow?.consumedAt || Date.now()))}" />
                  <input type="time" id="fix-time" value="${
                    state.fixTime.time ||
                    `${String(new Date(mealToShow?.consumedAt || Date.now()).getHours()).padStart(2, "0")}:${String(
                      new Date(mealToShow?.consumedAt || Date.now()).getMinutes()
                    ).padStart(2, "0")}`
                  }" />
                  <select id="fix-slot">
                    ${["breakfast", "lunch", "dinner", "snack"]
                      .map(
                        (s) =>
                          `<option value="${s}" ${(state.fixTime.slot || mealToShow?.mealType || "snack") === s ? "selected" : ""}>${
                            s.charAt(0).toUpperCase() + s.slice(1)
                          }</option>`
                      )
                      .join("")}
                  </select>
                </div>
                <div class="fix-actions">
                  <button id="fix-time-save" class="primary small" ${state.fixTime.status === "saving" ? "disabled" : ""}>
                    ${state.fixTime.status === "saving" ? `<span class="spinner"></span> Saving...` : "Save"}
                  </button>
                  <button id="fix-time-cancel" class="ghost small" ${state.fixTime.status === "saving" ? "disabled" : ""}>Cancel</button>
                  ${
                    state.fixTime.status === "success"
                      ? `<span class="small success-text">Updated your meal.</span>`
                      : ""
                  }
                </div>
              `
              : `
                <strong>When:</strong> ${formatWhen(mealToShow?.consumedAt, mealToShow?.mealType)}
                <button class="ghost small inline-edit" data-fix-time="${mealToShow?.id || ""}">Fix time</button>
              `
          }
        </div>
        <ul class="meal-items">
          ${(mealToShow?.items || [])
            .map(
              (item) => `
            <li>
              <div class="item-title">${item.name}</div>
              <div class="item-meta">${item.quantity} ${item.unit} (${Math.round(item.grams)}g)</div>
              ${state.editingItem?.itemId === item.id ? renderEditForm(mealToShow.id, item) : ""}
              <div class="macro">
                Calories: ${formatNumber(item.nutrients.calories, 0)} kcal |
                Protein: ${formatNumber(item.nutrients.protein_g, 1)}g |
                Carbs: ${formatNumber(item.nutrients.carbs_g, 1)}g |
                Fat: ${formatNumber(item.nutrients.fat_g, 1)}g
              </div>
              <details class="details-card details-inline">
                <summary>More nutrition details</summary>
                <div class="macro small">
                  Fiber: ${formatNumber(item.nutrients.fiber_g, 1)}g |
                  Sugar: ${formatNumber(item.nutrients.sugars_g, 1)}g |
                  Sat: ${formatNumber(item.nutrients.saturated_fat_g, 1)}g |
                  Trans: ${formatNumber(item.nutrients.trans_fat_g, 1)}g |
                  Unsat: ${formatNumber(Math.max((item.nutrients.fat_g || 0) - (item.nutrients.saturated_fat_g || 0) - (item.nutrients.trans_fat_g || 0), 0), 1)}g |
                  Chol: ${formatNumber(item.nutrients.cholesterol_mg, 0)}mg |
                  Sodium: ${formatNumber(item.nutrients.sodium_mg, 0)}mg |
                  Vitamin D: ${formatNumber(item.nutrients.vitamin_d_mcg, 1)}mcg |
                  Calcium: ${formatNumber(item.nutrients.calcium_mg, 0)}mg |
                  Iron: ${formatNumber(item.nutrients.iron_mg, 1)}mg |
                  Potassium: ${formatNumber(item.nutrients.potassium_mg, 0)}mg
                </div>
              </details>
            </li>
          `
            )
            .join("")}
        </ul>
      <div class="total">
        <div class="total-line">
          <span>Total: ${formatNumber(mealToShow?.total?.calories, 0)} kcal — P: ${formatNumber(mealToShow?.total?.protein_g, 1)}g | C: ${formatNumber(mealToShow?.total?.carbs_g, 1)}g | F: ${formatNumber(mealToShow?.total?.fat_g, 1)}g</span>
          ${
            mealToShow?.adjusted
              ? `<span class="badge badge-adjusted" title="You adjusted these numbers.">Adjusted</span>`
              : `<span class="badge badge-estimated" title="Values are estimates based on food data and AI matching.">Estimated</span>`
          }
          <button class="ghost small inline-adjust" data-edit="${mealToShow?.items?.[0]?.id || ""}" data-meal="${mealToShow?.id || ""}">Adjust nutrition</button>
        </div>
      </div>
    </div>
    `
    : "";

  return mealSection;
}

function renderDaySummary(dayTotals, meals = []) {
  if (!dayTotals) return "";
  const mealsList =
    meals?.length
      ? `<details id="today-meals-details" class="details-card" ${state.dayPanels.mealsOpen ? "open" : ""}>
            <summary>Meals today</summary>
            <ul class="day-meals-list">
              ${meals
                .map((m) => {
                  const totals = computeTotalsFromItems(m.items || []);
                  return `
                    <li class="meal-item">
                      <div class="meal-header">
                        <span class="pill">${m.mealType || "meal"}</span>
                        <span class="meal-time">${new Date(m.consumedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                      </div>
                      <div class="meal-text">${m.text || "Logged meal"}</div>
                      <div class="macro small">
                        ${formatNumber(totals.calories, 0)} kcal — P ${formatNumber(totals.protein_g, 0)}g · C ${formatNumber(totals.carbs_g, 0)}g · F ${formatNumber(totals.fat_g, 0)}g
                      </div>
                      <details class="details-card details-inline">
                        <summary>More nutrition details</summary>
                        <div class="macro small">
                          Fiber: ${formatNumber(totals.fiber_g, 1)}g |
                          Sugar: ${formatNumber(totals.sugars_g, 1)}g |
                          Sat: ${formatNumber(totals.saturated_fat_g, 1)}g |
                          Trans: ${formatNumber(totals.trans_fat_g, 1)}g |
                          Unsat: ${formatNumber(Math.max((totals.fat_g || 0) - (totals.saturated_fat_g || 0) - (totals.trans_fat_g || 0), 0), 1)}g |
                          Chol: ${formatNumber(totals.cholesterol_mg, 0)}mg |
                          Sodium: ${formatNumber(totals.sodium_mg, 0)}mg |
                          Vitamin D: ${formatNumber(totals.vitamin_d_mcg, 1)}mcg |
                          Calcium: ${formatNumber(totals.calcium_mg, 0)}mg |
                          Iron: ${formatNumber(totals.iron_mg, 1)}mg |
                          Potassium: ${formatNumber(totals.potassium_mg, 0)}mg
                        </div>
                      </details>
                    </li>
                  `;
                })
                .join("")}
            </ul>
         </details>`
      : "";
  return `
    <div class="day day-summary">
      <h3>Day so far (${formatLocalYMD(new Date())})</h3>
          ${renderMiniBars(dayTotals, ["calories", "protein_g", "carbs_g", "fat_g"])}
      <details id="today-nutrients-details" class="details-card" ${state.dayPanels.nutrientsOpen ? "open" : ""}>
        <summary>More nutrition details</summary>
        ${renderNutrientGrid(dayTotals)}
      </details>
      ${mealsList}
    </div>
  `;
}

function renderEditForm(mealId, item) {
  const vals = state.editingItem?.values || {};
  const field = (key, label, unit = "") => {
    const current = vals[key] ?? item.nutrients?.[key] ?? item[key] ?? "";
    return `
      <label class="inline-label">
        <span>${label}</span>
        <input type="number" step="0.1" data-field="${key}" value="${current}" />
        <span class="unit">${unit}</span>
      </label>
    `;
  };
  return `
    <div class="edit-block" data-item="${item.id}">
      <div class="edit-grid">
        ${field("calories", "Calories", "kcal")}
        ${field("protein_g", "Protein", "g")}
        ${field("carbs_g", "Carbs", "g")}
        ${field("fat_g", "Fat", "g")}
        ${field("fiber_g", "Fiber", "g")}
        ${field("sugars_g", "Sugars", "g")}
        ${field("saturated_fat_g", "Sat Fat", "g")}
        ${field("trans_fat_g", "Trans Fat", "g")}
        ${field("cholesterol_mg", "Cholesterol", "mg")}
        ${field("sodium_mg", "Sodium", "mg")}
        ${field("vitamin_d_mcg", "Vitamin D", "mcg")}
        ${field("calcium_mg", "Calcium", "mg")}
        ${field("iron_mg", "Iron", "mg")}
        ${field("potassium_mg", "Potassium", "mg")}
      </div>
      <div class="edit-actions">
        <span class="autosave-note">Auto-saving changes...</span>
        <button class="ghost small" data-cancel="${item.id}">Close</button>
      </div>
    </div>
  `;
}

function formatNumber(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(digits);
}

function computeTodayStats(today) {
  if (!today || !today.meals?.length) {
    return {
      headline: "Today: no meals logged yet.",
      avg: "",
      macros: "",
      mealCount: 0,
      totalCalories: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
    };
  }
  const totals = today.day || computeTotalsFromItems(today.meals.flatMap((m) => m.items || []));
  const mealCount = today.meals.length;
  return {
    headline: `Today: ${mealCount} meal${mealCount === 1 ? "" : "s"} logged`,
    avg: `Total ${Math.round(totals.calories || 0)} kcal`,
    macros: `Macros: P ${Math.round(totals.protein_g || 0)}g · C ${Math.round(totals.carbs_g || 0)}g · F ${Math.round(totals.fat_g || 0)}g`,
    mealCount,
    totalCalories: Math.round(totals.calories || 0),
    proteinG: Math.round(totals.protein_g || 0),
    carbsG: Math.round(totals.carbs_g || 0),
    fatG: Math.round(totals.fat_g || 0),
  };
}

function computeWeekStats(days) {
  const totalDays = 7;
  if (!days?.length) {
    return {
      headline: "Last 7 calendar days: no data yet.",
      avg: "",
      macros: "",
      loggedDays: 0,
      totalCalories: 0,
      avgCaloriesPerDay: 0,
      proteinG: 0,
      carbsG: 0,
      fatG: 0,
      mealCount: 0,
    };
  }
  const totals = days.reduce(
    (acc, day) => ({
      calories: acc.calories + (day.calories || 0),
      protein_g: acc.protein_g + (day.protein_g || 0),
      carbs_g: acc.carbs_g + (day.carbs_g || 0),
      fat_g: acc.fat_g + (day.fat_g || 0),
      meals: acc.meals + (day.mealCount || (day.meals ? day.meals.length : 0) || 0),
    }),
    { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, meals: 0 }
  );
  const loggedDays = days.filter((day) => (day.calories || 0) > 0).length;
  const avgCalories = totals.calories / Math.max(totalDays, 1);
  return {
    headline: `Last 7 calendar days: ${loggedDays} day${loggedDays === 1 ? "" : "s"} logged`,
    avg: `Avg ${Math.round(avgCalories)} kcal/day`,
    macros: `Macros: P ${Math.round(totals.protein_g)}g · C ${Math.round(totals.carbs_g)}g · F ${Math.round(totals.fat_g)}g`,
    loggedDays,
    totalCalories: Math.round(totals.calories || 0),
    avgCaloriesPerDay: Math.round(avgCalories || 0),
    proteinG: Math.round(totals.protein_g || 0),
    carbsG: Math.round(totals.carbs_g || 0),
    fatG: Math.round(totals.fat_g || 0),
    mealCount: totals.meals,
  };
}

function buildTodayLocalSummary(stats) {
  if (!stats.mealCount) {
    return "You haven't logged any meals today yet.";
  }
  return `You logged ${stats.mealCount} meal${stats.mealCount !== 1 ? "s" : ""} today totaling ${stats.totalCalories} kcal. Macros were Protein ${stats.proteinG}g, Carbs ${stats.carbsG}g, and Fat ${stats.fatG}g.`;
}

function buildWeeklyLocalSummary(stats) {
  const daysLogged = stats.loggedDays || 0;
  if (!stats.totalCalories && !daysLogged) {
    return "No meals logged in the last 7 days.";
  }
  const mealCount = stats.mealCount || 0;
  const mealLabel = mealCount === 1 ? "meal" : "meals";
  const dayLabel = daysLogged === 1 ? "day" : "days";
  return `Last 7 days: ${daysLogged} ${dayLabel} logged, ${mealCount || "?"} ${mealLabel} and ${stats.totalCalories.toLocaleString()} kcal, P ${stats.proteinG}g, C ${stats.carbsG}g, F ${stats.fatG}g (avg ${stats.avgCaloriesPerDay.toLocaleString()} kcal/day).`;
}

function normalizeTotals(total = {}) {
  return {
    calories: total.calories || 0,
    protein_g: total.protein_g || 0,
    carbs_g: total.carbs_g || 0,
    fat_g: total.fat_g || 0,
    fiber_g: total.fiber_g || 0,
    sugars_g: total.sugars_g || 0,
    saturated_fat_g: total.saturated_fat_g || 0,
    trans_fat_g: total.trans_fat_g || 0,
    cholesterol_mg: total.cholesterol_mg || 0,
    sodium_mg: total.sodium_mg || 0,
    vitamin_d_mcg: total.vitamin_d_mcg || 0,
    calcium_mg: total.calcium_mg || 0,
    iron_mg: total.iron_mg || 0,
    potassium_mg: total.potassium_mg || 0,
  };
}

function computePieSlices(total) {
  const t = normalizeTotals(total);
  const segments = [
    { label: "Total Carbs (g)", value: t.carbs_g },
    { label: "Fiber (g)", value: t.fiber_g },
    { label: "Total Sugar (g)", value: t.sugars_g },
    { label: "Protein (g)", value: t.protein_g },
    { label: "Total Fat (g)", value: t.fat_g },
    { label: "Cholesterol (mg)", value: t.cholesterol_mg },
  ].filter((s) => Number(s.value) > 0);
  const totalValue = segments.reduce((sum, seg) => sum + Number(seg.value || 0), 0) || 1;
  let cursor = 0;
  const slices = segments.map((seg, idx) => {
    const start = (cursor / totalValue) * 360;
    cursor += Number(seg.value || 0);
    const end = (cursor / totalValue) * 360;
    return { ...seg, start, end, color: PIE_COLORS[idx % PIE_COLORS.length] };
  });
  const gradient = slices.map((s) => `${s.color} ${s.start.toFixed(2)}deg ${s.end.toFixed(2)}deg`).join(", ");
  return { slices, gradient };
}

function renderPie(total, title) {
  const { slices, gradient } = computePieSlices(total);
  if (!slices.length) return "";
  return `
    <div class="pie-block">
      <div class="pie" style="background: conic-gradient(${gradient});"></div>
      <div class="pie-legend">
        ${slices
          .map(
            (s) => `
              <div class="legend-row">
                <span class="dot" style="background:${s.color};"></span>
                <span class="label">${s.label}</span>
                <span class="value">${formatNumber(s.value, 1)}</span>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderNutrientGrid(total) {
  const t = normalizeTotals(total);
  const unsaturated = Math.max(t.fat_g - t.saturated_fat_g - t.trans_fat_g, 0);
  return `
    <div class="nutrient-grid">
      <div class="nutrient-pill highlight">Calories <strong>${formatNumber(t.calories, 0)}</strong></div>
      <div class="nutrient-pill">Protein <strong>${formatNumber(t.protein_g, 1)}g</strong></div>
      <div class="nutrient-pill">Total Carbs <strong>${formatNumber(t.carbs_g, 1)}g</strong></div>
      <div class="nutrient-pill">Fiber <strong>${formatNumber(t.fiber_g, 1)}g</strong></div>
      <div class="nutrient-pill">Total Sugar <strong>${formatNumber(t.sugars_g, 1)}g</strong></div>
      <div class="nutrient-pill">Total Fat <strong>${formatNumber(t.fat_g, 1)}g</strong></div>
      <div class="nutrient-pill">Saturated Fat <strong>${formatNumber(t.saturated_fat_g, 1)}g</strong></div>
      <div class="nutrient-pill">Trans Fat <strong>${formatNumber(t.trans_fat_g, 1)}g</strong></div>
      <div class="nutrient-pill">Unsaturated Fat <strong>${formatNumber(unsaturated, 1)}g</strong></div>
      <div class="nutrient-pill">Cholesterol <strong>${formatNumber(t.cholesterol_mg, 0)}mg</strong></div>
      <div class="nutrient-pill">Sodium <strong>${formatNumber(t.sodium_mg, 0)}mg</strong></div>
      <div class="nutrient-pill">Vitamin D <strong>${formatNumber(t.vitamin_d_mcg, 1)}mcg</strong></div>
      <div class="nutrient-pill">Calcium <strong>${formatNumber(t.calcium_mg, 0)}mg</strong></div>
      <div class="nutrient-pill">Iron <strong>${formatNumber(t.iron_mg, 1)}mg</strong></div>
      <div class="nutrient-pill">Potassium <strong>${formatNumber(t.potassium_mg, 0)}mg</strong></div>
    </div>
  `;
}

// Daily values for %DV calculations.
const MINI_BAR_FIELDS = {
  calories: { label: "Calories", unit: "kcal", color: "#2563eb", dv: 2000 },
  protein_g: { label: "Protein", unit: "g", color: "#10b981", dv: 50 },
  carbs_g: { label: "Carbs", unit: "g", color: "#f59e0b", dv: 275 },
  fat_g: { label: "Fat", unit: "g", color: "#6366f1", dv: 78 },
  sugars_g: { label: "Sugar", unit: "g", color: "#ef4444", dv: 50 },
  fiber_g: { label: "Fiber", unit: "g", color: "#06b6d4", dv: 28 },
  saturated_fat_g: { label: "Sat Fat", unit: "g", color: "#a855f7", dv: 20 },
};

function renderMiniBars(total, keys = []) {
  const t = normalizeTotals(total);
  const rows = keys
    .map((k) => {
      const meta = MINI_BAR_FIELDS[k];
      if (!meta) return null;
      const value = t[k] ?? 0;
      const pctDv = meta.dv ? (value / meta.dv) * 100 : null;
      return { ...meta, value, pctDv };
    })
    .filter(Boolean);
  // Scale bars by %DV when available, otherwise relative max.
  const max = Math.max(
    ...rows.map((r) => (r.pctDv != null ? Math.min(r.pctDv, 100) : r.value)),
    1
  );
  return `
    <div class="mini-bars">
      ${rows
        .map((r) => {
          const pct = r.pctDv != null ? Math.min(100, Math.round(r.pctDv)) : Math.min(100, Math.round((r.value / max) * 100));
          const valueText = `${formatNumber(r.value, r.unit === "kcal" ? 0 : 1)}${r.unit}`;
          const pctText = r.pctDv != null ? ` (${Math.round(Math.min(r.pctDv, 999))}% DV)` : "";
          return `
            <div class="bar-row">
              <span class="bar-label">${r.label}</span>
              <div class="bar-track">
                <div class="bar-fill" style="width:${pct}%;background:${r.color};"></div>
              </div>
              <span class="bar-value">${valueText}${pctText}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function determineMealType(text) {
  const lower = (text || "").toLowerCase();
  if (lower.includes("breakfast") || lower.includes("morning")) return "breakfast";
  if (lower.includes("lunch") || lower.includes("noon")) return "lunch";
  if (lower.includes("dinner") || lower.includes("evening")) return "dinner";
  if (lower.includes("snack")) return "snack";
  return "snack";
}

function cmToFeetInches(cm) {
  if (!cm || Number.isNaN(cm)) return { feet: "", inches: "" };
  const totalInches = cm / 2.54;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round((totalInches - feet * 12) * 10) / 10;
  return { feet, inches };
}

function buildProfileFormFromUser(user) {
  const heightUnit = user?.heightUnit || "cm";
  const weightUnit = user?.weightUnit || "kg";
  let heightValue = "";
  let heightFeet = "";
  let heightInches = "";
  if (user?.heightCm) {
    if (heightUnit === "cm") heightValue = user.heightCm;
    else if (heightUnit === "in") heightValue = Math.round((user.heightCm / 2.54) * 10) / 10;
    else if (heightUnit === "ftin") {
      const h = cmToFeetInches(user.heightCm);
      heightFeet = h.feet;
      heightInches = h.inches;
    }
  }
  let weightValue = "";
  if (user?.weightKg) {
    if (weightUnit === "kg") weightValue = user.weightKg;
    else if (weightUnit === "lb") weightValue = Math.round((user.weightKg / 0.453592) * 10) / 10;
  }
  return {
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
    heightUnit,
    heightValue,
    heightFeet,
    heightInches,
    weightUnit,
    weightValue,
  };
}

function render() {
  maybeInitResetFromUrl();
  if (!state.auth.accessToken) {
    renderAuth();
  } else {
    if (state.tab === "today" && !state.today) {
      fetchToday();
    }
    renderApp();
  }
}

function renderAuth() {
  const {
    mode,
    email,
    password,
    confirmPassword,
    token,
    mfaRequired,
    rememberDevice,
    firstName,
    lastName,
    heightUnit,
    heightValue,
    heightFeet,
    heightInches,
    weightUnit,
    weightValue,
  } = state.auth;
  maybeDefaultRegisterUnits();
  const passwordTooShort = mode === "register" && password && password.length < 8;
  const confirmMismatch = mode === "register" && confirmPassword && confirmPassword !== password;
  const optionalActive = mode === "register" && (heightFeet || heightInches || heightValue || weightValue);
  let heightInlineError = "";
  let weightInlineError = "";
  if (mode === "register" && optionalActive) {
    if (heightUnit === "ftin" && !heightFeet) heightInlineError = "Enter feet (inches optional).";
    if (heightUnit === "cm" && !heightValue) heightInlineError = "Enter height in cm.";
    if (weightValue && !weightUnit) weightInlineError = "Choose a weight unit.";
  }
  const title = mode === "register" ? "Create your account" : "Welcome back";
  const subtitle = mode === "register" ? "Start logging meals in seconds." : "Log in to continue.";
  const themeIcon = state.theme === "dark" ? "🌙" : state.theme === "light" ? "☀️" : "🌓";
  appEl.innerHTML = `
    <div class="shell narrow">
      <header class="auth-header">
        <div class="brand-block">
          <h1 class="brand-title">Simple Nutrition Tracker</h1>
          <p>${mode === "register" ? "Create your account to start logging meals." : "Sign in to log meals and see reports."}</p>
        </div>
        <button id="theme-btn" class="ghost theme-icon" title="Toggle theme">${themeIcon}</button>
      </header>
      <main>
        <section class="card auth-card">
          <div class="auth-layout">
            ${mode === "login" ? `
              <div class="auth-visual">
                <div class="pill">Simple food logging</div>
                <h3>Fuel your day with better choices</h3>
                <p>Quickly log meals and jump back to your routine.</p>
              </div>
            ` : ""}
            ${
              mode === "reset"
                ? `
                <div class="form reset-block">
                  <p class="muted">Forgot your password? Send a reset link, then paste the token and set a new password.</p>
                  <label>Email <input type="email" id="reset-email" value="${email}" /></label>
                  <div class="inline-actions">
                    <button id="send-reset" class="ghost" type="button" ${state.status === "loading" ? "disabled" : ""}>Send reset link</button>
                  </div>
                  <label>Reset token <input type="text" id="reset-token" value="${token}" /></label>
                  <label class="password-field">
                    <span>New password</span>
                    <div class="password-input">
                      <input type="password" id="reset-password" value="${password}" />
                      <button class="icon-button" type="button" data-toggle-password="reset-password" aria-label="Toggle new password visibility">👁️</button>
                    </div>
                  </label>
                  <label class="password-field">
                    <span>Confirm new password</span>
                    <div class="password-input">
                      <input type="password" id="reset-confirm" value="${confirmPassword}" />
                      <button class="icon-button" type="button" data-toggle-password="reset-confirm" aria-label="Toggle confirm password visibility">👁️</button>
                    </div>
                  </label>
                  <button id="reset-submit" class="primary" type="button" ${state.status === "loading" ? "disabled" : ""}>Reset password</button>
                  <button id="back-to-login" class="link-button" type="button">Back to login</button>
                  <div class="status">${state.status === "loading" ? "Sending reset..." : ""} ${state.error ? `<span class="error">${state.error}</span>` : ""}</div>
                </div>
              `
                : `
                <div class="form">
                  <h2 class="auth-title">${title}</h2>
                  <p class="auth-subtitle">${subtitle}</p>
                  <label>Email <input type="email" id="email" value="${email}" placeholder="you@example.com" inputmode="email" autocomplete="email" /></label>
                  <label class="password-field">
                    <span>Password</span>
                    <div class="password-input">
                      <input type="password" id="password" value="${password}" autocomplete="${mode === "login" ? "current-password" : "new-password"}" />
                      <button class="icon-button" type="button" data-toggle-password="password" aria-label="Toggle password visibility">👁️</button>
                    </div>
                    <div class="helper">At least 8 characters.</div>
                    ${passwordTooShort ? `<div class="field-error">Password must be at least 8 characters.</div>` : ""}
                  </label>
                  ${
                    mode === "login"
                      ? `<button class="link-button inline-link" id="forgot-link" type="button">Forgot your password?</button>`
                      : ""
                  }
                  ${
                    mode === "register"
                      ? `
                          <label class="password-field">
                            <span>Confirm password</span>
                            <div class="password-input">
                              <input type="password" id="confirm-password" value="${confirmPassword}" autocomplete="new-password" />
                              <button class="icon-button" type="button" data-toggle-password="confirm-password" aria-label="Toggle confirm password visibility">👁️</button>
                            </div>
                            ${confirmMismatch ? `<div class="field-error">Passwords do not match.</div>` : ""}
                          </label>
                          <label>First name <input type="text" id="first-name" value="${firstName}" autocomplete="given-name" placeholder="(optional)" /></label>
                          <label>Last name <input type="text" id="last-name" value="${lastName}" autocomplete="family-name" placeholder="(optional)" /></label>
                          <div class="optional-block">
                            <button class="link-button optional-toggle" id="toggle-optional" type="button">
                              ${state.auth.showOptionalMetrics ? "Hide optional height & weight" : "Optional: Add height & weight (for personalization)"}
                            </button>
                            ${
                              state.auth.showOptionalMetrics
                                ? `
                                  <div class="optional-fields">
                                    <div class="two-col">
                                      <label>Height unit
                                        <select id="height-unit">
                                          <option value="cm" ${heightUnit === "cm" ? "selected" : ""}>cm</option>
                                          <option value="in" ${heightUnit === "in" ? "selected" : ""}>inches</option>
                                          <option value="ftin" ${heightUnit === "ftin" ? "selected" : ""}>feet + inches</option>
                                        </select>
                                      </label>
                                      ${
                                        heightUnit === "ftin"
                                          ? `
                                            <label>Feet
                                              <input type="number" step="1" id="height-feet" value="${heightFeet}" />
                                            </label>
                                            <label>Inches
                                              <input type="number" step="0.1" id="height-inches" value="${heightInches}" />
                                            </label>
                                          `
                                          : `<label>Height value
                                              <input type="number" step="0.1" id="height-value" value="${heightValue}" />
                                            </label>`
                                      }
                                      <label>Weight unit
                                        <select id="weight-unit">
                                          <option value="kg" ${weightUnit === "kg" ? "selected" : ""}>kg</option>
                                          <option value="lb" ${weightUnit === "lb" ? "selected" : ""}>lb</option>
                                        </select>
                                      </label>
                                      <label>Weight value
                                        <input type="number" step="0.1" id="weight-value" value="${weightValue}" />
                                      </label>
                                    </div>
                                    ${heightInlineError ? `<div class="field-error">${heightInlineError}</div>` : ""}
                                    ${weightInlineError ? `<div class="field-error">${weightInlineError}</div>` : ""}
                                  </div>
                                `
                                : ""
                            }
                          </div>
                        `
                      : ""
                  }
                  ${
                    mfaRequired
                      ? `<label>Authenticator code <input type="text" id="token" value="${token}" /></label>`
                      : ""
                  }
                  ${
                    mfaRequired
                      ? `<label class="checkbox">
                          <input type="checkbox" id="remember-device" ${rememberDevice ? "checked" : ""} />
                          Remember this device
                        </label>`
                      : ""
                  }
                  <button
                    id="auth-submit"
                    class="${mode === "login" ? "primary" : "ghost"}"
                    ${state.auth.status === "loading" ? "disabled" : ""}
                    aria-busy="${state.auth.status === "loading"}"
                  >
                    ${state.auth.status === "loading" ? `<span class="spinner" aria-hidden="true"></span>` : ""}
                    ${mode === "login" ? (state.auth.status === "loading" ? "Logging in..." : "Log in") : state.auth.status === "loading" ? "Creating..." : "Create account"}
                  </button>
                  ${
                    mode === "login"
                      ? `
                        <button class="link-button" id="switch-register" type="button">New here? Create an account</button>
                      `
                      : `<button class="link-button" id="switch-login" type="button">Already have an account? Log in</button>`
                  }
                  <p class="trust-copy">We only ask for what’s needed to log your food.</p>
                  <div class="status">${state.error ? `<span class="error">${state.error}</span>` : ""}</div>
                </div>
              `
            }
          </div>
        </section>
      </main>
    </div>
  `;
  if (document.getElementById("email")) {
    document.getElementById("email").oninput = (e) => (state.auth.email = e.target.value);
  }
  if (document.getElementById("password")) {
    document.getElementById("password").oninput = (e) => (state.auth.password = e.target.value);
  }
  document.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.onclick = () => {
      const targetId = btn.dataset.togglePassword;
      const input = document.getElementById(targetId);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "👁️" : "🙈";
    };
  });
  if (document.getElementById("first-name")) {
    document.getElementById("first-name").oninput = (e) => (state.auth.firstName = e.target.value);
  }
  if (document.getElementById("last-name")) {
    document.getElementById("last-name").oninput = (e) => (state.auth.lastName = e.target.value);
  }
  if (document.getElementById("height-unit")) {
    document.getElementById("height-unit").onchange = (e) => {
      state.auth.heightUnit = e.target.value;
      render(); // re-render to show correct inputs
    };
  }
  if (document.getElementById("height-value")) {
    document.getElementById("height-value").oninput = (e) => (state.auth.heightValue = e.target.value);
  }
  if (document.getElementById("height-feet")) {
    document.getElementById("height-feet").oninput = (e) => (state.auth.heightFeet = e.target.value);
  }
  if (document.getElementById("height-inches")) {
    document.getElementById("height-inches").oninput = (e) => (state.auth.heightInches = e.target.value);
  }
  if (document.getElementById("weight-unit")) {
    document.getElementById("weight-unit").onchange = (e) => (state.auth.weightUnit = e.target.value);
  }
  if (document.getElementById("weight-value")) {
    document.getElementById("weight-value").oninput = (e) => (state.auth.weightValue = e.target.value);
  }
  if (document.getElementById("confirm-password")) {
    document.getElementById("confirm-password").oninput = (e) => (state.auth.confirmPassword = e.target.value);
  }
  if (document.getElementById("token")) {
    document.getElementById("token").oninput = (e) => (state.auth.token = e.target.value);
  }
  if (document.getElementById("remember-device")) {
    document.getElementById("remember-device").onchange = (e) => (state.auth.rememberDevice = e.target.checked);
  }
  if (document.getElementById("auth-submit")) {
    document.getElementById("auth-submit").onclick = submitAuth;
  }
  const switchRegister = document.getElementById("switch-register");
  if (switchRegister) {
    switchRegister.onclick = () => {
      state.auth.mode = "register";
      maybeDefaultRegisterUnits();
       state.auth.showOptionalMetrics = false;
      state.error = null;
      render();
    };
  }
  const switchLogin = document.getElementById("switch-login");
  if (switchLogin) {
    switchLogin.onclick = () => {
      state.auth.mode = "login";
      state.error = null;
      state.auth.unitsDefaulted = false;
      state.auth.showOptionalMetrics = false;
      render();
    };
  }
  const forgotLink = document.getElementById("forgot-link");
  if (forgotLink) {
    forgotLink.onclick = () => {
      state.auth.mode = "reset";
      state.error = null;
      render();
    };
  }
  const resetEmail = document.getElementById("reset-email");
  if (resetEmail) resetEmail.oninput = (e) => (state.auth.email = e.target.value);
  const resetToken = document.getElementById("reset-token");
  if (resetToken) resetToken.oninput = (e) => (state.auth.token = e.target.value);
  const resetPass = document.getElementById("reset-password");
  if (resetPass) resetPass.oninput = (e) => (state.auth.password = e.target.value);
  const resetConfirm = document.getElementById("reset-confirm");
  if (resetConfirm) resetConfirm.oninput = (e) => (state.auth.confirmPassword = e.target.value);
  const sendResetBtn = document.getElementById("send-reset");
  if (sendResetBtn) sendResetBtn.onclick = sendResetLink;
  const resetSubmit = document.getElementById("reset-submit");
  if (resetSubmit) resetSubmit.onclick = resetPassword;
  const toggleOptional = document.getElementById("toggle-optional");
  if (toggleOptional) {
    toggleOptional.onclick = () => {
      state.auth.showOptionalMetrics = !state.auth.showOptionalMetrics;
      state.error = null;
      render();
    };
  }
  const backToLogin = document.getElementById("back-to-login");
  if (backToLogin) {
    backToLogin.onclick = () => {
      state.auth.mode = "login";
      state.error = null;
      render();
    };
  }
  if (document.getElementById("theme-btn")) {
    document.getElementById("theme-btn").onclick = toggleTheme;
  }
  if (document.getElementById("dismiss-tutorial")) {
    document.getElementById("dismiss-tutorial").onclick = dismissTutorial;
  }
}

function renderApp() {
  const { listening, status, text, result, error, tab, days } = state;
  const displayName = [state.auth.user?.firstName, state.auth.user?.lastName].filter(Boolean).join(" ") || state.auth.user?.email || "";
  const themeIcon = state.theme === "dark" ? "🌙" : state.theme === "light" ? "☀️" : "🌓";
  const todayBaseline = computeTodayStats(state.today);
  const weekBaseline = computeWeekStats(days);
  appEl.innerHTML = `
    <div class="shell">
      <header class="app-header">
        <div class="brand-block">
          <h1 class="brand-title">Simple Nutrition Tracker</h1>
          <p class="greeting">Hi ${displayName}</p>
        </div>
        <div class="tabs desktop-tabs">
          <button class="${tab === "today" ? "tab active" : "tab"}" data-tab="today">Today</button>
          <button class="${tab === "history" ? "tab active" : "tab"}" data-tab="history">History</button>
          <button class="${tab === "trends" ? "tab active" : "tab"}" data-tab="trends">Trends</button>
          <button class="${tab === "profile" ? "tab active" : "tab"}" data-tab="profile">Profile</button>
        </div>
        <div class="header-actions">
          <button id="theme-btn" class="ghost theme-icon" title="Toggle theme">${themeIcon}</button>
          <button class="ghost logout-btn" data-logout>Logout</button>
        </div>
      </header>
      ${
        state.toast
          ? `<div class="toast toast-${state.toast.type}">${state.toast.message}</div>`
          : ""
      }
      ${
        state.updateAvailable
          ? `<div class="update-banner">
              <span>New version available.</span>
              <button id="refresh-app" class="primary">Refresh</button>
            </div>`
          : ""
      }
      <main>
        ${
          tab === "today"
            ? `
          <section class="card">
            <h2>Log a meal</h2>
            <div class="log-input">
              <button id="voice-btn" class="icon-btn ghost-btn ${listening ? "active" : ""}" aria-pressed="${listening}" aria-label="Use microphone">🎤</button>
              <input id="text-input" class="log-field" placeholder="Type or say what you ate. We’ll estimate nutrition. (e.g., “2 eggs and toast”)" value="${text}" />
              <button id="submit-btn" class="primary log-btn" ${status === "loading" ? "disabled" : ""}>
                ${status === "loading" ? `<span class="spinner" aria-hidden="true"></span> Logging...` : "Log"}
              </button>
            </div>
            <div class="status">${error ? `<span class="error">${error}</span>` : ""}</div>
          </section>
          ${
            result
              ? `<section class="card">
                  <h2>We heard</h2>
                  ${renderTodaySection(result, state.today)}
                </section>`
              : ""
          }`
            : ""
        }
        ${
          tab === "today"
            ? `
          ${state.today?.day ? `<section class="card">
            ${renderDaySummary(state.today.day, state.today.meals)}
          </section>` : ""}
          <details id="today-summary" class="card summary-card" ${state.summary.today.open ? "open" : ""}>
            <summary><span class="summary-title">Summary</span></summary>
            <div class="summary-block">
              <p>${getSummaryText("today", todayBaseline)}</p>
            </div>
            <p class="muted" style="margin-top: 8px;">Based on logged meals. Estimates may be approximate.</p>
          </details>`
            : ""
        }
        ${
          tab === "history"
            ? `
          <section class="card">
            <h2>Recent days</h2>
            <details id="week-summary" class="details-card summary-card" ${state.summary.week.open ? "open" : ""}>
              <summary><span class="summary-caret" aria-hidden="true">▸</span><span class="summary-title">Summary</span></summary>
              <div class="summary-block">
                <p>${getSummaryText("week", weekBaseline)}</p>
              </div>
              <p class="muted" style="margin-top: 8px;">Based on logged meals · Estimates may be approximate</p>
            </details>
            ${
              days.length
                ? `<ul class="days">${days
                    .map(
                      (d) => {
                        const dateStr = typeof d.date === 'string' && d.date.includes('T') ? d.date.split('T')[0] : d.date;
                        const [y, m, day] = dateStr.split("-");
                        const formatted = `${m}-${day}-${y}`;
                        const isExpanded = state.expandedDays.has(dateStr);
                        const mealsHtml = isExpanded && d.loading ? `<div style="padding: 12px; text-align: center;">Loading<span class='spinner'></span></div>` : isExpanded && d.meals ? `
                          <ul class="day-meals-list">
                            ${d.meals.map(meal => {
                              const totals = computeTotalsFromItems(meal.items || []);
                              return `
                                <li class="meal-item">
                                  <div class="meal-header">
                                    <span class="pill">${meal.mealType || "meal"}</span>
                                    <span class="meal-time">· ${new Date(meal.consumedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                                  </div>
                                  <div class="meal-text">${meal.text || "Logged meal"}</div>
                                  <div class="macro small">
                                    ${formatNumber(totals.calories, 0)} kcal — P ${formatNumber(totals.protein_g, 0)}g · C ${formatNumber(totals.carbs_g, 0)}g · F ${formatNumber(totals.fat_g, 0)}g
                                  </div>
                                  ${
                                    (meal.items || []).length
                                      ? `<details class="meal-items details">
                                          <summary>More nutrition details</summary>
                                          <ul>
                                            ${meal.items
                                              .map((item) => {
                                                const n = item.nutrients || item;
                                                return `
                                                  <li>
                                                    <div class="item-title">${item.name || "Item"}</div>
                                                    <div class="macro small">
                                                      Calories: ${formatNumber(n.calories, 0)} kcal |
                                                      Protein: ${formatNumber(n.protein_g, 1)}g |
                                                      Carbs: ${formatNumber(n.carbs_g, 1)}g |
                                                      Fiber: ${formatNumber(n.fiber_g, 1)}g |
                                                      Sugar: ${formatNumber(n.sugars_g, 1)}g |
                                                      Fat: ${formatNumber(n.fat_g, 1)}g |
                                                      Sat: ${formatNumber(n.saturated_fat_g, 1)}g |
                                                      Trans: ${formatNumber(n.trans_fat_g, 1)}g |
                                                      Chol: ${formatNumber(n.cholesterol_mg, 0)}mg |
                                                      Sodium: ${formatNumber(n.sodium_mg, 0)}mg
                                                    </div>
                                                  </li>
                                                `;
                                              })
                                              .join("")}
                                          </ul>
                                        </details>`
                                      : ""
                                  }
                                </li>
                              `;
                            }).join("")}
                          </ul>
                        ` : "";
                        const highIntake = (d.calories || 0) >= 3200;
                        return `<li class="day-item" data-date="${dateStr}" style="cursor: pointer;">
                          <div style="display: flex; align-items: center; gap: 8px; align-items: flex-start;">
                            <span class="expand-icon">${isExpanded ? '▼' : '▶'}</span>
                            <div>
                              <strong>${formatted}</strong><br/>
                              <div class="macro small">${formatNumber(d.calories, 0)} kcal — P ${formatNumber(d.protein_g, 0)}g · C ${formatNumber(d.carbs_g, 0)}g · F ${formatNumber(d.fat_g, 0)}g</div>
                              ${highIntake ? `<div class="muted small">High intake day</div>` : ""}
                            </div>
                          </div>
                          ${mealsHtml}
                        </li>`;
                      }
                    )
                    .join("")}</ul>
                    <div class="inline-actions" style="margin-top: 12px;${days.length > 0 ? "" : " display:none;"}">
                      <button id="load-more-days" class="ghost small" type="button"${state.loadingMore ? " disabled" : ""}>
                        ${state.loadingMore ? `<span class="spinner"></span> Loading...` : "Load more days"}
                      </button>
                    </div>`
                : `<div class="empty-state">
                    <div class="empty-icon">📊</div>
                    <h3>No history yet</h3>
                    <p>Your meal history will appear here once you start logging meals.</p>
                  </div>`
            }
          </section>`
            : ""
        }
        ${
          tab === "trends"
            ? `
          <section class="card">
            <h2>7-day trend (Calories)</h2>
            ${days.length ? renderTrend(days) : `<div class="empty-state">
              <div class="empty-icon">📈</div>
              <h3>No trend data yet</h3>
              <p>Log meals for a few days to see your calorie trends.</p>
            </div>`}
          </section>`
            : ""
        }
        ${
          tab === "profile"
            ? `
          <section class="card profile-card">
            <div class="card-header">
              <div>
                <p class="eyebrow">Profile</p>
                <h2>Your details</h2>
              </div>
            </div>
            <div class="form">
              <div class="two-col">
                <label>First name <input type="text" id="profile-first" value="${state.profileForm.firstName || ""}" /></label>
                <label>Last name <input type="text" id="profile-last" value="${state.profileForm.lastName || ""}" /></label>
              </div>
              <div class="two-col">
                <label>Height unit
                  <select id="profile-height-unit">
                    <option value="cm" ${state.profileForm.heightUnit === "cm" ? "selected" : ""}>cm</option>
                    <option value="in" ${state.profileForm.heightUnit === "in" ? "selected" : ""}>inches</option>
                    <option value="ftin" ${state.profileForm.heightUnit === "ftin" ? "selected" : ""}>feet + inches</option>
                  </select>
                </label>
                ${
                  state.profileForm.heightUnit === "ftin"
                    ? `
                      <label>Feet <input type="number" step="1" id="profile-height-feet" value="${state.profileForm.heightFeet || ""}" /></label>
                      <label>Inches <input type="number" step="0.1" id="profile-height-inches" value="${state.profileForm.heightInches || ""}" /></label>
                    `
                    : `<label>Height value <input type="number" step="0.1" id="profile-height-value" value="${state.profileForm.heightValue || ""}" /></label>`
                }
              </div>
              <div class="two-col">
                <label>Weight unit
                  <select id="profile-weight-unit">
                    <option value="kg" ${state.profileForm.weightUnit === "kg" ? "selected" : ""}>kg</option>
                    <option value="lb" ${state.profileForm.weightUnit === "lb" ? "selected" : ""}>lb</option>
                  </select>
                </label>
                <label>Weight value <input type="number" step="0.1" id="profile-weight-value" value="${state.profileForm.weightValue || ""}" /></label>
              </div>
            </div>
            <div class="status">${state.error ? `<span class="error">${state.error}</span>` : ""}</div>
            <div class="actions">
              <button id="profile-save" class="primary">Save changes${state.status === "saving" ? "<span class='spinner'></span>" : ""}</button>
              <button class="ghost" data-logout>Logout</button>
            </div>
          </section>
          <section class="card">
            <div class="card-header">
              <div>
                <p class="eyebrow">Security</p>
                <h2>Multi-factor authentication</h2>
              </div>
            </div>
            <div class="mfa-block">
              <p>Status: ${state.auth.user?.mfaEnabled ? "Enabled" : "Disabled"}</p>
              ${
                state.mfa.otpauthUrl
                  ? `<p>Scan in your authenticator app:</p><code class="qr-url">${state.mfa.otpauthUrl}</code>`
                  : ""
              }
              ${
                !state.auth.user?.mfaEnabled
                  ? `<div class="mfa-actions">
                      <button id="mfa-start" class="ghost">Start setup</button>
                      ${
                        state.mfa.otpauthUrl
                          ? `<div class="form">
                              <label>Enter 6-digit code <input type="text" id="mfa-token" value="${state.mfa.token || ""}" /></label>
                              <button id="mfa-verify" class="primary">Verify & Enable</button>
                            </div>`
                          : ""
                      }
                    </div>`
                  : ""
              }
            </div>
            <div class="status">${state.error ? `<span class="error">${state.error}</span>` : ""}</div>
          </section>`
            : ""
        }
      </main>
      <nav class="mobile-nav">
        <button class="${tab === "today" ? "tab active" : "tab"}" data-tab="today">Today</button>
        <button class="${tab === "history" ? "tab active" : "tab"}" data-tab="history">History</button>
        <button class="${tab === "trends" ? "tab active" : "tab"}" data-tab="trends">Trends</button>
        <button class="${tab === "profile" ? "tab active" : "tab"}" data-tab="profile">Profile</button>
      </nav>
    </div>
  `;

  if (tab === "today") {
    document.getElementById("voice-btn").onclick = toggleVoice;
    document.getElementById("submit-btn").onclick = submitText;
    const todaySummaryEl = document.getElementById("today-summary");
    if (todaySummaryEl) {
      todaySummaryEl.ontoggle = () => {
        state.summary.today.open = todaySummaryEl.open;
        if (todaySummaryEl.open) ensureSummary("today");
      };
    }
    const todayNutrients = document.getElementById("today-nutrients-details");
    if (todayNutrients) {
      const summaryEl = todayNutrients.querySelector("summary");
      if (summaryEl) {
        summaryEl.onclick = (e) => {
          e.preventDefault();
          const nextOpen = !todayNutrients.open;
          state.dayPanels.nutrientsOpen = nextOpen;
          if (nextOpen) {
            todayNutrients.setAttribute("open", "");
          } else {
            todayNutrients.removeAttribute("open");
          }
        };
      }
      todayNutrients.ontoggle = () => {
        state.dayPanels.nutrientsOpen = todayNutrients.open;
      };
    }
    const todayMealsDetails = document.getElementById("today-meals-details");
    if (todayMealsDetails) {
      const summaryEl = todayMealsDetails.querySelector("summary");
      if (summaryEl) {
        summaryEl.onclick = (e) => {
          e.preventDefault();
          const nextOpen = !todayMealsDetails.open;
          state.dayPanels.mealsOpen = nextOpen;
          if (nextOpen) {
            todayMealsDetails.setAttribute("open", "");
          } else {
            todayMealsDetails.removeAttribute("open");
          }
        };
      }
      todayMealsDetails.ontoggle = () => {
        state.dayPanels.mealsOpen = todayMealsDetails.open;
      };
    }
    if (document.getElementById("fixText")) {
      document.getElementById("fixText").oninput = (e) => (state.fix.text = e.target.value);
    }
    if (document.getElementById("fixUpdateBtn")) {
      document.getElementById("fixUpdateBtn").onclick = async () => {
        const mealId = state.fix.mealId;
        const fixText = state.fix.text || "";
        const tzOffsetMinutes = new Date().getTimezoneOffset();
        state.error = null;
        state.status = "loading";
        render();
        if (mealId) {
          try {
            const res = await deleteMeal(mealId, state.auth.accessToken, tzOffsetMinutes);
            if (!res.ok) throw new Error("delete_failed");
            if (state.today?.meals?.length) {
              state.today.meals = state.today.meals.filter((m) => m.id !== mealId);
            }
            state.result = null;
            await fetchToday();
            await fetchDays();
            invalidateAllSummaries();
          } catch (err) {
            state.error = "Could not remove the previous meal. You can still log the update.";
          }
        }
        state.text = fixText;
        state.fix = { active: false, mealId: null, text: "" };
        render();
        await submitText();
        state.status = "idle";
        render();
        await fetchToday();
        await fetchDays();
      };
    }
    if (document.getElementById("fixCancelBtn")) {
      document.getElementById("fixCancelBtn").onclick = () => {
        state.fix = { active: false, mealId: null, text: "" };
        render();
      };
    }
    if (document.getElementById("theme-btn")) {
      document.getElementById("theme-btn").onclick = toggleTheme;
    }
    if (!state.today) {
      fetchToday();
    }
    const textInput = document.getElementById("text-input");
    textInput.oninput = (e) => {
      state.text = e.target.value;
    };
    textInput.onkeydown = (e) => {
      if (!isDesktopLike()) return;
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        submitText();
      }
    };
    document.querySelectorAll("[data-edit]").forEach((btn) => {
      const mealId = btn.dataset.meal || result?.meal?.id;
      btn.onclick = () => startEditItem(btn.dataset.edit, mealId);
    });
    document.querySelectorAll(".inline-adjust").forEach((btn) => {
      const mealId = btn.dataset.meal || result?.meal?.id;
      btn.onclick = () => startEditItem(btn.dataset.edit, mealId);
    });
    document.querySelectorAll(".inline-edit").forEach((btn) => {
      btn.onclick = async () => {
        const fixText = btn.dataset.fixText || "";
        const mealId = btn.dataset.fixMeal || "";
        state.fix = { active: true, mealId, text: fixText };
        state.result = state.result && state.result.meal?.id === mealId ? state.result : state.result;
        render();
        const input = document.getElementById("fixText");
        if (input) input.focus();
      };
    });
    document.querySelectorAll(".edit-block input[data-field]").forEach((input) => {
      input.oninput = (e) => updateEditingField(e.target.dataset.field, e.target.value);
    });
    document.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.onclick = () => cancelEdit();
    });
    document.querySelectorAll("[data-fix-time]").forEach((btn) => {
      btn.onclick = () => {
        const mealId = btn.dataset.fixTime;
          const meal =
            (state.result?.meal && state.result.meal.id === mealId ? state.result.meal : null) ||
            (state.today?.meals || []).find((m) => m.id === mealId);
        const consumedAt = meal?.consumedAt ? new Date(meal.consumedAt) : new Date();
        state.fixTime = {
          active: true,
          mealId,
          date: formatLocalYMD(consumedAt),
          time: `${String(consumedAt.getHours()).padStart(2, "0")}:${String(consumedAt.getMinutes()).padStart(2, "0")}`,
          slot: meal?.mealType || "snack",
        };
        render();
      };
    });
    const fixDate = document.getElementById("fix-date");
    const fixTimeInput = document.getElementById("fix-time");
    const fixSlot = document.getElementById("fix-slot");
    if (fixDate) fixDate.oninput = (e) => (state.fixTime.date = e.target.value);
    if (fixTimeInput) fixTimeInput.oninput = (e) => (state.fixTime.time = e.target.value);
    if (fixSlot) fixSlot.onchange = (e) => (state.fixTime.slot = e.target.value);
    if (document.getElementById("fix-time-cancel")) {
      document.getElementById("fix-time-cancel").onclick = () => {
        state.fixTime = { active: false, mealId: null, date: "", time: "", slot: "", status: "idle" };
        render();
      };
    }
    if (document.getElementById("fix-time-save")) {
      document.getElementById("fix-time-save").onclick = async () => {
        state.fixTime.status = "saving";
        render();
        
        try {
          const { mealId, date, time, slot } = state.fixTime;
          const tzOffsetMinutes = new Date().getTimezoneOffset();
          const consumedAt = buildConsumedAtFromInputs(date, time, slot || "snack");
          
          const res = await patchMealMeta(mealId, {
            consumedAt,
            mealType: slot || "snack",
            tzOffsetMinutes,
            token: state.auth.accessToken,
          });
          
          if (!res.ok) {
            const data = await parseJsonSafe(res);
            throw new Error(data?.error || "Save failed");
          }
          
          await fetchToday();
          await fetchDays();
          invalidateAllSummaries();
          state.fixTime.status = "idle";
          state.fixTime.active = false;
          showToast("Your changes have been saved");
          render();
        } catch (err) {
          state.fixTime.status = "idle";
          state.error = "Unable to update time. Please try again.";
          render();
        }
      };
    }
  }
  document.querySelectorAll(".tabs button, .mobile-nav button").forEach((btn) => {
    btn.onclick = () => {
      stopListening("tab-switch");
      state.tab = btn.dataset.tab;
       // Avoid leaving the log button stuck in a loading state when switching tabs.
      state.status = "idle";
      if (state.tab === "history" || state.tab === "trends") {
        fetchDays();
      }
      if (state.tab === "today") {
        fetchToday();
      }
      if (state.tab === "profile" && state.auth.user) {
        state.profileForm = buildProfileFormFromUser(state.auth.user);
      }
      render();
    };
  });
  if (tab === "history") {
    const weekDetails = document.getElementById("week-summary");
    if (weekDetails) {
      const summaryEl = weekDetails.querySelector("summary");
      // Manual toggle to avoid stuck-open state
      summaryEl.onclick = (e) => {
        e.preventDefault();
        const nextOpen = !weekDetails.open;
        state.summary.week.open = nextOpen;
        if (nextOpen) {
          weekDetails.setAttribute("open", "");
          ensureSummary("week");
        } else {
          weekDetails.removeAttribute("open");
          render();
        }
      };
      weekDetails.ontoggle = () => {
        state.summary.week.open = weekDetails.open;
      };
    }
    document.querySelectorAll(".day-item").forEach((item) => {
      item.onclick = () => toggleDayExpansion(item.dataset.date);
    });
    document.querySelectorAll(".day-item details summary").forEach((summary) => {
      summary.onclick = (e) => {
        e.stopPropagation();
      };
    });
    const loadMoreBtn = document.getElementById("load-more-days");
    if (loadMoreBtn) {
      loadMoreBtn.onclick = () => loadMoreDays();
      loadMoreBtn.onanimationstart = (e) => e.stopPropagation();
    }
  }
  if (tab === "profile") {
    document.getElementById("profile-first").oninput = (e) => (state.profileForm.firstName = e.target.value);
    document.getElementById("profile-last").oninput = (e) => (state.profileForm.lastName = e.target.value);
    document.getElementById("profile-height-unit").onchange = (e) => {
      state.profileForm.heightUnit = e.target.value;
      render();
    };
    if (document.getElementById("profile-height-value")) {
      document.getElementById("profile-height-value").oninput = (e) => (state.profileForm.heightValue = e.target.value);
    }
    if (document.getElementById("profile-height-feet")) {
      document.getElementById("profile-height-feet").oninput = (e) => (state.profileForm.heightFeet = e.target.value);
    }
    if (document.getElementById("profile-height-inches")) {
      document.getElementById("profile-height-inches").oninput = (e) => (state.profileForm.heightInches = e.target.value);
    }
    document.getElementById("profile-weight-unit").onchange = (e) => (state.profileForm.weightUnit = e.target.value);
    document.getElementById("profile-weight-value").oninput = (e) => (state.profileForm.weightValue = e.target.value);
    document.getElementById("profile-save").onclick = updateProfile;
    if (document.getElementById("mfa-start")) document.getElementById("mfa-start").onclick = startMfaSetup;
    if (document.getElementById("mfa-verify")) document.getElementById("mfa-verify").onclick = verifyMfa;
    if (document.getElementById("mfa-token")) {
      document.getElementById("mfa-token").oninput = (e) => (state.mfa.token = e.target.value);
    }
  }
  document.querySelectorAll("[data-logout]").forEach((btn) => {
    btn.onclick = () => {
      stopListening("logout");
      state.auth = {
        mode: "login",
        email: "",
        password: "",
        confirmPassword: "",
        firstName: "",
        lastName: "",
        heightCm: "",
        weightKg: "",
        token: "",
        accessToken: null,
        user: null,
        mfaRequired: false,
        deviceToken: localStorage.getItem("mfaDeviceToken") || "",
        rememberDevice: true,
      };
      state.result = null;
      state.summary.today = { status: "idle", text: "", summaryKey: "", generatedAt: null, source: "local", open: false };
      state.summary.week = { status: "idle", text: "", summaryKey: "", generatedAt: null, source: "local", open: false };
      state.dayPanels = { nutrientsOpen: false, mealsOpen: false };
      state.historyRangeDays = 7;
      state.profileForm = { firstName: "", lastName: "", heightCm: "", weightKg: "" };
      render();
    };
  });
  if (document.getElementById("refresh-app")) {
    document.getElementById("refresh-app").onclick = () => window.location.reload();
  }
  if (document.getElementById("theme-btn")) {
    document.getElementById("theme-btn").onclick = toggleTheme;
  }
  if (document.getElementById("dismiss-tutorial")) {
    document.getElementById("dismiss-tutorial").onclick = dismissTutorial;
  }
}

function renderTrend(days) {
  const max = Math.max(...days.map((d) => d.calories || 0), 1);
  const points = days.map((d, idx) => {
    const x = (idx / Math.max(days.length - 1, 1)) * 100;
    const y = 100 - (d.calories / max) * 100;
    return { x, y, date: d.date, value: d.calories || 0 };
  });
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  const area = `0,100 ${polyline} 100,100`;
  return `
    <div class="chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="caloriesFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.18" />
            <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <polygon fill="url(#caloriesFill)" points="${area}" />
        <polyline fill="none" stroke="#0ea5e9" stroke-width="2" points="${polyline}" />
        ${points
          .map(
            (p) =>
              `<circle cx="${p.x}" cy="${p.y}" r="1.8" fill="#0ea5e9" stroke="#fff" stroke-width="0.6"><title>${p.date}: ${p.value} kcal</title></circle>`
          )
          .join("")}
      </svg>
      <div class="chart-legend">Max: ${max} kcal</div>
    </div>
  `;
}

async function submitAuth() {
  const { mode, email, password, confirmPassword, token, mfaRequired, deviceToken, rememberDevice, firstName, lastName } = state.auth;
  if (mode === "reset") {
    await resetPassword();
    return;
  }
  if (!email || !password) {
    state.error = "Email and password are required.";
    render();
    return;
  }
  if (mode === "register" && password.length < 8) {
    state.error = "Password must be at least 8 characters.";
    render();
    return;
  }
  if (mode === "register" && password !== confirmPassword) {
    state.error = "Passwords do not match.";
    render();
    return;
  }
  const optionalActive =
    mode === "register" &&
    (state.auth.heightFeet || state.auth.heightInches || state.auth.heightValue || state.auth.weightValue);
  if (mode === "register" && optionalActive) {
    if (state.auth.heightUnit === "ftin" && !state.auth.heightFeet) {
      state.error = "Enter feet for your height (inches optional).";
      render();
      return;
    }
    if (state.auth.heightUnit === "cm" && !state.auth.heightValue) {
      state.error = "Enter height in cm.";
      render();
      return;
    }
    if (state.auth.weightValue && !state.auth.weightUnit) {
      state.error = "Choose a weight unit.";
      render();
      return;
    }
  }
  const trimmedFirst = firstName?.trim() || "";
  const trimmedLast = lastName?.trim() || "";
  const cleanedHeightFeet = state.auth.heightFeet || undefined;
  const cleanedHeightInches =
    state.auth.heightUnit === "ftin" ? (state.auth.heightInches !== "" ? state.auth.heightInches : "0") : undefined;
  const cleanedHeightValue = state.auth.heightUnit !== "ftin" ? state.auth.heightValue || undefined : undefined;
  const cleanedWeightValue = state.auth.weightValue || undefined;
  const cleanedWeightUnit = cleanedWeightValue ? state.auth.weightUnit || "lb" : undefined;
  const heightUnit = optionalActive ? state.auth.heightUnit : undefined;
  const weightUnit = optionalActive ? cleanedWeightUnit : undefined;
  const heightValue = optionalActive ? cleanedHeightValue : undefined;
  const heightFeet = optionalActive ? cleanedHeightFeet : undefined;
  const heightInches = optionalActive ? cleanedHeightInches : undefined;
  const weightValue = optionalActive ? cleanedWeightValue : undefined;
  state.auth.status = "loading";
  state.error = null;
  render();
  try {
    const body = {
      email,
      password,
      token: mfaRequired ? token : undefined,
      deviceToken: deviceToken || undefined,
      rememberDevice: rememberDevice && mfaRequired,
    };
    if (mode === "register") {
      body.firstName = trimmedFirst || undefined;
      body.lastName = trimmedLast || undefined;
      body.heightUnit = heightUnit;
      body.weightUnit = weightUnit;
      body.heightValue = heightValue;
      body.heightFeet = heightFeet;
      body.heightInches = heightInches;
      body.weightValue = weightValue;
    }
    const res = await fetch(`${AUTH_BASE}/auth/${mode === "login" ? "login" : "register"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await parseJsonSafe(res);
    if (data?.mfaRequired) {
      state.auth.mfaRequired = true;
      state.error = "Enter your authenticator code.";
      render();
      return;
    }
    if (!res.ok) throw new Error(data?.error || "Auth failed");
    state.auth.accessToken = data.accessToken;
    state.auth.user = data.user;
    state.profileForm.firstName = data.user?.firstName || "";
    state.profileForm.lastName = data.user?.lastName || "";
    state.auth.mfaRequired = false;
    state.auth.confirmPassword = "";
    if (mode === "register") {
      state.auth.firstName = "";
      state.auth.lastName = "";
      state.auth.heightCm = "";
      state.auth.weightKg = "";
    }
    if (data.deviceToken && rememberDevice) {
      localStorage.setItem("mfaDeviceToken", data.deviceToken);
      state.auth.deviceToken = data.deviceToken;
    }
    state.status = "idle";
    fetchDays();
    fetchToday();
    showToast(mode === "login" ? "Logged in" : "Registered");
    render();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.auth.status = "idle";
    render();
  }
}

async function sendResetLink() {
  if (!state.auth.email) {
    state.error = "Enter your email to send a reset link.";
    render();
    return;
  }
  state.status = "loading";
  state.error = null;
  render();
  try {
    const res = await fetch(`${AUTH_BASE}/auth/forgot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: state.auth.email }),
    });
    if (!res.ok) throw new Error("Unable to send reset link");
    showToast("Reset link sent");
    state.error = null;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.status = "idle";
    render();
  }
}

async function resetPassword() {
  const email = state.auth.email;
  const token = state.auth.token;
  const password = state.auth.password;
  const confirmPassword = state.auth.confirmPassword;
  if (!email || !token || !password) {
    state.error = "Email, token, and new password are required.";
    render();
    return;
  }
  if (password !== confirmPassword) {
    state.error = "Passwords do not match.";
    render();
    return;
  }
  state.status = "loading";
  state.error = null;
  render();
  try {
    const res = await fetch(`${AUTH_BASE}/auth/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token, password, confirmPassword }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || "Reset failed");
    showToast("Password reset. Please login.");
    state.auth.mode = "login";
    state.auth.password = "";
    state.auth.confirmPassword = "";
    state.auth.token = "";
  } catch (err) {
    state.error = err.message;
  } finally {
    state.status = "idle";
    render();
  }
}

let recognition;
let listeningTimeout;
function stopListening(reason = "") {
  state.listening = false;
  if (listeningTimeout) {
    clearTimeout(listeningTimeout);
    listeningTimeout = null;
  }
  try {
    recognition?.stop?.();
  } catch (_err) {}
  try {
    recognition?.abort?.();
  } catch (_err) {}
  recognition = null;
  render();
}
function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || "";
    state.text = transcript;
    stopListening("result");
    if (state.text.trim()) {
      submitText();
    }
  };
  rec.onerror = (event) => {
    state.error = event.error || "Voice error";
    stopListening("error");
  };
  rec.onspeechend = () => {
    stopListening("speechend");
  };
  rec.onsoundend = () => {
    stopListening("soundend");
  };
  rec.onaudioend = () => {
    stopListening("audioend");
  };
  rec.onnomatch = () => {
    stopListening("nomatch");
  };
  rec.onend = () => {
    stopListening("end");
  };
  return rec;
}

function toggleVoice() {
  if (state.listening) {
    stopListening("toggle-off");
    return;
  }
  state.error = null;
  recognition = initSpeech();
  if (!recognition) {
    state.error = "Voice recognition not supported in this browser.";
    render();
    return;
  }
  state.listening = true;
  try {
    recognition.start();
  } catch (_err) {
    stopListening("start-failed");
    state.error = "Could not start voice input. Try again.";
    render();
    return;
  }
  listeningTimeout = setTimeout(() => {
    if (state.listening) stopListening("timeout");
  }, 10000);
  render();
}
function invalidateSummary(range) {
  const target = state.summary[range];
  const wasOpen = target.open;
  target.status = "idle";
  target.text = "";
  target.summaryKey = "";
  target.generatedAt = null;
  target.source = "local";
  if (wasOpen) {
    ensureSummary(range);
  }
}

function invalidateAllSummaries() {
  invalidateSummary("today");
  invalidateSummary("week");
}

function getLocalSummary(range) {
  const stats = range === "today" ? computeTodayStats(state.today) : computeWeekStats(state.days);
  return range === "today" ? buildTodayLocalSummary(stats) : buildWeeklyLocalSummary(stats);
}

function getSummaryText(range, stats) {
  const summaryState = state.summary[range];
  if (summaryState.status === "loading") return "Creating summary...";
  if (summaryState.status === "success" && summaryState.text) return summaryState.text;
  return range === "today" ? buildTodayLocalSummary(stats) : buildWeeklyLocalSummary(stats);
}

async function loadSummary(range) {
  if (!state.auth.accessToken) return;
  const stats = range === "today" ? computeTodayStats(state.today) : computeWeekStats(state.days);
  const localText = range === "today" ? buildTodayLocalSummary(stats) : buildWeeklyLocalSummary(stats);
  const summaryState = state.summary[range];
  summaryState.status = "loading";
  summaryState.text = localText;
  summaryState.source = "local";
  render();
  try {
    const res = await fetchSummary(range, state.auth.accessToken);
    const data = await parseJsonSafe(res);
    if (!res.ok || !data?.text) throw new Error(data?.error || "summary_failed");
    summaryState.status = "success";
    summaryState.text = data.text;
    summaryState.summaryKey = data.summaryKey || "";
    summaryState.generatedAt = data.generatedAt || new Date().toISOString();
    summaryState.source = "ai";
  } catch (_err) {
    summaryState.status = "success";
    summaryState.text = localText;
    summaryState.source = "local";
  } finally {
    render();
  }
}

function ensureSummary(range) {
  const summaryState = state.summary[range];
  if (summaryState.status === "idle") {
    loadSummary(range);
  } else {
    render();
  }
}

async function submitText() {
  if (!state.text.trim()) {
    state.error = "Please enter what you ate.";
    render();
    return;
  }
  const mealType = determineMealType(state.text);
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  state.status = "loading";
  state.error = null;
  render();
  try {
    const res = await fetch(`${API_BASE}/meals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.auth.accessToken}`,
      },
      body: JSON.stringify({ text: state.text, mealType, tzOffsetMinutes }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      throw new Error(data?.error || "Request failed");
    }
    state.result = data;
    state.text = "";
    invalidateAllSummaries();
    fetchToday();
    fetchDays();
  } catch (err) {
    state.error = err.message || "Unknown error";
  } finally {
    state.status = "idle";
    render();
  }
}

async function fetchDays() {
  if (!state.auth.accessToken) return;
  state.loadingDays = true;
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (state.historyRangeDays - 1));
  const startStr = formatLocalYMD(start);
  const endStr = formatLocalYMD(end);
  try {
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    const res = await fetch(`${API_BASE}/days?start=${startStr}&end=${endStr}&tzOffsetMinutes=${tzOffsetMinutes}`, {
      headers: { Authorization: `Bearer ${state.auth.accessToken}` },
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || "Failed to load days");
    state.days = (data.days || []);
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loadingDays = false;
    render();
  }
}

async function loadMoreDays() {
  state.loadingMore = true;
  render();
  state.historyRangeDays += 7;
  await fetchDays();
  state.loadingMore = false;
  render();
}

async function fetchDayMeals(dateStr) {
  if (!state.auth.accessToken) return null;
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  try {
    const res = await fetch(`${API_BASE}/daily?date=${dateStr}&tzOffsetMinutes=${tzOffsetMinutes}`, {
      headers: { Authorization: `Bearer ${state.auth.accessToken}` },
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) return null;
    return data.meals || [];
  } catch (err) {
    return null;
  }
}

async function toggleDayExpansion(dateStr) {
  const normalizedDate = typeof dateStr === 'string' && dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
  if (state.expandedDays.has(normalizedDate)) {
    state.expandedDays.delete(normalizedDate);
    render();
  } else {
    state.expandedDays.add(normalizedDate);
    const day = state.days.find(d => {
      const dDate = typeof d.date === 'string' && d.date.includes('T') ? d.date.split('T')[0] : d.date;
      return dDate === normalizedDate;
    });
    if (day && !day.meals) {
      day.loading = true;
      render();
      day.meals = await fetchDayMeals(normalizedDate);
      day.loading = false;
    }
    render();
  }
}

async function fetchToday() {
  if (!state.auth.accessToken) return;
  state.loadingToday = true;
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  const date = formatLocalYMD(new Date());
  try {
    const res = await fetch(`${API_BASE}/daily?date=${date}&tzOffsetMinutes=${tzOffsetMinutes}&_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${state.auth.accessToken}` },
      cache: "no-store",
    });
    const data = await parseJsonSafe(res);
    if (res.status === 304) return;
    if (!res.ok || !data) throw new Error(data?.error || "Failed to load today");
    state.today = data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("fetch_today_failed", err);
  } finally {
    state.loadingToday = false;
    render();
  }
}

async function updateProfile() {
  state.status = "saving";
  state.error = null;
  render();
  try {
    const res = await fetch(`${API_BASE}/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.auth.accessToken}`,
      },
      body: JSON.stringify({
        firstName: state.profileForm.firstName,
        lastName: state.profileForm.lastName,
        heightUnit: state.profileForm.heightUnit,
        heightValue: state.profileForm.heightUnit === "ftin" ? undefined : state.profileForm.heightValue,
        heightFeet: state.profileForm.heightUnit === "ftin" ? state.profileForm.heightFeet : undefined,
        heightInches: state.profileForm.heightUnit === "ftin" ? state.profileForm.heightInches : undefined,
        weightUnit: state.profileForm.weightUnit,
        weightValue: state.profileForm.weightValue,
      }),
    });
    const data = await parseJsonSafe(res);
      if (!res.ok) throw new Error(data?.error || "Failed to update profile");
    state.auth.user = data.user;
    state.profileForm = buildProfileFormFromUser(data.user);
    state.error = null;
    showToast("Profile updated successfully!");
  } catch (err) {
    state.error = err.message;
  } finally {
    state.status = "idle";
    render();
  }
}

async function startMfaSetup() {
  try {
    const res = await fetch(`${AUTH_BASE}/auth/mfa/setup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.auth.accessToken}`,
      },
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || "Failed to start MFA");
    state.mfa.otpauthUrl = data.otpauth_url;
    state.mfa.base32 = data.base32;
    state.error = null;
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

async function verifyMfa() {
  try {
    const res = await fetch(`${AUTH_BASE}/auth/mfa/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.auth.accessToken}`,
      },
      body: JSON.stringify({ token: state.mfa.token }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || "Failed to verify MFA");
    state.auth.user = { ...state.auth.user, mfaEnabled: true };
    state.mfa = { otpauthUrl: "", base32: "", token: "" };
    state.error = null;
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

function applyTheme() {
  document.documentElement.classList.remove("theme-light", "theme-dark");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const mode = state.theme === "auto" ? (prefersDark ? "dark" : "light") : state.theme;
  if (mode === "light") document.documentElement.classList.add("theme-light");
  if (mode === "dark") document.documentElement.classList.add("theme-dark");
}

function toggleTheme() {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(state.theme) + 1) % order.length];
  state.theme = next;
  localStorage.setItem("appTheme", next);
  applyTheme();
  render();
}

let editSaveTimeout;

function getItemNutrientValues(item) {
  return {
    calories: item.nutrients?.calories ?? item.calories ?? 0,
    protein_g: item.nutrients?.protein_g ?? item.protein_g ?? 0,
    carbs_g: item.nutrients?.carbs_g ?? item.carbs_g ?? 0,
    fat_g: item.nutrients?.fat_g ?? item.fat_g ?? 0,
    fiber_g: item.nutrients?.fiber_g ?? item.fiber_g ?? 0,
    sugars_g: item.nutrients?.sugars_g ?? item.sugars_g ?? 0,
    saturated_fat_g: item.nutrients?.saturated_fat_g ?? item.saturated_fat_g ?? 0,
    trans_fat_g: item.nutrients?.trans_fat_g ?? item.trans_fat_g ?? 0,
    cholesterol_mg: item.nutrients?.cholesterol_mg ?? item.cholesterol_mg ?? 0,
    sodium_mg: item.nutrients?.sodium_mg ?? item.sodium_mg ?? 0,
    vitamin_d_mcg: item.nutrients?.vitamin_d_mcg ?? item.vitamin_d_mcg ?? 0,
    calcium_mg: item.nutrients?.calcium_mg ?? item.calcium_mg ?? 0,
    iron_mg: item.nutrients?.iron_mg ?? item.iron_mg ?? 0,
    potassium_mg: item.nutrients?.potassium_mg ?? item.potassium_mg ?? 0,
  };
}

function startEditItem(itemId, mealId) {
  const targetItem =
    state.result?.meal?.items?.find((i) => i.id === itemId) ||
    state.today?.meals?.flatMap((m) => m.items || []).find((i) => i.id === itemId);
  const values = targetItem ? getItemNutrientValues(targetItem) : {};
  state.editingItem = { itemId, mealId, values };
  render();
}

function updateEditingField(field, value) {
  if (!state.editingItem) return;
  state.editingItem.values[field] = value;
  scheduleAutoSave();
}

function cancelEdit() {
  if (!state.editingItem) return render();
  const pendingChanges = Object.keys(state.editingItem.values || {}).length > 0;
  const { mealId, itemId } = state.editingItem;
  if (editSaveTimeout) {
    clearTimeout(editSaveTimeout);
    editSaveTimeout = null;
  }
  if (pendingChanges) {
    saveItemEdits(mealId, itemId);
    state.editingItem = null;
  } else {
    state.editingItem = null;
    render();
  }
}

async function saveItemEdits(mealId, itemId) {
  if (!state.editingItem) return;
  const currentItem =
    state.today?.meals?.flatMap((m) => m.items || []).find((i) => i.id === itemId) ||
    state.result?.meal?.items?.find((i) => i.id === itemId);
  const baseline = currentItem ? getItemNutrientValues(currentItem) : getItemNutrientValues({ nutrients: {} });
  const merged = { ...baseline, ...state.editingItem.values };
  const body = {};
  for (const key of Object.keys(merged)) {
    const n = Number(merged[key]);
    body[key] = Number.isFinite(n) ? n : 0;
  }
  try {
    const res = await fetch(`${API_BASE}/meals/${mealId}/items/${itemId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.auth.accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || "Failed to update item");
    // Refresh the server view so we have authoritative items and totals.
    await fetchToday();
    const updated = state.today?.meals?.find((m) => m.id === mealId);
    if (updated) {
      const itemsWithNutrients = (updated.items || []).map((i) => ({
        ...i,
        nutrients: {
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
        },
      }));
      const mealTotal = data?.mealTotals || computeTotalsFromItems(itemsWithNutrients);
      if (state.result) {
        state.result.meal = { ...updated, total: mealTotal, items: itemsWithNutrients };
      }
      // Keep today.meals in sync with the totals the backend returned.
      state.today = state.today || { meals: [] };
      state.today.meals = (state.today.meals || []).map((m) =>
        m.id === mealId ? { ...m, total: mealTotal, items: itemsWithNutrients, adjusted: true } : m
      );
    }
    if (data?.dayTotals) {
      state.today = state.today || { day: {}, meals: [] };
      state.today.day = { ...state.today.day, ...data.dayTotals };
      if (state.result) {
        state.result.day = { ...state.result?.day, ...data.dayTotals };
      }
    }
    if (state.result?.meal && state.result.meal.id === mealId) {
      state.result.meal.adjusted = true;
    }
    await fetchDays();
    invalidateAllSummaries();
  } catch (err) {
    state.error = err.message;
  } finally {
    render();
  }
}

function scheduleAutoSave() {
  if (!state.editingItem) return;
  if (editSaveTimeout) clearTimeout(editSaveTimeout);
  editSaveTimeout = setTimeout(() => {
    saveItemEdits(state.editingItem.mealId, state.editingItem.itemId);
  }, 800);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    state.updateAvailable = true;
    render();
  });
}

if (window.matchMedia) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (state.theme === "auto") {
      applyTheme();
      render();
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopListening("hidden");
});

window.addEventListener("pagehide", () => {
  stopListening("pagehide");
});

window.addEventListener("blur", () => {
  stopListening("blur");
});

async function parseJsonSafe(res) {
  try {
    return await res.json();
  } catch (_err) {
    return null;
  }
}

function formatLocalYMD(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function computeTotalsFromItems(items) {
  return items.reduce(
    (acc, item) => ({
      calories: acc.calories + (item.calories || item.nutrients?.calories || 0),
      protein_g: acc.protein_g + (item.protein_g || item.nutrients?.protein_g || 0),
      carbs_g: acc.carbs_g + (item.carbs_g || item.nutrients?.carbs_g || 0),
      fat_g: acc.fat_g + (item.fat_g || item.nutrients?.fat_g || 0),
      fiber_g: acc.fiber_g + (item.fiber_g || item.nutrients?.fiber_g || 0),
      sugars_g: acc.sugars_g + (item.sugars_g || item.nutrients?.sugars_g || 0),
      saturated_fat_g: acc.saturated_fat_g + (item.saturated_fat_g || item.nutrients?.saturated_fat_g || 0),
      trans_fat_g: acc.trans_fat_g + (item.trans_fat_g || item.nutrients?.trans_fat_g || 0),
      cholesterol_mg: acc.cholesterol_mg + (item.cholesterol_mg || item.nutrients?.cholesterol_mg || 0),
      sodium_mg: acc.sodium_mg + (item.sodium_mg || item.nutrients?.sodium_mg || 0),
      vitamin_d_mcg: acc.vitamin_d_mcg + (item.vitamin_d_mcg || item.nutrients?.vitamin_d_mcg || 0),
      calcium_mg: acc.calcium_mg + (item.calcium_mg || item.nutrients?.calcium_mg || 0),
      iron_mg: acc.iron_mg + (item.iron_mg || item.nutrients?.iron_mg || 0),
      potassium_mg: acc.potassium_mg + (item.potassium_mg || item.nutrients?.potassium_mg || 0),
    }),
    {
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
    }
  );
}

applyTheme();
render();
