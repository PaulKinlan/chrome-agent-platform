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

Mutant: `if (sessionId) {` → `if (false && sessionId) {` — the cached id is kept
but never LOADED, so turn 2 prompts a session id the fresh adapter process has
never been asked to restore. (Reviewer's correction: this is "no load", not
"a new session" — the frame log shows no `session/load` and a prompt carrying a
stale id.)

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

## M9 — host cwd default removed at the CALL SITE (`scripts/acp-bridge.ts`)

Mutant: `const data = applyHostDefaults(String(event.data));` → `const data = String(event.data);`
(the pure rule still passes its own unit test; only the wiring dies).

```
FAILED | 5 passed | 1 failed
```
Restored → `6 passed | 0 failed`. The continuity test asserts the `session/new`
frame the ADAPTER received carries `$HOME/journal`.

## M10 — ACP tool statuses no longer mapped to the card vocabulary (`extension/lib/acp-runner.js`)

Mutant: `return TOOL_STATUS_UI[key] ?? ...` → `return String(status ?? "running");`
(the raw `completed` reaches a card that only renders done/success/error).

```
FAILED | 5 passed | 1 failed
```
Restored → `6 passed | 0 failed`.

## M11 / M14 / M16 — the supersede claim (`extension/lib/acp-runner.js`)

Mutant: `prior.cancelled = true;` → `prior.cancelled = false;`

```
runAcpTaskTurn: two rapid sends for one conversation never prompt concurrently ... FAILED
FAILED | 5 passed | 1 failed
```
Restored → `6 passed | 0 failed`. This is the second drilling of this property:
the FIRST version of the test waited for turn 1's prompt and then started turn 2,
which killed the mutant only via the client close — the test was rewritten to
start both turns with no gap, which is the window `cancelled` exists for.

The observer is now the FRAME LOG, not just the result count: the two-send test
asserts exactly one `session/prompt` reached the harness, and the live-prior test
below asserts the successor prompted only AFTER the `session/cancel` (sequential
prompts are the design; overlapping ones are the race).

## M15 — a superseded turn renders the error its successor caused (`extension/lib/acp-runner.js`)

Mutant: the `if (claim.cancelled) return { ok: false, error: "Task was superseded" };`
guard removed from the catch (the pre-fix shape: `stale()` only, which the side
panel never supplies). The first version of the drill SURVIVED, because the
cancelled prompt settled politely; the test now runs with
`CAP_ACP_FIXTURE_IGNORE_CANCEL=1` so the successor's socket close is what rejects
the prompt, and asserts the superseded turn appended NO error bubble:

```
FAILED | 9 passed | 1 failed
```
Restored → `10 passed | 0 failed`.

## M17 — `--allow-origin` back to a prefix match (`scripts/acp-bridge.ts`)

Mutant: exact-origin equality → `origin.startsWith(p)`.

```
ACP bridge: --allow-origin admits the EXACT origin, never a confusable one ... FAILED
FAILED | 2 passed | 1 failed
```
Restored → `3 passed | 0 failed`. (The pin starts the CLI with
`--allow-origin https://trusted.example` and asserts `https://trusted.example`
→ 101 while `https://trusted.example.evil.test` → 403.)

## M14 — the claim installed AFTER `await prior.cancel(...)` (`extension/lib/acp-runner.js`)

Mutant: `activeTurns.set(sessionKey, claim)` moved back below the `await
prior.client.cancel(...)` block (the pre-fix order — the order a third
independent review caught as a real 3-send race).

The FIRST version of this test was NOT discriminating: with the prior turn still
connecting its `client` is null, the await is skipped, and the mutant survived
(`9 passed | 0 failed`). The test was rewritten to the real window — one turn
LIVE (its prompt held by the fixture) and TWO sends arriving together — and the
mutant then died:

```
runAcpTaskTurn: two sends arriving while a turn is LIVE leave exactly one winner ... FAILED
FAILED | 8 passed | 1 failed
```
Restored → `10 passed | 0 failed`. This is the second time in this audit that a
surviving mutant forced a test to be rewritten; the survivor is the evidence
that the first test was a formality.

## Live probes (durable evidence, real pi-acp 0.0.33)

`cap-evidence/acp-resume-probe.ts` — session/load after the adapter process was killed:

```
[probe] turn1: "stored" (stopReason=end_turn)
[probe] loadSession: OK
[probe] turn2: "kumquat-4242"
[probe] RESUME MEMORY: PASS — session restored across adapter restart
```

`cap-evidence/acp-runner-continuity-probe.ts` — the exact NTP call shape (no cwd,
no threadId) through `runAcpTaskTurn`, two turns (it reports only what it
observes: a session created with no client cwd; the cwd the ADAPTER received is
pinned by the fixture test, not by this probe):

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
