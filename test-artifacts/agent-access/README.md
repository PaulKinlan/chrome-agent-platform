# Evidence — CAP-FB-20260818-AGENT-ACCESS-01 (unified agent access)

Captured 2026-08-18 from the REAL built MV3 extension in headless Chrome (CDP),
by `scripts/agent-access-journeys.ts` (after) and the pre-change capture (before).

## before/ (HEAD bdbe1f3 — the audit)
- `before-01-hub-agents.png` — the hub's separate one-off agent lists (sidebar + main).
- `before-02-plus-menu.png` — the + menu: attachments/browser-context only, no agent action.
- `before-03-slash-agent-popup.png` — the flat, ungrouped `/agent:` popup (no avatar/status/grouping).
- `before-04-mention-popup.png` — the @ mention popup (unchanged by this work).
- `before-05-sidepanel.png` — the side panel: page orchestration only, no Agents view.

## after/ (this change — 65/65 journey checks green)
- `after-01-plus-agent-picker.png` — the + menu's Choose agent: the shared `<agent-picker>` in a top-layer popover, grouped Named/Background/Site with avatars/roles/status.
- `after-02-agent-chip.png` — the removable agent chip after choosing.
- `after-03-routed-run.png` — the run routed by canonical ID into the agent's own surface/journal.
- `after-04-slash-agent.png` — `/agent:pr` opens the same grouped data UI in the composer.
- `after-05-sidepanel-agents.png` — the side panel's Agents view (all groups, disabled marked).
- `after-06-sidepanel-agent-detail.png` — the selected agent's conversation/history + composer.
- `after-07-sidepanel-run.png` — a task directed from the side panel, run in the agent's journal.
- `after-08-sidepanel-live.png` — live create/rename/delete updates (no reload).
- `after-09-sidepanel-narrow-zoom.png` — 380px + 200% zoom, no horizontal overflow.
