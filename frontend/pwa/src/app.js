// API base can be overridden by window.API_BASE; defaults to localhost API in dev.
const API_BASE = window.API_BASE || (location.hostname === "localhost" ? "http://localhost:4000/api" : "/api");
const AUTH_BASE = API_BASE.replace(/\/api$/, "");

const storedDeviceToken = localStorage.getItem("mfaDeviceToken") || "";
const storedTheme = localStorage.getItem("appTheme") || "auto";

const state = {
  listening: false,
  status: "idle",
  text: "",
  result: null,
  error: null,
  updateAvailable: false,
  theme: storedTheme, // auto | light | dark
  auth: {
    mode: "login",
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
    token: "",
    accessToken: null,
    user: null,
    mfaRequired: false,
    deviceToken: storedDeviceToken,
    rememberDevice: true,
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
};

const appEl = document.getElementById("app");

function determineMealType(text) {
  const lower = (text || "").toLowerCase();
  if (lower.includes("breakfast")) return "breakfast";
  if (lower.includes("lunch")) return "lunch";
  if (lower.includes("dinner")) return "dinner";
  if (lower.includes("snack")) return "snack";

  const hour = new Date().getHours();
  if (hour < 11) return "breakfast";
  if (hour < 17) return "lunch";
  return "dinner";
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
  if (!state.auth.accessToken) {
    renderAuth();
  } else {
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
  const themeLabel = state.theme === "auto" ? "Auto" : state.theme === "dark" ? "Dark" : "Light";
  appEl.innerHTML = `
    <div class="shell narrow">
      <header>
        <div class="brand-block">
          <h1>My Simple Nutrition Tracker</h1>
          <p>Sign in to log meals and see reports.</p>
        </div>
        <div class="theme-toggle">
          <span>Theme:</span>
          <button id="theme-btn" class="ghost">${themeLabel}</button>
        </div>
      </header>
      <main>
        <section class="card auth-card">
          <div class="tab-row">
            <button class="${mode === "login" ? "tab active" : "tab"}" id="tab-login">Login</button>
            <button class="${mode === "register" ? "tab active" : "tab"}" id="tab-register">Register</button>
          </div>
          <div class="auth-layout">
            ${mode === "login" ? `
              <div class="auth-visual">
                <div class="pill">Healthy living</div>
                <h3>Fuel your day with better choices</h3>
                <p>Quickly log meals and jump back to your routine.</p>
              </div>
            ` : ""}
            <div class="form">
              <label>Email <input type="email" id="email" value="${email}" /></label>
              <label>Password <input type="password" id="password" value="${password}" /></label>
              ${
                mode === "register"
                  ? `
                      <label>Confirm password <input type="password" id="confirm-password" value="${confirmPassword}" /></label>
                      <label>First name <input type="text" id="first-name" value="${firstName}" /></label>
                      <label>Last name <input type="text" id="last-name" value="${lastName}" /></label>
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
                              <label>Feet <input type="number" step="1" id="height-feet" value="${heightFeet}" /></label>
                              <label>Inches <input type="number" step="0.1" id="height-inches" value="${heightInches}" /></label>
                            `
                            : `<label>Height value <input type="number" step="0.1" id="height-value" value="${heightValue}" /></label>`
                        }
                        <label>Weight unit
                          <select id="weight-unit">
                            <option value="kg" ${weightUnit === "kg" ? "selected" : ""}>kg</option>
                            <option value="lb" ${weightUnit === "lb" ? "selected" : ""}>lb</option>
                          </select>
                        </label>
                        <label>Weight value <input type="number" step="0.1" id="weight-value" value="${weightValue}" /></label>
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
                class="primary"
                style="background: linear-gradient(135deg, #0ea5e9, #2563eb); color: #fff; border-color: #2563eb;"
              >
                ${mode === "login" ? "Login" : "Register"}
              </button>
              <div class="status">${state.error ? `<span class="error">${state.error}</span>` : ""}</div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
  document.getElementById("tab-login").onclick = () => {
    state.auth.mode = "login";
    state.error = null;
    render();
  };
  document.getElementById("tab-register").onclick = () => {
    state.auth.mode = "register";
    state.error = null;
    render();
  };
  document.getElementById("email").oninput = (e) => (state.auth.email = e.target.value);
  document.getElementById("password").oninput = (e) => (state.auth.password = e.target.value);
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
  document.getElementById("auth-submit").onclick = submitAuth;
  if (document.getElementById("theme-btn")) {
    document.getElementById("theme-btn").onclick = toggleTheme;
  }
}

function renderApp() {
  const { listening, status, text, result, error, tab, days } = state;
  const displayName = [state.auth.user?.firstName, state.auth.user?.lastName].filter(Boolean).join(" ") || state.auth.user?.email || "";
  const themeLabel = state.theme === "auto" ? "Auto" : state.theme === "dark" ? "Dark" : "Light";
  appEl.innerHTML = `
    <div class="shell">
      <header class="app-header">
        <div class="brand-block">
          <h1>My Simple Nutrition Tracker</h1>
          <p>Hi ${displayName}</p>
        </div>
        <div class="tabs desktop-tabs">
          <button class="${tab === "today" ? "tab active" : "tab"}" data-tab="today">Today</button>
          <button class="${tab === "history" ? "tab active" : "tab"}" data-tab="history">History</button>
          <button class="${tab === "trends" ? "tab active" : "tab"}" data-tab="trends">Trends</button>
          <button class="${tab === "profile" ? "tab active" : "tab"}" data-tab="profile">Profile</button>
        </div>
        <button class="ghost" id="logout-btn">Logout</button>
      </header>
      ${
        state.updateAvailable
          ? `<div class="update-banner">
              <span>New version available.</span>
              <button id="refresh-app" class="primary">Refresh</button>
            </div>`
          : ""
      }
      <main>
        <div class="theme-toggle">
          <span>Theme:</span>
          <button id="theme-btn" class="ghost">${themeLabel}</button>
        </div>
        ${
          tab === "today"
            ? `
          <section class="card">
            <div class="input-row">
              <button id="voice-btn" class="${listening ? "danger" : "primary"}">${listening ? "Stop" : "Speak"}</button>
              <textarea id="text-input" placeholder="e.g., I ate egg and toast for breakfast">${text}</textarea>
              <button id="submit-btn" class="primary">Submit</button>
            </div>
            <div class="status">${status === "loading" ? "Processing..." : ""} ${error ? `<span class="error">${error}</span>` : ""}</div>
          </section>
          <section class="card">
            <h2>Meal result</h2>
            ${
              result
                ? `
              <div class="meal">
                <div class="tag">${result.meal.mealType || "unspecified"}</div>
                <div><strong>Text:</strong> ${result.meal.text}</div>
                <ul>
                  ${result.meal.items
                    .map(
                      (item) => `
                    <li>
                      ${item.name} — ${item.quantity} ${item.unit} (${item.grams}g) [${item.source}]
                      <div class="macro">Calories: ${item.nutrients.calories} kcal | P: ${item.nutrients.protein_g}g | C: ${item.nutrients.carbs_g}g | F: ${item.nutrients.fat_g}g</div>
                    </li>
                  `
                    )
                    .join("")}
                </ul>
                <div class="total">
                  Total: ${result.meal.total.calories} kcal — P: ${result.meal.total.protein_g}g | C: ${result.meal.total.carbs_g}g | F: ${result.meal.total.fat_g}g
                </div>
              </div>
              <div class="day">
                <h3>Day so far (${result.day.date})</h3>
                <div>${result.day.calories} kcal — P: ${result.day.protein_g}g | C: ${result.day.carbs_g}g | F: ${result.day.fat_g}g</div>
              </div>
            `
                : "<p>No meal yet.</p>"
            }
          </section>`
            : ""
        }
        ${
          tab === "history"
            ? `
          <section class="card">
            <h2>Recent days</h2>
            ${
              days.length
                ? `<ul class="days">${days
                    .map(
                      (d) =>
                        `<li><strong>${d.date}</strong><br/>${d.calories} kcal — P ${d.protein_g}g / C ${d.carbs_g}g / F ${d.fat_g}g</li>`
                    )
                    .join("")}</ul>`
                : "<p>No data yet.</p>"
            }
          </section>`
            : ""
        }
        ${
          tab === "trends"
            ? `
          <section class="card">
            <h2>7-day trend (Calories)</h2>
            ${renderTrend(days)}
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
            <div class="form two-col">
              <label>First name <input type="text" id="profile-first" value="${state.profileForm.firstName || ""}" /></label>
              <label>Last name <input type="text" id="profile-last" value="${state.profileForm.lastName || ""}" /></label>
              <label>Height (cm) <input type="number" step="0.1" id="profile-height" value="${state.profileForm.heightCm || ""}" /></label>
              <label>Weight (kg) <input type="number" step="0.1" id="profile-weight" value="${state.profileForm.weightKg || ""}" /></label>
            </div>
            <div class="status">${state.error ? `<span class="error">${state.error}</span>` : ""}</div>
            <div class="actions">
              <button id="profile-save" class="primary">Save changes</button>
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
    document.getElementById("text-input").oninput = (e) => {
      state.text = e.target.value;
    };
  }
  document.querySelectorAll(".tabs button, .mobile-nav button").forEach((btn) => {
    btn.onclick = () => {
      state.tab = btn.dataset.tab;
      if (state.tab === "history" || state.tab === "trends") {
        fetchDays();
      }
      if (state.tab === "profile" && state.auth.user) {
        state.profileForm.firstName = state.auth.user.firstName || "";
        state.profileForm.lastName = state.auth.user.lastName || "";
        state.profileForm.heightCm = state.auth.user.heightCm ?? "";
        state.profileForm.weightKg = state.auth.user.weightKg ?? "";
      }
      render();
    };
  });
  if (tab === "profile") {
    document.getElementById("profile-first").oninput = (e) => (state.profileForm.firstName = e.target.value);
    document.getElementById("profile-last").oninput = (e) => (state.profileForm.lastName = e.target.value);
    document.getElementById("profile-height").oninput = (e) => (state.profileForm.heightCm = e.target.value);
    document.getElementById("profile-weight").oninput = (e) => (state.profileForm.weightKg = e.target.value);
    document.getElementById("profile-save").onclick = updateProfile;
    if (document.getElementById("mfa-start")) document.getElementById("mfa-start").onclick = startMfaSetup;
    if (document.getElementById("mfa-verify")) document.getElementById("mfa-verify").onclick = verifyMfa;
    if (document.getElementById("mfa-token")) {
      document.getElementById("mfa-token").oninput = (e) => (state.mfa.token = e.target.value);
    }
  }
  document.getElementById("logout-btn").onclick = () => {
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
    state.profileForm = { firstName: "", lastName: "", heightCm: "", weightKg: "" };
    render();
  };
  if (document.getElementById("refresh-app")) {
    document.getElementById("refresh-app").onclick = () => window.location.reload();
  }
  if (document.getElementById("theme-btn")) {
    document.getElementById("theme-btn").onclick = toggleTheme;
  }
}

function renderTrend(days) {
  if (!days.length) return "<p>No data yet.</p>";
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
  if (mode === "register" && password !== confirmPassword) {
    state.error = "Passwords do not match.";
    render();
    return;
  }
  state.error = null;
  try {
    const res = await fetch(`${AUTH_BASE}/auth/${mode === "login" ? "login" : "register"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        firstName: mode === "register" ? firstName : undefined,
        lastName: mode === "register" ? lastName : undefined,
        heightCm: mode === "register" ? state.auth.heightCm : undefined,
        weightKg: mode === "register" ? state.auth.weightKg : undefined,
        token: mfaRequired ? token : undefined,
        deviceToken: deviceToken || undefined,
        rememberDevice: rememberDevice && mfaRequired,
      }),
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
    render();
  } catch (err) {
    state.error = err.message;
    render();
  }
}

let recognition;
function initSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    state.text = transcript;
    state.listening = false;
    render();
  };
  rec.onerror = (event) => {
    state.error = event.error || "Voice error";
    state.listening = false;
    render();
  };
  rec.onend = () => {
    state.listening = false;
    render();
  };
  return rec;
}

function toggleVoice() {
  if (!recognition) {
    recognition = initSpeech();
  }
  if (!recognition) {
    state.error = "Voice recognition not supported in this browser.";
    render();
    return;
  }
  if (state.listening) {
    recognition.stop();
    state.listening = false;
    render();
  } else {
    state.error = null;
    state.listening = true;
    recognition.start();
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
      body: JSON.stringify({ text: state.text, mealType }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      throw new Error(data?.error || "Request failed");
    }
    state.result = data;
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
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  try {
    const res = await fetch(`${API_BASE}/days?start=${startStr}&end=${endStr}`, {
      headers: { Authorization: `Bearer ${state.auth.accessToken}` },
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data?.error || "Failed to load days");
    state.days = data.days || [];
  } catch (err) {
    state.error = err.message;
  }
}

async function updateProfile() {
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
        heightUnit: "cm",
        heightValue: state.profileForm.heightCm,
        weightUnit: "kg", 
        weightValue: state.profileForm.weightKg,
      }),
    });
    const data = await parseJsonSafe(res);
      if (!res.ok) throw new Error(data?.error || "Failed to update profile");
    state.auth.user = data.user;
    state.profileForm.firstName = data.user.firstName || "";
    state.profileForm.lastName = data.user.lastName || "";
    state.profileForm.heightCm = data.user.heightCm ?? "";
    state.profileForm.weightKg = data.user.weightKg ?? "";
    state.error = null;
    render();
  } catch (err) {
    state.error = err.message;
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

async function parseJsonSafe(res) {
  try {
    return await res.json();
  } catch (_err) {
    return null;
  }
}

applyTheme();
render();
