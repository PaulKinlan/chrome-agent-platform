// lib/recipes.js — the recipe registry.
//
// Recipes are prompt-driven utility agents, ported from the prompt-in-a-box
// pattern (a goal + the tool steps). Two modes:
//   - "on-demand": shown as chips on the hub, run immediately when tapped.
//   - "background": live-in-the-background agents, run on a schedule (the
//     "sorting hat" tab-grouper is the canonical example). Enabled/disabled
//     from the hub's background-agent manager; enabling schedules the task.
//
// Each recipe declares the optional capabilities it needs (requiredCapabilities)
// so the agent can request them — never granted wholesale. Recipes are DATA
// (a prompt + config), never eval'd. This file is the single source of truth
// for the hub's recipe chips, the background-agent manager, and the future
// /task:name command + @-mention targets (ids are stable).

const ON_DEMAND = "on-demand";
const BACKGROUND = "background";

export const RECIPE_CATEGORIES = [
  { id: "tabs", label: "Tabs" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "reading", label: "Reading" },
  { id: "downloads", label: "Downloads" },
  { id: "focus", label: "Focus" },
  { id: "summaries", label: "Summaries" },
  { id: "context", label: "Context actions" },
  { id: "monitor", label: "Monitoring" },
  { id: "analyze", label: "Analysis" },
];

// Intent groups — what the user is TRYING to do, not which Chrome resource it
// touches. The hub groups capabilities by intent (a cleaner mental model than
// "tabs vs bookmarks vs downloads"), and it is what makes the on-demand and
// background recipes feel like ONE list instead of two overlapping ones.
export const INTENTS = [
  { id: "organize", label: "Organize", hint: "tidy tabs, bookmarks, downloads" },
  { id: "digest", label: "Digest", hint: "read, summarise, understand" },
  { id: "capture", label: "Capture", hint: "save quotes, notes, screenshots" },
  { id: "focus", label: "Focus", hint: "protect attention, reflect" },
  { id: "monitor", label: "Monitor", hint: "watch prices, pages, links" },
  { id: "analyze", label: "Analyze", hint: "inspect, audit, extract" },
];

// Default intent per recipe category, with explicit per-recipe overrides where
// a recipe's intent differs from its category default.
const CATEGORY_INTENT = {
  tabs: "organize",
  bookmarks: "organize",
  downloads: "organize",
  reading: "capture",
  summaries: "digest",
  context: "capture",
  focus: "focus",
  monitor: "monitor",
  analyze: "analyze",
};

const INTENT_OVERRIDES = {
  "link-collector": "capture",
  "reading-time-estimator": "digest",
  "right-click-summarize": "digest",
  "right-click-extract-topics": "digest",
  "omnibox-ask": "digest",
  "download-nightly-summary": "digest",
  "tab-screenshot-diary": "capture",
  "reader-mode": "digest",
};

/** Resolve a recipe's intent (with a safe fallback to "organize"). */
export function intentOf(recipe) {
  return INTENT_OVERRIDES[recipe.id] ?? CATEGORY_INTENT[recipe.category] ??
    "organize";
}

export const RECIPES = [
  // ── On-demand (chips) ────────────────────────────────────────────────────
  {
    id: "tab-hygiene",
    name: "Tab hygiene",
    category: "tabs",
    mode: ON_DEMAND,
    icon: "broom",
    description: "Find duplicate/stale tabs and close or group them.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You are a tab-hygiene assistant. List every open tab across every window (tab_list). If there are fewer than 20 tabs, do nothing and return a one-line summary. Otherwise identify duplicates, stale tabs (same URL opened repeatedly), and tabs idle-looking enough to close or group. Group related tabs, close obvious duplicates, and report what you changed. Be conservative — never close a tab with unsaved form state you can't detect.",
  },
  {
    id: "page-summary",
    name: "Summarise this page",
    category: "summaries",
    mode: ON_DEMAND,
    icon: "doc",
    description: "Read the active tab and give a tight summary.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Read the active tab's content (tab_read) and produce a concise summary: what the page is, the 3 key points, and one recommended next action. Keep it under 120 words.",
  },
  {
    id: "link-collector",
    name: "Collect links",
    category: "summaries",
    mode: ON_DEMAND,
    icon: "link",
    description: "Gather the outbound links from the active page.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Read the active tab and collect its outbound links, grouped by domain, with the link text. Return the list as markdown. Skip navigation/boilerplate links.",
  },
  {
    id: "reading-list",
    name: "Save to reading list",
    category: "reading",
    mode: ON_DEMAND,
    icon: "books",
    description: "Capture the active tab into memory as a reading-list entry.",
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "Read the active tab and save it to memory under the key 'reading-list' (append: title, url, and a one-line note). Confirm what you saved.",
  },
  {
    id: "context-menu-save-quote",
    name: "Save quote (right-click)",
    category: "context",
    mode: ON_DEMAND,
    icon: "quote",
    description: "Save selected text as a quote with source attribution.",
    requiredCapabilities: ["contextMenus", "storage"],
    prompt:
      "Register a context-menu item for saving quotes. When the user right-clicks selected text and chooses it, save the selection with the page URL + title as source attribution into memory under 'quotes' (append). Confirm each save.",
  },
  {
    id: "right-click-extract-topics",
    name: "Extract topics (right-click)",
    category: "context",
    mode: ON_DEMAND,
    icon: "tags",
    description: "Extract key topics from selection or the whole page.",
    requiredCapabilities: ["contextMenus", "storage", "notifications"],
    prompt:
      "Register context-menu items to extract key topics from either the selected text or the whole active page. On use, derive the top topics, show them in a notification, and append them to memory under 'topics'. Confirm each run.",
  },
  {
    id: "right-click-summarize",
    name: "Summarise (right-click)",
    category: "context",
    mode: ON_DEMAND,
    icon: "doc",
    description: "Summarise the active tab from a right-click menu item.",
    requiredCapabilities: ["contextMenus", "tabs", "notifications"],
    prompt:
      "Register a context-menu item 'Summarise page'. On use, read the active tab and produce a short summary, shown in a notification. Confirm each run.",
  },
  {
    id: "right-click-translate-selection",
    name: "Translate selection (right-click)",
    category: "context",
    mode: ON_DEMAND,
    icon: "translate",
    description: "Translate selected text to English and copy it.",
    requiredCapabilities: ["contextMenus", "notifications"],
    prompt:
      "Register a context-menu item to translate the selected text into English (target language: English). On use, translate the selection, show the result in a notification, and copy it to the clipboard. Confirm each run.",
  },
  {
    id: "clipboard-phrase-via-command",
    name: "Phrase library (command)",
    category: "context",
    mode: ON_DEMAND,
    icon: "quote",
    description: "Canned phrases on a keyboard shortcut.",
    requiredCapabilities: ["notifications"],
    prompt:
      "Maintain a phrase library in memory under 'phrases'. Register keyboard-shortcut commands, one per phrase family; when the user invokes a shortcut, copy the chosen phrase to the clipboard and confirm.",
  },
  {
    id: "omnibox-ask",
    name: "Omnibox ask",
    category: "context",
    mode: ON_DEMAND,
    icon: "ask",
    description: "Type 'ask' in the address bar to get an answer as a notification.",
    requiredCapabilities: ["notifications"],
    prompt:
      "Register an omnibox keyword 'ask'. When the user types 'ask' + a question in the address bar, answer it and show the answer as a desktop notification — no new tabs, no page loads.",
  },

  // ── Background agents (scheduled — live in the background) ───────────────
  {
    id: "auto-group-by-domain",
    name: "Sorting Hat",
    category: "tabs",
    mode: BACKGROUND,
    icon: "layers",
    description: "Group open tabs by domain into colour-coded collapsed groups.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 30 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs"],
    // Event triggers (the hooks registry): in addition to its 30-min schedule,
    // the Sorting Hat subscribes to tab-created/tab-updated so a burst of new
    // tabs is grouped immediately rather than waiting for the next alarm. Enabling
    // the recipe subscribes these; disabling unsubscribes them.
    hooks: ["tabs.onCreated", "tabs.onUpdated"],
    prompt:
      "Group open tabs into tab groups by registered domain. On each scheduled run: (1) tab_list to get every tab. (2) For each window, group tabs by eTLD+1 (github.com, google.com, news.ycombinator.com). (3) For each domain with 3+ tabs in a window, move stragglers into an existing group with that domain's title, or create a new group via tab_group with title=domain, colour picked deterministically from the domain hash (grey/blue/red/yellow/green/pink/purple/cyan/orange), collapsed=true. (4) Leave 1–2-tab domains ungrouped. Dedupe: never create a duplicate group title; never re-group tabs already correctly grouped.",
  },
  {
    id: "auto-pin-favorites",
    name: "Auto-pin favourites",
    category: "tabs",
    mode: BACKGROUND,
    icon: "pin",
    description: "Pin tabs that reappear 5+ times a week.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 60 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "Track visit counts in memory under 'visits' (a map of URL -> {count, lastSeen}). On each scheduled run, tab_list to see open tabs; for each tab whose URL has count >= 5, pin it if not already pinned. Increment counts and set lastSeen. Only pin tabs that reappear frequently — never pin one-off tabs.",
  },
  {
    id: "auto-reading-list",
    name: "Auto reading list",
    category: "reading",
    mode: BACKGROUND,
    icon: "books",
    description: "Add unfinished article tabs to the reading list.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 60 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "Track tabs the user opened but likely didn't finish reading (an article-like URL open at least 30s that was never bookmarked/saved). On each scheduled run, look at the recent tab activity; for article tabs the user closed without finishing, add them to the reading list (memory 'reading-list') so 'I'll read this later' actually lands somewhere. Never duplicate an entry.",
  },
  {
    id: "bookmark-auto-categorize",
    name: "Auto-categorise bookmarks",
    category: "bookmarks",
    mode: BACKGROUND,
    icon: "folder",
    description: "Sort uncategorised bookmarks into topic folders.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 1440 },
    defaultEnabled: false,
    requiredCapabilities: ["bookmarks"],
    prompt:
      "On each scheduled run, list every bookmark. Find bookmarks sitting directly in the Bookmarks Bar or Other Bookmarks roots that are not folders. Infer a topic folder for each (create it if missing) and move the bookmark there. Report what you moved. Never move a bookmark you can't confidently categorise.",
  },
  {
    id: "bookmark-dedupe",
    name: "Bookmark dedupe",
    category: "bookmarks",
    mode: BACKGROUND,
    icon: "link",
    description: "Flag duplicate bookmarks (report only, never delete).",
    trigger: "scheduled",
    schedule: { periodInMinutes: 1440 },
    defaultEnabled: false,
    requiredCapabilities: ["bookmarks"],
    prompt:
      "On each scheduled run, list every bookmark and group by normalised URL (lowercase host, strip trailing slashes, fragments, and tracking params utm_*/fbclid/gclid/mc_cid/mc_eid/ref/ref_src). Produce a report of duplicates — flag them for the user, DO NOT delete anything.",
  },
  {
    id: "daily-summary",
    name: "Daily summary",
    category: "summaries",
    mode: BACKGROUND,
    icon: "doc",
    description: "Evening journal of the day's browsing.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 1440 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "Once a day, in the evening (only between 21:00 and 23:59 local), summarise the user's browsing into a journal entry under memory 'daily-summary/YYYY-MM-DD'. Skip if today's date already has an entry. Like a browsing-activity diary that writes itself.",
  },
  {
    id: "dead-bookmark-cleaner",
    name: "Dead bookmark checker",
    category: "bookmarks",
    mode: BACKGROUND,
    icon: "link",
    description: "Check a batch of bookmarks for dead links, flag only.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 1440 },
    defaultEnabled: false,
    requiredCapabilities: ["bookmarks"],
    prompt:
      "On each scheduled run, check a batch of bookmarks to see if they still resolve (use a cursor in memory under 'deadCheck.cursor' to advance through the list). Flag dead ones in a report — DO NOT delete. Advance the cursor so each run checks the next batch.",
  },
  {
    id: "dedupe-tabs",
    name: "Dedupe tabs",
    category: "tabs",
    mode: BACKGROUND,
    icon: "layers",
    description: "Close duplicate tabs (same URL) keeping the oldest/active.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 60 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs"],
    prompt:
      "On each scheduled run, tab_list all tabs and group by normalised URL (strip trailing slashes, fragments, tracking params). Where the same URL is open in multiple tabs, close all but the oldest — or keep the active one if present. Report what you closed.",
  },
  {
    id: "download-nightly-summary",
    name: "Download nightly summary",
    category: "downloads",
    mode: BACKGROUND,
    icon: "download",
    description: "Daily evening summary of what was downloaded.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 1440 },
    defaultEnabled: false,
    requiredCapabilities: ["downloads", "notifications"],
    prompt:
      "On each scheduled run (evening), summarise what the user downloaded that day and fire a single desktop notification with the summary. Skip if there were no downloads today.",
  },
  {
    id: "download-organizer",
    name: "Download organiser",
    category: "downloads",
    mode: BACKGROUND,
    icon: "download",
    description: "Log every download with inferred category + source.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 60 },
    defaultEnabled: false,
    requiredCapabilities: ["downloads", "storage"],
    prompt:
      "On each scheduled run, look at recent downloads and log each one with an inferred category (Images / Documents / Archives / Media / Other, from mime + filename + referring domain), source context, and timestamp, into memory under 'downloads'. Build a searchable 'where did that file come from?' history.",
  },
  {
    id: "focus-mode",
    name: "Focus mode",
    category: "focus",
    mode: BACKGROUND,
    icon: "target",
    description: "Speed-bump distraction domains during focus hours.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 15 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "notifications", "storage"],
    prompt:
      "Enforce focus hours (memory 'focus' config: focusHours 09:00–17:00 Mon–Fri, distractionHosts twitter.com/x.com/reddit.com/news.ycombinator.com/youtube.com/tiktok.com/instagram.com/facebook.com, mode 'warn'). On each scheduled run during focus hours, if the user navigates to a distraction host, fire a gentle notification (a speed bump, not a blocker — never close the tab without the owner opting in).",
  },
  {
    id: "idle-close-tabs",
    name: "Idle tab saver",
    category: "tabs",
    mode: BACKGROUND,
    icon: "sleep",
    description: "Snapshot + close non-pinned tabs after 30 min idle.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 30 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "When the user is idle 30+ minutes: snapshot the session (the list of non-pinned, non-audible, non-active tabs) into memory under 'session-snapshots/YYYY-MM-DD-HH-MM', then close those tabs. Skip if you already ran within the last 2 hours. Never close pinned, audible, or active tabs.",
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    category: "context",
    mode: BACKGROUND,
    icon: "calendar",
    description: "Write a notes template when a Calendar event opens.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 15 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "On each scheduled run, if a tab matching calendar.google.com/calendar/*event is open, read it and extract the meeting title, date/time, and attendees, then write a notes template (attendees, agenda, notes, action items) into memory under 'meetings/<date>-<slug>'. Skip non-event calendar views.",
  },
  {
    id: "page-sentiment-log",
    name: "Page sentiment log",
    category: "summaries",
    mode: BACKGROUND,
    icon: "mood",
    description: "One-word sentiment + one-line summary per visited page.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 30 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "On each scheduled run, for recently completed page navigations: skip non-article hosts (gmail, slack, asana, linear, jira, notion, docs.google, chrome://, about:, file://, auth/login paths). For the rest, read the page and log a single-word sentiment classification + one-line summary into memory under 'sentiment'. Accumulate an emotional shape of browsing over time.",
  },
  {
    id: "reading-time-estimator",
    name: "Reading-time estimate",
    category: "reading",
    mode: BACKGROUND,
    icon: "clock",
    description: "Notify when a long article needs 5+ minutes.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 15 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "notifications"],
    prompt:
      "On each scheduled run, for recently completed navigations to long-form articles, estimate the reading time and notify the user if it's over 5 minutes. Avoids the 'tab left open for 3 weeks' trap. Skip non-article pages.",
  },
  {
    id: "stale-tab-closer",
    name: "Stale tab closer",
    category: "tabs",
    mode: BACKGROUND,
    icon: "clock",
    description: "Close tabs untouched for 24h (protects pinned/audible).",
    trigger: "scheduled",
    schedule: { periodInMinutes: 360 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "Track last-touch timestamps per tab in memory under 'lastTouch:<tabId>'. On each scheduled run, close tabs not touched in 24 hours (configurable), with a 6-hour grace period for newly opened tabs. Never close pinned, audible, or recently-active tabs. Report what you closed.",
  },
  {
    id: "summarize-on-navigate",
    name: "Summarise on navigate",
    category: "summaries",
    mode: BACKGROUND,
    icon: "doc",
    description: "Auto-summarise pages matching patterns you care about.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 30 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "On each scheduled run, summarise recently navigated pages whose hostname/path matches a configurable list (default: arxiv.org, *.github.com repo readmes, long-form news). Accumulate summaries in memory under 'summaries' so the user can read them later.",
  },
  {
    id: "tab-screenshot-diary",
    name: "Screenshot diary",
    category: "summaries",
    mode: BACKGROUND,
    icon: "camera",
    description: "Hourly screenshot of the active tab as a photo diary.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 60 },
    defaultEnabled: false,
    requiredCapabilities: ["activeTab", "storage"],
    prompt:
      "On each scheduled run (hourly, during the day), capture a screenshot of the active tab and store it in memory under 'diary/YYYY-MM-DD/HH'. Creates a photo album of what the user was looking at, for ambient review of the shape of the day.",
  },
  {
    id: "weekly-digest",
    name: "Weekly digest",
    category: "summaries",
    mode: BACKGROUND,
    icon: "doc",
    description: "Sunday-evening digest of bookmarks + reading list.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 10080 },
    defaultEnabled: false,
    requiredCapabilities: ["bookmarks", "storage", "notifications"],
    prompt:
      "On each scheduled run, if it is Sunday evening (>= 18:00 local) and you have not already run today, summarise what the user bookmarked and added to their reading list over the past 7 days into a single digest. Show it as a notification.",
  },
  {
    id: "weekly-review-prompt",
    name: "Weekly review prompt",
    category: "focus",
    mode: BACKGROUND,
    icon: "doc",
    description: "Friday 17:00 — open a pre-filled weekly review template.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 10080 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "On each scheduled run, if it is Friday at 17:00 local (and not already run today), open a new tab with a pre-filled weekly review template (what went well, what didn't, what to carry forward). Turns 'I should reflect' into something that just appears.",
  },

  // ── Monitoring (watch + alert) ─────────────────────────────────────────
  {
    id: "price-watcher",
    name: "Price watcher",
    category: "monitor",
    mode: BACKGROUND,
    icon: "eye",
    description: "Watch a product page and alert when the price drops.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 360 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "notifications", "storage"],
    prompt:
      "On each scheduled run, re-check the product page you are watching. Read the current price and compare it to the last recorded price in memory. If the price dropped, notify the user with the old and new price and the link. Record the new price. If the page is unreachable, do nothing this cycle.",
  },
  {
    id: "page-change-watcher",
    name: "Page change watcher",
    category: "monitor",
    mode: BACKGROUND,
    icon: "eye",
    description: "Alert when a watched page changes.",
    trigger: "scheduled",
    schedule: { periodInMinutes: 180 },
    defaultEnabled: false,
    requiredCapabilities: ["tabs", "notifications", "storage"],
    prompt:
      "On each scheduled run, re-fetch the watched page and compare its main content to the last snapshot in memory. If the content meaningfully changed, notify the user with a short summary of what changed. Store the new snapshot. If unchanged, do nothing.",
  },
  {
    id: "link-checker",
    name: "Link checker",
    category: "monitor",
    mode: ON_DEMAND,
    icon: "scan",
    description: "Check every link on the page and report the broken ones.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Collect every link on the current page. Check each one and report the broken links (404, 5xx, timeouts) with their URLs and anchor text. Cap the check at 50 links and report the total scanned.",
  },

  // ── Analysis (inspect / audit / extract) ───────────────────────────────
  {
    id: "data-extractor",
    name: "Data extractor",
    category: "analyze",
    mode: ON_DEMAND,
    icon: "table",
    description: "Extract tables and lists from the page to CSV or JSON.",
    requiredCapabilities: ["tabs", "downloads"],
    prompt:
      "Find the tables and structured lists on the current page. Extract the primary table into clean rows and columns and offer it as CSV (JSON if there are nested fields). Save the file via download and report the shape (rows × columns).",
  },
  {
    id: "cookie-tracker-auditor",
    name: "Tracker auditor",
    category: "analyze",
    mode: ON_DEMAND,
    icon: "cookie",
    description: "Audit the page's cookies and third-party trackers.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Inspect the cookies and third-party requests the current page sets. Report the tracking cookies, the third-party domains, and what they are likely used for. Flag the high-risk trackers and give a plain-language summary.",
  },
  {
    id: "performance-reporter",
    name: "Performance report",
    category: "analyze",
    mode: ON_DEMAND,
    icon: "gauge",
    description: "Report the page's Core Web Vitals and load performance.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Measure the current page's load performance: Largest Contentful Paint, Cumulative Layout Shift, and interaction readiness, plus the resource weight (total bytes and request count). Report the numbers against the 'good' thresholds and give one concrete improvement.",
  },
  {
    id: "accessibility-checker",
    name: "Accessibility check",
    category: "analyze",
    mode: ON_DEMAND,
    icon: "accessible",
    description: "Scan the page for accessibility issues.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Scan the current page for accessibility issues: missing alt text, missing form labels, low contrast, missing heading hierarchy, keyboard traps. Report the concrete issues with their elements, ordered by impact.",
  },
  {
    id: "seo-meta-checker",
    name: "SEO checker",
    category: "analyze",
    mode: ON_DEMAND,
    icon: "search",
    description: "Check the page's title, meta and headings for SEO.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Check the current page's SEO fundamentals: the title tag length, the meta description, the heading structure, the canonical link, and the open-graph tags. Report what is missing or suboptimal with specific fixes.",
  },

  // ── Capture / context (fill + annotate) ────────────────────────────────
  {
    id: "form-filler",
    name: "Form filler",
    category: "context",
    mode: ON_DEMAND,
    icon: "form",
    description: "Fill the page's form fields from your stored profile.",
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "Read the form fields on the current page (name, email, address, etc.) and fill them from the user's stored profile in memory. Only fill fields you can match confidently; never invent values. Report which fields you filled and which you left empty.",
  },
  {
    id: "screenshot-annotate",
    name: "Annotate screenshot",
    category: "context",
    mode: ON_DEMAND,
    icon: "pen",
    description: "Capture the page and annotate the key elements.",
    requiredCapabilities: ["tabs", "activeTab"],
    prompt:
      "Capture a screenshot of the current page. Identify the most important elements (headline, call-to-action, key figure) and describe where they are so they can be highlighted. Return the screenshot with a short annotation summary.",
  },

  // ── Reading + research (digest) ────────────────────────────────────────
  {
    id: "reader-mode",
    name: "Reader mode",
    category: "reading",
    mode: ON_DEMAND,
    icon: "glasses",
    description: "Extract the main article into clean, distraction-free reading.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Extract the main article content from the current page (title, byline, body text, images) and present it as clean readable markdown, stripping navigation, ads, sidebars, and comments. Preserve the reading order and the source link.",
  },
  {
    id: "multi-tab-researcher",
    name: "Multi-tab researcher",
    category: "summaries",
    mode: ON_DEMAND,
    icon: "network",
    description: "Gather across open tabs and synthesize a single answer.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Gather the relevant content from the open tabs (list them with tab_list, read the ones relevant to the question). Synthesize a single, sourced answer that draws from all of them, citing which tab each point came from.",
  },
];

export function getRecipe(id) {
  return RECIPES.find((r) => r.id === id);
}

// ── Skills aliases ────────────────────────────────────────────────────────
// Recipes are the user-facing SKILLS: reusable, composable capabilities you
// INCLUDE in a task (anywhere in the composer string) or attach to an agent /
// schedule as a background agent — not things you "run" in isolation. The
// SKILLS/* aliases are the canonical skill-facing names; RECIPES/* remain for
// back-compat with the existing routes.
export const SKILLS = RECIPES;
export const getSkill = getRecipe;
export const skillsByMode = recipesByMode;
export const skillsByCategory = recipesByCategory;
export const onDemandSkills = onDemandRecipes;
export const backgroundSkills = backgroundRecipes;
export const skillById = getRecipe;
export const skillIntentOf = intentOf;

export function recipesByMode(mode) {
  return RECIPES.filter((r) => r.mode === mode);
}

export function recipesByCategory(category) {
  return RECIPES.filter((r) => r.category === category);
}

export function onDemandRecipes() {
  return recipesByMode(ON_DEMAND);
}

export function backgroundRecipes() {
  return recipesByMode(BACKGROUND);
}
