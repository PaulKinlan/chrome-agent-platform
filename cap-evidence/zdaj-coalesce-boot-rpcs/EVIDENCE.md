# Evidence: chrome-agent-platform-zdaj

## Problem
During cold boot of `ntp.html`, 26 RPCs were dispatched against an authorized budget of 24. Four read-only routes were being queried twice:
- `artifacts.list` (2 calls)
- `agent.directory` (2 calls)
- `agent.tool-offers` (2 calls)
- `board.messages` (2 calls)

## Root Cause Analysis
1. `board.messages`: Two call sites queried with different limits (`ntp.js:2150` with `{ limit: 3 }` and `<jobs-board>` with `{ limit: 5 }`). Because cache keys include serialized arguments, they produced disjoint cache entries (`board.messages:{"limit":3}` vs `board.messages:{"limit":5}`), preventing single-flight coalescing.
2. `artifacts.list`: During cold boot stage 1, `renderTimeline` queried `artifacts.list`. At stage 2A, `subscribeRunRegistry` received the initial empty `run-snapshot` (`runs: []`), which scheduled a redundant `scheduleRunLogRefresh()` timer for 1500ms later, triggering a second query to `artifacts.list`.
3. `agent.directory` and `agent.tool-offers`: Queried at stage 2A (~157ms). When Chrome finished initial tab navigation on boot (~473ms), `open-tabs-changed` arrived. In `BROADCAST_INVALIDATIONS`, `open-tabs-changed` wiped `agent.directory` and `agent.tool-offers`. Immediately following, `dispatchProgressBatch` re-queried both routes, resulting in a duplicate ask.

## Fix
1. In `extension/ntp/ntp.js`:
   - Unified `send("board.messages", { limit: 5 })` to match `<jobs-board>`, enabling single-flight in-flight and cache deduplication.
   - In `stage2A.ambientProgress`, guarded `subscribeRunRegistry`: only call `scheduleRunLogRefresh()` if `snapshot?.runs?.length > 0`, avoiding redundant 1.5s refresh when cold-booting with an empty run list.
2. In `extension/shared/rpc-cache.js`:
   - Removed `agent.directory` and `agent.tool-offers` from `open-tabs-changed` in `BROADCAST_INVALIDATIONS`. `agent.directory` depends on enrolled origins (invalidated by agent registry/enrolment events), not open tabs. `agent.tool-offers` is invalidated when tools are detected (`site-tools-detected`) and naturally expires after its TTL.
3. In `tests/ntp-rpc-census.test.ts`:
   - Resolved Chrome for Testing binary dynamically via `resolveChromeForTesting()` from `scripts/lib/chrome-for-testing.ts`.
   - Measured cold boot total dropping from 26 to 22 RPCs, with all 22 routes queried exactly once.
   - Lowered the census assertion budget from `<= 24` to `<= 22`.

## Verification
- `tests/ntp-rpc-census.test.ts`: PASS (14s). Total boot RPCs: exactly 22.
- `tests/rpc-cache.test.ts`: PASS (9/9).
- `tests/hub-timeline-filters.test.ts`: PASS (22/22).
- `tests/conversation-run-sequence.test.ts`: PASS (14/14).
- `tests/code-health.test.ts`: PASS (5/5).
- `tests/sw-dispatch-authority-census.test.ts`: PASS (5/5).
- `npm run check:vocabulary`: Clean (17 surfaces).
- `npm run note:dist`: Clean.
- `npm run build:production`: PASS (Store SW: 2,562,434 B <= 3.0 MB budget).
