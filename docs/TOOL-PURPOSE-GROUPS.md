# Tool library purpose groups

The tool library (Settings → Tool library) lists every tool the platform can
see. The list exists so a person can predict **what they can ask the agent to
do**. Grouping by the implementing Chrome API fails that job — "browser.tabs"
is an engineering fact, not a user one. This document is the product judgement
the UI renders: **two families, subdivided into task-shaped groups**, each
with one plain line saying what it lets you ask for.

- **Running the browser** — sensing and driving Chrome itself: the tabs,
  pages, downloads, and settings of the browser in front of you.
- **Doing the work** — the agent's own workspace: files, text, tables, scripts,
  schedules, agents, and memory. These tools would mean the same thing in any
  host; they are not about Chrome.

A tool belongs to exactly one group. The assignment is explicit (a static map
in `extension/lib/tool-purpose-groups.js`, by route family with per-tool
overrides where a family mixes purposes — e.g. `browser.page` splits into
reading vs. driving). A build-time test asserts every catalogued tool resolves
to exactly one group and no group is empty, so the taxonomy cannot rot as
tools are added.

## Family 1 — Running the browser

| Group | One line | Tools (route families / overrides) |
|---|---|---|
| **Tabs & windows** | Open, close, move, pin, group, and switch between tabs and windows. | `browser.tabs` (minus zoom), `browser.windows`, `browser.tab-groups` |
| **Reading, search & capture** | Read a page, search the web, take a screenshot, and see what a page loads. | `read_page`, `find_elements`, `browser.capture`, `browser.search`, `browser.navigation`, `browser.requests` |
| **Driving pages** | Click, type, scroll, and wait inside the page you are on. | `click_element`, `type_text`, `select_option`, `scroll_page`, `wait_for` |
| **Bookmarks, history & activity** | Save and find bookmarks, reading-list entries, history, and recent browser activity. | `browser.bookmarks`, `browser.reading-list`, `browser.history`, `browser.top-sites`, `browser.sessions`, `browser.events` |
| **Downloads** | Start, watch, and manage downloads. | `browser.downloads` |
| **Browser data & privacy** | See and manage cookies, site data, and privacy settings. | `browser.cookies`, `browser.browsing-data`, `browser.content-settings`, `browser.privacy` |
| **Network & proxy** | See and control network rules and proxy settings. | `browser.network-rules`, `browser.proxy` |
| **Appearance & system** | Zoom, fonts, and information about this device and browser. | `browser.font-settings`, `browser.system`, `browser.runtime`, `browser.power`, `get_tab_zoom`, `set_tab_zoom` |
| **Notifications & speech** | Send notifications and read text aloud. | `browser.notifications`, `browser.tts` |
| **Reminders & timing** | Set alarms and see when the browser is idle. | `browser.alarms`, `browser.idle` |
| **Browser controls** | Manage extensions, menus, shortcuts, and scripts that run on pages. | `browser.management`, `browser.commands`, `browser.context-menus`, `browser.content-scripts`, `browser.user-scripts`, `browser.side-panel`, `browser.action`, `browser.permissions` |

## Family 2 — Doing the work

| Group | One line | Tools |
|---|---|---|
| **Files & data** | Read and write files in folders you have granted. | `browser.fs-grant`; bundled `du`, `stat`, `tree`, `touch`, `truncate`, `gzip` |
| **Text & documents** | Search, sort, cut, compare, and convert text. | bundled `head`, `tail`, `cut`, `sort`, `uniq`, `tr`, `grep`, `wc`, `diff`, `patch`, `markdown`, `toml2json`, `awk_filter_bounded`, `date_formatter_bounded`, `base64`, `xxd` |
| **Tables & queries** | Work with CSV tables and query databases. | bundled `csvtool`, `sqlite3_query_bounded` |
| **Checksums & IDs** | Hash data and generate unique IDs. | bundled `md5sum`, `sha256sum`, `sha512sum`, `uuid` |
| **Scripts & compute** | Run Python and reusable scripts. | `python_execute`, `management.scripts` |
| **Automation & scheduling** | Schedule work, react to events, and generate interfaces. | `management.schedules`, `management.hooks`, `generate_ui`, `schedule_task` |
| **Agents & delegation** | Create, manage, and delegate work to agents. | `management.agents`, `management.named-agents`, `management.board`, `list_agents`, `delegate_task` |
| **Assets** | Files the agent creates and keeps for you. | `management.assets` |
| **Memory & usage** | Remember facts and see what the agent has stored and used. | `memory_get`, `memory_set`, `get_memory_overview`, `get_usage` |
| **Site tools (declared)** | Things the current site says other tools can do. | dynamic `webmcp-declared` rows |
| **Site tools (inferred)** | Things the current site appears to offer. | dynamic `webmcp-inferred` rows |

## Judgement calls (and why)

- **`schedule_task` lives in family 2** although its route family is
  `browser.scheduler`: the person is asking the *agent* to do work later, not
  asking about the browser.
- **`browser.page` splits in two**: reading a page and driving a page are
  different requests in anyone's mouth.
- **Tab zoom is appearance**, not tab management: "make this page bigger" is
  not "open/close/move".
- **Site tools keep their declared/inferred split** because that distinction
  is the honesty boundary (what the site claims vs. what we guessed) — it is
  user-meaningful, not API trivia.
- **The source axis is not deleted, it is demoted**: each row still names its
  source ("Browser", "Management", …) in its meta line, and the by-source
  counts stay in the diagnostics detail. The primary presentation is purpose.
