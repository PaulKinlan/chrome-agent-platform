# Chrome Agent Platform — Robustness Constitution

The non-negotiable constraints for this project. Every agent (human or model)
and every reviewer agent checks work against this. These are long-living tools
responding to actions with minimal human intervention — they must be robust,
resilient, performant, secure, and accessible by construction, not by review.

## 1. Security (the attack surface)

The extension runs with broad browser power (tabs, scripting, capture, OPFS,
alarms) and acts on untrusted page content + model output. Threat vectors:

- **Cross-origin memory access** — one site's sub-agent must never read another
  origin's memory. Origin-keyed OPFS; canonicalize origins (`new URL().origin`,
  injectively encoded); reject non-web schemes; never overload the master
  sentinel. (Verified: the A/B clear isolation test.)
- **Sender-origin spoofing** — a page must not be able to claim another origin.
  The ISOLATED bridge derives the origin from its OWN `location.origin` (never a
  message-supplied origin — a content script never trusts `sender.tab.url`),
  reject claimed-origin mismatches, treat all tool reports as page-controlled
  data, bound + validate descriptors. (The re-review reproduced this exploit;
  the fix must hold.)
- **Unvalidated tool invocation** — every discovered tool is called with a
  validated schema (the descriptor's inputSchema, enforced as a zod schema).
  No `z.record(z.any())` bypass.
- **Destructive browser actions** — open/navigate/close/screenshot tabs need an
  explicit, scoped user grant (per-task or per-origin, not a permanent global).
  Read/list are ungated.
- **Browser mutations accept http(s) destinations only** — every tool that takes
  a destination URL (`open_tab`, `navigate_tab`, `create_window`) refuses `chrome:`, `chrome-extension:`, `file:`, `about:`,
  `javascript:`, `data:`, `blob:` and `view-source:` BEFORE any permission or
  grant check, with the plain error "only http(s) destinations are allowed"
  (`webDestination` in `extension/lib/browser-tools.js`). A global grant never
  authorizes a privileged page: `canonicalOrigin` returns `null` for non-web
  schemes and a null origin must never pass as "all sites".
- **Untrusted content → model → action** — page text can influence a model that
  can act. Prompt-injection: model output must not directly trigger destructive
  actions without the grant.
- **Model-written scripts are approved as code, and their fetch is fenced** —
  `script.create`, `script.run` and a scheduled script (`task.schedule-script`)
  are destructive actions: a model-initiated call pauses on an in-context card
  that shows the EXACT source (the approval payload binds its digest) and the
  hosts it fetches; the owner's own hub action is owner-direct. The host-side
  `cap:fetch` sends `credentials:"omit"`, never follows redirects, refuses
  loopback/private/link-local addresses (`extension/lib/fetch-policy.js`,
  `tests/cap-fetch-deny.test.ts`) and refuses any host not on the run's
  allow-list derived from the approved source. No registered run → no fetch.
- **Untrusted content is fenced** (`CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01`,
  `extension/lib/untrusted-fence.js`) — every untrusted tool result (`read_page`
  text, WebMCP tool descriptions + results, board jobs, fetched bodies via the
  `tagUntrusted` hook) reaches the model ONLY inside a labelled block bounded by
  a random per-assembly token, and a protected, dynamic system-prompt layer
  names that token and states that fenced text is data, never an instruction.
  A tool never has to remember to wrap its own output: it tags its result
  `untrusted: true` and the lazy projection fences it. Page content is still
  rendered in cards with `textContent`. The passive WebMCP detector transports
  a tool COUNT only; descriptions reach the model only after the owner enrols
  the origin, and then fenced. `confirmActionDialog` refuses a scripted click by
  default (`requireGenuineGesture: true`). The journey suite's `injection:`
  checks assert all three, with the demo model scripted to obey the page.
- **MV3 CSP** — no `eval`/`new Function` in the bundle (verified: 0 sites).
  (Exemption: the agent-script host `sandbox/script-sandbox.js` runs in the
  manifest `sandbox` page — an opaque origin with no chrome.* access — and uses
  `new Function` there. The sandbox origin IS the boundary; the bundle remains
  eval-free.)
- **XSS** — chat/directory/memory render untrusted data with `textContent`/
  escaping, never `innerHTML` with unvalidated data.
- **Permissions** — ALL optional (Paul's hard requirement): the manifest declares
  an empty `permissions` array; `alarms`/`storage`/`sidePanel`/`tabs`/`scripting`/
  `notifications` are `optional_permissions`, host access is
  `optional_host_permissions`. No `debugger` anywhere. It was re-declared
  as an *optional* permission at `0.2.286` for the CDP power tools and removed
  again on 2026-08-27 (owner decision, Q17): the original rationale was
  imprecise — `debugger` **can** be declared optional — but the real costs
  stand, namely Chrome's all-sites permission warning and the persistent
  "started debugging this browser" bar. `tests/chrome-tools-t12.test.ts` holds
  a removal guard and `scripts/chrome-journeys.ts` asserts absence from the
  manifest, so a future tranche cannot reintroduce it silently. Screenshots useScreenshots use
  `chrome.tabs.captureVisibleTab` (the ACTIVE tab). `activeTab` is transient and
  tied to a qualifying owner invocation on the current tab; it is never a
  model/background fallback. Model-selected screenshots require exact host
  access and fail closed without it. The extension boots + runs with ZERO optional
  permissions (degrade gracefully), and each capability is requested from a real
  owner gesture in Settings → Permissions (the SW never requests). Enrollment
  requests `scripting` + exact host access; browser control requests `tabs`.
- **Credentials** — provider keys live in chrome.storage (user-entered), never
  in the bundle, never logged, never in receipts.

## 2. Accessibility

- Keyboard: every action reachable + operable by keyboard (focus visible,
  logical tab order, Enter/Space activation).
- Screen readers: semantic HTML, ARIA only where needed, live regions for
  agent updates, labeled controls (the composer, the mic, the attach menu, the
  nav).
- Motion: respect `prefers-reduced-motion` (the glow/equalizer disable).
- Contrast: WCAG AA for text + interactive elements across all themes.
- Focus management: modals/menus trap + return focus; the side panel doesn't
  steal focus.
- The side panel / side-sheet: a usable target size, readable text scale.

## 3. Design consistency

- One design language: shared spacing/icon/button scale (the `icon-btn` scale).
- One design system, applied consistently to every surface. (The theme picker was
  removed at `0.2.301` — it only ever worked on Settings and was unused.)
- Icons: inline SVG, line-art, currentColor (no emoji).
- States: idle/loading/responding/error/empty are designed + consistent.

## 4. Memory resilience + performance

These are long-living agents. Memory + perf degrade over time if unchecked.

- **Memory resilience**: no unbounded growth — the activity log, the OPFS
  stores, the screenshots/MHTML, the event log are all bounded (rolling windows
  or explicit retention) + the user can clear per-origin.
- **Memory checks**: run the leak probe (heap/DOM-counter deltas across loops)
  on the long-lived surfaces (the hub, the chat) regularly.
- **Performance budgets**: the SW must register fast (<500ms); the NTP/chat
  render fast (<1s); the agent loop doesn't block the UI thread; bundles stay
  reasonable (the SW bundle is ~2.5mb — watch it).
- **Performance traces**: capture a trace on the key journeys (hub load, task
  run, directory) + check for long tasks.

## 5. Web resilience (the installed skills)

The `skills/web-resilience-audit` + `skills/web-resilience-fix` skills are the
project's resilience checks: the audit runs the failure matrix (offline,
dns-fail, asset block, throttling, memory, backgrounding, permissions,
incognito, interventions) and the fix skill maps findings to the guides. Run
the audit on the extension's surfaces where applicable.

## 6. The review workflow (revised by Paul, 2026-08-27)

Every change is reviewed against this constitution. The normative rules live in
`AGENTS.md` under "Review without a second model"; the short version:

1. **Build** — a worker implements.
2. **Review** — the diff is read against the constitution (security vectors,
   accessibility, design, memory/perf) with severity + file/line. Prefer a
   FRESH SESSION that sees only the diff. There is no second model available,
   so an author review is permitted — and must then clear the falsification
   gates in step 3.
3. **Falsify, don't just inspect.** A changed assertion must be shown going RED
   against the unfixed product and GREEN after, with both recorded. A fix must
   reproduce the bug before and not after, in a real loaded extension. Deleted
   coverage must leave a guard that fails if the property comes back. These are
   mechanical; they do not depend on a reviewer noticing anything.
4. **Fix** — the worker addresses the findings.
5. **Re-review** — each finding is confirmed resolved, with evidence.
6. **Push after the suite is green at the tip.** Vision review is one gate, not
   a substitute for code/security review.

**Label reviews honestly.** `author review` and `independent review` are
different claims; never write the second when the first is what happened.
Taste, architecture and "you solved the wrong problem" are what a second reader
used to catch and no gate above replaces — those now rest on the owner using
the product. That is an accepted trade, recorded so nobody mistakes it for
coverage that exists.

## 7. Auto-research loops (performance / security / accessibility / design)

Agents actively improve the project:
- **Identify** the issues first (the audit + the constitution review), then
  work on them.
- **Strict goals**: performance budgets (SW register <500ms, render <1s),
  accessibility (WCAG AA, keyboard-complete), security (the vector list passes),
  design (the consistency checks pass).
- **Loop**: each round runs the checks → records the score → improves → re-runs
  → keeps the winner. The eval/checks are frozen; the agent improves the code.

## The current gate state
- 2026-08-15: independent review REJECTED the build twice; fix workers
  addressed the blockers (per-origin OPFS clear, MAIN-world bridge, provider
  invalidation, MV3 eval removal, sender-auth exploit, provider method) +
  highs. Re-review in flight.
