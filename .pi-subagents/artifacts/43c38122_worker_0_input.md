# Task for worker

[Read from: /home/paulkinlan/chrome-agent-platform/context.md, /home/paulkinlan/chrome-agent-platform/plan.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
REBUILD the chrome-agent-platform agent core. The previous build is a FAKE — it claims agent-do but does not import it, the provider is a label (a Chrome extension cannot call deepseek-pro), and it was never tested end-to-end. The owner is rightfully upset. Fix it for real. Work in /home/paulkinlan/chrome-agent-platform. Commit as you go; never push.

## What is actually wrong (verified)
- extension/lib/agent.js says "agent-do pattern" but does NOT import agent-do — no package.json, no node_modules, no real library. It is a hand-rolled fake.
- extension/lib/provider.js claims "deepseek-v4-pro" at api.deepseek.com — but a Chrome extension cannot call that without the owner's API key (which must never ship in the extension). It is a label, not a working provider.
- It was never tested end-to-end (the agent loop never ran against a real model).

## The real patterns to use (READ THESE)
1. **agent-do** — the REAL library is at /home/paulkinlan/agent-do (npm package "agent-do" v0.7.0, exports createAgent/runAgentLoop/streamAgentLoop). The chaos extension (/home/paulkinlan/chaos/packages/extension) bundles it for real: `import { createAgent } from "agent-do"` with agent-do in node_modules. Read /home/paulkinlan/chaos/packages/extension/src/agents/extension-agent.ts for how chaos integrates agent-do in an extension.
2. **chaos usage logging** — /home/paulkinlan/chaos/packages/extension/src/agents/usage.ts + pricing.ts: records per-LLM-call usage (agentId, agentName, provider, model, inputTokens, outputTokens, estimatedCost, source) into chrome.storage.local with a 7-day rolling window + aggregation. THE OWNER ASKED FOR THIS PATTERN (usage logging like the chaos extension) — NOT the chaos relay project.

## What to build (the fix)
1. **Real agent-do integration**: add agent-do as a dependency (npm install agent-do or vendor it from /home/paulkinlan/agent-do) and bundle it into the extension (esbuild or a build step like chaos uses). The agent core (extension/lib/agent.js) must call createAgent/runAgentLoop from the REAL agent-do — not a reimplementation.
2. **A provider that actually works in the extension**: the DEFAULT must be Chrome's built-in Prompt API (Gemini nano — window.LanguageModel / the global LanguageModel) so the extension works on-device with NO key. Add a SECONDARY configurable OpenAI-compatible endpoint (the user pastes their own baseURL+key+model in the hub settings, stored in chrome.storage) — clearly documented that it needs the user's own key. REMOVE the fake "deepseek-v4-pro" default. The provider layer must actually instantiate a working AI-SDK-compatible model (the Prompt API has a community AI-SDK adapter — or wrap it in a minimal AI-SDK-compatible generateText interface).
3. **Usage logging like chaos**: port chaos's usage.ts pattern (recordUsage per LLM call → chrome.storage.local, 7-day window, aggregation by agent/provider/model) into extension/lib/usage.js, and wire it into the agent loop (every LLM call records usage). Surface it in the memory explorer (a usage view).
4. **End-to-end test**: the extension must LOAD in Chrome with no errors AND the agent loop must actually run — prove it: load the extension in headless Chrome, open the NTP hub, run a task (with the Prompt API if available, else a stub provider that returns a canned response so the loop completes), and capture evidence (the task completes, the usage is recorded, the chat shows the result). Screenshot the working hub + the chat with a completed task.

## Acceptance bar (functional, not "loads")
- The extension loads with no errors.
- A task typed into the hub actually runs the agent loop and produces a result in the chat (real model if Prompt API available, else a clearly-labelled stub).
- Usage is recorded + visible in the explorer.
- agent-do is genuinely imported (not a pattern comment).
- Evidence: screenshots + a note on how you verified it functionally.

Commit per piece. Reply with: the commit log, what is real vs stubbed, how the provider works, how usage logging works, the end-to-end test evidence, and what is left. Do NOT claim it works without driving it in a browser.

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