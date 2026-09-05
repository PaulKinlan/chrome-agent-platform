// lib/site-activity-focus.js — one-shot owner navigation from a site-tool
// result card to the matching Settings audit view. The hint is deliberately
// limited to the exact site/tool labels plus a timestamp: no arguments, run,
// provider, model, or conversation metadata.

export const SITE_ACTIVITY_FOCUS_KEY = "cap:siteActivityFocus";

function isSafeToolLabel(value) {
  if (typeof value !== "string" || !value || value.length > 128) return false;
  try {
    return value === value.normalize("NFC") && !/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
  } catch { return false; }
}

export function normalizeSiteActivityFocus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let keys;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    keys = Reflect.ownKeys(value);
  } catch { return null; }
  if (keys.length !== 3 || !keys.includes("origin") || !keys.includes("tool") || !keys.includes("at")) return null;
  const origin = Object.getOwnPropertyDescriptor(value, "origin");
  const tool = Object.getOwnPropertyDescriptor(value, "tool");
  const at = Object.getOwnPropertyDescriptor(value, "at");
  if (!origin?.enumerable || !("value" in origin) || !tool?.enumerable || !("value" in tool) || !at?.enumerable || !("value" in at)) return null;
  if (typeof origin.value !== "string" || origin.value.length > 240 || !isSafeToolLabel(tool.value) || !Number.isSafeInteger(at.value) || at.value < 0) return null;
  try {
    const url = new URL(origin.value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin.value) return null;
  } catch { return null; }
  return { origin: origin.value, tool: tool.value };
}

export async function consumeSiteActivityFocus(sessionStorage) {
  if (!sessionStorage?.get || !sessionStorage?.remove) return null;
  let stored;
  try { stored = await sessionStorage.get(SITE_ACTIVITY_FOCUS_KEY); }
  catch { return null; }
  const normalized = normalizeSiteActivityFocus(stored?.[SITE_ACTIVITY_FOCUS_KEY]);
  try { await sessionStorage.remove(SITE_ACTIVITY_FOCUS_KEY); } catch { /* one-shot best effort */ }
  return normalized;
}
