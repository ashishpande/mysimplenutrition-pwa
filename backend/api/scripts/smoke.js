/* Simple API smoke test (register/login → create meal → edit item → fetch daily).
 * Usage:
 *   node scripts/smoke.js --base https://nutrition-api-spring-dust-1526.fly.dev --email you@example.com --password "pass"
 */
import { randomUUID } from "crypto";
import http from "http";
import https from "https";
import { URL } from "url";

// Minimal fetch replacement using http/https.
const fetchFn = async (urlStr, options = {}) => {
  const url = new URL(urlStr);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const { method = "GET", headers = {}, body } = options;
  const requestOpts = {
    method,
    headers,
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(url, requestOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => {
            try {
              return JSON.parse(data || "{}");
            } catch {
              return {};
            }
          },
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
};
const fetch = fetchFn;

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, ...rest] = arg.replace(/^--/, "").split("=");
    return [k, rest.join("=")];
  })
);

const base = args.base || "http://localhost:4000";
const email = args.email || `smoke_${randomUUID()}@example.com`;
const password = args.password || "Passw0rd!";

const headers = { "Content-Type": "application/json" };

async function register() {
  const res = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok && data?.error !== "email_taken") throw new Error(`register failed: ${res.status} ${JSON.stringify(data)}`);
  console.log("register ok (or already exists)");
}

async function login() {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`login failed: ${res.status} ${JSON.stringify(data)}`);
  console.log("login ok");
  return data.accessToken;
}

async function createMeal(token) {
  const mealText = "I ate 1 packet Kodiak banana nut oatmeal for breakfast";
  const res = await fetch(`${base}/api/meals`, {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      text: mealText,
      mealType: "breakfast",
      clientDateStr: new Date().toISOString().slice(0, 10),
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`create meal failed: ${res.status} ${JSON.stringify(data)}`);
  console.log("meal created");
  return data.meal;
}

async function editFirstItem(token, meal) {
  const item = meal.items?.[0];
  if (!item) {
    console.log("no items to edit");
    return;
  }
  const res = await fetch(`${base}/api/meals/${meal.id}/items/${item.id}`, {
    method: "PATCH",
    headers: { ...headers, Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      calories: item.nutrients?.calories || item.calories || 0,
      protein_g: (item.nutrients?.protein_g || item.protein_g || 0) + 1,
      carbs_g: item.nutrients?.carbs_g || item.carbs_g || 0,
      fat_g: item.nutrients?.fat_g || item.fat_g || 0,
      fiber_g: item.nutrients?.fiber_g || item.fiber_g || 0,
      sugars_g: item.nutrients?.sugars_g || item.sugars_g || 0,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`edit item failed: ${res.status} ${JSON.stringify(data)}`);
  console.log("item edited");
}

async function fetchDaily(token) {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`${base}/api/daily?date=${today}&tzOffsetMinutes=${new Date().getTimezoneOffset()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`fetch daily failed: ${res.status} ${JSON.stringify(data)}`);
  console.log("daily totals", data.day);
}

async function main() {
  await register();
  const token = await login();
  const meal = await createMeal(token);
  await editFirstItem(token, meal);
  await fetchDaily(token);
  console.log("smoke test completed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
