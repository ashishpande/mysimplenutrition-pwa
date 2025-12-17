import { API_BASE, AUTH_BASE } from "./state.js";

export function authRequest(mode, body) {
  return fetch(`${AUTH_BASE}/auth/${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function requestResetLink(email) {
  return fetch(`${AUTH_BASE}/auth/forgot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export function resetPasswordApi(payload) {
  return fetch(`${AUTH_BASE}/auth/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function patchMealMeta(mealId, payload) {
  return fetch(`${API_BASE}/meals/${mealId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${payload.token}` },
    body: JSON.stringify({
      consumedAt: payload.consumedAt,
      mealType: payload.mealType,
      tzOffsetMinutes: payload.tzOffsetMinutes,
    }),
  });
}

export function createMeal(body, token) {
  return fetch(`${API_BASE}/meals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

export function fetchDaysApi(startStr, endStr, tzOffsetMinutes, token) {
  return fetch(`${API_BASE}/days?start=${startStr}&end=${endStr}&tzOffsetMinutes=${tzOffsetMinutes}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function fetchDailyApi(dateStr, tzOffsetMinutes, token) {
  return fetch(`${API_BASE}/daily?date=${dateStr}&tzOffsetMinutes=${tzOffsetMinutes}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function fetchTodayApi(token, tzOffsetMinutes, dateStr, bust) {
  const dateParam = dateStr ? `&date=${encodeURIComponent(dateStr)}` : "";
  const bustParam = bust ? `&_=${bust}` : "";
  return fetch(`${API_BASE}/daily?tzOffsetMinutes=${tzOffsetMinutes}${dateParam}${bustParam}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
}

export function deleteMeal(mealId, token, tzOffsetMinutes) {
  return fetch(`${API_BASE}/meals/${mealId}?tzOffsetMinutes=${tzOffsetMinutes}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}
