# ACP audit — falsification evidence (2026-09-12)

Bead: chrome-agent-platform-qlho (epic) — AUDIT lane, branch `feat/acp-agent-harness`.

Every new/changed assertion was observed FAILING under a mutant that removes the
behaviour it guards, then GREEN after restore (repo gate rule: "a changed test
must be proven able to fail").

## M1 — origin guard removed (`scripts/acp-bridge.ts`)

Mutant: the Origin allowlist check rewritten to `if (false) { ... }`.

```
ACP bridge: a web page's Origin is refused, an extension's is accepted ... FAILED
AssertionError: Values are not equal: a web-page origin must be refused, got: HTTP/1.1 101 Switching Protocols
FAILED | 0 passed | 1 failed
```

Restored → `1 passed | 0 failed`.

## M2 — session key reverted (`extension/lib/acp-runner.js`)

Mutant: `acpSessionKey` returns `threadId || String(harnessId || "pi")` (the
pre-fix shape: no per-harness key, so a null threadId never resumes).

```
acpSessionKey: thread-scoped inside a persisted thread, per-harness otherwise ... FAILED
FAILED | 1 passed | 1 failed
```

Restored → `2 passed | 0 failed`.

## M3 — bridge plumbing broken (`tests/fixtures/acp-fake-adapter.mjs`)

Mutant: the fixture's `agent_message_chunk` text changed from `fake reply` to
`BROKEN reply` (i.e. the streamed message no longer matches what the client
collects).

```
ACP End-to-End (fixture): drives a full turn through the loopback bridge ... FAILED
FAILED | 0 passed | 1 failed | 1 ignored
```

Restored → `1 passed | 0 failed | 1 ignored` (the ignored one is the opt-in
LIVE pi journey, which requires `CAP_ACP_LIVE=1`).

## Live probes (durable evidence, run against real pi-acp 0.0.33)

`cap-evidence/acp-resume-probe.ts` — session/load after the adapter process was
killed:

```
[probe] turn1: "stored" (stopReason=end_turn)
[probe] loadSession: OK
[probe] turn2: "kumquat-4242"
[probe] RESUME MEMORY: PASS — session restored across adapter restart
```

`cap-evidence/acp-runner-continuity-probe.ts` — the exact NTP call shape (no
cwd, no threadId) through `runAcpTaskTurn`, two turns:

```
[probe] turn1 ok=true resumed=false session=01a09763-... result="stored"
[probe] turn2 ok=true resumed=true  session=01a09763-... result="kumquat-7777"
[probe] HOST CWD DEFAULT: PASS — session created with no client cwd
[probe] SESSION CONTINUITY: PASS — turn 2 resumed the session
[probe] MEMORY ACROSS TURNS: PASS — recall verified
```
