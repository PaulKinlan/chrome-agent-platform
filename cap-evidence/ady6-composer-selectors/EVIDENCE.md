# Evidence: chrome-agent-platform-ady6

## Problem
An unfinished composer selector migration left legacy `#task-input` / `#run-task` queries across scripts. Because documents carry multiple `<agent-composer>` elements, hard-coded IDs silently resolve to whichever composer appears first in DOM order. The migration requires replacing legacy IDs with canonical scoped helpers (`composerInput()` / `composerSend()` / `composerPopup()` from `scripts/lib/composer-target.ts`).

## Migrations Performed
1. **`scripts/component-gallery-smoke.ts`**:
   - Replaced all legacy `#task-input` / `.popup` DOM queries with `composerInput("hub")`, `composerPopup("hub")`, and `composerSend("hub")`.
   - Retired ID match count dropped from 3 to **0**.
   - Pruned `scripts/component-gallery-smoke.ts` from `INVENTORY` in `tests/composer-selector-migration.test.ts`.
2. **`scripts/chrome-journeys.ts`**:
   - Imported `composerInput`, `composerSend`, and `composerPopup` from `scripts/lib/composer-target.ts`.
   - Migrated 40 individual call sites across hub and thread journeys:
     - `sendTask` helper (lines 535-536) -> `composerInput("hub")`, `composerSend("hub")`
     - Tab navigation focus assertion (line 1539) -> removed `#task-input`
     - Folder command (line 2732) -> `composerInput("hub")`
     - Multi-slash command journeys (lines 2773, 2796, 2829, 2832, 2861, 2866, 2870, 2875) -> `composerInput("hub")`, `composerSend("hub")`
     - Undo journey agent creation (lines 3111-3112) -> `composerInput("hub")`, `composerSend("hub")`
     - Keyless command (lines 4262-4263) -> `composerInput("hub")`, `composerSend("hub")`
     - General task typing (lines 4701-4702) -> `composerInput("hub")`, `composerSend("hub")`
     - Thread view follow-ups (lines 5483-5484, 5573-5574, 6467-6470) -> `composerInput("thread")`, `composerSend("thread")`
     - Script run card preparation (lines 7747, 7751, 7752) -> `composerInput("hub")`, `composerSend("hub")`
     - Popup slash skill search (line 8003) -> `composerInput("hub")`
     - Playbook palette queries and clears (lines 8135, 8160, 8181, 8212-8213) -> `[data-composer-input]`, `composerInput("hub")`, `composerSend("hub")`
     - Exec demo steps (lines 8805-8806, 8877-8878, 8996-8997) -> `composerInput("hub")`, `composerSend("hub")`
   - Retired ID match count in `scripts/chrome-journeys.ts` dropped from 44 to **4** (only the 4 lines in `boxOf` compatibility mapper remain).
   - Updated `INVENTORY["scripts/chrome-journeys.ts"]` to 4 in `tests/composer-selector-migration.test.ts`.

## Verification
- `tests/composer-selector-migration.test.ts`: PASS (3/3 passed).
- `tests/agent-composer-unique-ids.test.ts`: PASS (2/2 passed).
- `tests/code-health.test.ts`: PASS (5/5 passed).
- `npm run check:vocabulary`: Clean (17 surfaces).
- `npm run note:dist`: Clean.
- `npm run build:production`: PASS (Store SW: 2,562,434 B <= 3.0 MB budget).
