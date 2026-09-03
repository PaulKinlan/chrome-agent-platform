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
exactly those tabs at run end.

## What each lifecycle tool leaves behind

| Tool | Opens / leaves | Release path | Auto-closeable? |
|---|---|---|---|
| `open_tab` | a NEW tab (reports `tabId`) | `close_tab` (Act — the run opened it) | yes — by its `tabId` |
| `duplicate_tab` | a NEW copy tab (reports `newTabId`) | `close_tab` (Act — the copy is a new tab the run created) | yes — by `newTabId` |
| `create_window` | a NEW window (reports `windowId`) | `close_window` (always owner-approved — it closes every tab in the window) | never — closing a window is Destructive by policy |
| `restore_closed` | re-opens a recently closed tab/window (reports no ids — the sessions API does not return them) | `close_tab` / `close_window` when it was scratch | never — no ids are reported |

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
  closed itself — and the summary note reports which ids were auto-closed.
  Windows and restored sessions are never auto-closed.
  ponytail ceiling: the issue's "except ones the agent flagged as keepers"
  needs a flag channel that does not exist yet; with the setting on, the model
  should close nothing it must keep — tell the user in the summary, and the
  owner re-opens from there (or keeps the setting off).

## Falsification

- Every name in `LIFECYCLE_OPEN_TOOLS` has a shipped `browserToolset()`
  description carrying `Cleanup:`, `close`, and `deliberate choice`
  (tests/lifecycle-cleanup.test.ts walks the list).
- The run-end summary lists the ids the run opened (`runEndCleanupNote`).
- `autoCloseTabPlan` returns exactly the run's still-open opened tabs —
  nothing foreign can enter the plan, nothing the run closed itself is
  re-closed.
