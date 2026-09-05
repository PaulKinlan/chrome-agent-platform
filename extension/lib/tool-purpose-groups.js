// lib/tool-purpose-groups.js — the tool library's PURPOSE taxonomy
// (CAP-FB-20260828-TOOL-LIBRARY-GROUPING-01).
//
// The tool library exists so a person can predict what they can ask the agent
// to do. Grouping by the implementing Chrome API (routeFamily) fails that
// job — it is an engineering fact, not a user one. This module is the product
// judgement the UI renders: two families ("running the browser" / "doing the
// work"), subdivided into task-shaped groups, each with one plain line saying
// what it lets you ask for. The rationale lives in docs/TOOL-PURPOSE-GROUPS.md.
//
// A tool belongs to exactly one group. Assignment is a route-family default
// plus explicit per-tool overrides where a family mixes purposes (browser.page
// splits into reading vs. driving; tab zoom is appearance, not tab management).
// tests/tool-purpose-groups.test.ts asserts every catalogued tool resolves to
// exactly one group and no static group is empty, so the taxonomy cannot rot
// as tools are added.

import { CHROME_TOOL_CAPABILITY_TABLE } from "./chrome-tool-capabilities.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "./bundled-tool-packages.data.js";

export const TOOL_PURPOSE_FAMILIES = Object.freeze([
  Object.freeze({
    id: "running-the-browser",
    label: "Running the browser",
    line: "Sensing and driving Chrome itself: tabs, pages, downloads, and settings.",
  }),
  Object.freeze({
    id: "doing-the-work",
    label: "Doing the work",
    line: "The agent's own workspace: files, text, tables, scripts, schedules, agents, and memory.",
  }),
]);

// groupId → { family, label, line }. Declaration order is the render order.
export const TOOL_PURPOSE_GROUPS = Object.freeze({
  "tabs-windows": Object.freeze({
    family: "running-the-browser",
    label: "Tabs & windows",
    line: "Open, close, move, pin, group, and switch between tabs and windows.",
  }),
  "reading-capture": Object.freeze({
    family: "running-the-browser",
    label: "Reading, search & capture",
    line: "Read a page, search the web, take a screenshot, and see what a page loads.",
  }),
  "driving-pages": Object.freeze({
    family: "running-the-browser",
    label: "Driving pages",
    line: "Click, type, scroll, and wait inside the page you are on.",
  }),
  "bookmarks-history": Object.freeze({
    family: "running-the-browser",
    label: "Bookmarks, history & activity",
    line: "Save and find bookmarks, reading-list entries, history, and recent browser activity.",
  }),
  "downloads": Object.freeze({
    family: "running-the-browser",
    label: "Downloads",
    line: "Start, watch, and manage downloads.",
  }),
  "browser-data-privacy": Object.freeze({
    family: "running-the-browser",
    label: "Browser data & privacy",
    line: "See and manage cookies, site data, and privacy settings.",
  }),
  "network-proxy": Object.freeze({
    family: "running-the-browser",
    label: "Network & proxy",
    line: "See and control network rules and proxy settings.",
  }),
  "appearance-system": Object.freeze({
    family: "running-the-browser",
    label: "Appearance & system",
    line: "Zoom, fonts, and information about this device and browser.",
  }),
  "notifications-speech": Object.freeze({
    family: "running-the-browser",
    label: "Notifications & speech",
    line: "Send notifications and read text aloud.",
  }),
  "reminders-timing": Object.freeze({
    family: "running-the-browser",
    label: "Reminders & timing",
    line: "Set alarms and see when the browser is idle.",
  }),
  "browser-control": Object.freeze({
    family: "running-the-browser",
    label: "Browser controls",
    line: "Manage extensions, menus, shortcuts, and scripts that run on pages.",
  }),
  "files-data": Object.freeze({
    family: "doing-the-work",
    label: "Files & data",
    line: "Read and write files in folders you have granted, and inspect or compress them.",
  }),
  "text-documents": Object.freeze({
    family: "doing-the-work",
    label: "Text & documents",
    line: "Search, sort, cut, compare, and convert text.",
  }),
  "tables-queries": Object.freeze({
    family: "doing-the-work",
    label: "Tables & queries",
    line: "Work with CSV tables and query databases.",
  }),
  "hashes-ids": Object.freeze({
    family: "doing-the-work",
    label: "Checksums & IDs",
    line: "Hash data and generate unique IDs.",
  }),
  "scripts-compute": Object.freeze({
    family: "doing-the-work",
    label: "Scripts & compute",
    line: "Run Python and reusable scripts.",
  }),
  "automation": Object.freeze({
    family: "doing-the-work",
    label: "Automation & scheduling",
    line: "Schedule work, react to events, and generate interfaces.",
  }),
  "agents": Object.freeze({
    family: "doing-the-work",
    label: "Agents & delegation",
    line: "Create, manage, and delegate work to agents.",
  }),
  "assets": Object.freeze({
    family: "doing-the-work",
    label: "Assets",
    line: "Files the agent creates and keeps for you.",
  }),
  "memory-usage": Object.freeze({
    family: "doing-the-work",
    label: "Memory & usage",
    line: "Remember facts and see what the agent has stored and used.",
  }),
  "site-declared": Object.freeze({
    family: "doing-the-work",
    label: "Site tools (declared)",
    line: "Things the current site says other tools can do.",
  }),
  "site-inferred": Object.freeze({
    family: "doing-the-work",
    label: "Site tools (inferred)",
    line: "Things the current site appears to offer.",
  }),
});

// Route-family defaults for the chrome-api + management registry rows.
const ROUTE_FAMILY_GROUP = Object.freeze({
  "browser.fs-grant": "files-data",
  "browser.tabs": "tabs-windows",

  "browser.windows": "tabs-windows",
  "browser.tab-groups": "tabs-windows",
  "browser.capture": "reading-capture",
  "browser.search": "reading-capture",
  "browser.navigation": "reading-capture",
  "browser.requests": "reading-capture",
  "browser.bookmarks": "bookmarks-history",
  "browser.reading-list": "bookmarks-history",
  "browser.history": "bookmarks-history",
  "browser.top-sites": "bookmarks-history",
  "browser.sessions": "bookmarks-history",
  "browser.events": "bookmarks-history",
  "browser.downloads": "downloads",
  "browser.cookies": "browser-data-privacy",
  "browser.browsing-data": "browser-data-privacy",
  "browser.content-settings": "browser-data-privacy",
  "browser.privacy": "browser-data-privacy",
  "browser.network-rules": "network-proxy",
  "browser.proxy": "network-proxy",
  "browser.font-settings": "appearance-system",
  "browser.system": "appearance-system",
  "browser.runtime": "appearance-system",
  "browser.power": "appearance-system",
  "browser.notifications": "notifications-speech",
  "browser.tts": "notifications-speech",
  "browser.alarms": "reminders-timing",
  "browser.idle": "reminders-timing",
  "browser.scheduler": "automation", // the agent scheduling ITS work, not the browser's
  "browser.management": "browser-control",
  "browser.commands": "browser-control",
  "browser.context-menus": "browser-control",
  "browser.content-scripts": "browser-control",
  "browser.user-scripts": "browser-control",
  "browser.side-panel": "browser-control",
  "browser.action": "browser-control",
  "browser.permissions": "browser-control",
  "management.agents": "agents",
  "management.named-agents": "agents",
  "management.board": "agents",
  "management.assets": "assets",
  "management.scripts": "scripts-compute",
  "management.compute": "scripts-compute",
  "management.schedules": "automation",
  "management.hooks": "automation",
  "management.ui": "automation",
  "management.memory": "memory-usage",
  "management.usage": "memory-usage",
});

// Per-tool overrides where the route family mixes purposes. Keyed by toolId.
const TOOL_GROUP_OVERRIDES = Object.freeze({
  // browser.page splits into reading vs. driving.
  "read_page": "reading-capture",
  "find_elements": "reading-capture",
  "click_element": "driving-pages",
  "type_text": "driving-pages",
  "select_option": "driving-pages",
  "scroll_page": "driving-pages",
  "wait_for": "driving-pages",
  // "Make this page bigger" is appearance, not tab management.
  "get_tab_zoom": "appearance-system",
  "set_tab_zoom": "appearance-system",
});

// Bundled Wasm packages and built-in core tools have no capability-table row;
// they are classified by toolId directly.
const DIRECT_TOOL_GROUP = Object.freeze({
  // Bundled packages — files & data.
  "du": "files-data",
  "stat": "files-data",
  "tree": "files-data",
  "touch": "files-data",
  "truncate": "files-data",
  "gzip": "files-data",
  // Bundled packages — text & documents.
  "head": "text-documents",
  "tail": "text-documents",
  "cut": "text-documents",
  "sort": "text-documents",
  "uniq": "text-documents",
  "tr": "text-documents",
  "grep": "text-documents",
  "wc": "text-documents",
  "diff": "text-documents",
  "patch": "text-documents",
  "markdown": "text-documents",
  "toml2json": "text-documents",
  "awk_filter_bounded": "text-documents",
  "date_formatter_bounded": "text-documents",
  "base64": "text-documents",
  "xxd": "text-documents",
  // Bundled packages — tables & queries.
  "csvtool": "tables-queries",
  "sqlite3_query_bounded": "tables-queries",
  // Bundled packages — checksums & IDs.
  "md5sum": "hashes-ids",
  "sha256sum": "hashes-ids",
  "sha512sum": "hashes-ids",
  "uuid": "hashes-ids",
  // Built-in core tools.
  "memory_get": "memory-usage",
  "memory_set": "memory-usage",
  "memory_list": "memory-usage",
  "memory_grep": "memory-usage",
  "list_agents": "agents",
  "delegate_task": "agents",
});

const SOURCE_KIND_GROUP = Object.freeze({
  "webmcp-declared": "site-declared",
  "webmcp-inferred": "site-inferred",
});

// toolName → routeFamily, built once from the canonical registry.
const ROUTE_FAMILY_BY_TOOL = new Map(
  CHROME_TOOL_CAPABILITY_TABLE.map((row) => [row.toolName, row.routeFamily]),
);

/**
 * Resolve the purpose group for one tool. Returns the groupId, or null when
 * the tool is unknown to the taxonomy (the completeness test asserts this
 * never happens for a catalogued tool; the UI renders an honest "Ungrouped"
 * section rather than dropping the row).
 *
 * @param {string} toolId
 * @param {string} [sourceKind]
 * @returns {string|null}
 */
export function toolPurposeGroup(toolId, sourceKind = "") {
  const id = typeof toolId === "string" ? toolId : "";
  if (!id) return null;
  const override = TOOL_GROUP_OVERRIDES[id];
  if (override) return override;
  const direct = DIRECT_TOOL_GROUP[id];
  if (direct) return direct;
  const routeFamily = ROUTE_FAMILY_BY_TOOL.get(id);
  if (routeFamily && ROUTE_FAMILY_GROUP[routeFamily]) {
    return ROUTE_FAMILY_GROUP[routeFamily];
  }
  const bySource = SOURCE_KIND_GROUP[sourceKind];
  if (bySource) return bySource;
  return null;
}

/** The group metadata for one groupId, or null when the id is unknown. */
export function purposeGroupMeta(groupId) {
  return Object.prototype.hasOwnProperty.call(TOOL_PURPOSE_GROUPS, groupId)
    ? TOOL_PURPOSE_GROUPS[groupId]
    : null;
}

// The static universe the completeness test walks: the registry, the bundled
// packages, and the built-in core tools (site tools are dynamic by nature).
export const STATIC_TOOL_INVENTORY = Object.freeze([
  ...CHROME_TOOL_CAPABILITY_TABLE.map((row) => row.toolName),
  ...BUNDLED_TOOL_PACKAGE_ROWS.map((row) => row.toolId),
  "memory_get",
  "memory_set",
  "memory_list",
  "memory_grep",
  "list_agents",
  "delegate_task",
]);
