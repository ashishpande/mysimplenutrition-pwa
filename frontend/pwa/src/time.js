export function formatWhen(consumedAt, slot) {
  if (!consumedAt) return "";
  const d = new Date(consumedAt);
  const now = new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((stripTime(now) - stripTime(d)) / oneDay);
  const dayLabel =
    diffDays === 0 ? "Today" : diffDays === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const slotLabel = slot ? slot.charAt(0).toUpperCase() + slot.slice(1) : "";
  return slotLabel ? `${dayLabel} · ${slotLabel}` : dayLabel;
}

export function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function buildConsumedAtFromInputs(dateStr, timeStr, slot) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  let hours = 15;
  let minutes = 0;
  if (timeStr && timeStr.includes(":")) {
    const [hh, mm] = timeStr.split(":").map(Number);
    hours = hh;
    minutes = mm;
  } else {
    switch (slot) {
      case "breakfast":
        hours = 8;
        break;
      case "lunch":
        hours = 13;
        break;
      case "dinner":
        hours = 19;
        break;
      case "snack":
      default:
        hours = 15;
    }
  }
  // Treat the input as local time, then convert to UTC so the backend stores the correct instant.
  const local = new Date(y, m - 1, d, hours, minutes, 0);
  return new Date(local.getTime() - local.getTimezoneOffset() * 60000);
}
