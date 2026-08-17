// lib/avatar.js — a shared, UTF-8-safe initial-letter avatar (the fallback for
// agents without a generated avatar). The data URL is URI-encoded (NOT btoa),
// because btoa throws InvalidCharacterError for code points > 0xFF (a CJK or
// emoji initial crashed the whole agents-panel render).

export function initialAvatar(name) {
  // [...str][0] gets a FULL code point (an emoji is a surrogate pair — str[0]
  // would take the lone high surrogate, which encodeURIComponent rejects).
  const initial = (String(name ?? "?").trim() ? [...String(name ?? "?").trim()][0] : "?") || "?";
  const upper = initial.toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<circle cx="32" cy="32" r="30" fill="#f7f6f3" stroke="#0e6e63" stroke-width="3"/>` +
    `<text x="32" y="42" font-family="system-ui,sans-serif" font-size="28" font-weight="600" fill="#0e6e63" text-anchor="middle">${upper}</text>` +
    `</svg>`;
  // encodeURIComponent handles any Unicode code point (btoa does not).
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
