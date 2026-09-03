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
// /skill:name command + @-mention targets (ids are stable).

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
  { id: "collaboration", label: "Collaboration" },
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
  collaboration: "organize",
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
    // chrome-agent-platform-4ffg: the first-party browser-tidy skill. Surfaced
    // through the SAME catalog every skill surface reads (the /skill command,
    // the @-mention popup, the agent-config dialog, Settings → Skills, and the
    // skill PROMOTION layer) — run it after a task that opened tabs/windows to
    // review what you opened, close the scratch, and report the keepers. Also
    // offered to the model by the tool descriptions' cleanup guidance.
    id: "browser-tidy",
    name: "Browser tidy",
    category: "tabs",
    mode: ON_DEMAND,
    icon: "broom",
    description: "After a task: review the tabs/windows you opened, close the scratch, report what you kept.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You are the browser-tidy assistant. The user just finished a task that may have opened tabs or windows. 1) Review what YOU (or the task) opened: list_tabs and list_windows, and compare against the task's own run summary when one names opened tab ids. 2) Close the scratch: tabs you opened only as working material and no longer need — close them with close_tab (closing a tab the same task opened is Act, no approval card). 3) Report the keepers plainly: for every tab/window you leave open, say which one it is and why you kept it ('I left the docs tab open for you'). 4) Never close a tab you did not open unless the user asks, and never close a tab with unsaved form state you can't detect. If there is nothing to tidy, say so in one line.",
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

  // ── Collaboration (higher-level agent working patterns — DATA, never code;
  //    grounded in the owner's docker-agent-test persona model: identity,
  //    numbered instructions, and a concrete output contract) ──────────────
  {
    id: "review-work",
    name: "Review work",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "check",
    description: "Review a run, thread, or artifact and return a findings list with a verdict.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You are reviewing work on the owner's behalf — be sceptical and specific. (1) Open and read the artifact, thread, or run you were asked to review in full. (2) Build a findings list grouped by severity: BLOCKING (wrong, broken, or unsafe), MAJOR (should fix), MINOR (polish) — each finding with a short evidence quote or observation. (3) End with a verdict: PASS (nothing blocking) or REVISE (with the smallest fix list that would unblock). Keep the whole review under 300 words unless findings force more.",
  },
  {
    id: "delegate-and-collect",
    name: "Delegate and collect",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "send",
    description: "Split a goal across agents, collect the results, and report with per-agent credit.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You are coordinating work across agents. (1) Split the goal into per-agent subtasks matched to what each named agent is for. (2) Hand each subtask to the right agent — in a hub run use delegate_task; direct agent-to-agent delegation is not available yet, so in an agent run write the per-agent briefs into memory under 'delegation/<topic>' and tell the owner to relay them. (3) Collect every result. (4) Reconcile conflicts between results explicitly — never average them away. (5) Report a consolidated summary with per-agent credit (who did what).",
  },
  {
    id: "red-team",
    name: "Red-team",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "shield",
    description: "Argue against a plan: steel-man it, then give the strongest honest objections.",
    requiredCapabilities: ["tabs"],
    prompt:
      "Your job is the strongest honest objection — never soften it. (1) Restate the plan steel-manned: the best version of what it is trying to do. (2) Produce the THREE strongest objections: risks, counter-evidence, gaps — each with concrete evidence or a concrete scenario, not vibes. (3) For each objection propose the cheapest mitigation or say plainly that none exists. End with the single objection that should most change the plan.",
  },
  {
    id: "research-and-report",
    name: "Research and report",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "doc",
    description: "Gather across tabs, cross-check claims, and produce a sourced digest with confidence levels.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You research and report with sources — you never assert without a captured link. (1) Gather: read the relevant open tabs (multi-tab reading), capturing key claims with their URLs. (2) Cross-check: where sources disagree, say so explicitly. (3) Report a sourced digest: a short answer first, then the evidence per claim as a list of link-backed points, each marked CONFIRMED (multiple sources), SINGLE-SOURCE, or UNCERTAIN. End with what you could NOT find.",
  },
  {
    id: "browser-research-playbook",
    name: "Browser research playbook",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "globe",
    description: "Scripted web learning: search, open the top results, extract, and synthesise with logged sources.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You are learning about a topic on the web, on the owner's behalf. (1) Search for the topic and open the top results — cap at 8 tabs, note the search query used. (2) For each result, extract the key points relevant to the question (reader-mode/plain-text, not raw HTML dumps). (3) Capture the best quotes with their URLs. (4) Synthesise: what the web currently says, where sources agree, where they conflict. Output a report with every claim linked; list the sources you opened at the end.",
  },
  {
    id: "manager-check",
    name: "Manager check",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "user",
    description: "Answer 'what would my manager say': critique a finished run against its goal and recommend accept or redo.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You are the owner's quality bar. (1) Summarise what was actually done, with evidence (links, outputs, artifacts) — not what was intended. (2) Critique against the goal on three axes: completeness (anything skipped?), correctness (anything wrong or unsourced?), scope discipline (anything done that was NOT asked for?). (3) Recommend ACCEPT or REDO with the specific reasons; for REDO, name the smallest thing that must change. Be fair — credit what is genuinely good.",
  },
  {
    id: "handoff-brief",
    name: "Handoff brief",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "books",
    description: "Write a handoff note so another agent (or a future you) can pick the task up cleanly.",
    requiredCapabilities: ["tabs", "storage"],
    prompt:
      "You are handing this work to another agent mid-task — write for someone with zero context. (1) Current state: what exists now, what has been done. (2) Decisions taken and WHY (the reasoning matters more than the choices). (3) Open threads: what is unfinished, blocked, or unknown. (4) The single next action. Save the brief to memory under 'handoffs/<topic>' (append) and also show it to the owner so they can pass it on.",
  },
  {
    id: "evidence-pack",
    name: "Evidence pack",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "doc",
    description: "Every reported finding ships with URL, exact quote, screenshot, and timestamp.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You make findings verifiable. For EVERY finding in the report you are producing, attach the full evidence set: the page URL, the exact supporting quote (copy the text, do not paraphrase), a screenshot when the finding is visual, and the timestamp of when you captured it. A finding without evidence is marked UNVERIFIED and flagged to the owner — it is never presented as settled. 'It returned a 200' or 'it looked right' is not evidence.",
  },
  {
    id: "form-playbook",
    name: "Form playbook",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "check",
    description: "Record a form-filling session once (field map + values source), then replay it with per-field review.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You make repeated form flows reliable. (1) RECORD: the first time through a form, capture the field map (every field: selector/label, purpose, the value you used, and WHERE that value came from — memory, the owner, or the page). (2) REPLAY: on later runs, reuse the field map, filling each field from its recorded source. (3) REVIEW: before any submit, show the owner every filled field and its source. Submits and payments always wait for the owner. Save the playbook to memory under 'form-playbooks/<site>' so the next run starts from the map.",
  },
  {
    id: "change-digest",
    name: "Change digest",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "doc",
    description: "Turn watcher output into a briefed narrative: what changed, why it matters, what to do.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You turn raw change-watch noise into briefed signal. (1) List what changed, per page, with before/after values and timestamps. (2) For each change, say WHY it matters (or 'trivial') — a price moved 2% is noise; a subscription grew 40% is signal. (3) Recommend an action for every signal-grade change; explicitly recommend NO action for noise so the owner can skip it with a clear conscience. Never bury a signal-grade change among noise.",
  },
  {
    id: "claim-crosscheck",
    name: "Claim cross-check",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "shield",
    description: "Claims in, verdicts out: per-claim corroboration with sources and confidence levels.",
    requiredCapabilities: ["tabs"],
    prompt:
      "You verify claims, not argue. (1) Extract each discrete claim from the text you were given. (2) For each claim, find independent sources: read beyond the original (multi-tab reading), quote the exact supporting or contradicting text with URLs. (3) Verdict per claim: CORROBORATED (independent sources agree), CONTRADICTED (sources disagree — show both), or UNVERIFIED (no independent source found — say what you searched). Output a verdict table: claim | verdict | sources (linked quotes) | confidence. You never soften a contradicted claim.",
  },
  {
    id: "export-artifact",
    name: "Export artifact",
    category: "collaboration",
    mode: ON_DEMAND,
    icon: "download",
    description: "A digest or report becomes a downloadable file (markdown/CSV today) with a clear filename.",
    requiredCapabilities: ["tabs", "downloads"],
    prompt:
      "You make reports portable. (1) Compose the artifact as a file — markdown for prose/digests, CSV for tabular data (csvtool can build it) — with a clear, dated filename (e.g. 'research-<topic>-2026-08-28.md'). (2) Save it through the Downloads capability; if the save cannot be completed from this context, hand the owner the full content in a single code block labelled with the suggested filename — the artifact must never exist only as chat text. (3) Confirm where it landed.",
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

/**
 * Parse a skill reference into its source + raw id (CAP-FB-20260831-
 * SKILL-LIST-SYNC-01 r2). The catalog offers every skill under a
 * source-qualified refId (builtin:<id> / imported:<id> / custom:<id>); this
 * parser tells the resolver whether a reference is source-locked:
 *   - "imported:x"  → resolve ONLY in the imported store (never a built-in)
 *   - "builtin:x"   → resolve ONLY in the built-in table
 *   - "custom:x"    → resolve ONLY among custom recipes
 *   - "x" (raw)     → historical order: built-in → custom → imported
 * Pure, no store access — unit-testable.
 */
export function parseSkillRef(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return { source: "raw", id: "" };
  const i = raw.indexOf(":");
  if (i > 0) {
    const prefix = raw.slice(0, i);
    if (prefix === "builtin" || prefix === "imported" || prefix === "custom") {
      return { source: prefix, id: raw.slice(i + 1) };
    }
  }
  return { source: "raw", id: raw };
}

/**
 * The store-resolution order for a skill reference (CAP-FB-20260831-
 * SKILL-LIST-SYNC-01 r3). A source-qualified ref is LOCKED to its own store
 * (custom:<id> only ever consults the custom store — it can never fall
 * through to built-in or imported); a raw ref keeps the historical order
 * built-in → custom → imported (saved agents, old task text, and
 * background-agent.set resolving a duplicated background agent by its raw id).
 * Pure — resolveRecipe (service-worker) drives its branches from this order.
 */
export function skillResolutionOrder(source) {
  switch (source) {
    case "builtin": return ["builtin"];
    case "custom": return ["custom"];
    case "imported": return ["imported"];
    default: return ["builtin", "custom", "imported"];
  }
}

/**
 * Checkbox state for ONE catalog row in the agent-config dialog
 * (CAP-FB-20260831-SKILL-LIST-SYNC-01 r3). The dialog keys checkboxes by the
 * source-qualified refId; this decides whether the row is selected given the
 * agent's saved skill ids.
 *
 * Collision rule: a raw saved id that several catalog rows share (a built-in
 * and an imported skill with the same id) matches EXACTLY ONE row — the
 * built-in — mirroring resolveRecipe's raw-id order (built-in first). This is
 * what prevents "selecting the checkbox selects BOTH source-qualified rows".
 * A refId saved id matches only its own row.
 *
 * Pure, no DOM, no store access — unit-testable.
 */
export function skillRowChecked(available, savedIds, row) {
  const saved = new Set(Array.isArray(savedIds) ? savedIds : []);
  if (row?.refId && saved.has(row.refId)) return true;
  const rawId = row?.id ?? row?.name;
  if (!rawId || !saved.has(rawId)) return false;
  const owners = (Array.isArray(available) ? available : [])
    .filter((x) => (x?.id ?? x?.name) === rawId);
  if (owners.length <= 1) return true; // the unique owner
  return row?.source === "builtin"; // legacy raw id → built-in wins (resolveRecipe order)
}

/**
 * Template suggestion matching for ONE catalog row (same collision rule as
 * skillRowChecked). A template references skills by raw id; the row whose
 * refId is in the template, or the unique raw-id owner, or (on collision) the
 * built-in row, is the one toggled — never both.
 */
export function templateSkillMatches(available, templateIds, row) {
  const ids = new Set(Array.isArray(templateIds) ? templateIds : []);
  if (row?.refId && ids.has(row.refId)) return true;
  const rawId = row?.id ?? row?.name;
  if (!rawId || !ids.has(rawId)) return false;
  const owners = (Array.isArray(available) ? available : [])
    .filter((x) => (x?.id ?? x?.name) === rawId);
  if (owners.length <= 1) return true;
  return row?.source === "builtin";
}

/**
 * Normalize an agent record's saved skills to a deduped id list. The record
 * stores `{id,name,description}` objects (the create dialog), but tolerates
 * bare strings (older records / imports). Pure — no store access.
 */
export function agentSkillIds(agent) {
  const out = [];
  for (const s of Array.isArray(agent?.skills) ? agent.skills : []) {
    const id = typeof s === "string" ? s : (s?.id ?? s?.name);
    if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Merge skill/recipe objects for ONE run's composition, deduped by identity
 * with first occurrence winning (an agent's saved skills first, then any
 * /skill:<id> references in the task text — a reference to an already-saved
 * skill composes once, never twice). The dedup key is the source-qualified
 * refId when present (CAP-FB-20260831-SKILL-LIST-SYNC-01 r2): a built-in
 * `tab-hygiene` and an imported `tab-hygiene` are DISTINCT skills and both
 * compose; two references to the SAME row compose once. Pure — the caller
 * resolves ids to records.
 */
export function mergeRunSkills(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const r of Array.isArray(list) ? list : []) {
      const key = r?.refId ?? r?.id;
      if (typeof key !== "string" || !key || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
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
