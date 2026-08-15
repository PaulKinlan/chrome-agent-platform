# Web Resilience Audit

Audit a website against a matrix of failure states (offline, DNS interception,
asset loss, throttling, CPU/memory pressure, backgrounding) using raw Chrome
DevTools Protocol, and produce a structured findings report. The companion
skill (web-resilience-fix) maps findings to remediation patterns.

## When to use

- The user asks to check a site's resilience, failure handling, offline behavior,
  low-end-device behavior, or "what happens when X breaks".
- The user wants a resilience test plan for a URL (interaction paths included).
- You are evaluating a fixture site against a rubric (run via the eval harness).

## How it works

1. **Run the scenario matrix** (all scenarios, or the ones the user asks for):

```bash
# single scenario
deno run -A /tmp/web-resilience/harness/run-scenario.ts <url> --scenario offline --screenshot --out /tmp/audit-<site>
# full matrix (recommended first pass)
deno run -A /tmp/web-resilience/harness/run-scenario.ts <url> --all --screenshot --out /tmp/audit-<site>
```

2. **Read `/tmp/audit-<site>/audit.json`** — one `ScenarioReport` per scenario:
   - `networkFailures` — every `Network.loadingFailed` (errorText, canceled, blockedReason)
   - `consoleErrors` / `uncaughtExceptions` — JS failures under the injected condition
   - `perf` — FCP/DCL/load + full metric set
   - `fonts` — font faces + their status (loaded/error/unloaded)
   - `pageTextSample` — body text (lets text-only models analyze without vision)
   - `screenshotPath` — PNG per scenario (attach to context when vision-capable)
   - `navSucceeded`, `crashDetected`

3. **Analyze per scenario** and answer these questions:
   - **offline / dns-fail**: Does anything survive? Is there a service worker /
     app-shell fallback / cached shell? Or a blank page + uncaught errors?
   - **block-js / block-css**: Does the page degrade gracefully (content visible,
     no dead UI) or go blank/white? Progressive enhancement present?
   - **block-fonts**: FOIT vs FOUT? Does the fallback stack render? (`fonts`
     status shows `error`; compare the screenshot)
   - **throttled-***: Which assets starve? Font swap behavior? LCP affected?
   - **cpu-***: Long tasks / INP risk (from perf metrics + the report).
   - **memory-critical / tab-crash**: State preserved on reload? Crash recovery?
   - **backgrounded**: Timers/persistence survive freeze/resume?
   - **no-cache**: True first-load cost; is caching configured?
   - **storage-quota**: Persistence writes fail gracefully or throw?
   - **hardware-concurrency**: Worker/pool code assumes more cores than 1?

4. **Emit the findings report** as a structured list — one finding per failure
   class, each with: scenario, observed signal (quote the error text/status),
   severity (critical/major/minor/info), and the affected resource.

## Interaction coverage (test plans)

The harness accepts a JSON interaction plan (`harness/interactions.ts`):
`deno run -A harness/leak-probe.ts <url> --steps plan.json` drives the steps and
`harness/run-scenario.ts` can run scenarios with interactions. Plans can be
DOM-derived (the harness extracts forms/buttons/links) or user-described; Chrome
DevTools recorder macro exports map to the same step format.

## Leak detection (optional deep-dive, not a matrix scenario)

`deno run -A harness/leak-probe.ts <url> --loops 10` samples heap + DOM-counter
deltas across repeated interaction loops — a growing heap/node/listener count
is a leak to flag in the findings (see web-resilience-fix).


Loading alone misses interaction-dependent failures. Extend the audit with a
**test plan**:
- Auto-derive: analyze the DOM (forms, buttons, links, app-shell navigation)
  and pick the most likely user flows (submit a form, open a dialog, paginate,
  auth flow). Run the flows under the failure scenarios (inject the scenario,
  drive the interaction via Runtime.evaluate, then capture).
- Or let the user describe the flows they care about ("sign in, add to cart,
  checkout, offline payment retry").
- Reuse recorded macros when available (Chrome DevTools recorder exports) —
  the harness accepts a list of interaction steps as JSON.

## Source-aware audit (optional)

Pass `--source <dir>` to also analyze the site's SOURCE (like web-uplift):
derive user flows + expectations from the code (routes, forms, error paths,
feature flags), then build richer test plans for the interaction scenarios.
The audit skill uses source to DESIGN tests; the fix skill uses source to
APPLY them — the find/fix delineation is preserved (both may read the source,
but the audit still only REPORTS, the fix only CHANGES).

## Vision guidance

Screenshots are captured for every scenario. **Attach them to your context
only if your model's provider is vision-capable** (Claude, GPT-4o/5, Gemini).
For text-only providers (DeepSeek, GLM), rely on the structured signals
(network failures, console errors, font status, page text, perf) — they are
sufficient for the findings classes above. CLI users can route screenshots to
a vision model separately (`--vision <provider>` — see harness/vision.ts).

## Rules

- Never modify the target site — the audit is read-only (CDP emulation +
  interception only).
- A scenario that "completes" despite the injection (e.g., offline nav still
  succeeds) is itself a finding (cached shell / SW) — record it, don't dismiss it.
- If a scenario run errors (injection failed, navigation timed out), record the
  error in the finding — do not silently skip.
