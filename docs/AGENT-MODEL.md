# The Agent Model (proposal, informed by Grok Bot)

The key distinction (from Grok Bot): "an agent performs a single task and disappears; a Grok Bot is a persistent teammate." Delegate by ROLE, not by prompt.

## The three concepts

### 1. A task
A single instruction, one-shot, disappears. What the user types in the composer ("summarise this page").

### 2. An agent
A persistent, NAMED identity:
- A name + an avatar (in the sidebar).
- A role ("my PR reviewer", "my reader").
- Attached skills (the pluggable skills — GitHub, reading, etc.).
- Compounding memory (origin-keyed OPFS, per-agent).
- Delegatable: the user assigns a task TO the agent, or turns a task INTO an agent.
- Autonomous-capable: it can run on a schedule/hook (a background agent) AND can start its own sub-tasks.
- Callable: /agent:name or @mention.

### 3. The master agent
The hub orchestrator. Creates + manages the agents (the management tool suite).

## The spectrum
- **Background agents** (Sorting Hat, etc.) — simple agents configured to run on a schedule. A special case.
- **Complex named agents** — teammates the user builds up (a role + skills + memory), delegated tasks, running autonomously or called directly.

## The flow
- `/agent:create <name>` — create a named agent (a role, attach skills).
- `/agent:<name> <task>` — delegate a task to the agent (it runs with its context/memory/skills).
- Assign a task to an agent, or turn a task into an agent (a one-shot task becomes a persistent teammate).
- The sidebar shows the agents (avatars + names); clicking one opens its conversation/capabilities/run-log.

## Unified agent access (LANDED 2026-08-18 — CAP-FB-20260818-AGENT-ACCESS-01)
One coherent system — not three one-offs — gives the user a view of the agents
and access to them from every surface:

1. **The canonical agent ref.** Every agent has ONE unambiguous id:
   `named:<id>` / `background:<id>` / `site:<origin>`. It flows from the picker
   → the composer chip → the run request, so routing is by ID, never by a
   (possibly duplicated) display name. The redacted, grouped registry comes
   from the service worker's `agent.registry` route (named = redacted registry,
   background = enabled state derived from the schedule store, site = enrolled
   origins + tool names only — never provider keys or internal paths). Every
   mutation (create/update/delete/enable/disable/enroll) broadcasts
   `agent-registry-changed`; the surfaces re-fetch — there is no duplicated
   registry state.
2. **`<agent-picker>`** (extension/shared/components.js) — the ONE reusable
   picker: grouped Named/Background/Site, search/filter, avatar+name+role/
   status/skills, selected + "Current" states, empty/loading/error states, a
   combobox→listbox a11y contract (ArrowUp/Down/Home/End, Enter/Tab commit,
   Escape cancel, pointer select, debounced SR result count, ≥44px rows).
3. **The side panel Agents view** — browse/search every agent (including the
   disabled background ones, marked), select → the agent's own conversation/
   history, direct a task, switch back to page orchestration. The selection
   persists per sidepanel session; live create/rename/delete/status updates.
4. **Every composer's + menu → "Choose agent"** — the picker in a top-layer
   popover anchored to the + button (logical anchor positioning + edge flipping
   + a JS fallback). Choosing sets a removable agent chip; send routes the run
   directly to the agent (named → named-agent.run, background →
   background-agent.run, site → agent.delegate — each with its OWN OPFS
   sandbox). A stale (deleted/disabled) selection is rejected at send and on
   the registry broadcast.
5. **`/agent` + `/agent:query`** — the composer opens the SAME shared
   `<agent-picker>` renderer as the + menu (not a parallel popup). A slash
   command is recognized only at input index 0; ordinary prose, URLs, and a
   leading-space `/agent:` remain text. Committing inserts the canonical
   textual reference exactly once AND selects the agent chip; Escape keeps the
   typed text and commits nothing.

**The @mention vs /agent distinction.** `@` inserts an INLINE reference inside
a task for the MASTER agent (mention several agents/skills/artifacts; the
master reads + may delegate). `/agent:<name>` (or the + menu chip) TARGETS the
whole message at ONE agent — it runs in that agent's own context/memory/
skills, not the master's.

## Status
LANDED (2026-08-18): the named-agent layer + the unified agent access above
(the canonical ref, the redacted `agent.registry` route, the shared
`<agent-picker>`, the side-panel Agents view, the + menu Choose agent, the
grouped /agent command). Residual: site-agent delegation carries the task text
only (no attachments, no live per-run progress) — tracked in KNOWN-ISSUES.
