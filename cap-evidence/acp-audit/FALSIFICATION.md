# ACP audit — falsification evidence (2026-09-12)

Bead: chrome-agent-platform-qlho (epic) — AUDIT lane, branch `feat/acp-agent-harness`.
Latest commit for this file: see `git log -1` on the branch.

Every new/changed assertion is observed FAILING under a mutant that removes the
behaviour it guards, then GREEN after restore (repo rule: "a changed test must be
proven able to fail"). M2 below is a CORRECTION: the first drill died for the
wrong reason (an independent review, sol, caught it — see the note), and it was
replaced by M4, which kills the continuity behaviour itself.

## M1 — origin guard removed (`scripts/acp-bridge.ts`)

Mutant: the origin allowlist check rewritten to `if (false) { ... }`.

```
ACP bridge: a web page's Origin is refused, an extension's is accepted ... FAILED
AssertionError: a web-page origin must be refused, got: HTTP/1.1 101 Switching Protocols
FAILED | 0 passed | 1 failed
```
Restored → `1 passed | 0 failed`. (Now `2 passed` with the token test.)

## M2 — session key namespacing — CORRECTED

First drill: `acpSessionKey` returned `"pi"` instead of `"acp:pi"` and the test
failed on the literal string. **That is a pin on the literal, not on continuity**
— both the map lookup and the store still used the same key, so resume continued
to work. The reviewer flagged it; the honest replacement is M4, and the key test
now pins the namespacing rule explicitly (`thread-1:pi` vs `thread-1:claude-code`).

## M3 — bridge plumbing broken (`tests/fixtures/acp-fake-adapter.mjs`)

Mutant: the fixture's `agent_message_chunk` text changed to `BROKEN reply`.

```
ACP End-to-End (fixture): drives a full turn through the loopback bridge ... FAILED
FAILED | 0 passed | 1 failed | 1 ignored
```
Restored → `1 passed | 0 failed | 1 ignored` (the ignored one is the opt-in LIVE
pi journey, `CAP_ACP_LIVE=1` / `npm run test:acp:live`).

## M4 — resume disabled (`extension/lib/acp-runner.js`)

Mutant: `if (sessionId) {` → `if (false && sessionId) {` — every turn starts a
new session.

```
runAcpTaskTurn: turn 2 RESUMES the session (session/new once, session/load after) ... FAILED
FAILED | 3 passed | 2 failed
```
Restored → `5 passed | 0 failed`. This is the behaviour pin: the fixture's frame
log shows exactly one `session/new` and one `session/load` naming the same
session id.

## M5 — durable session hint ignored (`extension/lib/acp-runner.js`)

Mutant: `sessionId = await sessionStore.get(sessionKey) ?? null;` → `sessionId = null;`

```
FAILED | 4 passed | 1 failed
```
Restored → `5 passed | 0 failed`. (The store test asserts no `session/new` frame
and a `session/load` naming the stored id.)

## M6 — tool updates append duplicates (`extension/lib/acp-runner.js`)

Mutant: `const existing = toolCards.get(cardId);` → `const existing = undefined;`

```
FAILED | 4 passed | 1 failed
```
Restored → `5 passed | 0 failed`. (One card for a call that streams
`tool_call` + `tool_call_update`, settled to `completed`.)

## M7 — host cwd default removed (`scripts/acp-bridge.ts`)

Mutant: the `session/new || session/load` branch → `if (false)`.

```
FAILED | 2 passed | 1 failed
```
Restored → `3 passed | 0 failed`.

## M8 — token gate removed (`scripts/acp-bridge.ts`)

Mutant: `if (TOKEN && url.searchParams.get("token") !== TOKEN) {` → `if (false) {`

```
ACP bridge: --token requires the shared secret on the upgrade ... FAILED
FAILED | 1 passed | 1 failed
```
Restored → `2 passed | 0 failed`.

## Live probes (durable evidence, real pi-acp 0.0.33)

`cap-evidence/acp-resume-probe.ts` — session/load after the adapter process was killed:

```
[probe] turn1: "stored" (stopReason=end_turn)
[probe] loadSession: OK
[probe] turn2: "kumquat-4242"
[probe] RESUME MEMORY: PASS — session restored across adapter restart
```

`cap-evidence/acp-runner-continuity-probe.ts` — the exact NTP call shape (no cwd,
no threadId) through `runAcpTaskTurn`, two turns:

```
[probe] turn1 ok=true resumed=false session=01a09763-... result="stored"
[probe] turn2 ok=true resumed=true  session=01a09763-... result="kumquat-7777"
[probe] HOST CWD DEFAULT: PASS — session created with no client cwd
[probe] SESSION CONTINUITY: PASS — turn 2 resumed the session
[probe] MEMORY ACROSS TURNS: PASS — recall verified
```

## Real-browser acceptance (`cap-evidence/acp-browser-acceptance.ts`)

The BUILT extension, headless Chrome, genuine CDP input, real bridge + real pi:

```
PASS  extension loaded (service worker registered)
PASS  hub composer rendered
PASS  @pi offers the pi harness agent in the mention popup
PASS  the composer committed a routing chip after selecting pi
PASS  a real pi turn produced agent text in the conversation
PASS  the run settled (no orphaned running status)
PASS  no console errors during the acceptance
7 passed, 0 failed
```

The bridge log from that run also answers an open question the reviewer could
not settle statically — the extension's WebSocket Origin is the extension scheme:

```
[acp-bridge] Client connected from chrome-extension://lhkccphpghedfohfpjgadebhkmmfanlf
```
