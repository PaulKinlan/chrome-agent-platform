# Lifecycle cleanup: tabs, windows, and the tidy contract (chrome-agent-platform-4ffg)

Agents open tabs and windows to do work and used to never close them; the tab
count grew across tasks and the owner closed them by hand. This doc is the
AUDIT half of the fix. The machine-readable tables (what opens what, what the
descriptions must say, the per-run tracker) live in
`extension/lib/lifecycle-cleanup.js` and are what the falsification tests walk;
this page lists each lifecycle-bearing tool with exactly what it leaves behind
and the cleanup rule.

## The tidy contract

A tool description that opens persistent browser surface says so and carries
three obligations for the model:

1. **State what it opens.** The tool is never silent about creating a tab,
   window, or restored session.
2. **Close what the task no longer needs.** When the work that motivated the
   open is done, release it with `close_tab` (a tab the same run opened is
   Act — no approval card) or `close_window` (always owner-approved).
3. **Leaving something open is a deliberate choice told to the user.** The
   agent says which tab/window it kept and why ("I left the docs tab open for
   you").

The run-end summary is the enforcement point: when a task finishes, the
runtime appends a note to the final summary naming the tabs/windows that run
opened and left open — so cleanup is one obvious step — and the default-off
**Auto-close run tabs** owner setting (Settings → Browser control) removes
exactly those tabs at run end, leaving the tabs the run opened with
`keep:true` (its deliberate results, e.g. "open this article for me") open.

## What each lifecycle tool leaves behind

| Tool | Opens / leaves | Release path | Auto-closeable? |
|---|---|---|---|
| `open_tab` | a NEW tab (reports `tabId`) | `close_tab` (Act — the run opened it) | yes — by its `tabId`; pass `keep:true` to flag the tab as the task's result so auto-close leaves it |
| `duplicate_tab` | a NEW copy tab (reports `newTabId`; the echoed source `tabId` is never the run's surface) | `close_tab` (Act — the copy is a new tab the run created) | yes — by `newTabId` only; pass `keep:true` to protect the copy |
| `create_window` | a NEW window (reports `windowId`) | `close_window` (always owner-approved — it closes every tab in the window) | never — closing a window is Destructive by policy |
| `restore_closed` | re-opens a recently closed tab/window (reports the restored ids: `restoredTabId` / `restoredWindowId` + `restoredWindowTabIds`) | `close_tab` / `close_window` when it was scratch | never — re-opening is the deliberate act |

### Lifecycle-adjacent tools (no new surface; listed for the audit)

| Tool | What it changes | Cleanup note |
|---|---|---|
| `navigate_tab` | navigates an existing tab (does not create one) | nothing left behind beyond the tab itself; if the tab was this run's scratch, close it |
| `close_tab` / `close_window` | release tools — the tracker removes released ids from the run's still-open set | closing a foreign tab/window stays Destructive (approval card) |
| `focus_window`, `move_tab`, `highlight_tabs`, `set_tab_pinned`, tab groups | rearrange existing surface | none |
| `capture_screenshot`, `read_page`, `save_page_as_mhtml`, `download_file`, `open_download` | capture/download flows | write files/download entries, never open a tab for the model to close; downloads stay in the Downloads manager |

## Runtime behavior

- **Per-run tracker.** The service worker feeds every tool-result of a run
  (the same stream the durable run log persists) into
  `createLifecycleTracker()`: opens are recorded, releases (`close_tab` /
  `close_window` of the run's own ids) remove them, and failed calls never
  count. Trackers are per-run — one run's opens can never leak into the next.
- **Run-end summary.** On a terminal SUCCESS settle, when the run opened
  something it did not close itself, the runtime appends a short note to the
  final summary text: the tab/window ids, how many are still open, and the
  close/keep reminder. A tidy run (nothing opened, or everything already
  closed by the run) gets no note.
- **Auto-close run tabs (owner setting, DEFAULT OFF).** When on, at the same
  terminal settle the service worker removes exactly the tabs in
  `autoCloseTabPlan` — the run's opened tabs minus the ones the run already
  closed itself minus the ones the run flagged as keepers — and the summary
  note reports which ids were auto-closed and which were kept. A tab opened
  with `keep:true` (the task's result, e.g. "open this article for me") is
  never auto-closed. Windows and restored sessions are never auto-closed.
  The keeper signal is run-scoped: it rides the opening tool's own result
  (`open_tab` / `duplicate_tab` echo `keep:true`), so it can never protect a
  tab a different run opened.

## Falsification

- Every name in `LIFECYCLE_OPEN_TOOLS` has a shipped `browserToolset()`
  description carrying `Cleanup:`, `close`, and `deliberate choice`
  (tests/lifecycle-cleanup.test.ts walks the list).
- The run-end summary lists the ids the run opened (`runEndCleanupNote`),
  names restored tab/window ids instead of a bare count, and marks kept tabs.
- `autoCloseTabPlan` returns exactly the run's still-open opened tabs that
  were not flagged as keepers — nothing foreign can enter the plan, nothing
  the run closed itself is re-closed, and a `keep:true` result tab survives.
