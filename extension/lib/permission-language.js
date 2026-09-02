// lib/permission-language.js — the user-language name for each optional Chrome
// permission the product can ask for: what allowing it lets the agent DO, in
// the owner's words. The approval card and the requirement derivation both
// read this table so a permission token ("tabGroups", "browsingData") never
// reaches owner-visible copy (CAP-FB-20260901-ONE-CARD-PER-STEP-01).
//
// Pure data — no chrome.*; shared by the extension pages and the component
// gallery (scripts/sync-gallery.mjs copies it beside components.js).

export const PERMISSION_USER_LANGUAGE = Object.freeze({
  tabs: "see your open tabs (their titles and addresses)",
  tabGroups: "group tabs",
  storage: "remember settings and memory",
  activeTab: "see the current tab",
  scripting: "read and act on pages",
  downloads: "manage downloads",
  notifications: "show notifications",
  alarms: "run scheduled tasks",
  cookies: "read and change cookies",
  browsingData: "clear browsing data",
  contentSettings: "change site content settings",
  bookmarks: "read and change bookmarks",
  history: "read and change browsing history",
  sidePanel: "change the side panel",
  management: "manage extensions",
  userScripts: "run user scripts on sites",
  declarativeNetRequest: "change network rules",
  webNavigation: "see page navigation",
  webRequest: "see network requests",
  readingList: "read and change the reading list",
  topSites: "see your most visited sites",
  idle: "see when you are away",
  contextMenus: "add right-click menu items",
  pageCapture: "save pages",
  privacy: "change privacy settings",
  proxy: "change proxy settings",
  fontSettings: "change font settings",
  power: "keep the computer awake",
  search: "search with your default search engine",
  tts: "read text aloud",
  "system.memory": "see system memory details",
  "system.cpu": "see system CPU details",
  "system.storage": "see system storage details",
  "system.display": "see display details",
});

/** A permission token as plain words: "tabGroups" → "tab groups",
 * "system.memory" → "system memory" (for a sentence such as "the tab groups
 * permission"). */
export function permissionPlainName(permission) {
  return String(permission ?? "").replace(/[._-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
}

/** The user-language phrase for a permission. An unknown token falls back to
 * a readable sentence rather than the raw token. */
export function permissionUserLanguage(permission) {
  const known = PERMISSION_USER_LANGUAGE[permission];
  if (known) return known;
  const words = permissionPlainName(permission);
  return words ? `use the ${words} capability` : "use an extra capability";
}

/** The host a site is shown as in owner copy ("docs.example", never the
 * scheme); a value that is not a web origin is shown as given. */
export function siteLabel(origin) {
  try {
    const u = new URL(String(origin));
    if (u.protocol === "http:" || u.protocol === "https:") return u.host;
  } catch { /* not a URL */ }
  return String(origin ?? "");
}
