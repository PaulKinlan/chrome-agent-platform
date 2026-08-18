# Chrome Agent Platform

Chrome as the agent platform: a **new-tab agent hub** that orchestrates the web with
**persistent named agents**, **per-site sub-agents** (WebMCP tool discovery), and the
**generative-UI** surface. Built on [agent-do](https://github.com/PaulKinlan/agent-do)
patterns + the **Vercel AI SDK** (swappable models).

The hub is the command center: a task composer, a conversation surface with live
progress, a task thread list, and the agents you've created — each with its own
isolated OPFS memory, run history, skills, and avatar.

## What it does

- **The agent model** — persistent, named agents (avatar + name + role) with their own
  OPFS sandbox (memory + run history + installable skills + a `memory_grep` tool).
  Named, site, and background agents are all isolated. The master hub agent
  creates + manages them (create/update/delete/delegate).
- **Unified agent access** — one shared `<agent-picker>` everywhere: the side
  panel's Agents view (browse/search/select → the agent's own conversation →
  direct a task, live updates, per-session restore), every composer's + menu
  "Choose agent" (a removable agent chip routes the run by canonical ID), and
  the `/agent` slash command (grouped, keyboard-complete, stale selections
  rejected).
- **Sites as sub-agents** — enrolled origins expose their WebMCP tools; the agent
  discovers + invokes them (first-run approval per tool).
- **Tasks as threads** — a task is a distinct thread (auto-named, full-screen, with
  live progress + per-task error detail + a nudge/continue composer).
- **Skills** — reusable capabilities (the recipes reworked into skills): include a
  skill in a task (`/skill:<id>`), attach one to an agent, schedule one, or import an
  external skill (the chaos skill-loader pattern: a GitHub repo/URL → SKILL.md).
- **Generative UI + artifacts** — the agent generates HTML UI rendered live in a
  sandboxed double-iframe, saved as a reusable artifact.
- **Agent-generated scripts** — the agent writes JavaScript that runs repeatedly
  (on a schedule/hook) in a sandboxed worker, without re-invoking the model.
- **System hooks** — the full `chrome.*` `on*` event surface as candidate hooks, with
  an owner-only authoritative deny-list.
- **Transparency** — an error console (full error detail + copy) and a security shield
  (CSP/permission state) in the hub.

## Security model

- **All permissions are optional** (the manifest `permissions` is empty). Each feature
  requests its permission on a user gesture, at the moment of need — never silently.
- **No `debugger`**, no broad `<all_urls>`; screenshots via `captureVisibleTab`/`activeTab`.
- **Origin-keyed OPFS** — one agent/origin can never read another's memory.
- **The standing security suite** (`npm run test:security`) proves network exfiltration,
  sandbox escapes, and prompt-injection → destructive-tool are all blocked.
- The review loop (sol / GLM / DeepSeek, independent sessions) reviews every change.

See **docs/CONSTITUTION.md** for the full security/accessibility/design/memory
constraints.

## Load + run

```sh
npm install
npm run build          # bundles the AI SDK + zod into the service worker
npm test               # unit tests
npm run test:chrome    # the CDP journeys (drives the real extension)
npm run test:components  # the component gallery smoke
npm run test:security  # the sandbox-boundary security suite
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select the `extension/` directory. The new-tab page becomes the hub.

## Architecture

```
extension/
  manifest.json                 MV3 manifest (permissions: []; all optional)
  background/service-worker.js  the router + agent core (bundled → dist/)
  ntp/                          the agent hub (new-tab page — the command center)
  sidepanel/                    the driven-page surface (chrome.sidePanel)
  chat/                         the conversation surface
  options/                      the settings (providers, agents, appearance, permissions,
                                hooks, advanced system prompts, usage, data & memory)
  artifacts/                    the artifact gallery
  content/                      the WebMCP bridge + window.* tool inference (MAIN + isolated)
  shared/                       the single-source Web Components (the design system)
  lib/                          provider, memory, named-agents, skills, hooks, artifacts,
                                script-host, management-tools, scheduler, system-prompts, ...
```

## System prompts (Settings → Advanced)

Every system prompt the platform sends is composed by ONE authority
(`extension/lib/system-prompts.js` — see **docs/SYSTEM-PROMPTS.md**): the versioned
built-in base + the owner's per-scope customization (append/prepend/replace)
+ the agent role + the per-run skills + the immutable protected runtime policy
(lib/runtime-policy.js, always the FINAL layer). Hub, named-agent, background,
scheduled, hook, and site-worker runs all resolve through it, so the Settings →
Advanced preview is the exact platform composition a run is built with — and
every run records a run-bound attestation (the SHA-256 digest + UTF-8 bytes of
the exact provider-bound system message, keyed receipts, never content) proving
the wire message embeds that composition. A product update to a built-in prompt
never silently overwrites a customization — the UI flags it with an old-vs-new
diff and explicit keep/edit/reset choices.


## The design system

20+ reusable Web Components (the single source `extension/shared/components.js`),
testable in isolation in the component gallery —
<https://paulkinlan.github.io/chrome-agent-platform/components.html> — which imports the
same file (a drift guard fails the build on divergence). See **docs/DESIGN.md** +
**PRODUCT.md** for the design tokens (the paper/teal palette).

## Models

`lib/provider.js` is the pluggable model layer — OpenAI-compatible endpoints (OpenAI,
Anthropic, Gemini, DeepSeek, Ollama), each with a per-provider model dropdown + a
**Test connection** button. Per-agent provider override is supported. The model list +
the usage pricing come from the bundled [llm-prices.com](https://www.llm-prices.com/)
table (cost tracking + spending limits work out of the box).

## The plan, the history, and the remaining work

This README is the overview. **The plan — the landed state, the in-flight work, the
open questions, and the proactive backlog — lives in [PLAN.md](PLAN.md)** (the single
source of truth for what's done vs what's next). Historical detail and the open review
findings live in **docs/KNOWN-ISSUES.md** + **docs/UI-FIXES-TRACKER.md**. The design
is **docs/DESIGN.md**; the constraints are **docs/CONSTITUTION.md**.
