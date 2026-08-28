# Task Lifecycle Contract

The short, testable statement of how task creation, follow-ups, history, and
titles behave. Every behaviour here is pinned by
`tests/task-lifecycle-contract.test.ts` (real-browser KAT) — if a refactor
breaks one of these statements, that refactor is wrong.

## 1. Surfaces and composers

- The HUB surface owns the hub composer (`#composer`). A send there starts a
  NEW task — except when a task view is open (see §2).
- A TASK view (`#thread-view`) owns the thread composer (`#thread-composer`).
  A send there ALWAYS continues the open task's thread. It never creates a
  task.
- While a task view is open the hub composer is hidden. The thread composer is
  the only reply affordance, and it is visible whenever a task is open.

## 2. Continuation rule (the one the owner expects)

A reply must land in the conversation the user is looking at.

- Reply in an open task view → that task's thread continues (same thread id,
  no new task row). This holds even if the send races a settling run: the send
  is a turn of THAT thread.
- If a task view is open and a send arrives through ANY composer, it continues
  the open thread. No composer input may silently fork a visible conversation
  into a new task.
- A NEW task is started ONLY by an explicit new-task action: the `+` button,
  the `#compose` command, or a send on the hub surface with no task view open.

## 3. History

- The durable run log is the only authority for a task's history. The thread
  view projects it (`thread.get` → `projectThreadMessages`).
- Reopening a task from the list MUST render its full persisted conversation —
  user turns, assistant turns, and tool cards — with nothing dropped.
- A reload or SW restart may never lose or blank a thread's history: the
  openThread retry covers SW restart; the log index covers replay.

## 4. Titles

- The task view title is bound to the OPEN thread's name and must update on
  every task switch (list click AND back/forward traversal). A stale title on
  a switched task is a bug.

## 5. Navigation

- Task-list clicks and back/forward traversals are both first-class open
  paths. Back after opening task B returns to task A with A's title, history,
  and reply context intact (one press — the back-stack contract).
- Self-initiated pushes (openThread/openView pushState) do not re-dispatch;
  traversals do. Programmatic hash writes follow the same rule as pushes.

## 6. Agents and tasks are different surfaces

- A named/background agent's conversation is the AGENT surface; sends there
  continue the agent's journal, not a hub task.
- An @mention inside a task delegates work to the agent but the TASK stays the
  hub's thread; the result returns into the task.
