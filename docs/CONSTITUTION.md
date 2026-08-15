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
  Derive the origin from `sender.tab.url`, reject claimed-origin mismatches,
  treat all tool reports as page-controlled data, bound + validate descriptors.
  (The re-review reproduced this exploit; the fix must hold.)
- **Unvalidated tool invocation** — every discovered tool is called with a
  validated schema (the descriptor's inputSchema, enforced as a zod schema).
  No `z.record(z.any())` bypass.
- **Destructive browser actions** — open/navigate/close/screenshot tabs need an
  explicit, scoped user grant (per-task or per-origin, not a permanent global).
  Read/list are ungated.
- **Untrusted content → model → action** — page text can influence a model that
  can act. Prompt-injection: model output must not directly trigger destructive
  actions without the grant.
- **MV3 CSP** — no `eval`/`new Function` in the bundle (verified: 0 sites).
- **XSS** — chat/directory/memory render untrusted data with `textContent`/
  escaping, never `innerHTML` with unvalidated data.
- **Permissions** — ALL optional (Paul's hard requirement): the manifest declares
  an empty `permissions` array; `alarms`/`storage`/`sidePanel`/`tabs`/`scripting`/
  `notifications` are `optional_permissions`, host access is
  `optional_host_permissions`. No `debugger` anywhere (it cannot be optional and
  carries Chrome's all-sites warning) — screenshots use
  `chrome.tabs.captureVisibleTab`. The extension boots + runs with ZERO optional
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
- The theme picker themes every surface consistently.
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

## 6. The reviewer-agent workflow (LLM-as-judge)

Every change is reviewed by an independent agent against this constitution:

1. **Build** — a worker implements.
2. **Review** — a DIFFERENT model/session reviews the diff against the
   constitution (security vectors, accessibility, design, memory/perf) with
   severity + file/line. Not the same model that wrote it.
3. **Fix** — the worker addresses the findings.
4. **Re-review** — the reviewer confirms each finding resolved, with evidence.
5. **Push only after re-review clears.** Vision review is one gate, not a
   substitute for code/security review.

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
