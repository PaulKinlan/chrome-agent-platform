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

## Status
PROPOSED (Paul, 2026-08-16). Awaiting confirmation before building the named-agent layer.
