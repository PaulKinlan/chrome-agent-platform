# Task for worker

[Read from: /home/paulkinlan/chrome-agent-platform/context.md, /home/paulkinlan/chrome-agent-platform/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
IMPLEMENTATION TASK — build the chrome-agent-platform extension. Work in /home/paulkinlan/chrome-agent-platform (the repo exists with docs/DESIGN.md, mock/ pages, extension/ scaffold, docs/OPEN-QUESTIONS.md — READ them first). Build the extension from the design, with Paul's review decisions baked in. Commit as you go; never push.

## Paul's decisions (from his review — implement these exactly)
1. **Multi-agent hub**: the hub has MULTIPLE agents that fan out to per-site sub-agents. Make it MODULAR so we can iterate between 1-agent vs multi-agent (a config flag).
2. **Consumer next-steps tray**: inferred functionality (offer 2-3 useful actions per navigation without taking over browsing).
3. **Tool approval**: required on FIRST RUN per origin (a one-time approval before the agent may call an inferred/WebMCP tool on that origin).
4. **Memory segregation**: OPFS keyed per origin — one site origin must NEVER access another origin's memory (origin-keyed stores + a master memory).
5. **co-do integration**: use the co-do project's design principles + learnings as INSPIRATION (not a direct code import) — read /home/paulkinlan/co-do for the patterns.
6. **History**: store both screenshots AND MHTML saves; keep data until the user deletes it (via chat or the memory explorer).
7. **Naming**: placeholder for now.
8. **Agent harness: agent-do** (read /home/paulkinlan/agent-do) — which is built on the Vercel AI SDK, so models are swappable. Use it for the agent loop (tools, skills, lifecycle hooks, permissions, usage tracking, master/worker orchestration).
9. **Usage accounting** like chaos-relay (per-task/per-model token + cost accounting; a usage store + a usage view in the explorer).
10. **Model routing**: a pluggable model layer (AI SDK) + the ability to defer some tasks to a glm-5.3 endpoint via intercom (a deferred-tasks route — pluggable, document the seam).

## Build order (core first; commit per piece)
1. **MV3 extension skeleton** wired up: the NTP hub page (from mock/ntp-hub.html), the side panel, the background service worker, the content script bridge. The extension must LOAD cleanly in Chrome (chrome://extensions → load unpacked) with no errors.
2. **The agent core**: agent-do loop integrated (a hub agent with a tool set + skills); the multi-agent hub with a config flag for 1-vs-N agents; the per-site sub-agent registry.
3. **The tool directory**: read a page's WebMCP tools (document.modelContext when present) + infer functionality from window.* functions (reuse the webmcp-lib approach — read /home/paulkinlan/webmcp-lib) + the approval gate (first-run approval per origin).
4. **Memory**: origin-keyed OPFS stores (per-origin + master) + a simple memory explorer page (from mock/memory.html) + the usage store.
5. **The chat surface** (from mock/chat.html): the chat interface, task input (text + image/audio/video attachments stubbed), a screenshot-history strip (capture screenshots of visited pages; MHTML save via chrome.pageCapture if available else a stub), clickable history.
6. **The side-panel orchestration**: open a page in the side panel + drive it via the WebMCP bridge / injected JS.
7. **The alarm scheduler** (agent-do pattern): register future tasks (chrome.alarms) + respond to actions.
8. **The morph (double-iframe)** — stub + structure (meld 2-3 sites) — document the seam.

## Rules
- MV3, vanilla JS frontend, agent-do for the agent core. Deno for any server pieces.
- The extension must load in Chrome without errors; the NTP hub + side panel + chat must render (match the mock/ pages).
- Commit per piece. Reply with: the commit log, what is implemented vs stubbed, how to load + use the extension, what works end-to-end, and what is left for the next iteration. The extension loading cleanly + the hub/chat/panel rendering is the acceptance bar for this run.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```