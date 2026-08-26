# Changelog

## [0.2.287] — 2026-08-26
- Real observability: npm run build now makes a debug build with source maps and verbose logging; npm run build:production makes the store bundle (unchanged). A namespaced, levelled, timed logger and performance marks now trace grants, every tool call, model round-trips, and task loading — with a trace you can dump. Security assertions identical in both modes

## [0.2.286] — 2026-08-26
- Power tools: attach Chrome DevTools Protocol debugging to tabs and send allowlisted commands (network conditions, CPU throttling, device emulation, navigation, screenshots, performance metrics) — Runtime.evaluate is never available; register user scripts and dynamic content scripts on specific sites

## [0.2.285] — 2026-08-25
- Network rules: manage the extension's dynamic request rules (block/allow/redirect/upgrade), inspect navigation frames, and observe recent page/request activity — rule changes are browser-wide and need the global grant

## [0.2.284] — 2026-08-25
- Browser settings control: privacy preferences (WebRTC, safe browsing, autofill, do-not-track and more), proxy configuration, fonts, keep-awake, default-engine search, and text-to-speech — every change needs the global browser-control grant

## [0.2.283] — 2026-08-25
- Extension manager tools: list your installed extensions with permission warnings, enable/disable or uninstall them (with confirmation, and the extension can never touch itself), plus platform/runtime info reads

## [0.2.282] — 2026-08-25
- Recently-closed tabs and windows can now be listed and restored, and browsing history can be searched, viewed by visit, added to, and deleted — restores and deletes are grant-gated, wipes need the global grant and explicit confirmation

## [0.2.281] — 2026-08-25
- New browser insight + saving tools: memory/CPU/storage/display status, top sites, a read-only view of the extension's granted permissions, your reading list (add/find/update/remove), and save-any-tab as an MHTML archive — capture is consent-gated, race-checked, and size-capped

## [0.2.280] — 2026-08-25
- Deep tab control: move, duplicate, pin, reload, back/forward, zoom, discard and highlight tabs; enable/disable the toolbar action; side-panel options — all grant-gated with the stricter any-origin-less-tab rule

## [0.2.279] — 2026-08-25
- New browser-control tools: tab groups (create/rename/recolor/collapse, move tabs between groups) and downloads (start, list, pause/resume/cancel, show in folder, open) — all gated behind the browser-control grant

## [0.2.278] — 2026-08-25
- New browser-control tools for site data: cookies (per-site, permission asked on demand), a scoped browsing-data wipe you choose the parts of, and per-site content settings (JavaScript/images/cookies/popups/notifications/location)

## [0.2.277] — 2026-08-25
- The agent list on the new-tab hub now shows a short two-line preview of each agent's role instead of the whole description; the full text is still there on hover.

## [0.2.276] — 2026-08-25
- chore(tasks): record bundled-inventory drift fix (0.2.275)

## [0.2.275] — 2026-08-25
- fix(build): version bumps now keep the bundled tool inventory in lockstep, so npm run build no longer fails after a release

## [0.2.274] — 2026-08-25
- fix(build): keep bundled inventory release in lockstep with version bumps

## [0.2.273] — 2026-08-25
- chore(tasks): record mic/view-transition landed (0.2.272)

## [0.2.272] — 2026-08-25
- fix(security+ui): restore cairn->cap-* rename (lost to worktree overwrite) + consolidate mic/view-transition; clean version 0.2.271

## [0.2.271] — 2026-08-25
- fix(security): rename all foreign 'cairn' identifiers to cap-* (bridge/auth consistent) + surface bounded DOMException name
- fix(ui): create-agent dialog mic replaces with cumulative transcript (no doubling) + navigation applies immediately (view transitions removed, focus routing preserved)

## [0.2.267] — 2026-08-25
- Site Agents are now discoverable: when you open a page that offers agent tools you get a clear "Add Site Agent" button, and the Site Agents list shows discovered-but-not-yet-added sites (no typing origins). Enrolled sites now reliably work after a browser restart instead of going silent.



## [0.2.266] — 2026-08-25
- The memory tree in Settings → Data & memory now stays open where you left it when you clear a store, instead of collapsing.

## [0.2.265] — 2026-08-25
- Fixed the Clear button in Settings → Data & memory: clearing a Site Agent's memory now visibly empties it straight away instead of leaving the old key count on screen, and tells you honestly if a clear fails.

## [0.2.264] — 2026-08-25
- Fixed Site Agent tool calls opening the website's home page instead of the specific page that registered the tool. The booking now opens the exact page (e.g. the Le Petit Bistro demo page) and runs its tool there; older site records heal automatically.


## [0.2.263] — 2026-08-25
- Agent roles now show as a short, readable one-line preview in the task list (hover to see the full text) — the full role is still saved without any length limit.



## [0.2.262] — 2026-08-25
- Internal: hardened thread-id validation, reclaimed storage when a task thread is deleted, and fixed the side-panel shortcut's permission check. No user-visible change.

## [0.2.261] — 2026-08-25
- Internal: updated the acceptance suite for the owner-direct approval policy. No user-visible change.

## [0.2.260] — 2026-08-25
- Fixed every task failing to run. Starting a task returned an internal error instead of a result; tasks work again.

## [0.2.259] — 2026-08-25
- Fixed two tests that were incorrectly failing, and added a safeguard so the test data stays fresh and won't silently expire in the future.



## [0.2.258] — 2026-08-25
- Added keyboard shortcuts: Alt+Shift+H opens the agent hub, Alt+Shift+K starts a new task with the composer ready, and Alt+Shift+S opens the side panel on the current tab. Settings → About lists them and links to Chrome's page for changing them.



## [0.2.257] — 2026-08-25
- Reworked how task and agent logs are stored and shown so nothing is lost or hidden: every tool call and every reply now shows correctly when you reopen a task, and a task can no longer get stuck showing "running" after an interruption.


## [0.2.256] — 2026-08-25
- fix(build): regenerate the bundled inventory after the version bump

## [0.2.255] — 2026-08-25
- Fixed the task tracker: a garbled entry was repaired, and a new format check keeps the tracker valid.

## [0.2.254] — 2026-08-25
- Fixed Site Agent tool calls (like the bistro booking) failing to connect — the site tab is now opened, focused, and confirmed ready before the tool runs, and any genuine connection problem is explained clearly instead of a bare "connection failed".



## [0.2.252] — 2026-08-25
- Site Agents can now tell apart different pages on the same website, so each page's own tools stay available and the right page is opened when a tool needs it.


## [0.2.251] — 2026-08-25
- Rewrote all 26 built-in tool descriptions in clear, complete language (what each does, when to use it, inputs/outputs, key flags, limits, and a worked example) so agents can pick and call the right tool.



## [0.2.250] — 2026-08-24
- Fixed Site Agent tool calls (like the bistro booking) failing with an unexplained "invalid arguments" error. The tool's full set of allowed values is now accepted, and any genuinely wrong argument is clearly explained so it can be corrected automatically.


## [0.2.249] — 2026-08-24
- Raised the agent limits significantly: descriptions up to 32,000 characters, plus higher caps for names, skills, and attached files. Over-limit input now shows a clear message instead of being silently cut off.

## [0.2.248] — 2026-08-24
- Fixed tasks that mention an agent with @ disappearing from your task list. The task now stays in your list and the agent's answer comes back into the same task.

## [0.2.247] — 2026-08-24
- Fixed deleting an agent leaving you stuck on a dead view. It now returns you to the main page.


## [0.2.246] — 2026-08-24
- Reconstructed and modernized the release changelog with clear, user-focused descriptions.

## [0.2.245] — 2026-08-24
- Older tasks now reopen with your messages and the final reply shown correctly.

## [0.2.244] — 2026-08-24
- Fixed a bug where Site Agent tool calls (like making a booking) always failed with an authorization error; they now run, and any block is clearly explained.

## [0.2.243] — 2026-08-24
- Added the ability to delete an agent from the hub, side panel, and Settings, with a confirmation preview of what will be removed.

## [0.2.242] — 2026-08-24
- Fixed scheduled background tasks so alarms don't get lost or fire repeatedly when missing task details, and added clear diagnostic logs.

## [0.2.241] — 2026-08-24
- Reopening a task thread now shows all your previous messages and assistant replies in order.

## [0.2.240] — 2026-08-24
- Tool call results now display as formatted, interactive JSON trees, while HTML outputs render directly in a live visual preview.

## [0.2.239] — 2026-08-24
- Enrolled Site Agents' declared tools are now ready to use without extra approval steps.

## [0.2.238] — 2026-08-24
- Site-agent tool calls now open or reuse the site's tab automatically instead of failing when the page wasn't already open.

## [0.2.237] — 2026-08-24
- Fixed a bug where a task's final answer and your earlier messages could disappear when you reopened the task.

## [0.2.236] — 2026-08-24
- Added support for local AI models, including on-device Gemma, Chrome Built-in AI (Prompt API), Ollama, and LM Studio.

## [0.2.235] — 2026-08-24
- Added a lightweight, on-demand Python execution environment with strict memory and time limits.

## [0.2.234] — 2026-08-24
- Tool cards in conversation threads are now collapsed by default to keep the chat clean and readable.

## [0.2.233] — 2026-08-24
- Cleaned up the Site Agents status card on the new tab page to clearly show discovered tools and connection health.

## [0.2.232] — 2026-08-24
- Fixed Site Agent tool execution to automatically plan and connect to the website tab when you run a task.

## [0.2.231] — 2026-08-24
- Fixed artifact preview iframe sizing and ensured generated HTML interfaces render smoothly in a secure frame.

## [0.2.230] — 2026-08-24
- Updated build integrity verification and development tracking standards.

## [0.2.229] — 2026-08-24
- Fixed task thread continuation so returning to a prior task preserves all previous messages, attachments, and tool runs.

## [0.2.228] — 2026-08-24
- Added built-in SQLite database query support with safe read-only limits.

## [0.2.227] — 2026-08-24
- Added low-level file and directory management primitives for advanced data tools.

## [0.2.226] — 2026-08-24
- Added safe scratch directory creation and removal for multi-file workspace tasks.

## [0.2.225] — 2026-08-24
- Added browser management tools for alarms, bookmarks, system notifications, idle detection, and context menus.

## [0.2.224] — 2026-08-24
- Completed local folder integration with live file change watching, safe file writing, and deep directory scanning.

## [0.2.223] — 2026-08-24
- Added persistent permission re-granting and a fast, non-blocking local file viewer.

## [0.2.222] — 2026-08-24
- Added file truncation and SQLite scratch database workspace profiles.

## [0.2.221] — 2026-08-24
- Added touch and file creation tools to the built-in tool library.

## [0.2.220] — 2026-08-24
- Added safe local directory listing and checksum-verified file reading.

## [0.2.219] — 2026-08-24
- Added folder and file picker dialogs in Settings for selecting persistent local project directories.

## [0.2.218] — 2026-08-24
- Added the Persistent Local Filesystem access manager in Settings.

## [0.2.217] — 2026-08-24
- Added a factory reset button in Settings to completely wipe local extension data with confirmation.

## [0.2.216] — 2026-08-24
- Added file resize, timestamp updating, and symlink-following capabilities to built-in tools.

## [0.2.215] — 2026-08-24
- Redesigned the Create Agent dialog with unclipped focus rings, collapsible skills, and an always-visible save bar.

## [0.2.214] — 2026-08-24
- Added click-to-edit task renaming directly on the task header and improved side-panel layout.

## [0.2.213] — 2026-08-24
- Polished the first-run onboarding guide and fixed example agent creation.

## [0.2.212] — 2026-08-24
- Fixed Settings permission toggle alignment, per-run token usage attribution, and deep-link section anchors.

## [0.2.211] — 2026-08-24
- Added scratch directory creation and removal for data tools.

## [0.2.210] — 2026-08-24
- Renamed built-in tools to use standard, intuitive Unix names and clear descriptions.

## [0.2.209] — 2026-08-24
- Improved packaging isolation for built-in task tools.

## [0.2.208] — 2026-08-23
- Added on-demand downloading and deletion for local models.

## [0.2.207] — 2026-08-23
- Fixed browser back/forward navigation history across all pages and views.

## [0.2.206] — 2026-08-23
- Enabled agents to automatically discover and execute built-in tools during tasks.

## [0.2.205] — 2026-08-23
- Added browser tools for inspecting windows, managing extension actions, and listing commands.

## [0.2.204] — 2026-08-23
- Restored the live task view on leave-and-return so conversation transcripts and statuses remain visible.

## [0.2.203] — 2026-08-23
- Added tool discovery enumeration for agents and back-button navigation for Settings.

## [0.2.202] — 2026-08-23
- Added Navigation API support for smoother back-button routing and expanded generated UI preview frames.

## [0.2.198] — 2026-08-23
- Packaged all built-in tools directly into the extension for fully offline, reliable operation.

## [0.2.197] — 2026-08-23
- Added first-run browser-control consent so you can explicitly choose whether agents may navigate tabs.

## [0.2.196] — 2026-08-23
- Fixed Settings links to navigate directly to background agent configuration.

## [0.2.195] — 2026-08-23
- Added live run transcript logs to the agent detail view.

## [0.2.194] — 2026-08-23
- Made artifact deletion a direct one-click owner action with confirmation.

## [0.2.193] — 2026-08-23
- Fixed agent avatars to generate immediately upon creation.

## [0.2.192] — 2026-08-23
- Replaced browser prompt popups with accessible in-page confirmation dialogs.

## [0.2.191] — 2026-08-23
- Verified built-in tool package security and build integrity.

## [0.2.190] — 2026-08-23
- Added expandable tool library details and package summaries to Settings.

## [0.2.189] — 2026-08-23
- Updated descriptions for all built-in tools to improve agent task selection.

## [0.2.188] — 2026-08-23
- Updated task and notification action routing tracking.

## [0.2.187] — 2026-08-23
- Enabled clicking system notifications to open the relevant task view directly.

## [0.2.186] — 2026-08-23
- Updated feature delivery tracking and task reviews.

## [0.2.185] — 2026-08-23
- Reconciled tracker tasks and priorities.

## [0.2.184] — 2026-08-23
- Added secure isolated scratch workspaces for file processing tools.

## [0.2.183] — 2026-08-23
- Added Gzip file compression and decompression support.

## [0.2.182] — 2026-08-23
- Added lossless output encoding for file processing tools.

## [0.2.181] — 2026-08-23
- Added directory tree visualization support for files.

## [0.2.180] — 2026-08-23
- Upgraded agents to on-demand tool discovery and execution.

## [0.2.179] — 2026-08-23
- Added disk usage inspection tools for files and folders.

## [0.2.178] — 2026-08-23
- Added directory scanning capabilities for built-in file tools.

## [0.2.177] — 2026-08-23
- Added file metadata and status inspection tools.

## [0.2.176] — 2026-08-23
- Added workspace path alias support for file execution jobs.

## [0.2.175] — 2026-08-23
- Added document comparison (diff) and patch tools.

## [0.2.174] — 2026-08-22
- Added fast, secure Markdown to HTML preview rendering.

## [0.2.173] — 2026-08-22
- Added support for Markdown document rendering.

## [0.2.172] — 2026-08-22
- Added text manipulation tools (sort, unique, translate, search, TOML converter).

## [0.2.171] — 2026-08-22
- Added cryptographic hashing and stream formatting tools.

## [0.2.170] — 2026-08-22
- Added CSV and text extraction tools to the tool library.

## [0.2.169] — 2026-08-22
- Added CSV data inspection to Settings tool preview.

## [0.2.168] — 2026-08-22
- Added JWT token inspection support.

## [0.2.167] — 2026-08-22
- Added SQLite query engine package to extension bundle.

## [0.2.166] — 2026-08-22
- Added tabular data diff viewing to task artifacts.

## [0.2.165] — 2026-08-22
- Added built-in tool library foundational packages.

## [0.2.164] — 2026-08-22
- Added code minification support to task workers.

## [0.2.163] — 2026-08-22
- Added package verification authority for built-in tools.

## [0.2.162] — 2026-08-22
- Reserved package types for built-in tool integration.

## [0.2.161] — 2026-08-22
- Hardened extension security policies for local tool compilation.

## [0.2.160] — 2026-08-22
- Improved extension package scanning accuracy for Chrome Web Store compliance.

## [0.2.159] — 2026-08-22
- Added isolated worker execution host for tool execution.

## [0.2.158] — 2026-08-22
- Configured package boundary checks for store distribution.

## [0.2.157] — 2026-08-22
- Ensured reproducible builds for extension packaging.

## [0.2.156] — 2026-08-22
- Added the Tool Library panel in Settings to browse available capabilities.

## [0.2.155] — 2026-08-22
- Defined sandboxed execution contracts for built-in tools.

## [0.2.154] — 2026-08-22
- Configured runtime import verification for tool sandboxes.

## [0.2.153] — 2026-08-22
- Standardized browser capability metadata across tools.

## [0.2.152] — 2026-08-22
- Added code difference tracking for task artifacts.

## [0.2.151] — 2026-08-22
- Added verification authority for bundled tool packages.

## [0.2.150] — 2026-08-22
- Added isolated file storage workspaces for agent tools.

## [0.2.149] — 2026-08-22
- Added on-demand tool search protocol for agent execution.

## [0.2.148] — 2026-08-22
- Automated security verification across extension test suites.

## [0.2.147] — 2026-08-22
- Updated extension archive generation freshness checks.

## [0.2.146] — 2026-08-22
- Established tool catalog contracts for agent tool search.

## [0.2.145] — 2026-08-22
- Cleaned up legacy test mocks and documentation redirects.

## [0.2.144] — 2026-08-22
- Improved service worker modularization for provider credentials.

## [0.2.143] — 2026-08-22
- Enforced TypeScript type safety checks in test suites.

## [0.2.142] — 2026-08-22
- Completed repository hygiene audits and safe path conventions.

## [0.2.141] — 2026-08-22
- Cleaned up internal provider listings in Settings.

## [0.2.140] — 2026-08-22
- Added replay safety checks for background tool actions.

## [0.2.139] — 2026-08-22
- Removed unreferenced mock files to keep the build clean.

## [0.2.138] — 2026-08-22
- Updated internal task tracking and status records.

## [0.2.137] — 2026-08-21
- Fixed layout and text overflow on narrow viewports for the new tab page.

## [0.2.136] — 2026-08-21
- Added @-mention auto-completion for delegating tasks to specific agents in chat.

## [0.2.135] — 2026-08-21
- Improved Site Agent status labels and connection messages.

## [0.2.134] — 2026-08-21
- Hardened console logging boundaries for safety.

## [0.2.133] — 2026-08-21
- Hardened alarm scheduling lifecycle and memory bounds.

## [0.2.132] — 2026-08-21
- Added guided first-run provider setup and storage onboarding in Settings.

## [0.2.131] — 2026-08-21
- Fixed conversation status indicators to show the assistant's reply before marking done.

## [0.2.130] — 2026-08-21
- Added local Gemma AI model catalog and compatibility checks.

## [0.2.129] — 2026-08-21
- Added a quick access drawer for viewing task artifacts.

## [0.2.128] — 2026-08-21
- Improved sandboxed artifact preview stability across reloads.

## [0.2.127] — 2026-08-21
- Reconciled conversation status tracking for active runs.

## [0.2.126] — 2026-08-21
- Updated token usage recording standards.

## [0.2.125] — 2026-08-21
- Improved crash safety for artifact storage operations.

## [0.2.124] — 2026-08-21
- Aligned Site Agent discovery status indicators on the new tab page.

## [0.2.123] — 2026-08-21
- Fixed live tool call streaming in conversation threads.

## [0.2.122] — 2026-08-21
- Scoped run stop and retry controls to the active conversation.

## [0.2.121] — 2026-08-21
- Removed file storage key limits to support larger workspaces.

## [0.2.120] — 2026-08-21
- Separated background task execution logs from main storage.

## [0.2.119] — 2026-08-21
- Fixed focus transitions between main and side views.

## [0.2.118] — 2026-08-21
- Preserved composer focus when sending follow-up messages in a thread.

## [0.2.117] — 2026-08-21
- Retained composer focus when switching between tasks and agent chats.

## [0.2.115] — 2026-08-21
- Smooth task view transitions and focus management on the new tab page.

## [0.2.114] — 2026-08-21
- Added the Agent Directory overlay for discovering available tools and agents.

## [0.2.113] — 2026-08-21
- Added durable background task execution that persists across browser reloads.

## [0.2.109] — 2026-08-21
- Published architectural review documentation.

## [0.2.108] — 2026-08-21
- Updated delivery lifecycle tracking.

## [0.2.107] — 2026-08-21
- Adopted the four-state delivery lifecycle.

## [0.2.106] — 2026-08-21
- Integrated independent architectural review findings.

## [0.2.105] — 2026-08-20
- Added semantic tool search to the project roadmap.

## [0.2.104] — 2026-08-19
- Added searchable provider and model picker in Settings with secure key storage.

## [0.2.103] — 2026-08-19
- Added permission preflight checks with clear "waiting for permission" banners.

## [0.2.102] — 2026-08-19
- Added the Usage tracking ledger in Settings to monitor token costs across providers.

## [0.2.101] — 2026-08-19
- Improved reliability for automated browser tests.

## [0.2.100] — 2026-08-19
- Protected task run status indicators during fast view switching.

## [0.2.99] — 2026-08-19
- Polished the conversation status banner and resolved progress indicator glitches.

## [0.2.98] — 2026-08-19
- Added owner approval dialogs for destructive agent actions.

## [0.2.97] — 2026-08-18
- Isolated test modules from production storage.

## [0.2.96] — 2026-08-18
- Aligned Tasks and Agents side-panel navigation with the new tab page.

## [0.2.95] — 2026-08-18
- Added collapsible, structured tool result cards in conversation threads.

## [0.2.94] — 2026-08-18
- Added the collapsible sidebar with keyboard navigation and RTL support.

## [0.2.92] — 2026-08-18
- Cleaned up build artifacts and versioned distribution pointers.

## [0.2.91] — 2026-08-18
- Ignored packaging archive outputs in version control.

## [0.2.89] — 2026-08-18
- Hardened extension build locking and packaging proof.

## [0.2.88] — 2026-08-18
- Untracked distribution symlinks for cleaner git status.

## [0.2.87] — 2026-08-18
- Added atomic distribution pointer swaps during extension builds.

## [0.2.86] — 2026-08-18
- Synchronized the bundled changelog with release versions.

## [0.2.85] — 2026-08-18
- Added build verification gates for changelog integrity and packaging.

## [0.2.84] — 2026-08-18
- Added automatic port retries for test harnesses.

## [0.2.83] — 2026-08-18
- Improved service worker lifecycle idempotency and token isolation.

## [0.2.82] — 2026-08-18
- Consolidated security review updates into release packages.

## [0.2.81] — 2026-08-18
- Added atomic build publishing and expiring permission leases.

## [0.2.80] — 2026-08-18
- Added flaky test detection and evidence recording to test suites.

## [0.2.79] — 2026-08-18
- Hardened secret masking across logs and diagnostics.

## [0.2.78] — 2026-08-18
- Integrated website tool discovery with unified agent access.

## [0.2.77] — 2026-08-18
- Restricted test harnesses to strictly required system permissions.

## [0.2.76] — 2026-08-18
- Added unified agent access with @-mentions and the /agent command.

## [0.2.75] — 2026-08-18
- Resolved independent review recommendations for system prompts.

## [0.2.74] — 2026-08-18
- Hardened system prompt composition and runtime policies.

## [0.2.73] — 2026-08-18
- Added the System Prompt Editor in Settings to customize agent instructions.
