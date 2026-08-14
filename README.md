# Chrome Agent Platform

Chrome as the agent platform: a **multi-agent hub** (new-tab page) that orchestrates
the web via WebMCP, with **sites-as-sub-agents**, **origin-keyed OPFS memory**,
**alarms**, and **usage accounting**. Built on the [agent-do](https://github.com/PaulKinlan/agent-do)
patterns + the **Vercel AI SDK** (swappable models).

## Load + run

```sh
npm install
npm run build          # bundles the AI SDK + zod into the service worker
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select the `extension/` directory. The new-tab page becomes the hub.

## Architecture

```
extension/
  manifest.json            MV3 manifest
  background/service-worker.js   message router + agent core (bundled → dist/)
  ntp/                      the agent hub (new-tab page)
  sidepanel/                the driven-page surface + morph seam
  chat/                     the conversation surface + screenshot history
  memory/explorer.html      origin-keyed memory + usage view
  directory/                the agent directory + per-tool approval
  content/content-script.js WebMCP bridge + window.* tool inference
  lib/                      provider, memory, usage, tools, skills, agent, messages
```

## Paul's design decisions (implemented)

1. **Multi-agent hub** — a master/hub agent + per-site worker agents, with
   `delegate_task` / `list_agents` / `get_agent_status` delegation tools. A
   `multiAgent` config flag (see `createOrchestrator`) switches between 1-agent
   and multi-agent for iteration.
2. **Consumer next-steps tray** — inferred (the agent derives 2-3 actions per
   navigation; seam in the side panel).
3. **Tool approval** — first-run approval per (origin, tool); the directory page
   lists pending tools with an "approve" action; the agent may only call
   approved tools.
4. **Memory segregation** — OPFS keyed per origin (`memory/origins/<origin>`);
   one origin cannot read another's store; a `memory/master` store for the hub.
5. **co-do** — its tool/sandbox principles are used as inspiration (not a code
   import); the tool-set + upload seam follow the co-do shape.
6. **History** — screenshots (chat strip) + MHTML saves (seam: `chrome.pageCapture`);
   data retained until the user deletes it (chat or memory explorer).
7. **Naming** — placeholder.

## Models

`lib/provider.js` is the pluggable model layer (`@ai-sdk/openai` `createOpenAI`
over any OpenAI-compatible endpoint). Default: DeepSeek (`deepseek-chat` =
deepseek-v4-pro). Set the API key in the hub settings. A **deferred-tasks seam**
(`deferToGlm`) routes tasks to a glm-5.3 endpoint via a configurable webhook
(intercom) — unconfigured, callers fall back to the local model.

Usage is accounted per task/model (tokens + cost) in `lib/usage.js`, rendered in
the memory explorer — the chaos-relay accounting pattern.

## Status

- [x] Extension loads cleanly (verified: background worker registers)
- [x] NTP hub, side panel, chat, memory explorer, directory render
- [x] Agent core (AI SDK) + multi-agent orchestrator + usage accounting
- [x] WebMCP bridge + window.* tool inference + first-run approval
- [x] Origin-keyed OPFS memory
- [x] Alarm scheduler
- [ ] Morph (double-iframe meld) — documented seam, not wired
- [ ] Real model key + end-to-end agent run (needs a configured key)
- [ ] MHTML capture (chrome.pageCapture) — seam stubbed
- [ ] glm-5.3 intercom deferral — seam documented, needs the hosted harness
