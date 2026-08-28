# Agent Product Gaps — persona agents, role templates, and collaboration skills

**Date:** 2026-08-28 · **Type:** research / product-gap analysis (no source changes)
**Question:** how far is CAP's named-agent model from the persona-agent products the owner points at (grok.com/bots, his "business in a box"), and what is the smallest path to default agent templates + higher-level collaboration skills?

---

## 1. Reference study

### 1.1 Grok / X.com bots (grok.com/bots)

**Confidence: partial.** The bot gallery (`grok.com/bots`, `x.com/i/grok/bots`) is auth-walled; findings below combine the publicly documented surface with the owner's description. Verify in-product before copying UX details.

What Grok exposes that is relevant:

- **Named, persona-shaped agents ("bots")**: a user-facing gallery of agents identified by *name and role*, not by tool count — the product leads with WHO the agent is (a persona) and WHAT it's for.
- **Persona config**: per-bot custom instructions (system-prompt shaping), avatar, and a shareable/publishable identity.
- **Per-agent capability sets**: bots carry their own tool/skill configuration; the owner specifically calls out per-agent **MCP-server** configuration ("they might even have MCP servers they can talk to and be configured to work with").
- **Composability into teams**: the owner's interest is the *organisational* pattern — chief of staff, billing organiser — i.e. agents that read as co-workers occupying roles, each with its own kit.

### 1.2 Comparable products (fully verifiable grounding used for the gap table)

| Product | Persona model | Per-agent tools/skills | External tool config (MCP/actions) | Sharing/publishing |
|---|---|---|---|---|
| ChatGPT **GPTs** | named GPT, instructions, avatar, conversation starters | knowledge files + capabilities toggles | "Actions" = per-GPT OpenAPI tool config | GPT Store publishing |
| Gemini **Gems** | named Gem, pre-prompted persona | knowledge uploads | (limited; no MCP) | link sharing |
| GitHub **Copilot custom agents + MCP** | repo-scoped custom agents | per-agent tool allow-lists | first-class **MCP server config** per agent | repo-defined, shareable via repo |
| Claude **subagents** | named subagent, own prompt + own tool allow-list, own context | per-agent tool selection | MCP servers available per agent | project-file defined |
| **CAP today** | named agent: `role` free-text + avatar | `skills[]` (recipe ids) + `coreAssets[]` | WebMCP is runtime-discovered per *site*, not configured per *agent* | not shareable |

The industry converges on: **name + persona prompt + per-agent tool allow-list + per-agent external-tool config + shareability**. CAP has the first three in embryo and lacks the last two.

### 1.3 "Business in a box" (owner's project)

**Not locatable.** No local directory, no public or private repo found under that name (checked `gh repo list` public + private). The owner describes: multi-user, each user accumulates **different capabilities over time** — i.e. capability *growth* as a first-class model. Flagged as an open question for the owner; the capability-growth axis is included in the gap table from the description alone.

### 1.4 CAP current state (verified in code)

- **Named agents** (`extension/lib/named-agents.js`): `{id, name, role, avatar, skills[], coreAssets[], agentsMd, provider}`; per-agent provider + **per-agent memory** (`agentMemory(id)`, grep-able); max 200 agents; per-agent composer ("direct a task to this agent").
- **Role is free text only** — there is no template concept; the `role` string is not wired into the system prompt builder as a structured persona.
- **Skills = recipes** (`extension/lib/recipes.js`, 50+ skills): DATA (goal + steps + `requiredCapabilities`), never eval'd; modes: on-demand chips + background (scheduled); intent-grouped (tabs/bookmarks/reading/downloads/focus/summaries/context/monitor/analyze/organize/digest/capture).
- **Delegation**: `delegate_task` → `agent.delegate` (hub → named agent, with grant/redaction authority in the SW). Agents do not currently delegate to each other.
- **WebMCP** (`webmcp-authority.js`): page-provided tools, runtime-discovered per site — a *site*-sub-agent concept, not a per-agent configured server.
- **Bundled wasm capability tools**: jq, sed, htmlq, gzip, csvtool, numbat, xan, tokei, bttf, stat, tree (+ bounded python pending the runtime build).
- **Background agents**: enabled recipes on schedules (alarms), pause/resume + per-agent alarm view landing 2026-08-28.

---

## 2. Gap analysis

Legend: Grok = grok.com/bots (partial confidence); BITB = business-in-a-box (description only); CAP = current main. Effort: S = hours, M = 1–2 days, L = multi-day.

| # | Capability | Grok | BITB | CAP today | Gap + effort |
|---|---|---|---|---|---|
| G1 | **Named persona agents** | yes — gallery of named bots | yes — per-user roles | **mostly** — named agents exist, but `role` is free text and unused in prompt construction | Wire `role` into the system prompt; make the persona first-class. **S** |
| G2 | **Agent templates** (ready-made roles) | yes — curated bots | yes — role archetypes | **missing** — blank create form | Template catalogue + picker in agent-create. **S** once G1 |
| G3 | **Per-agent skill sets** | yes | yes | **yes** (`skills[]` on the agent record) + per-agent memory | Solid. Template default skill-packs reference it. **—** |
| G4 | **Per-agent MCP / external tool config** | yes (owner) | — | **missing** — WebMCP is site-scoped, not agent-scoped | Per-agent "tools" config: allow-list of WebMCP origins + per-agent bundled-wasm allow-list; later arbitrary MCP endpoints. **M** |
| G5 | **Agent-to-agent delegation** (worker → reviewer loops) | implied | implied ("what would your manager say") | **SHIPPED** — `delegate_to_agent` management tool: per-edge allow-list, depth ≤2, cycle-detect, descendant cap, budget-capped, audited ([contract](AGENT-DELEGATION.md)) | Done |
| G6 | **Capability growth over time** | — | **core** (capabilities accumulate per user) | **partial** — per-agent memory accumulates knowledge, but skills/tools are static per agent | "Earned skills": an agent's skill list grows from usage (memory-derived suggestions → owner-approved additions). **M/L** |
| G7 | **Sharing/publishing agents** | yes (shareable bots) | — | **missing** — agents are local-only | Export/import an agent (name/role/skills/agentsMd as a portable JSON "agent card"). **S/M** |
| G8 | **Multi-user** | yes (per-account) | **core** | **no** — single-profile extension | Out of scope short-term; agent cards (G7) are the compatible future bridge. **L** |
| G9 | **Schedules owned by agents** | yes (tasks) | — | **landing now** — background agents + per-agent alarms | Done when per-agent alarms lane lands. **—** |
| G10 | **Higher-level collaboration skills** | — | implied | **missing** — all 50+ skills are browser-functional | Collaboration skill pack (§4). **S/M** |

**Top-5 gaps by leverage:** G1+G2 (persona + templates — turns the existing agent record into a product), G10 (collaboration skills — makes agent *teams* meaningful), G5 (agent→agent delegation — the mechanic behind "manager reviews work"), G4 (per-agent tool/MCP config — the Grok parity item), G7 (agent cards — shareable, and the honest path toward G8).

---

## 3. Agent template catalogue

All templates are **shippable today** (marked ✅) using the existing agent record + skills, unless marked ⚠️ (needs a gap closed). Every skill id referenced exists in `recipes.js`.

| Template | Role / prompt sketch | Default skills | First task | Status |
|---|---|---|---|---|
| **Chief of Staff** ✅ | "You coordinate the owner's browser: triage, brief, delegate. You open the day with a summary and end it with a review. You delegate specialist work and verify results." | `daily-summary`, `weekly-digest`, `tab-hygiene`, `link-collector`, `meeting-prep` | "Brief me: open tabs, unread reading list, today's downloads; propose what to delegate." | ✅ today |
| **Research Analyst** ✅ | "You research across tabs: collect, extract, cross-check, and report with sources. You never assert without a captured link." | `multi-tab-researcher`, `link-collector`, `reader-mode`, `data-extractor`, `page-summary` | "Collect every article on <topic> open in tabs; produce a sourced digest." | ✅ today |
| **Code Reviewer** ⚠️(G10) | "You review work before it ships: you read the artifact, run checks, and report findings by severity. You are sceptical on the owner's behalf." | `page-summary`, `screenshot-annotate` + collaboration skill `review-work` (§4) | "Review this thread's last run; list blocking findings." | ⚠️ needs `review-work` skill + G5 to delegate *to* it |
| **Team Lead / Manager** ⚠️(G5,G10) | "You own an outcome and delegate the steps. You brief workers, chase results, and answer 'what would the manager say' honestly about quality." | `weekly-review-prompt` + `review-work`, `delegate-and-collect` (§4) | "Own the weekly digest: delegate collection, review, deliver." | ⚠️ needs G5 agent→agent + `delegate-and-collect` |
| **Critic** ⚠️(G10) | "You argue against the plan. Your job is the strongest honest objection: risks, counter-evidence, gaps. You never soften." | collaboration `red-team` (§4) + `page-summary` | "Red-team this plan; give the three strongest objections." | ⚠️ needs `red-team` skill |
| **Tab Janitor** ✅ | "You keep the browser clean without asking: dedupe, close stale, group by domain, pin favourites. You report what you did." | `dedupe-tabs`, `stale-tab-closer`, `auto-group-by-domain`, `idle-close-tabs`, `auto-pin-favorites` | (background) runs on schedule | ✅ today (background) |
| **Bookmark Librarian** ✅ | "You curate bookmarks: categorise, dedupe, kill dead links. The library gets better every week." | `bookmark-auto-categorize`, `bookmark-dedupe`, `dead-bookmark-cleaner`, `reading-list` | (background) weekly | ✅ today (background) |
| **Price & Change Watcher** ✅ | "You watch pages for change: prices, content, availability. You only interrupt when a threshold is crossed." | `price-watcher`, `page-change-watcher`, `link-checker` | "Watch <url> for price drops below X." | ✅ today (background) |
| **Site Auditor** ✅ | "You audit pages: accessibility, performance, SEO meta, cookies. You produce a scored report with evidence." | `accessibility-checker`, `performance-reporter`, `seo-meta-checker`, `cookie-tracker-auditor`, `screenshot-annotate` | "Audit <url>; report by severity." | ✅ today (uses wasm+browser capability tools) |
| **Data Wrangler** ✅ | "You extract and shape: tables from pages, CSV clean-up, structured summaries. jq/csv/sed are your instruments." | `data-extractor`, `form-filler` + bundled wasm (jq/csvtool/sed/htmlq) | "Extract every table from <url> into clean CSV." | ✅ today |
| **Meeting Wing** ✅ | "You prepare and follow up: brief before, digest after." | `meeting-prep`, `page-summary`, `context-menu-save-quote`, `weekly-review-prompt` | "Prep for <meeting>: brief on attendees' recent pages and open threads." | ✅ today |
| **Site Specialist (WebMCP)** ⚠️(G4) | "You are the agent for <origin>: you use that site's own WebMCP tools first, browser control second." | per-origin WebMCP allow-list (needs G4) + `page-summary` | "Use <site>'s own tools to do X." | ⚠️ needs per-agent WebMCP config |

---

## 4. Built-in collaboration skill catalogue

Higher-level skills the recipes manager can ship as DATA, composing existing browser skills. Each: trigger → steps → output.

| Skill | Trigger | Steps (spec) | Output |
|---|---|---|---|
| **review-work** | owner says "review X" or a Team Lead delegates | 1. open the artifact/thread/run to review; 2. build a findings list (blocking/major/minor) with evidence quotes; 3. state a verdict: PASS / REVISE with the smallest fix list | structured findings + verdict |
| **delegate-and-collect** | multi-step work spanning roles | 1. split the goal into per-role tasks; 2. `delegate_task` each to the right agent; 3. collect results; 4. reconcile conflicts; 5. report with per-agent credit | consolidated report |
| **red-team** | before committing to a plan/decision | 1. restate the plan steel-manned; 2. produce the 3 strongest objections with evidence; 3. propose mitigations | objection memo |
| **research-and-report** | open-ended question | compose `multi-tab-researcher` + `link-collector` + `reader-mode`: gather → extract → cross-check claims → sourced digest with confidence levels | sourced digest |
| **browser-research-playbook** | "go learn about X on the web" | scripted browser sequence: search → open top N → `reader-mode` extract → quote-capture → synthesis; N bounded, sources logged | playbook report |
| **manager-check** ("what would your manager say") | after any significant run | 1. summarise what was done + evidence; 2. critique against the goal (completeness, correctness, scope discipline); 3. recommend accept/redo with reasons | accept/redo memo |
| **handoff-brief** | switching agents mid-task | 1. current state; 2. decisions taken + why; 3. open threads + next action | handoff note (into receiving agent's memory) |

---

## 5. Recommended roadmap (smallest path to the vision)

1. **Wire `role` into the system prompt + ship the template picker** (G1+G2, S): agent-create gains a template gallery (the §3 catalogue as data); picking one pre-fills name/role/skills/agentsMd. Pure additive data + one render. *This alone delivers the Grok-shaped product feel.*
2. **Ship the collaboration skill pack** (G10, S/M): add the §4 skills to `recipes.js` (they are DATA; `review-work`/`manager-check`/`handoff-brief` need no new mechanics).
3. ~~**Agent→agent delegation with loop guards** (G5, M)~~ **SHIPPED** (see [AGENT-DELEGATION.md](AGENT-DELEGATION.md)): `delegate_to_agent` inside named-agent runs, depth ≤2, cycle-detect, per-edge allow-list enforced in the SW, per-root descendant cap, budget-capped children, durable audit log. Unlocks Team Lead/Critic for real.
4. **Per-agent tool config** (G4, M): WebMCP origin allow-list + bundled-wasm allow-list on the agent record, surfaced in the agent editor. The Grok-parity item.
5. **Agent cards** (G7, S/M): export/import `{name, role, skills, agentsMd, coreAssets}` as JSON — shareable now, the honest bridge to multi-user later (G8 stays out of scope until the owner asks).
6. **Capability growth** (G6, M/L, needs owner's BITB reference): memory-derived skill suggestions, owner-approved. Park until the BITB model is shared.

**Owner decisions requested:** (a) point me at business-in-a-box (name/repo) so G6/G8 reflect it; (b) confirm the Grok bot surface in-product (auth-walled here) before copying its UX; (c) pick the first template batch for roadmap step 1.
