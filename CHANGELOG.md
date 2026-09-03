# Changelog

## [0.3.15] — 2026-09-03
- targeted test gates — a dependency-aware picker runs only the tests your change exercises, and fails closed to the full suite when coverage can't be proven

## [0.3.14] — 2026-09-03
- skill promotion — agents with no skills attached get a bounded, fenced pointer at relevant catalog skills, with a falsification-proven eval suite

## [0.3.13] — 2026-09-03
- the model picker gains Gemini 3.8 Flash and Fable 5.1, with every price audited against published sources

## [0.3.12] — 2026-09-03
- embedded Settings Test connection fixed at the root — embedded views boot at their canonical URL (owner-options binds again), and a surface refusal never blames the API key

## [0.3.11] — 2026-09-02
- embedded Settings Test connection fixed at the root — embedded views boot at their canonical URL (owner-options binds again), and a surface refusal never blames the API key

## [0.3.10] — 2026-09-02
- embedded Settings Test connection fixed at the root — embedded views boot at their canonical URL (owner-options binds again), and a surface refusal never blames the API key

## [0.3.9] — 2026-09-02

## [0.3.8] — 2026-09-02
- Embedded views keep their owner identity: the boot strips ?embedded=1 after marking the document, so exact-document authorization matches the real Settings surface again

## [0.3.7] — 2026-09-02
- CSP lint: require whitespace before src so data-src cannot smuggle an inline script

## [0.3.6] — 2026-09-02
- No shipped page runs an inline script: the embedded boot moves to a shared external file and a lint pins CSP hygiene

## [0.3.5] — 2026-09-02
- Task board: the privacy page and the reset repair are complete.

## [0.3.4] — 2026-09-02
- A new Privacy page says exactly what the extension sends and stores, and Reset everything now really does clear everything.

## [0.3.3] — 2026-09-02
- Task board: the running-cost work is complete.

## [0.3.2] — 2026-09-02
- Tasks now cost less to run: the instructions sent with every message are a quarter of their old size, and a task that stops making progress is stopped instead of looping.

## [0.3.1] — 2026-09-02
- deduplicate changelog entries and bump version after merge conflict resolution

## [0.3.0] — 2026-09-02
- Reachability gate fix: skip generated *.bundle.js artifacts

## [0.2.653] — 2026-09-02
- Task board: the delegation checks are complete.

## [0.2.652] — 2026-09-02
- The delegation checks now test the real budget guard, and the test runner notices when a known failure has quietly started passing.

## [0.2.651] — 2026-09-02
- Task board: a test count was filled in.

## [0.2.650] — 2026-09-02
- Task board: the hub chrome polish is complete; one counting defect was written up.

## [0.2.649] — 2026-09-02
- A calmer hub: Settings now sits beside Directory and Artifacts instead of looking selected, and whichever one you open is marked as the page you are on. An agent opened from a link shows its name rather than its address. The header lost its permanent status dot and its two developer icons — the status appears only while something is happening, the security shield only when it has something to show, and the console moved into Settings under Advanced. A tool in the Directory can no longer squeeze down to one letter per line.
- Reachability gate skips generated *.bundle.js artifacts: a stale pre-dist-era bundle under extension/ (gitignored, never a source) no longer fails the build

## [0.2.648] — 2026-09-02
- Task board: the test-suite honesty work is complete; one regression was opened and four more items are being worked on.

## [0.2.647] — 2026-09-02
- The test suite now tells the truth: security checks run against the real extension, browser checks no longer collide, and every known failure is named.

## [0.2.646] — 2026-09-02
- Task board: the compact Permissions and Hooks settings are complete.

## [0.2.645] — 2026-09-02
- Settings → Permissions and Hooks are now compact grouped lists with a switch per item instead of hundreds of identical cards.

## [0.2.644] — 2026-09-02
- Task board: the finished-on-the-last-step fix is complete.

## [0.2.643] — 2026-09-02
- A task that finishes its answer on its final step is now shown as finished instead of asking you to continue.

## [0.2.642] — 2026-09-02
- Task board: the artifact quick fixes are complete.

## [0.2.641] — 2026-09-02
- A guard now ensures the artifact New tab button opens exactly one tab.

## [0.2.640] — 2026-09-02
- Task board: the single-permission-card fix is complete; two product questions were written up for a decision.

## [0.2.639] — 2026-09-02
- When the agent needs several permissions for one action, you now see a single card in plain words and one Chrome prompt.

## [0.2.638] — 2026-09-02
- Task board: the long-task memory fix is complete; three more items are being worked on.

## [0.2.637] — 2026-09-02
- Long multi-step tasks no longer forget their earliest results: the final answer covers every item it read.

## [0.2.636] — 2026-09-02
- Task board: the multi-site permission fix is complete; two small follow-ups were opened.

## [0.2.635] — 2026-09-02
- Allowing the agent on a second site no longer forgets the first; Settings lists every allowed site and each can be turned off on its own.

## [0.2.634] — 2026-09-02
- Task board: the plain-language copy pass is complete.

## [0.2.633] — 2026-09-02
- Messages, toggles and delete confirmations now use plain language throughout.

## [0.2.632] — 2026-09-02
- Task board: the unused-code cleanup is complete.

## [0.2.631] — 2026-09-02
- The extension's build now checks that every shipped file is actually used, and two unused modules are gone.

## [0.2.630] — 2026-09-02
- Task board: finished items moved to the archive so the open list is easier to read.

## [0.2.629] — 2026-09-02
- Task board: one more item is being worked on.

## [0.2.628] — 2026-09-02
- Task board: the every-item run fix is complete; four more items are being worked on.

## [0.2.627] — 2026-09-02
- Long tasks now go through every item: the agent reuses its tool selections, shows Step N of M while working, and offers Continue when it runs out of steps.

## [0.2.626] — 2026-09-02
- Task board: the reopen-a-conversation fix is complete.

## [0.2.625] — 2026-09-02
- Reopening a conversation now shows everything from its last 50 runs — every tool card, approval and full answer — and says plainly if older details were folded.

## [0.2.624] — 2026-09-02
- Task board: the background-polling fix is complete.

## [0.2.623] — 2026-09-02
- Open tabs no longer poll in the background; the extension's worker can go idle and badges still update the moment something happens.

## [0.2.622] — 2026-09-02
- Task board: the generated-document preview checks are complete.

## [0.2.621] — 2026-09-02
- The generated-document preview is now checked for its language and for script errors on every run.

## [0.2.620] — 2026-09-02
- Task board: two new defects — allowing a second site forgets the first, and long read loops forget their earliest pages.

## [0.2.619] — 2026-09-02
- After you click Allow, the paused action now runs by itself — no retry, no protocol words in the conversation.

## [0.2.618] — 2026-09-02
- Task board: three more items are being worked on.

## [0.2.617] — 2026-09-02
- Task board: the site-tools demo is complete.

## [0.2.616] — 2026-09-01
- When an open page offers tools, a chip next to the composer now lets you use them in one click; a demo shop is included to try it.

## [0.2.615] — 2026-09-01
- Task board: the full JSON tool-result view is complete.

## [0.2.614] — 2026-09-01
- Tool results now show the complete formatted JSON with a Copy button, errors are shown plainly, and nothing is lost when you reload.

## [0.2.613] — 2026-09-01
- Task board: the page-access Allow card fix is complete.

## [0.2.612] — 2026-09-01
- The generated gallery bundle is ignored by git again.

## [0.2.611] — 2026-09-01
- Reading a page on a site the extension cannot access now asks you with one clear Allow card instead of failing silently.

## [0.2.610] — 2026-09-01
- Task board: three defects found while rehearsing the demo are now tracked — a tool that stalls after you click Allow, too many permission prompts in one step, and when a site tool should ask first.

## [0.2.609] — 2026-09-01
- Every screen now escapes untrusted text the same strict way, so a name like O'Brien can never break the page.

## [0.2.608] — 2026-09-01
- Editing files in a shared folder is now a fully supported agent action.

## [0.2.607] — 2026-09-01
- The agent can now edit a file in a folder you shared: you see the exact diff and approve it before anything is written.

## [0.2.606] — 2026-09-01
- Release notes describe the provider base-URL fix in plain language

## [0.2.605] — 2026-09-01
- Providers without a base URL now use their built-in endpoint.

## [0.2.604] — 2026-09-01
- A provider saved without a base URL now runs on its built-in endpoint, and a custom endpoint with no URL is refused up front with a clear reason.

## [0.2.603] — 2026-09-01
- Task board: four defects seen in a real research run are now tracked — truncated tool results, runs stopping early, page reads failing without an Allow card, and transcript loss on reload.

## [0.2.602] — 2026-09-01
- Task view full work — the agent's full response is stored, shown, and copyable

## [0.2.601] — 2026-09-01
- Housekeeping release: the task board now reflects what has actually shipped, and stale in-progress markers were cleared.

## [0.2.600] — 2026-09-01
- check screenshots no longer cascade: a capture on a stale or backgrounded tab fails the evidence quietly instead of hanging the suite

## [0.2.599] — 2026-09-01
- Dialog work — searchable grouped customizable select for agent templates; computed-style contrast gates in both schemes; headless base-select paint limitation documented

## [0.2.598] — 2026-09-01
- : each agent can inherit, disable, and add its own MCP servers

## [0.2.597] — 2026-09-01
- Dialog work — searchable grouped customizable select for agent templates with both-scheme contrast gates

## [0.2.596] — 2026-09-01
- You can now add and test remote MCP servers in Settings, and destructive browser actions always ask before they run

## [0.2.595] — 2026-09-01
- : merge — the agent connects and calls MCP server tools on a run

## [0.2.594] — 2026-09-01
- DONE (2906/0, 294/294); fix provider check block for the radiogroup redesign

## [0.2.593] — 2026-09-01
- : merge — Settings leads with a recommended provider and a four-click key setup

## [0.2.592] — 2026-09-01
- The next two steps of external tool-server support are underway.

## [0.2.591] — 2026-09-01
- MCP-CONFIG-STORE-01, MODEL-TOOL-ADHERENCE-01 DONE (2900/0, 294/294)

## [0.2.590] — 2026-09-01
- : merge — the assistant is told to use the real tools, not simulate them

## [0.2.589] — 2026-09-01
- : merge — the config model for global and per-agent MCP servers

## [0.2.588] — 2026-09-01
- user-language release notes (fix banned words in recent entries)

## [0.2.587] — 2026-09-01
- A recent improvement is now available.

## [0.2.586] — 2026-09-01
- The remaining steps for external tool-server support are written up.

## [0.2.585] — 2026-09-01
- Task records were completed to the required shape.

## [0.2.584] — 2026-09-01
- Task view full work — the agent's full response is stored, shown, and copyable; bounds are byte-true, escape-aware, surrogate-safe, and honest

## [0.2.583] — 2026-09-01
- Task view full work — the agent's full response is stored, shown, and copyable; bounds are byte-true, escape-aware, surrogate-safe, and honest

## [0.2.582] — 2026-09-01
- Task view full work — the agent's full response is stored, shown, and copyable; bounds are byte-true, escape-aware, surrogate-safe, and honest

## [0.2.581] — 2026-09-01
- Skill list work — /skill and Settings read one catalog; collision-proof refIds; broken skills hidden and reported

## [0.2.580] — 2026-08-31
- Release notes entries are in plain language, and the version bump keeps them that way

## [0.2.579] — 2026-08-31
- Typing a second /command after the first now works; the release notes gained two entries for it.)

## [0.2.578] — 2026-08-31
- Typing a second /command after the first now works; the release notes gained two entries for it.)

## [0.2.577] — 2026-08-31
- Skill list work — /skill and Settings read one catalog; collision-proof refIds; broken skills hidden and reported

## [0.2.576] — 2026-08-31
- Skill list work — /skill and Settings read one catalog; collision-proof refIds; broken skills hidden and reported

## [0.2.575] — 2026-08-31
- Focus order work — 24px hit areas, a real label-for gate, shadow-DOM aware audit checks, and the attach button's ring restored

## [0.2.574] — 2026-08-31
- Untrack the generated diff-core bundle left tracked by the merge

## [0.2.573] — 2026-08-31
- Multi-slash work — sequential /commands work: a slash after a resolved reference reopens the picker, prose never does

## [0.2.572] — 2026-08-31
- user-language release notes

## [0.2.571] — 2026-08-31
- A recent improvement is now available.

## [0.2.570] — 2026-08-31
- The agent can now read, search and list files in a folder you share, with clear errors.

## [0.2.569] — 2026-08-31
- Release notes wording corrected.

## [0.2.568] — 2026-08-31
- A recent improvement is now available.

## [0.2.567] — 2026-08-31
- Groundwork for connecting the agent to external tool servers is in place.

## [0.2.566] — 2026-08-31
- Work has begun on folder tools and external tool-server support.

## [0.2.565] — 2026-08-31
- A recent improvement is now available.

## [0.2.564] — 2026-08-31
- Release notes wording corrected.

## [0.2.563] — 2026-08-31
- A recent improvement is now available.

## [0.2.562] — 2026-08-31
- Scheduled tasks now show when they will next run, and repeating tasks are called routines.

## [0.2.561] — 2026-08-31
- A recent improvement is now available.

## [0.2.560] — 2026-08-31
- A recent improvement is now available.

## [0.2.559] — 2026-08-31
- A plan for connecting the agent to external tool servers is written up.

## [0.2.558] — 2026-08-31
- A recent improvement is now available.

## [0.2.557] — 2026-08-31
- A generated file that used to change after every build is no longer kept in source control.

## [0.2.556] — 2026-08-31
- Work has begun on the enterprise-permission and scheduling improvements.

## [0.2.555] — 2026-08-31
- A recent improvement is now available.

## [0.2.554] — 2026-08-31
- : merge — a Show developer features toggle hides the advanced surfaces by default

## [0.2.553] — 2026-08-31
- : merge — the library never silently drops your oldest artifact

## [0.2.552] — 2026-08-31
- DONE (coordinator gates 2813/0, 272/272)

## [0.2.551] — 2026-08-31
- The shared jobs board is now always visible on the new tab, with a clear empty state and the state of every job.

## [0.2.550] — 2026-08-31
- Five more pieces of owner feedback were written up as tasks.

## [0.2.549] — 2026-08-31
- DONE (coordinator gates 2808/0, 272/272)

## [0.2.548] — 2026-08-31
- The agent now knows about the shared jobs board and will post and pick up work there.

## [0.2.547] — 2026-08-31
- The jobs-board fixes and more polish have begun.

## [0.2.546] — 2026-08-31
- Two jobs-board gaps were written up: it is hard to find, and the agent is not told to use it.

## [0.2.545] — 2026-08-31
- Housekeeping: parallel work streams reconciled.

## [0.2.544] — 2026-08-31
- DONE (coordinator gates 2807/0, 272/272); repair FOLDER-COMMAND-01 schema

## [0.2.543] — 2026-08-31
- : merge — a scheduled agent leaves a report, a timeline row and a notification

## [0.2.542] — 2026-08-31
- Housekeeping: a completed item was recorded correctly.

## [0.2.541] — 2026-08-31
- /folder work — attach a granted local folder as a task reference, complementing /files

## [0.2.540] — 2026-08-31
- Changelog entries for the permissions and model fixes are in plain language, and the version bump keeps jargon out

## [0.2.539] — 2026-08-31
- Typing a model id now always saves it, and a missing model stops the run with a clear message instead of silently using the demo model.

## [0.2.538] — 2026-08-31
- Typing a model id now always saves it, and a missing model stops the run with a clear message instead of silently using the demo model.

## [0.2.537] — 2026-08-31
- The side panel is now a companion for the current tab, and the hub timeline shows a runs-today count.

## [0.2.536] — 2026-08-31
- The companion side panel is now available.

## [0.2.535] — 2026-08-31
- : merge — the side panel is a companion pinned to the current tab

## [0.2.534] — 2026-08-31
- Fix refreshHubActivity to use the current timeline surface after the hub-timeline rename

## [0.2.533] — 2026-08-31
- Fix a duplicated refresh timer line left by the recent-activity merge

## [0.2.532] — 2026-08-31
- The hub activity feed now shows only what a person cares about, in plain bounded sentences, with fresh counts

## [0.2.531] — 2026-08-31
- The companion side panel work has begun.

## [0.2.530] — 2026-08-31
- DONE — Q19 delivered (coordinator gates 2772/0, 255/255, page-actions 14/14)

## [0.2.529] — 2026-08-31
- : merge — the agent can act inside a page (find, click, type, select, scroll) under a grant

## [0.2.528] — 2026-08-31
- DONE (coordinator gates 2758/0, 255/255)

## [0.2.527] — 2026-08-31
- The new tab now shows a single timeline of your recent tasks below the composer.

## [0.2.526] — 2026-08-31
- Page interaction and timeline improvements have begun.

## [0.2.525] — 2026-08-31
- DONE (coordinator gates 2751/0, 255/255)

## [0.2.524] — 2026-08-31
- : merge — a what-I-did activity log with Undo

## [0.2.523] — 2026-08-31
- DONE (coordinator gates 2740/0, 249/249)

## [0.2.522] — 2026-08-31
- : merge — a running task shows its steps as a live checklist

## [0.2.521] — 2026-08-31
- DONE (coordinator gates 2734/0, 247/247)

## [0.2.520] — 2026-08-31
- : merge — the host-access story is now told truthfully everywhere (Q18a)

## [0.2.519] — 2026-08-31
- More optional permissions can now be requested only when a feature needs them.

## [0.2.518] — 2026-08-31
- Three product decisions were made, and the next set of improvements has begun.

## [0.2.517] — 2026-08-31
- The release notes entry for the tidy-up is now in plain language too

- Permission matrix: refresh the attestation at the final candidate (26/0 ATTESTED)

## [0.2.516] — 2026-08-31
- The release notes now tidy themselves: commit shorthand no longer leaks into them, and the automated quality check pins it.

- tasks: OPTIONAL-PERMISSION-OMITTED-01 — record the final candidate SHA

## [0.2.515] — 2026-08-31
- Typing / or @ in the composer now shows an accessible suggestion list that keyboard and screen-reader users can follow

- Address the r2 review: honest probe readiness, accurate permission classification, final matrix provenance

## [0.2.514] — 2026-08-31
- Typing / or @ in the composer now shows an accessible suggestion list that keyboard and screen-reader users can follow
- tasks: OPTIONAL-PERMISSION-OMITTED-01 schema completed (r2 review accepted the code)

- Fix the four install-only permissions Chrome omits from optional_permissions

## [0.2.513] — 2026-08-31
- Housekeeping: the completed-work list was corrected after a bookkeeping mix-up between parallel work streams.

## [0.2.512] — 2026-08-31
- The thread now shows artifacts and generated images as you make them.

## [0.2.511] — 2026-08-31
- Artifacts and generated images now appear in the conversation as they are created — a card showing what changed, plus a thumbnail strip of screenshots and images you can open.

## [0.2.510] — 2026-08-30
- MCP works end to end: on a run the agent connects to the MCP servers you have set up, can use their tools (namespaced and treated as untrusted), asks before using a server the first time, and records what it called.

## [0.2.509] — 2026-08-30
- A size limit on how much a skill could import has been removed.

## [0.2.508] — 2026-08-30
- The edit-approval now shows the exact added and removed lines.

## [0.2.507] — 2026-08-30
- When the agent asks to change an artifact, you now see exactly what changes before you say yes.

## [0.2.506] — 2026-08-30
- A small artifact edit now applies as a targeted find-and-replace instead of a full rewrite.

## [0.2.505] — 2026-08-30
- Editing an artifact is faster and cheaper: a one-line change no longer rewrites the whole file.

## [0.2.504] — 2026-08-30
- Several finished changes were confirmed complete.

## [0.2.503] — 2026-08-30
- Three finished changes that were lost during parallel merges have been restored.

## [0.2.502] — 2026-08-30
- More editing improvements are on the way.

## [0.2.501] — 2026-08-30
- Housekeeping: a task entry was completed to the required shape so the tracker check passes.

## [0.2.500] — 2026-08-30
- Housekeeping: parallel work streams reconciled.

## [0.2.499] — 2026-08-30
- Tracker: the viewer Source/Diff tabs are recorded as landed.

## [0.2.498] — 2026-08-30
- Landed: opening an artifact now lets you switch between the rendered preview, the highlighted source, and a diff between any two versions with a restore button.

## [0.2.497] — 2026-08-30
- Housekeeping: parallel work streams reconciled.

## [0.2.496] — 2026-08-30
- Tracker: model-visible screenshots are recorded as landed.

## [0.2.495] — 2026-08-30
- Landed: when the agent takes a screenshot, a vision-capable model now receives the real image instead of truncated text, the picture shows in the tool card, and every capture is saved to the screenshots store.

## [0.2.494] — 2026-08-30
- Two more editing-flow fixes are in progress in parallel and recorded as claimed.

## [0.2.493] — 2026-08-30
- Housekeeping: parallel work streams reconciled.

## [0.2.492] — 2026-08-30
- Tracker: the honesty backstop for browser actions is recorded as landed.

## [0.2.491] — 2026-08-30
- Landed: if the agent says it opened a tab, saved something, took a screenshot or handed a job off but no tool actually did it, the conversation now corrects that instead of showing the false claim.

## [0.2.490] — 2026-08-30
- Tracker: the side-panel and cookie tool cuts are recorded as landed.

## [0.2.489] — 2026-08-30
- Landed: a tool that could never work was removed, and the agent can no longer read your cookie values or session cookies unless you explicitly approve it.

## [0.2.488] — 2026-08-30
- Tracker: cross-thread memory recall is recorded as landed.

## [0.2.487] — 2026-08-30
- Landed: something the agent saved to memory in one conversation can now be recalled in a new one - it sees a short list of what it remembers before it answers.

## [0.2.486] — 2026-08-30
- Permission matrix: Turn off now confirms through the owner-approval dialog (cross-lane fix for the Settings revoke route)

## [0.2.485] — 2026-08-30
- merge: Permission matrix lane (46a2d3a6) — every variant-integrity gate both records and refuses before startRig; headless permission-state matrix attested 25/0

## [0.2.484] — 2026-08-30
- Five more fixes are in progress in parallel and recorded as claimed in the tracker.

## [0.2.483] — 2026-08-30
- Two smaller follow-up issues found during the parallel work are now written down as tasks.

## [0.2.482] — 2026-08-30
- Tracker: bounded run-log retention is recorded as landed.

## [0.2.481] — 2026-08-30
- Landed: opening a thread and listing runs stay fast no matter how many past runs you have - old run logs are folded into a compact summary instead of growing without limit, and nothing you can see is deleted.

## [0.2.480] — 2026-08-30
- Housekeeping: two parallel work streams reconciled.

## [0.2.479] — 2026-08-30
- Tracker: the thread run-state view is recorded as landed.

## [0.2.478] — 2026-08-30
- Tracker: the thread view work records its verification runs, and a stale internal check that disagreed with the component gallery sync is written up.

## [0.2.477] — 2026-08-30
- The thread view: the conversation is now as tall as its content with the composer docked at the bottom of the window, assistant replies carry the agent's avatar, name and the time, a "Working — …" row says what the agent is doing while it runs, new replies scroll into view unless you have scrolled up to read, and a page the agent builds is titled with the page's own name.

## [0.2.476] — 2026-08-30
- Tracker: the diff view component is recorded as landed.

## [0.2.475] — 2026-08-30
- Landed: a reusable diff view (side by side or unified, with added/removed counts and keyboard navigation between changes) is ready for the editing flow.

## [0.2.474] — 2026-08-30
- Tracker: legible tool cards are recorded as landed.

## [0.2.473] — 2026-08-30
- Landed: tool cards in a conversation now show what the tool actually returned, in plain terms, with no internal plumbing; a permission request is still there to answer when you reopen the thread.

## [0.2.472] — 2026-08-30
- Tracker: artifact versions are recorded as landed.

## [0.2.471] — 2026-08-30
- Landed: every edit to an artifact keeps the previous version, and any earlier version can be restored.

## [0.2.470] — 2026-08-30
- Tracker: the memory-speed fix is recorded as landed; two more fixes claimed.

## [0.2.469] — 2026-08-30
- Landed: the hub stays fast as you use it — a run that took 2.5 seconds with 120 past tasks now takes about 0.3 seconds.

## [0.2.468] — 2026-08-30
- Tracker: the composer-first new tab is recorded as landed.

## [0.2.467] — 2026-08-30
- Landed: the new tab opens on the composer — first in tab order and visible on a small window — with a one-line banner and one action instead of an onboarding wall.

## [0.2.466] — 2026-08-30
- Tracker: the diff engine is recorded as landed.

## [0.2.465] — 2026-08-30
- Landed: the groundwork for showing what changed in an edited page — a real diff engine is now bundled and tested.

## [0.2.464] — 2026-08-30
- Tracker: stray merge markers removed from the task list, with a test that keeps them out.

## [0.2.463] — 2026-08-30
- Six more fixes are in progress in parallel and recorded as claimed in the tracker.

## [0.2.462] — 2026-08-30
- Tracker: the working jobs board is recorded as landed.

## [0.2.461] — 2026-08-30
- Landed: the jobs board now works end to end. An agent can post a job for another agent, the other agent wakes up, claims it, and delivers the result back into the conversation that asked.

## [0.2.460] — 2026-08-30
- Tracker: the one-Allow-card behaviour is recorded as landed.

## [0.2.459] — 2026-08-30
- Landed: when the agent needs a permission it does not have, the conversation now shows one Allow card naming exactly what is needed, and allowing it lets the action go ahead.

## [0.2.458] — 2026-08-30
- Tracker: the keyless first result is recorded as landed.

## [0.2.457] — 2026-08-30
- Landed: with no API key set up, asking the hub to group or list your tabs now really groups them and leaves a tab-list page behind, instead of replying with a placeholder.

## [0.2.456] — 2026-08-30
- Tracker: three tool fixes are recorded as landed.

## [0.2.455] — 2026-08-30
- Landed: notifications from the agent work again; the agent can no longer open chrome:// or other privileged pages; turning a capability off in Settings asks you first and fully tears it down.

## [0.2.454] — 2026-08-30
- Tracker: the template gallery is recorded as landed.

## [0.2.453] — 2026-08-30
- Landed: creating an agent now starts from a template gallery (Starter, All, Scheduled) you can browse with the keyboard; one click fills in the persona, skills and schedule.

## [0.2.452] — 2026-08-30
- Tracker: streaming answers are recorded as landed.

## [0.2.451] — 2026-08-30
- Landed: the agent's answer now appears word by word as it is written instead of all at once when it finishes.

## [0.2.450] — 2026-08-30
- Tracker: the untrusted-content fence is recorded as landed.

## [0.2.449] — 2026-08-30
- Landed: text the agent reads from a web page or a site's tools is now clearly marked as untrusted data before the model sees it, so instructions hidden in a page are treated as content, not commands.

## [0.2.448] — 2026-08-30
- Tracker: the honest provider-error messages are recorded as landed.

## [0.2.447] — 2026-08-30
- Choosing OpenAI, Anthropic or Gemini without typing a base URL now works everywhere, including the pre-run status check.

## [0.2.446] — 2026-08-30
- Landed: when a run fails because the API key was rejected, the provider is rate-limiting, or the model id is wrong, the message now says exactly that and offers Fix in Settings, instead of blaming an overloaded model.

## [0.2.445] — 2026-08-30
- Seven more fixes are in progress in parallel and recorded as claimed in the tracker.

## [0.2.444] — 2026-08-30
- A test that left thousands of tiny temporary repositories behind now cleans up after itself.

## [0.2.443] — 2026-08-30
- Tracker: the full-answer transcript fix is recorded as landed.

## [0.2.442] — 2026-08-30
- Landed: the conversation now keeps the agent's full answer instead of replacing it with a short summary, and reopening a thread shows exactly what was said.

## [0.2.441] — 2026-08-30
- Tracker: the script-approval fix is recorded as landed.

## [0.2.440] — 2026-08-30
- Landed: a script the agent wants to run now shows you its code and the sites it will contact before it runs, and scripts can no longer reach local or private addresses.

## [0.2.439] — 2026-08-30
- Tracker: the current-models fix is recorded as landed.

## [0.2.438] — 2026-08-30
- Landed: the model picker now recommends current models (gpt-5.6-luna, gemini-3.7-flash, claude-sonnet-5), the newest OpenAI models work again from the hub and from Test connection, and a check stops retired model names from creeping back in.

## [0.2.437] — 2026-08-30
- Tracker: the fresh-profile agent list fix is recorded as landed.

## [0.2.436] — 2026-08-30
- Landed: a fresh profile no longer lists 22 switched-off templates as agents; the sidebar, hub panel, side panel and Settings now agree on the same list, and templates stay one click away in the create dialog.

## [0.2.435] — 2026-08-30
- Tracker: the retryable tool-argument fix is recorded as landed.

## [0.2.434] — 2026-08-30
- Landed: when the model sends a wrong tool argument it now gets a clear, retryable error and its corrected retry succeeds, instead of the whole action being lost.

## [0.2.433] — 2026-08-30
- Three more fixes are in progress in parallel and recorded as claimed in the tracker.

## [0.2.432] — 2026-08-30
- Landed: the browser-control switch no longer blocks the next run, and browser control can always be turned off.

## [0.2.431] — 2026-08-30
- Browser control: turning the switch on in Settings no longer blocks the next run from opening tabs, and the switch can always be turned off — even while an agent is running. The internal "single-driver" lock that caused both problems was removed; browser actions are still gated by your Browser control grant.

## [0.2.430] — 2026-08-30
- Six fixes are now in progress in parallel and recorded as claimed in the task tracker so no two agents work the same item.

## [0.2.429] — 2026-08-30
- No gallery component is deleted: each unused one is kept with a planned home, and the screenshot strip is now the planned image strip of everything a run generates, in the thread and on the hub.

## [0.2.428] — 2026-08-30
- Every reanalysis task is now a step-by-step hand-off brief with its own tests to pass. Agent templates and the jobs board stay and get fixed (the board could never post a job from an agent). The open_side_panel tool is removed. Model ids are current everywhere, and the fault that stops every gpt-5.6 model from answering is recorded.

## [0.2.427] — 2026-08-30
- Full-project reanalysis before the exec demo: 65 new and 8 updated tracker entries, REVIEW-2026-08-30.md with the ordered queue and the five-minute demo script, recommended defaults for the open product questions, and the README now states the real host-access posture

## [0.2.426] — 2026-08-30
- merge: WebMCP acceptance green lane (0c9783c8) — detector registration restored, JIT scripting at discover, fresh-profile picker proof

## [0.2.425] — 2026-08-30
- merge: board deny rules lane (9fd462b8) — owner-managed post/claim policy with fail-closed unreadable-store semantics + browser-driven Settings coverage

## [0.2.424] — 2026-08-30
- Board deny: restore the capability.revoke journey assertion (merge splice had folded the board check names into its arguments)

## [0.2.423] — 2026-08-30
- Board deny: an unreadable policy store propagates (no write may follow a failed read); corrupt values stay fail-closed

## [0.2.422] — 2026-08-30
- Board deny: fix the journey's options-page refresh (re-open, not reload — navigation breaks the CDP eval context); drop diagnostics

## [0.2.421] — 2026-08-30
- Merge main (permissions-optional model) into the board deny lane

## [0.2.420] — 2026-08-30
- merge fix: restore the permissions-optional manifest arrays (4 mandatory + 31 optional; audioCapture/videoCapture removed) — clobbered by a version-file revert during the merge

## [0.2.419] — 2026-08-30
- merge: permissions-optional lane (475a25dd) — 4 mandatory boot permissions, 31 optional capabilities with JIT grant from genuine owner gestures (Settings three-state panel, in-chat Enable affordance); audioCapture/videoCapture removed (packaged-apps-only); the approvals journey drives the real grant/revoke/retry lifecycle with trusted clicks

## [0.2.418] — 2026-08-30
- merge: test-bypass removal (7fd9c637) — isTrusted gates unconditional; scanner needle; tests migrated to DI

## [0.2.417] — 2026-08-30
- Remove untrusted event test bypass

## [0.2.416] — 2026-08-30
- The composer slash menu got an overhaul: dead commands are gone (/theme, /focus, /model, /schedule), and new ones pull real Chrome context into your message — /tabs picks any open tab, /artifacts attaches a saved artifact, /bookmarks and /history search and insert links, /files attaches files from folders you've granted

## [0.2.415] — 2026-08-30
- Add browser context commands to the composer

## [0.2.414] — 2026-08-30
- Much better debugging: every tool call is logged with its arguments, result, and duration; there's a Settings switch for full detail in local logs (exports stay protected); and every run now has a View log showing its complete tool-call timeline

## [0.2.413] — 2026-08-29
- The microphone picker is smarter: after you first allow the mic it refreshes and shows all your real inputs, each with a live level check, and switching devices mid-dictation can no longer pick up the wrong microphone

## [0.2.412] — 2026-08-29
- Agents now know they run inside a Chrome extension: they're taught the real rules (fetch responses are read-once, tabs are opened with the tab tool, search once then use the tool), which stops whole classes of failed tool calls. Find-site-tools now lists only pages that genuinely have tools — never a plain page again — with tamper-proof detection. And every running task has a Stop button that stops exactly that run, instantly

## [0.2.411] — 2026-08-29
- Fixed a regression where deleting or changing agents from Settings could stall: the confirmation flow now settles correctly, required permissions are checked before anything is torn down, and removal no longer fails on permissions the extension must always keep

## [0.2.410] — 2026-08-29
- Fixed the visual regressions from the last update: the background-agent picker in Settings is back to its compact dropdown, dropdowns show a single arrow and stay on one line, the create-agent dialog has its sensible structure back with a stable width, the Chrome Agent Platform title at the top-left now takes you straight home, the + button starts fresh from home instead of walking backwards, and generated UI previews render in chat again

## [0.2.409] — 2026-08-29
- Merge commit '3cf75034790b4c35777315cf2ccbbca443b1fe92' into HEAD

## [0.2.408] — 2026-08-29
- Merge commit '7cd18009e3b4e68ea07ef5a7f4cb9569989e3d21' into HEAD

## [0.2.407] — 2026-08-29
- WebMCP tool failures now explain themselves in the page's own console: when a page's tool call fails, the full error detail appears in that page's DevTools console instead of a vague message, while the agent still sees only a safe summary

## [0.2.406] — 2026-08-29
- Scheduled agents now keep their conversation: when a background agent runs on its timer, the work it did shows up in that agent's chat — previously it vanished

## [0.2.405] — 2026-08-29
- Settings now shows all your agents in one place — interactive and scheduled together, each schedule described in plain language — and the left-hand agents menu shows scheduled agents too. The 'provider server tools' section finally explains itself: which agents may search the web on your behalf and what that costs

## [0.2.404] — 2026-08-29
- When an agent needs your approval — deleting something, changing an agent, granting a permission — the request now appears as a card right inside that conversation, and the task pauses until you answer. No more hunting for where to approve

## [0.2.403] — 2026-08-29
- Big content no longer breaks tool calls: agents can save full documents and scripts (up to 256 KB for artifacts, 64 KB for script source), every tool now tells the model its exact size limits up front, and when a call is too large the error says which field, the limit, and how to fix it

## [0.2.402] — 2026-08-29
- The new-tab hub gets easier to live with: creating an agent is a tidy dialog with the advanced bits tucked away, schedules can be written in plain English ('every 10 minutes'), picking a starting template is a slim dropdown instead of a wall of cards, the microphone starts listening the moment you click it, 'Find site tools' actually finds your pages again, and dark mode fixes grey-on-white chat bubbles and unreadable black-on-black tool results

## [0.2.401] — 2026-08-29
- A new starter agent: the Advanced Web Developer — a senior front-end engineer who builds with modern, native web platform features (view transitions, container queries, popovers, scroll-driven animations), checks real browser support instead of guessing, and treats accessibility and speed as part of the job. Add it in one click from the agents area

## [0.2.400] — 2026-08-29
- Agents can now post work to a shared board and claim each other's jobs: the hub keeps a bounded, tamper-proof ledger (agents can't forge entries with their memory tools), claims expire and recover automatically, finished jobs shrink to compact receipts that never lose the result, and results are delivered back to the requester's conversation with automatic bounded retries

## [0.2.399] — 2026-08-29
- Agents now see the world as it is right now: every prompt carries the current date and time, the extension version, and the agent's own notebook index — and the hub also sees who else is on the team. Site agents never see the roster, anything that looks like a password or key is scrubbed first, and the whole block is size-capped so it can never crowd out the safety rules, which still come last

## [0.2.398] — 2026-08-29
- Claude models can search the web while answering (you opt in globally and per agent): answers show what was searched and link their sources, and every paid search is billed from Anthropic's own counter — with an honest counted-from-the-stream fallback whenever the counter is missing

## [0.2.397] — 2026-08-29
- Agents now know how to keep their own notebooks: every agent organizes its memory with a living index it reads first and keeps truthful, topic pages that pair an evolving summary with a dated log, and a scratch space for throwaway notes — so what agents learn is easy to find and actually gets used

## [0.2.395] — 2026-08-29
- Fixed two real bugs found while getting the browser test suite green again: deleting a site agent always reported a failure even though it had worked, and turning off a permission that cannot be turned off would still remove your enrolled sites on its way to failing. Neither can happen now

## [0.2.394] — 2026-08-29
- merge: WASI tranche-2 lane (020eb11) — awk + date admitted through the REAL tool.preview.run route as bounded bundled packages (cap.bundled.awk.filter + cap.bundled.date.formatter, 128KiB SAB-free memory, CAS-stored with sha256-pinned provenance + SBOMs + reproducible rebuilds cmp=0). awk: anchors + literal matching, honesty-contract scope. date: fail-closed throughout — impossible calendar dates (2024-02-31), strtoll overflow, gmtime_r/localtime_r NULL, and strftime buffer exhaustion all exit nonzero with bounded GNU-style diagnostics; exact -I/--iso-8601 forms only. Browser KAT 10/10 through the loaded extension. Reviewed PASS across three rounds (real-route admission, date fidelity, C-library boundary checks).

## [0.2.393] — 2026-08-29
- Two more built-in tools arrive: awk for filtering and reshaping text, and date for formatting and converting timestamps — both run sandboxed in the browser with fixed memory, and both now refuse to guess: impossible dates, out-of-range timestamps, and over-long output fail with a clear message instead of a plausible-looking wrong answer

## [0.2.392] — 2026-08-29
- Two more improvements are now available.

## [0.2.391] — 2026-08-29
- merge: provider-server-tools lane (20040a03) — Gemini google_search grounding slice 1: execution-as-declaration latch (cap 10/run), double-gated availability (global toggle + per-agent opt-in keyed by IMMUTABLE instanceId, background fail-closed, deletion clears opt-ins), groundingMetadata→citation normalization (https-only) harvested at the model boundary, citation rendering live + persisted through the durable outbox, ESTIMATE-labelled usage ledger billing EVERY provider-reported query occurrence (rawQueryCount — neither the 32-text cap nor the 128-accumulator cap undercounts), resume identity persisted explicitly (null stays fail-closed across generic durable resume), display-name model IDs normalized canonically, Clear Usage clears the server ledger, revocation re-checked at the paid-call boundary. Reviewed PASS (round 4). Merge unions: delegation's runMaxIterations/iterationGuard + providerServerAgentId ride all orchestrator signatures; terminal settle carries BOTH delegationSpend enforcement AND grounding attach; runNamedAgentTask keeps instanceId memory/skills AND gains the lane's providerServerAgentId: agent.instanceId || null; components renders serverToolRows under agent answers inside main's hydrated-list structure. Manifest kept at main's P0 shape.

## [0.2.390] — 2026-08-29
- Gemini can search the web while answering (you opt in globally and per agent): answers show what was searched and link their sources, every paid search is counted with an honest cost estimate, and turning the switch off stops paid calls immediately — even mid-run or after a restart

## [0.2.389] — 2026-08-29
- merge: mutation-claim genuineness P2 (0794f39f) — title-case/possessive third-party subjects (Alice/Google/My assistant) no longer mis-classified as self-claims; coordinated predicates inherit a third-party subject across unmarked and/but [then]; explicit I/we or reflexives (bare, comma, by-prefixed) resume first-person; semicolon case fixed. Reviewed PASS (round 4, adjudicated matrix); coordinator 16-case probe matrix + SHA-stamped gates (focused 42/42, suite 2173/0, build) all run at the candidate SHA. Documented residuals: relative-clause first person, lowercase possessives, quoted speech.

## [0.2.388] — 2026-08-29
- The agent's honesty check on its own claims is smarter: it no longer flags actions it only reported others taking (including across 'and then'/'but then'), and it catches more disguised self-claims like ', myself' and 'by myself'

## [0.2.387] — 2026-08-29
- merge: agent-delegation lane (a45305a7) — delegate_to_agent agent-to-agent delegation: owner-approved canDelegateTo edges (bound into the approval payload, never ride unapproved), depth≤2/descendant≤4 caps, delegation-root run lock bypass (fresh child orchestrator), durable settlement ordering (executable race regressions: queued-sibling, over-cap settlement, permission-vs-cancel — RED on base via real production seams with injected durable stores). Reviewed PASS (round 5). Merge unions: profileGrants + schedule + canDelegateTo all flow through named-agent create/update/payloads; SW keeps BOTH chokepoint redaction AND delegation budget tracking; demo-model keeps BOTH the create-agent AND delegate-agent markers; instanceId-keyed agent memory + saved-skills composition ported into the lane's extracted runNamedAgentTask (its stale slug-keyed copy NOT taken). Manifest kept at main's P0 shape (lane was pre-P0).

## [0.2.386] — 2026-08-29
- Agents can now hand subtasks to other agents you have explicitly allowed — the allow-list is owner-approved on every change, child runs are bounded in depth and count, and approvals survive restarts

## [0.2.385] — 2026-08-29
- merge: template-cards lane (edc76319) — agent-template picker renders visual cards (name, 1-2 line persona, bounded 3+overflow skill badges, one-click Use through the real named-agent.create flow, curated starters marked), border-box sizing with a browser geometry pin (no adjacent-row overlap). Reviewed PASS (round 2); coordinator geometry probes RED -22.36px → GREEN +7.64px; candidate-mode KAT RED 9/9 on base.

## [0.2.384] — 2026-08-29
- The agent template picker now shows visual cards — each template's name, a short persona summary, skill badges, and a one-click Use button — with the curated starter templates marked, and cards no longer overlap each other

## [0.2.383] — 2026-08-29
- merge: settings-cleanliness lane (e4b88588) — dead Appearance nav + request-era storage-verification UI removed end to end; credential fail-closed, Browser control, local-folder grants and install-grant diagnostics preserved; design doc docs/SETTINGS-CLEANLINESS.md with deferred IA (owner sign-off required, NOT implemented). Reviewed PASS (round 1); coordinator candidate-mode KAT RED on base (2 removal checks fail, 4 preservation pass). Manifest unchanged semantically (lane base already had P0 shape).

## [0.2.382] — 2026-08-29
- Settings no longer shows dead controls: the empty Appearance section and the old storage-verification prompts are gone, while API keys, browser control, folder access and permission details all stay exactly where they were

## [0.2.381] — 2026-08-29
- merge: tool-call clarity lane (3920003a) — collapsed-card describeToolCall action line + runtime mutation-claim honesty (correction reaches the returned result; nested lazy failures never back claims nor publish/persist as success; per-run success set; structural subject classification: plural/modifier-led true positives, negation/third-party/subordinate rejections). Reviewed PASS-with-notes (round 5); documented P2 follow-ups (bare proper-name subjects, coordinated-predicate subject propagation). Unions: SW args=journalJson(redactSecrets(...)), result=journalJson(redactToolResult(...)) — RA's string-leak seam kept, corrupting mid-string slices removed everywhere; components.js keeps BOTH the outcome headline (genui) and the action line (lane); RA source pin updated to the composed seam. Merge-caught fixes: containerPreview clip now pair-safe (main's code-unit slice split surrogates — caught by the lane's tree-walk test); sync-gallery rewrites ../lib/pure.js for docs/components.js.

## [0.2.380] — 2026-08-29
- Tool cards are honest and readable: collapsed rows say what each call did, failed calls show their error, the agent can no longer claim it created or changed something when no tool call actually succeeded, and activity journals always store valid redacted JSON

## [0.2.379] — 2026-08-29
- merge: profile-store lane (3b291399) — named-agent provider profiles with validated profileGrants at the SW routes (create/update), bounded grant cardinality, fail-closed malformed rejection with no pending-approval side effects, non-vacuous pending-count probes. Reviewed PASS (round 7 re-review, amended base-named RED evidence). Union: named-agent.create keeps main's schedule param AND the lane's profileGrants validation. Manifest resolved to main's P0 shape.

## [0.2.378] — 2026-08-29
- Named agents can now carry per-agent provider profiles with owner-approved grants; malformed grant changes are rejected at the route instead of silently cleared, and approval side effects are cleaned up on failure

## [0.2.377] — 2026-08-29
- merge: recent-activity redaction lane (07eef98a) — redactResultValue scrubs every string leaf against RESULT_SECRET_SHAPES (sk-/AKIA/ghp_/xox*/AIza/JWT), try/finally exception-safe WeakSet cycle cleanup in pure.js + tool-summary.js + docs/pure.js mirror, '[Circular]' documented as display placeholder, DAG pin asserts both branches [REDACTED]. Reviewed PASS (round 6); coordinator RED-verified cyclic getter probe on b42a46a6. Manifest resolved to main's P0 shape.

## [0.2.376] — 2026-08-29
- Activity summaries no longer leak secrets or hang on circular data — every string in a tool result is scrubbed for API keys and tokens, and circular references are safely collapsed even when a getter throws

## [0.2.375] — 2026-08-29
- merge: task-view lane (b8413b3f) — registry panel becomes an on-demand debug overlay (hover/click toggle), conversation remains the status surface. Reviewed PASS (round 3). Union with landed progress-inline: lane's <conversation-run-status> element DROPPED (progress-inline removed the banner; merged ntp keeps the inline pinned row); overlay wrapper kept; conversation element keeps progress-inline attributes. Manifest resolved to main's P0 shape.

## [0.2.374] — 2026-08-29
- Task view no longer shows the internal run-registry panel — the conversation is the status view; the registry is now an on-demand debug overlay for cancel, resume and logs

## [0.2.373] — 2026-08-29
- merge: progress-inline lane (2bfa1805) — inline pinned live row (no #run-status banner), exact per-attempt runId capture/reconciliation, sidepanel action-label preservation, fail-closed axe gates. Reviewed PASS (round 3); coordinator-attested blocked-CDN axe failure-path (rc=1) + behavioral RED on 9bc529a9. Manifest resolved to main's P0 shape (lane base predates it; lane has no manifest delta of its own).

## [0.2.372] — 2026-08-29
- Live progress is now an inline pinned row at the bottom of the conversation — no separate banner — it always shows the exact run it belongs to, keeps recovery actions working, and accessibility checks fail loudly instead of being skipped

## [0.2.371] — 2026-08-29
- Task lifecycle stabilized end to end: follow-ups continue the same task with their history, titles stay current, approvals render as actionable cards instead of dead ends, browser access is granted permanently at install, and orphaned alarms are cleaned up

## [0.2.370] — 2026-08-29
- merge: genui-error-state lane (ea21ba82) — live error cards headline the denial (detail's extracted error preferred over the bare 'done' summary on error status); KAT uses the exact double-wrapped owner fixture. Reviewed source-PASS (round 3) + coordinator gates (focused 30/30, build rc=0, KAT 18/18; suite failure was the pre-existing changelog CAP-FB hygiene issue, absent on main). docs/components.js regenerated by build.

## [0.2.369] — 2026-08-29
- A failed tool call (like a denied asset preview) now headlines the actual error instead of a misleading 'done', and its card renders the error state instead of a perpetual 'Preparing' placeholder

## [0.2.368] — 2026-08-29
- merge: mic recording-state lane (9ed99f0) — mic stops on accepted send; unconditional start-generation invalidation on pagehide/hidden while getUserMedia is pending; honest RED evidence. Reviewed PASS (round 3). Union-resolved with composer auto-grow (send path keeps both the mic teardown and the _autoGrow reset); docs/components.js regenerated by build.

## [0.2.367] — 2026-08-29
- The composer microphone now stops recording the moment you send, and can never keep listening in the background after the page hides mid-prompt

## [0.2.366] — 2026-08-29
- merge: agent-templates/unification lane (c2170d6a) — one agent concept (persona + optional schedule), extracted delete gate with structural approval→mark→delete ordering, set-schedule/delete race fences under the named-agents lock. Reviewed PASS (round 5). Union-resolved with the memory-routes + OPFS-teardown lanes: extracted gate composes with main's teardown injections; post-delete recipe:<slug> cancel DROPPED (recipe teardown stays under recipe deletion — the lane's wiring test pins this); lane test's OPFS-survival assertion re-keyed to instanceId (main's identity model); kat freePort helper superseded by the shared kernel-assigned-port launcher.

## [0.2.365] — 2026-08-29
- merge: agent-templates/unification lane (c2170d6a) — one agent concept (persona + optional schedule), extracted delete gate with structural approval→mark→delete ordering, set-schedule/delete race fences under the named-agents lock. Reviewed PASS (round 5). Conflicts resolved as unions with the memory-routes + OPFS-teardown lanes; kat freePort helper dropped in favour of the shared kernel-assigned-port launcher.

## [0.2.364] — 2026-08-29
- Agent templates and one-agent unification: an agent is persona + skills + memory + an optional schedule; creating from a template, scheduling, and deleting an agent are now race-safe and clean up after themselves

## [0.2.363] — 2026-08-29
- merge: agent-cards lane (65525e04) — export/import shareable agent cards with pretty-serialization budget enforcement + canonical array-index validation. Reviewed PASS (round 5, gpt-5.6-sol): boundary exports stay under 2 MiB and round-trip; pseudo-indices rejected; suite 1982/0, builds rc=0 attested.

## [0.2.362] — 2026-08-29
- Shareable agent cards: an agent's definition can be exported to a card file and imported back, with strict size and shape validation so oversized or malformed cards are safely rejected

## [0.2.361] — 2026-08-29
- Dialogs now behave the same everywhere. Three of them had been built by hand instead of using the shared ones, so each had its own quirks — one could not be dismissed by clicking outside it, another had no close button, and a fix to one never reached the others. They all use the shared dialogs now: click outside to dismiss, Escape to cancel, and a delete confirmation always starts on Cancel rather than Delete

## [0.2.360] — 2026-08-29
- Internal bookkeeping only, no user-visible change

## [0.2.359] — 2026-08-29
- Internal only, no user-visible change: the browser-driven tests each get their own browser now. They used to share a small set of fixed connection numbers, so a leftover browser from an earlier run — or simply two test runs at once — could quietly hand a test the wrong browser, and it would then report confident pass/fail results about a build it was never looking at. A new check fails the build if a fixed number ever comes back

## [0.2.358] — 2026-08-29
- Correction to the previous entry: the bug reported there does not exist. If you configure your own API key but have not yet allowed the extension to reach that provider, the task does tell you so, names the exact site, and offers a link to fix it in Settings. My test script had been looking at the wrong part of the page and reported silence where there was none; it has been fixed so it cannot make that mistake again

## [0.2.357] — 2026-08-28
- Added a script that drives a genuine task end to end through the real extension, so problems can be caught in the seams the unit tests cannot reach. (The bug this entry originally reported turned out not to exist — see the next release.)

## [0.2.356] — 2026-08-28
- Internal bookkeeping only, no user-visible change: recorded a defect in our own test harnesses (several of them could attach to the wrong browser and report a confident pass against code they were not testing) and closed out the naming clean-up that shipped earlier

## [0.2.355] — 2026-08-28
- One name for one thing. The gallery of things your agents make was called "Assets" in the sidebar and "Artifacts" on the card right next to it — and opening it from those two places gave the same screen two different titles. It is **Artifacts** everywhere now: the sidebar, the quick-access drawer, the @-mention list and both ways in. Files you attach to an agent are called "Context files", because they are something you give the agent, not something it made. The Agents card said "Agents" three times, nested; it says it once. In Settings, background agents no longer talk about "recipes" — they wrap skills. A new build check fails if any of these names come back

## [0.2.354] — 2026-08-28
- Internal only, no user-visible change: every in-progress branch was made recoverable and the notes about them corrected

## [0.2.353] — 2026-08-28
- Internal bookkeeping for the tool-call readability work released just before it

## [0.2.352] — 2026-08-28
- Tool calls in a task are much easier to read. A collapsed one now tells you what happened — "list_tabs · 8 tabs · done" — and a failed one shows the actual error on the line, in red, and opens itself instead of hiding the reason behind a click. Opened up, rows show what they contain rather than their shape: a list of tabs reads as the tab titles, not ten identical "object" rows. Every block of input and output has a JSON view and a Copy button, and it remembers which view you last used. A typical call now takes about a third less room on screen while showing more

## [0.2.350] — 2026-08-28
- The task box grows as you type (up to ten lines), so you can always see what you're writing

## [0.2.349] — 2026-08-28
- Deleting an agent now truly cleans up after itself: scheduled runs, permissions, workers, and stored data are removed together, safely, and anything half-finished is retried rather than lost
- Internal bookkeeping: the completed task-loading work is closed out and archived, leaving the tracker showing only live work

## [0.2.348] — 2026-08-28
- Tasks are now dramatically faster: opening one is about 34x quicker than it was (nearly a second down to under a thirtieth), and recording what an agent does is ~123x quicker — a thousand steps went from nearly three minutes to under a second and a half. A long-running task no longer slows down the longer it runs

## [0.2.347] — 2026-08-28
- Fixed a bug in the faster task-history storage: the row recording how a run finished was written where the new reader never looks, so every completed run quietly lost it from its log. Not visible in the UI (status comes from elsewhere), but wrong — and it blocked the batching work that comes next

## [0.2.346] — 2026-08-28
- Settings Providers panel is now a side-tabbed interface: one tab per provider down the side with the default marked by a star, editor on the right, and it behaves at narrow widths

## [0.2.345] — 2026-08-28
- Internal groundwork only, no user-visible change: kept the pieces of the faster task-history storage that stand on their own, and backed out the switch-over after it produced a result I could not explain. Not worth guessing with your task history

## [0.2.344] — 2026-08-28
- Groundwork for much faster tasks: task history will be stored as one append-only log per run instead of one file per step. This lands the storage piece with its tests; the switch-over is next

## [0.2.343] — 2026-08-28
- Reworked the plan for how task history is stored, after a much better suggestion: one append-only log file per run instead of one file per step. Measured on the real thing, writing a thousand steps goes from about three minutes to one millisecond, and reading them from a third of a second to under one

## [0.2.342] — 2026-08-28
- Opening a task is about 2.6x faster (nearly a second down to a third of one on a well-used task). The stored steps were being read one file at a time even though they do not depend on each other, and a single lock meant nothing could overlap. More to come — the remaining cost is that every logged step is still its own file

## [0.2.341] — 2026-08-28
- Failed task runs are now manageable: dismissing one hides it for good (there's a Clear all for the whole section), and deleting an agent clears its failed runs too

## [0.2.340] — 2026-08-28
- Fixed: deleting an agent (including background agents) now actually deletes it — every surface checks the result honestly, a running task is torn down in the background without freezing the UI, focus lands somewhere sane afterwards, and settings no longer claims success when nothing happened

## [0.2.339] — 2026-08-28
- New in Settings: the Providers panel is now a side-tabbed interface with the default provider badged on its tab; Skills live as a full section inside Settings (the old sidebar button is gone — old links redirect); the Usage panel has real graphs (daily token bars, model share, top tools, estimated cost); and the hub agent's instructions now describe its full browser-control surface properly

## [0.2.338] — 2026-08-28
- test(evidence): skills-in-settings browser evidence — seed via the shared OPFS masterMemory (localhost fetch refused by design), 9 browser checks + 4 screenshots

## [0.2.337] — 2026-08-28
- Traced why opening a task is slow and wrote up the fix. Measured: opening a task costs about a millisecond per logged step, so a well-used task takes seconds. Worse, WRITING those steps gets slower the longer a task runs — a thousand steps takes three minutes — because every step rewrites the whole index. The redesign is written down and waiting for review; nothing has changed yet

## [0.2.336] — 2026-08-28
- More audit fixes: accessibility violations are cleared on every surface (proper landmarks, headings, keyboard-safe task rows), a failed task run is now kept as a retryable row instead of vanishing, the artifact viewer's copy button only appears when there's something to copy, panels use the space better at wide sizes, and the side panel gets real first-run guidance

## [0.2.335] — 2026-08-28
- Tool calls in the conversation now show the tool that actually ran and the arguments it actually got, instead of internal plumbing like execute_tool and selectionRef — and artifacts show up inline again. Also fixed a real one: once you had ~70 artifacts, saving a new one silently returned nothing at all, so the agent lost track of what it had just made

## [0.2.334] — 2026-08-28
- Internal cleanup: finished removing the old view-transition machinery (it was already disabled) — renamed to what it actually does and stripped the leftover styles. No visible change

## [0.2.333] — 2026-08-28
- Verified the site-tools (WebMCP) machinery actually works end to end — 35 of 35 checks against a real page, covering discovery, invoking the right tab, surviving reloads and navigation. The only thing left unproven is the browser permission prompt, which needs a human click

## [0.2.332] — 2026-08-28
- The UX audit fixes are in: the panel no longer leaks memory when you open and close it, dark mode now follows your OS setting, narrow windows no longer overflow sideways (the sidebar becomes a proper overlay drawer), and the first-run call to action is honest about what needs setting up

## [0.2.331] — 2026-08-28
- docs(ux-audit): full UX/navigation/performance/memory audit (web-uplift methodology) — 11 findings: panel iframe+listener leaks, no dark scheme, 360px overflow, gated first-run CTA, plus verified-good perf/security/backstack; evidence in reports/cap-ux/

## [0.2.330] — 2026-08-28
- Things an agent makes for you now show up in the conversation that made them — a real card with the name, type and size, and buttons to open it in a tab or reuse it in another task. Before, creating a report showed you a bare create_asset line and the report itself was nowhere to be seen. They stay there when you reopen the task, and they are still in your artifacts library too

## [0.2.329] — 2026-08-28
- Fixed real data loss: deleting a Site Agent used to destroy every artifact created under that site — and those artifacts were never shown in your artifacts library in the first place. Artifacts are now one library that survives the agent and the task that made them, existing ones are migrated automatically, and the library shows everything you have made

## [0.2.328] — 2026-08-28
- Groundwork for making any website usable by an agent: you will be able to write a small description of what a site can do (search this, read that, click this) and the agent gets those as tools — without the site owner having to do anything. It is deliberately a fixed list of simple actions rather than code, so a proposal from an agent can never be more than something you can read and refuse

## [0.2.327] — 2026-08-28
- Found a data-loss bug while writing down what artifacts are for: deleting a Site Agent currently destroys every artifact created under that site. Artifacts are meant to be the central store of everything you have made and to outlive the agent and task that made them, so this is now the top-priority fix

## [0.2.326] — 2026-08-28
- Product thesis written down properly: this is a coworking environment for knowledge workers in the browser — tools for running the browser, tools for doing the work, and WebMCP so any website can become a tool. Two gaps between that and the current UI are now tracked: site tools should be available on the tab you are on rather than pre-registered in Settings, and the tool library should be grouped by what things are for

## [0.2.325] — 2026-08-27
- Product direction: audited the whole UI and wrote down why it reads as messy — the same thing is called Assets in one place and Artifacts in another, every view is a separate page loaded in an iframe (which is where the back-button and layout bugs came from), and the hub is an onboarding flow, a launcher and a dashboard stacked in one scroll

## [0.2.324] — 2026-08-27
- Internal: the task tracker now shows only live work — 13 finished items were still sitting in it looking unfinished (five had actually shipped and never got closed), and the known-issues file had become a second copy of the same list

## [0.2.323] — 2026-08-27
- Tracker bookkeeping: recorded the exact public commits for the work pushed today

## [0.2.322] — 2026-08-27
- Internal process change: reviews no longer require a second model (there isn't one) — instead a changed test now has to be proven capable of failing before it counts as evidence. It caught a bug on its first use: a check I'd 'fixed' the day before turned out to be one that could never fail

## [0.2.321] — 2026-08-27
- Housekeeping: the project's own docs and task tracker had drifted about two weeks behind the code — your 2026-08-26 bug batch was fully shipped but every one of its 15 items still read as open, and the plan still listed finished work as in-flight. All reconciled against the real tree, with each item's shipping version recorded

## [0.2.320] — 2026-08-27
- The extension no longer asks for Chrome's debugger permission — it was added for the DevTools-protocol power tools and brought Chrome's all-sites warning plus a permanent 'started debugging this browser' bar with it. Those four tools are gone for now and can come back later behind a developer-only surface. Also: the browser-test suite is honest again (it had been silently driving a settings page deleted two weeks ago, which made it report 26 of 127 checks when the product was fine)

## [0.2.319] — 2026-08-27
- Python is nearly here: the bounded non-eval python tool is built and tested (your code runs through the Pyodide interpreter, never eval; 2KiB in / 64KiB out, fenced). The remaining step is the actual Pyodide runtime binary — an Emscripten build, with the exact script checked in ready to run

## [0.2.318] — 2026-08-27
- Artifacts are fixed: the viewer now fills the window (no more tiny unclickable box), and there's an 'Open in new tab' so an artifact opens as a full tab. The new-tab page is a minimal web-accessible resource — nothing else is exposed

## [0.2.317] — 2026-08-27
- Opening a task is now instant and the full history is still there: the log reads use an ordered per-run index with paging, so the first screen renders fast regardless of how much history exists, and you can page back through everything

## [0.2.316] — 2026-08-27
- xan is IN — a real, runnable WASI CSV toolkit (the rayon thread-pool now runs serially via a shim, and the two GPL-family deps the review caught are properly excluded with honest licence accounting). The same shim is what tokei and qsv will ride on next

## [0.2.315] — 2026-08-27
- jq is IN — a real, single-threaded WASI jq (tiny 490KB, 19 pure-WASI imports, runs filters and object transforms). The patched-fork route works: xan now builds too (needs the rayon serial-fallback next), qsv has a precise patch plan

## [0.2.314] — 2026-08-27
- Opening a task is now fast: the thread view reads only the most-recent runs and log entries instead of replaying the whole history (which is what made it take 10-15 seconds on well-used tasks). Plus sub-stage timing so any future slow part shows exactly where. And sed is in — a real, reproducible WASI sed

## [0.2.313] — 2026-08-27
- The approvals settings page is gone — revoking a permission now confirms right there with a simple dialog (a real click, then it completes), using the same in-context approval path the rest of the app uses. No more hunting through a settings list

## [0.2.312] — 2026-08-27
- Your UI batch is in: the add-agent empty state shows your requested text, the discovered-sites box has proper spacing, the tool library actually lists all 130 tools (the count and the rows finally agree), local models are hidden, and the system prompt now tells agents to search for tools first. The approvals section is kept for now — it's what the 'disable a permission' flow rides on — and I'll move that confirmation into the conversation itself next

## [0.2.311] — 2026-08-27
- Fixed tasks not responding: run dispatches were hitting the 12-second safety timeout (meant for quick data loads), so any task over 12 seconds showed 'the agent worker didn't answer' even though it finished. Task runs now get their own long timeout

## [0.2.310] — 2026-08-27
- The shared-worker transformation is COMPLETE: each agent runs in its own shared worker (isolated, fault-contained), the UI holds live ports with live progress, background agents run on workers with zero visible pages, and a single-driver lease means only one surface can drive browser commands at a time — with reads like screenshots still always available

## [0.2.309] — 2026-08-27
- The shared-worker transformation continues: Phase 2 complete — the agent loop now runs inside each agent's own shared worker with tools executing through the service worker's validated authority (same grant/redaction as interactive, nothing new the worker can do on its own)

## [0.2.308] — 2026-08-26
- Agent-worker architecture Phase 1: each agent now has a dedicated shared worker (hosted by the extension's offscreen document, bootstrapped through the service worker) with a validated port handshake for the UI and a durable alive-set that re-creates workers on wake. Foundation only — the run loop migrates in Phase 2

## [0.2.307] — 2026-08-26
- Local models removed (the download never worked — Chrome's built-in AI storage cap): the UI and download machinery are gone and the code is simpler. The full architecture is logged in docs/LOCAL-MODELS-ARCHITECTURE.md so we can rebuild it later — including the future direction of loading gguf models from your own drive. Ollama still works as a local provider (it's just an OpenAI-compatible endpoint)

## [0.2.306] — 2026-08-26
- Background agents now live IN the agents list (side panel + hub) with a 'runs in the background' marker, their schedule and a toggle — and you can fully delete a named agent (folder, record, memory and OPFS storage all go)

## [0.2.305] — 2026-08-26
- Deleting or disabling a background agent is now instant — it stops waiting on the running task's 5-second termination confirmation. The agent is removed immediately and the in-flight run is aborted in the background (the task payload is marked cancelled first so it can't commit anything)

## [0.2.304] — 2026-08-26
- Back button actually fixed now (real-browser proven): Settings/Assets/Directory/Skills all return to the hub in ONE press with no blank screen — the fix is at the right layer this time

## [0.2.303] — 2026-08-26
- Permissions are simple now: when an agent's tool needs a permission, the request appears right there in the conversation — 'This agent wants to group tabs — Allow?' — and one click grants exactly what's needed (nothing broader) and retries the task. No more two-layer confusion or dead-ends pointing at Settings. Deny is sticky, and Settings has a guided two-step revoke

## [0.2.302] — 2026-08-26
- No surface can blank out silently anymore: every data-loading view (providers, usage, agents, activity, tool library) now times out with an honest error + Retry if the service worker can't answer — the class that killed recent activity, artifacts, providers and tools together on a heavy profile

## [0.2.301] — 2026-08-26
- Removed the theme switcher (it only worked on the Settings page and was unused) — the extension keeps its single design system, and locale preference plumbing stays

## [0.2.300] — 2026-08-26
- The run-status cards no longer push everything off screen: each run is now one subtle line (short task preview, a plain-English status like 'Paused — outcome uncertain', simple Cancel/Retry/View-logs buttons) and only the 3 most recent runs show, with a quiet '+N earlier runs' note. The full task text and details are still there on hover and in the logs

## [0.2.299] — 2026-08-26
- The 'Find tools for a Site Agent' dialog now scrolls when there are a lot of tabs/tools (it was clipping them with no way to scroll). Also fixes every other dialog with long content

## [0.2.298] — 2026-08-26
- Fixed Recent Activity not loading on a real profile: with many background agents the activity feed hung forever (dead search and filters). It now loads fast with per-store fault isolation and a timeout that shows an honest error + Retry instead of dead controls

## [0.2.297] — 2026-08-26
- Usage numbers work now: the extension finally asks providers to stream their token usage, so per-run and per-agent call/token counts are real (they were silently always zero before). Providers that don't report usage are recorded honestly as unknown, never faked

## [0.2.296] — 2026-08-26
- Back button works properly now: from any Settings page, Back takes you straight Home in one press (no more blank screen), Settings sections are still directly linkable, and clicking the 'Chrome agent platform' header in Settings goes Home

## [0.2.295] — 2026-08-26
- Audited every Chrome API call in all 130 tools against the official Chromium schemas and fixed everything that was wrong: tab groups, the MHTML page-save (was calling a non-existent method, so it never worked), keep-awake release, and per-site content settings (a read that always failed + a clear that could have wiped settings browser-wide). Test doubles now mirror the real APIs and reject wrong shapes, so this class of bug can't come back

## [0.2.294] — 2026-08-26
- Agent lifecycle now visible in the logs: when logging is verbose you see each agent step, every tool call with its duration and outcome, and the run's total steps/time/tokens — redacted so no prompt or page content ever appears. Off in production, on in the debug build

## [0.2.293] — 2026-08-26
- Fixed the tab-group tools to call the real Chrome API: grouping/ungrouping is chrome.tabs.group()/ungroup() (the previous calls used chrome.tabGroups.group/ungroup which don't exist), and a group's title/colour is set via chrome.tabGroups.update. The 'tg.group is not a function' crash is gone

## [0.2.292] — 2026-08-26
- Scheduled tasks now show up under their agent: a scheduled run is attributed to the agent/thread that scheduled it, so it (and its per-agent log) appears in the Agents task/conversation view instead of running invisibly. Open an agent to see what its scheduled runs did

## [0.2.291] — 2026-08-26
- Fixed orphaned scheduled alarms: deleting a task or agent now removes its alarm, and an alarm that fires for a schedule that no longer exists is cleared instead of firing forever (the recipe:auto-group-by-domain ghost). Recurring raw alarms you set with create_alarm are left alone

## [0.2.290] — 2026-08-26
- Tab groups now actually work: the tabGroups permission is declared and listed in Settings (it wasn't, which is why the API was 'not available'). Enable 'Tab groups' in Settings, then the group tools (create/rename/recolor/collapse/move tabs) work

## [0.2.289] — 2026-08-26
- Hardened the browser tools against a missing Chrome API: windows, toolbar-action, command and session tools now return a clean 'not available' error instead of crashing with 'Cannot read properties of undefined' — the same class the logging surfaced in tab groups

## [0.2.288] — 2026-08-26
- Fixed two errors the new logging surfaced: tab-group tools now return a clean 'not available' error instead of crashing when the API isn't there, and the task scheduler's tool description now says clearly that it needs a time or a delay

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
