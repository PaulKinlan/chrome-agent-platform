# Hooks — the system-event surface

Agents (the master hub agent, or a background recipe like the **Sorting Hat**) can listen to a Chrome system event and be invoked when it fires. The full candidate surface is catalogued below, with the required (OPTIONAL) permission and a candidate use.

The reference implementation (the chaos extension) wires 11 of these (`action.onClicked`, `alarms.onAlarm`, `commands.onCommand`, `contextMenus.onClicked`, `runtime.onConnect/onInstalled/onMessage/onStartup`, `tabs.onCreated/onRemoved/onUpdated`). This project treats **every `chrome.*` `on*` event as a candidate hook** — anything that is an event in the extension API can be listened to + responded to.

## Permissions layer (authoritative)

A hook can only be subscribed if:
1. it is **not on the owner's deny-list** (checked FIRST — fail-closed), and
2. its required **optional permission is granted**.

The deny-list is owner-only (changed from Settings, a user gesture) and authoritative: an agent **cannot** break past it. A task that makes an agent listen to bookmarks can be constrained by denying the bookmarks hook; a hook the owner decides is too powerful is refused no matter what the agent asks. The agent-facing subscription path checks the deny-list first, and the event-dispatch path re-checks before invoking.

## The catalog

| Hook | Event | Required permission | Candidate use |
|---|---|---|---|
| `tabs.onCreated` | a tab opens | `tabs` | Sorting Hat groups the new tab; Auto-pin pins repeat domains; focus-mode closes tabs opened in a distraction session |
| `tabs.onUpdated` | a tab loads/updates | `tabs` | Summarise-on-navigate fires on load; page-sentiment-log records the URL |
| `tabs.onRemoved` | a tab closes | `tabs` | Stale-tab-closer confirms; reading-time captures an unfinished article |
| `tabs.onActivated` | a tab becomes active | `tabs` | Focus-mode tracks the foreground tab |
| `tabs.onAttached` | a tab moves to a window | `tabs` | Sorting Hat re-groups moved tabs |
| `tabs.onZoomChange` | a tab's zoom changes | `tabs` | An accessibility agent logs zoom usage |
| `windows.onCreated` | a window opens | `tabs` | Focus-mode opens a distraction-free window |
| `windows.onRemoved` | a window closes | `tabs` | A workspace agent tears down session state |
| `windows.onFocusChanged` | focus moves between windows | `tabs` | A presence agent pauses when the user switches away |
| `bookmarks.onCreated` | a bookmark is created | `bookmarks` | Auto-categorize files it; bookmark-dedupe flags duplicates |
| `bookmarks.onRemoved` | a bookmark is deleted | `bookmarks` | Dead-bookmark-cleaner updates its index |
| `bookmarks.onChanged` | a bookmark's title/URL changes | `bookmarks` | A link-rot agent re-checks the changed URL |
| `bookmarks.onMoved` | a bookmark moves folders | `bookmarks` | Auto-categorize re-derives the folder |
| `bookmarks.onChildrenReordered` | a folder is reordered | `bookmarks` | Respect the user's manual order |
| `history.onVisited` | a page is visited | `history` | Page-sentiment-log records the visit |
| `history.onVisitRemoved` | history is removed | `history` | A privacy agent confirms a clear actually happened |
| `downloads.onCreated` | a download starts | `downloads` | Download-organizer files it; nightly-summary collects it |
| `downloads.onChanged` | a download progresses/completes | `downloads` | A completion agent fires on `state=complete` |
| `downloads.onErased` | a download is erased | `downloads` | Download-organizer drops the index entry |
| `webNavigation.onCompleted` | a navigation finishes | `webNavigation` | Summarise-on-navigate runs on the main frame |
| `webNavigation.onBeforeNavigate` | a navigation starts | `webNavigation` | Focus-mode blocks a distraction domain |
| `webNavigation.onCommitted` | a navigation commits | `webNavigation` | A per-origin sub-agent prepares its tools |
| `contextMenus.onClicked` | a context-menu item is clicked | `contextMenus` | Save-quote / right-click-summarize / translate-selection |
| `commands.onCommand` | a keyboard command fires | (none) | A global hotkey invokes clipboard-phrase / omnibox-ask |
| `idle.onStateChanged` | the machine goes idle/locked | `idle` | Idle-close-tabs runs when the user is away |
| `alarms.onAlarm` | an alarm fires | `alarms` | The scheduled background agents (Sorting Hat, daily-summary) |
| `storage.onChanged` | a storage key changes | `storage` | A sync agent reacts to an external change |
| `notifications.onClicked` | a notification is clicked | `notifications` | Clicking a digest opens the full digest |
| `action.onClicked` | the extension action is clicked | (none) | The owner-invoked screenshot path |
| `runtime.onStartup` | the extension starts | (none) | `recoverOnBoot` reconciles the scheduler |
| `runtime.onInstalled` | installed/updated | (none) | First-run onboarding: seed memory + welcome |
| `runtime.onSuspend` | the service worker is suspending | (none) | Flush in-memory state |

## Subscription model

A subscription is **data** (never eval'd): `{ hookId, recipeId|null, promptTemplate, enabled }`, persisted under `cap:hooks`. When a hook fires, the registry resolves the subscription, builds a prompt (the template with the event payload serialized in place of `{{payload}}`, or the recipe's prompt with the payload appended), and invokes the agent via the same fenced `runTask` path as every other run.

Background recipes subscribe through this registry: an event-triggered recipe (e.g. the Sorting Hat on `tabs.onCreated`/`tabs.onUpdated`) is subscribed when the owner enables it and unsubscribed on disable.
