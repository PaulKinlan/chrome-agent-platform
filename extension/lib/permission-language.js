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
  sessions: "see and restore recently closed tabs",
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

/** The user-language names for internal tool names. Maps camelCase and
 * snake_case tool identifiers to readable actions. */
export const TOOL_USER_LANGUAGE = Object.freeze({
  summarize_text: "summarise text on-device",
  detect_language: "detect language on-device",
  translate_text: "translate text on-device",
  browser_list_tabs: "List open tabs",
  listTabs: "List open tabs",
  list_tabs: "List open tabs",
  capture_region: "Capture page region",
  captureRegion: "Capture page region",
  capture_screenshot: "Capture page screenshot",
  captureScreenshot: "Capture page screenshot",
  screenshot: "Capture page screenshot",
  read_page: "Read current page",
  readPage: "Read current page",
  get_page_text: "Read current page",
  getPageText: "Read current page",
  click: "Click on page",
  browser_click: "Click on page",
  browserClick: "Click on page",
  fill: "Fill form field",
  type_text: "Fill form field",
  typeText: "Fill form field",
  navigate: "Open web page",
  open_tab: "Open web page",
  openTab: "Open web page",
  memory_read: "Read saved memory",
  memoryRead: "Read saved memory",
  recall_memory: "Read saved memory",
  recallMemory: "Read saved memory",
  memory_write: "Save to memory",
  memoryWrite: "Save to memory",
  save_memory: "Save to memory",
  saveMemory: "Save to memory",
  group_tabs: "Group tabs",
  groupTabs: "Group tabs",
});

/** The user-language phrase for a tool. */
export function toolUserLanguage(toolName) {
  return TOOL_USER_LANGUAGE[toolName] ?? null;
}

/** Return a readable sentence-case label for a tool name.
 * Maps known tool names from TOOL_USER_LANGUAGE, falling back to converting
 * camelCase or snake_case to sentence case. */
export function humanToolLabel(rawName) {
  if (!rawName || typeof rawName !== "string") return "";
  const trimmed = rawName.trim();
  if (!trimmed) return "";
  if (TOOL_USER_LANGUAGE[trimmed]) return TOOL_USER_LANGUAGE[trimmed];
  const lowered = trimmed.toLowerCase();
  if (TOOL_USER_LANGUAGE[lowered]) return TOOL_USER_LANGUAGE[lowered];
  const words = trimmed
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

