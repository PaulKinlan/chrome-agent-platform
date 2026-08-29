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
  discovers + invokes them (first-run approval per tool). Discovery is observable:
  enable **Settings → Site agents → Diagnostics** for gated `[WebMCP]` logs (page
  DevTools console) + a status readout (last discovery, origin, script state, tool count).
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
- **Agent workers** — each agent runs in its **own shared worker** hosted by the
  offscreen document and bootstrapped through the service worker. One crashed or leaky
  agent no longer takes the router and every other agent down with it. The UI holds a
  live `MessagePort` with redacted progress; background agents run with zero visible
  pages; a service-worker-owned single-driver lease means only one surface drives
  *destructive* browser commands at a time (reads like screenshots stay ungated).
- **126 Chrome tools**, every `chrome.*` call audited against the Chromium IDL/JSON
  schemas — tabs and tab groups, windows, downloads, history, cookies, bookmarks,
  reading list, content settings, MHTML capture, network rules, extension management,
  privacy/proxy/font/power settings, TTS, and user scripts. All grant-gated; the
  extension can never act on itself.
- **Live bounded lazy tool provider** — every run receives exactly two definitions,
  `search_tools` and `execute_tool`, regardless of how large the catalog is, so provider
  context stays constant. Search derives bounded metadata from the live built-in,
  browser, management and WebMCP sources and returns expiring single-use references
  bound to run/task/agent/origin/document/generation; it never grants, approves,
  installs or executes. Execute accepts only a returned reference and revalidates
  catalog, source, capability, permission, grant, enrollment, document, run, expiry and
  replay fences before validation, before dispatch, and after dispatch.
- **26 bundled Wasm tools** — base64, csvtool, cut, diff, du, grep, gzip, head, markdown,
  md5sum, patch, sha256sum, sha512sum, sort, sqlite3 (bounded query), stat, tail,
  toml2json, touch, tr, tree, truncate, uniq, uuid, wc, xxd. Each ships with an exact
  manifest, CAS digest, SBOM and licence record, verified at build time by a bounded raw
  import/memory scan. A Rust→`wasm32-wasip1` lane (htmlq, numbat, bttf, sed, jq, xan,
  tokei) builds and runs with reproducible builds and lock-faithful licence censuses —
  those seven are **proven, not yet admitted** to the shipped set.
- **Usage + cost accounting** — per-call token/cost records against the bundled
  llm-prices table, aggregated per run and per agent. Providers that don't report usage
  are recorded as unknown, never faked.
- **Observability** — `npm run build` produces a debug build with source maps and a
  namespaced, levelled, timed logger plus performance marks across grants, every tool
  call, model round-trips and task loading. Redacted: no prompt or page content ever
  appears. Security assertions are identical in both builds.
- **Transparency** — an error console (full error detail + copy) and a security shield
  (CSP/permission state) in the hub.

## Security model

- **All permissions are optional** (the manifest `permissions` is empty). Each feature
  requests its permission on a user gesture, at the moment of need — never silently.
- No broad `<all_urls>` in `permissions`; screenshots via `captureVisibleTab`/`activeTab`.
- **No `debugger`.** It was re-declared as an optional permission at `0.2.286` for the
  CDP power tools and **removed again on 2026-08-27** (owner decision): it carries
  Chrome's all-sites permission warning and a persistent "started debugging this
  browser" bar. The four CDP tools went with it; the browser-tool count is 126.
  `tests/chrome-tools-t12.test.ts` guards the removal, so bringing it back has to be a
  deliberate act rather than a side effect of the next tool tranche.
- **Origin-keyed OPFS** — one agent/origin can never read another's memory.
- **The standing security suite** (`npm run test:security`) acquires the canonical
  Chrome lock, supervises one fresh exact profile under a hard timeout, and proves
  network exfiltration, sandbox escapes, and prompt-injection → destructive-tool
  are all blocked. Do not execute `scripts/security-suite.ts` directly.
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
npm run package        # fresh exact-inventory Store production ZIP
npm run package:store  # same exact Store boundary (explicit alias)
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select the `extension/` directory. The new-tab page becomes the hub.

Production packaging never copies the local `extension/` tree wholesale. It
combines Git-tracked regular files with the current generated `dist` and the
byte-identical generated changelog, rejects symlinks/special files, verifies a
fresh ZIP's exact names and hashes, then atomically replaces the final archive.
`dist.complete` v2 is canonical JSON bound to the Git commit, current indexed
source bytes, exact generated bundle hashes, and the declared `store` target;
lock owners, PIDs, stage paths and wall-clock timestamps remain build custody
and never enter package bytes. The target is an intent/mismatch gate, not proof
of content. The package step revalidates the marker around inventory hashing,
then independently scans the actual tracked and generated package bytes.
Identical source builds therefore produce byte-identical markers and ZIPs,
while ignored local bundles, stale/legacy/cross-target markers, and files removed
since an older ZIP cannot survive.

Store packaging uses the same inventory, content hashes, ZIP construction, and
atomic replacement without transforming bytes. The explicit `--target=store`
boundary additionally requires the exact MV3 extension CSP, the bundled-reviewed-
only lane, zero unmanifested Wasm, no alternate Worker literal, and no statically
visible remote script/code-loading URL. Computed and simple aliased Worker,
SharedWorker, importScripts, and remote JavaScript fetch sinks are rejected. The
manifest sandbox evaluator alone has an exact-path exemption; generated service-
worker/options bundles do not. These scans are bounded heuristic defense in depth;
exact CSP, package hashes, marker bindings, and archive verification remain
mandatory. Static PASS is not Chrome Web Store policy approval.

## Architecture

```
extension/
  manifest.json                 MV3 manifest (install-granted permissions; <all_urls>)
  background/service-worker.js  the router + agent core (bundled → dist/)
  ntp/                          the agent hub (new-tab page — the command center)
  sidepanel/                    the driven-page surface (chrome.sidePanel)
  chat/                         the conversation surface
  options/                      the settings (providers, agents, permissions, hooks,
                                advanced system prompts, usage, data & memory)
  artifacts/                    the artifact gallery
  content/                      the WebMCP bridge + window.* tool inference (MAIN + isolated)
  shared/                       the single-source Web Components (the design system)
  lib/                          provider, memory, named-agents, skills, hooks, artifacts,
                                tool-catalog/search/selection shadow authorities,
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

This README is the overview. The document map, in precedence order:

| Document | What it is authoritative for |
|---|---|
| **[TASKS.md](TASKS.md)** | **Task state, and the only authority for it.** Holds ONLY what is in progress or still to do — merged is done, and done is archived to `TASKS-DONE.md` at triage. The entry always wins over any summary of it. |
| **[PLAN.md](PLAN.md)** | The roadmap view — what has landed, what is next, and the current gate results. |
| **[CHANGELOG.md](CHANGELOG.md)** | What shipped, in plain English, one line per release. |
| **[KNOWN-ISSUES.md](KNOWN-ISSUES.md)** | Gate state and the few open findings not obvious from a task title. A thin view over TASKS.md, not a second tracker. |
| **[docs/UI-FIXES-TRACKER.md](docs/UI-FIXES-TRACKER.md)** | UI-detail asks and their fix state. |
| **[TASKS-DONE.md](TASKS-DONE.md)** | Completed work, archived at triage. |
| **[docs/CONSTITUTION.md](docs/CONSTITUTION.md)** | The non-negotiable security/a11y/design/perf constraints. |
| **[docs/DESIGN.md](docs/DESIGN.md)** + **[PRODUCT.md](PRODUCT.md)** | The visual system and the product's voice. |
| **[REVIEW-2026-08-21.md](REVIEW-2026-08-21.md)** | The 2026-08-21 independent architectural review. Its *delivery* diagnosis has since been acted on (`0.2.105 → 0.2.319`); read it for the method, not for current status. |

**Current gate status:** build clean · unit **1779/0** · Chrome journeys **127/127** ·
security suite **PASS**. The journey suite had been red at 26/127 from `0.2.313` until
`0.2.320`; the causes are at the top of [PLAN.md](PLAN.md).
