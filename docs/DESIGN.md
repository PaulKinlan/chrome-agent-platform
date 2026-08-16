# Chrome Agent Platform — Design

Chrome as the agent platform: a MV3 Chrome extension whose **new-tab page is the agent
hub**. The user starts tasks from the hub; the agent opens web pages in a side panel and
orchestrates them through WebMCP. Sites that expose WebMCP/MCP tools become callable
agents; sites without them are understood through an inferred tool directory. Everything
the agent needs — memory, alarms, skills, and a chat surface — lives in the extension.

## 1. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NEW TAB PAGE  (the hub — front and center, not a side panel)           │
│  ┌───────────┐  ┌──────────────────────────┐  ┌──────────────────────┐  │
│  │  input    │  │  agent directory         │  │  active task /       │  │
│  │  text ·   │  │  (sites-as-agents)       │  │  conversation        │  │
│  │  image ·  │  │  ┌ site ┐ ┌ site ┐ ...   │  │  (chat surface)      │  │
│  │  audio ·  │  │  └──────┘ └──────┘       │  │  + screenshot strip  │  │
│  │  video    │  └──────────────────────────┘  └──────────────────────┘  │
│  └───────────┘                                                          │
└─────────────────────────────────────────────────────────────────────────┘
        │  tasks / intents                    ▲  results / narration
        ▼                                    │
┌─────────────────────────────────────────────────────────────────────────┐
│  AGENT CORE  (extension service worker + background)                    │
│  · intent planner        · sub-agent registry   · tool directory        │
│  · alarm scheduler       · memory (OPFS)        · morph (double-iframe) │
└─────────────────────────────────────────────────────────────────────────┘
        │  orchestrate (WebMCP / MCP / injected JS)
        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SIDE PANEL  — web pages open here; the agent drives them              │
│  · WebMCP bridge (document.modelContext / window.functions)            │
│  · double-iframe morph surface (meld 2–3 sites)                        │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. Components

### 2.1 Agent Hub (NTP)
- Multimodal input: text, image, audio (mic), video (camera / file). Transcribed /
  described before planning (Web Speech API now; WebRTC voice-model seam documented).
- Task start → the agent plans → executes across sites.
- Renders the chat surface inline plus the agent directory.
- `at-@` mentions: `@github`, `@aifoc` refer to a site-as-agent and call its tools
  directly.

### 2.2 Side panel
- The agent opens target pages in the side panel and drives them, not the user.
- WebMCP bridge: reads `document.modelContext` (WebMCP) tools and registered
  `window.*` functions (via the webmcp-lib discovery) and calls them as tools.
- The double-iframe morph surface renders a merged view of 2–3 sites.

**Page-tool cancellation (honest cooperative limit):** a site tool invocation is
preemptively cancelled at the isolated-world bridge BEFORE the page function starts
(the enrollment generation is checked + the MAIN world re-checks its cancel epoch
immediately before the call). But once a page function's body has started, its own
DOM / storage / network side effects **cannot be unwound** — this is a fundamental
browser constraint (an extension cannot preempt or roll back arbitrary page code).
Cancellation after the fact discards the RESULT (never surfaced to the SW) but does
not rewind an already-started side effect. The window is minimized (the cancel
epoch is re-checked synchronously right up to the call edge) but a zero-delay timer
vs. a message dispatch cannot be guaranteed to order a delete before an invoke; the
residual limit is documented here rather than claimed away.

### 2.3 Tool directory
- Aggregates tools three ways, ranked:
  1. **Declared** — WebMCP/MCP tools the site exposes (document.modelContext).
  2. **Linked** — `link rel="agent.md"` / `link rel="skills"` documents that describe
     the site's capabilities + how to use them.
  3. **Inferred** — non-DOM `window.*` functions discovered + described (names,
     args, JSDoc; sourcemaps; Chrome Prompt-API for minified).
- Stored in an IndexedDB/OPFS-backed directory: `{ origin, tools[], skills[], score }`.
- The biggest directory of functionality links on the web: every visited origin
  contributes.

### 2.4 Sites as sub-agents
- Each origin is a sub-agent with its own:
  - **context** — what the agent knows about this site (structure, tools, skills)
  - **journal** — task history on this site
  - **goals/knowledge** — accumulated over time
- Influenced by the origin: `link rel="agent.md"` (agent instructions) and
  `link rel="skills"` (capability manifest).
- At-referenced (`@origin`) to call directly; otherwise the directory picks the
  best origin for an intent.

### 2.5 Memory (OPFS)
- **Master memory** — the hub agent's global memory (user prefs, known agents, tasks).
- **Per-agent memory** — one OPFS file/dir per origin sub-agent.
- **Explorer** — an advanced-config UI to browse/clear each agent's memory.
- OPFS (`navigator.storage.getDirectory()`) — private, per-origin, no quota
  prompts, sync + async access.

### 2.6 Alarm scheduler
- The agent registers future tasks: `chrome.alarms` + a background service worker.
- On alarm fire: resume the agent context, run the task, respond to browser actions
  (notifications, side-panel updates).
- Primitives for knowledge workers: "check this site at 9am", "remind me to review",
  "watch this page and tell me when X changes".

### 2.7 Morph (double-iframe)
- The agent can generate/meld content by composing 2–3 sites into one view
  (double-iframe surface).
- Sandboxed WASM tools: the agent can call compiled WASM functions
  and the user can upload more tools.
- In the chat: the agent launches URLs, captures screenshots (clickable, re-opens the
  page), and stores MHTML saves of visited pages.

### 2.8 Chat surface
- Inline in the NTP: the conversation, launched-URL chips, a screenshot
  history strip (click to re-open), MHTML saves, and the double-iframe morph output.

## 3. Security model
- The extension holds the user's session; it never exfiltrates credentials.
- WebMCP tool calls are limited to the origin that declared them.
- Inferred tools are advisory only until the user approves an origin's tools.
- OPFS memory is per-origin scoped; master memory is extension-scoped.
- Alarms run in the background; the agent's capabilities are the user's session's.
- **Screenshot capture (threat model, honest):** pixel capture uses
  `chrome.tabs.captureVisibleTab` (the standard extension API — the same one the
  chaos extension uses, NOT the Chrome `debugger` API, which cannot be optional
  and carries Chrome's all-sites warning). It captures the **active tab**; the
  agent activates a tab first, then captures the now-active tab. The capture is
  gated by (a) the OPTIONAL `activeTab` (Screenshots) capability and (b) the
  scoped, expiring browser-control grant for that tab's origin. The origin +
  grant id are re-validated before AND after the capture (atomic snapshot) so a
  navigation or revoke→regrant during capture discards the bytes (fail closed).
  `activeTab` is transient and tied to the tab active at the granting gesture,
  so **capture success is a headed-browser path**: the user invokes the
  extension on the page they are viewing and the agent captures that page. The
  concrete headed invocation is `chrome.action.onClicked` — clicking the toolbar
  action grants `activeTab` for the clicked tab and captures it (journaled to the
  hub's memory under `screenshots`). In a headless browser there is no action
  invocation and no grantable permission that authorizes an arbitrary tab, so
  capture fails closed (asserted as such in the Chrome suite; the headed success
  path is the action handler, exercised in a headed browser).

- **Enrollment requests `scripting` + host together:** the Settings Enroll
  gesture calls `chrome.permissions.request({ permissions: ["scripting"],
  origins: ["<origin>/*"] })` in ONE prompt, so a successful host grant also
  grants the `scripting` permission needed to register + drive the discovery
  content scripts. Requesting host alone (the prior behavior) could never
  register scripts after a successful host grant.

- **Permissions (all optional):** the manifest declares an EMPTY `permissions`
  array. `alarms`, `storage`, `sidePanel`, `tabs`, `scripting`, and `notifications`
  are all in `optional_permissions`; host access is in `optional_host_permissions`.
  The extension boots and runs with ZERO optional permissions (degrading
  gracefully: session-only storage, no scheduled tasks, read-only, no
  notifications). Each capability is requested from a real owner gesture in the
  Settings → Permissions panel; the service worker never requests a permission
  itself (no gesture).

## 4. Phasing
1. **Design** (this doc) → 2. **Mock UI** (static HTML for review) → 3. **Scaffold**
(extension skeleton) → 4. **Open questions** → 5. build (later, after review).
