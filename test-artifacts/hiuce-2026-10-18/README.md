# Bounded real-browser verification — chrome-agent-platform-hiuce

2026-10-18, imp-sec lane. One headless Chrome for Testing 154.0.8037.92 launch, the
real unpacked extension loaded (`--load-extension`), closed in a `finally`.

    deno run -A test-artifacts/hiuce-2026-10-18/verify-hiuce.ts

`dist` must be current for HEAD (`npm run note:dist`); the launch helper asserts the
unpacked build exists. Screenshots are written next to the script.

## 1. 89rk4 — the Settings diagnostics copy (options page)

`chrome-extension://<id>/options/options.html`, the `options_diagnostics_logs_help` row:

- renders from i18n as copy, not as the raw key `options_diagnostics_logs_help`;
- reads: “Write webmcp-sw injection diagnostics to the extension's service-worker
  DevTools console. Page-console diagnostics remain off.”;
- names the service-worker DevTools console (what 89rk4 pointed the owner at);
- “Page-console” appears exactly once in the page, in that sentence — no surviving
  claim that a page-console diagnostic can be turned on;
- no `#diag-page-console`-style control remains.

Screenshot: `1-options-diagnostics.png` (row scrolled into view).

## 2. oagmf — the approval card's script-registration disclosure (hub page)

`chrome-extension://<id>/ntp/ntp.html` (its bundle registers `<approval-card>`), a real
`boundScriptRegistrationApprovalDetail` projection feeding a real `<approval-card>`:

- an 8-match registration projects with all 8 matches, digest, id, size, runAt, world;
- a 9-match registration is REFUSED (`undefined` from the projection), not truncated;
- the card renders a full SHA-256, `Script ID: script-42 (content_script)`,
  `Size: 48,213 bytes`, `Run at: document_idle`, `World: ISOLATED` and all 8 matches;
- the card takes a real box (1374 x 399 px) with **no horizontal overflow**
  (scrollWidth === clientWidth) now that the 2000-character body bound is gone;
- one Approve + one Deny affordance.

Screenshot: `2-approval-card-script-registration.png`.

Result: 14/14 checks GREEN (`GREEN: 14 passed, 0 failed`).

Not judged by eye: this lane's model has no vision channel, so the screenshots are the
evidence for a human/vision reviewer; every claim above is a DOM/computed-style
measurement taken in the real page, not an aesthetic judgement.
