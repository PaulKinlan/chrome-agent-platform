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
- **Screenshot capture (threat model, honest):** pixel capture of a tab uses the
  Chrome `debugger` API. That permission is **optional**, never permanent — it is
  requested from a real owner gesture (the Settings "Allow the agent to control the
  browser" toggle) and removed on revoke. Chrome's install-time warning for `debugger`
  is "Read and change all your data on all websites"; we accept this because the
  capability is (a) opt-in per the owner, (b) scoped at runtime to the browser-control
  grant's origin allowlist, (c) attached to ONE tab by id for a single
  capture-and-detach call (no lingering attachment), and (d) fail-closed — capture
  is refused and detach failures are surfaced when the permission or grant is absent.
  A failed debugger detach is treated as an error, never silently swallowed.

## 4. Phasing
1. **Design** (this doc) → 2. **Mock UI** (static HTML for review) → 3. **Scaffold**
(extension skeleton) → 4. **Open questions** → 5. build (later, after review).
