# chrome-agent-platform-o1y1 — Site Agents Panel Copy De-duplication

**Bead:** `chrome-agent-platform-o1y1`  
**Candidate branch:** `cap/gemini-o1y1-site-agents-copy` @ worktree `/home/paulkinlan/worktrees/cap-gemini-o1y1`  
**Base:** `origin/main` @ `04d58a7e`  
**Author:** `cap-gemini` (Gemini 3.8 Flash)  
**Date:** 2026-10-03  

---

## 1. Summary & Problem Statement

In a rendered Site Agents panel (e.g. when scripting permission is granted or agents are seeded), the user previously saw three simultaneous instructions stating the same thing in three different voices:
1. `"Find site tools"` (panel subhead link `#discover-page`)
2. `"No Site Agents yet. Find tools from an open tab to add one."` (`#site-agents .empty`)
3. `"Open a site and I'll look for tools you can use."` (`#webmcp-hub-status`)

In `scripts/sidebar-parity.ts`, this caused the assertion `"the Site tools panel states its one instruction once (no three-voice duplication)"` to fail because all three lines carried imperatives (`find`, `discover`, `open a site`).

---

## 2. Changes Applied

Per the recommended default:
1. **Single Imperative in Subhead:** Kept the panel subhead action `"Find site tools"` (`SITE_AGENT_COPY.findToolsAction`) as the only imperative.
2. **Shortened Empty Div:** Shortened the empty div to `"No Site Agents yet."` single-sourced as `SITE_AGENT_COPY.siteAgentsEmpty` in `extension/shared/site-agent-copy.js`.
3. **Suppressed Hub Status Sentence:** When the empty div is showing in `#site-agents`, `#webmcp-hub-status` suppresses the fallback sentence `"Open a site and I'll look for tools you can use."` (rendering empty text unless an active status card with tools/scripts is present).
4. **Vocabulary & Test Coverage:** Updated `tests/site-agent-copy.test.ts` to assert that `siteAgentsEmpty` is defined, user-facing, and consumed at runtime by `extension/ntp/ntp.js`.

---

## 3. Verification

- **Harness Verification (`scripts/sidebar-parity.ts`):**
  - Evaluated against CDP probe measuring rendered client rects.
  - Output verified:
    `PASS: the Site tools panel states its one instruction once (no three-voice duplication)`
    (`siteCopy: ["Find site tools", "No Site Agents yet."]`, `imperativeLines: ["Find site tools"]`).
- **Unit & Vocabulary Tests:**
  - `tests/site-agent-copy.test.ts`: **15 passed / 0 failed** in 43ms.
  - `tests/site-agent-chip.test.ts` & `tests/site-agent-delegation-attachments.test.ts`: **12 passed / 0 failed**.
  - `tests/test-partition-guard.test.ts`: **10 passed / 0 failed**.
  - `npm run check:vocabulary`: Clean (17 surfaces).
  - `npm run build:production`: Built atomically with dist.complete marker.
  - `npm run note:dist`: Clean.
