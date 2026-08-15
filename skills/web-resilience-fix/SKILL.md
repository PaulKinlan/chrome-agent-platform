# Web Resilience Fix

Map resilience audit findings to concrete remediation patterns, apply the fixes
(against the site's source when available), and re-run the audit to measure the
delta. Companion to web-resilience-audit.

## When to use

- The user has a resilience audit report (from web-resilience-audit or the eval
  harness) and wants the issues fixed.
- The user wants a remediation plan for a known failure class (offline, fonts,
  low memory, backgrounding).
- You are the "fix" step of the eval loop (audit → fix → re-audit → delta).

## The pattern library

Map each finding class to remediation patterns. The modern-web-guidance corpus
covers performance + font-visual-stability; **resilience-specific patterns below
are the gaps the guides must fill** (see docs/GUIDES-GAP.md). Where a guide
exists, follow it; where it doesn't, use the canonical pattern here + flag the
gap so a guide can be authored.

| Finding class | Canonical patterns |
|---|---|
| Nothing survives offline | Service worker shell (precache app shell + fallback page), `fetch` handler with cache-first for static + network-first for navigations, offline fallback UI |
| DNS/network request failures | SW fallback for navigations; graceful error surfaces; retry with backoff; `navigator.onLine` + `online`/`offline` events; don't assume requests succeed |
| JS single point of failure | Progressive enhancement (content first, JS enhances); defensive init (feature-detect, try/catch per feature, no hard dependency on one bundle); error boundaries; `defer`/`type=module` |
| CSS single point of failure | Content readable unstyled (semantic HTML, alt text); critical CSS inlined; stylesheet `media`/`onerror` fallbacks; CSS containment where possible |
| Fonts on poor networks | `font-display: swap` (never `block`); font fallback stacks with metric-compatible fallbacks; `preload` the primary font; subset/woff2; visually-stable fallbacks (modern-web-guidance: user-experience/visually-stable-font-fallbacks.md) |
| Asset starvation (throttled) | Prioritize LCP-critical assets (`fetchpriority`), lazy-load below-fold images/videos, responsive images (`srcset`/`sizes`), compress (avif/webp, brotli/gzip), avoid render-blocking |
| Low memory | Reduce JS heap (code-splitting, avoid leaks — see leak detection below); `content-visibility` for off-screen; avoid huge DOM/strings; handle `Memory` pressure events if exposed |
| Tab crash / discard | Persist critical state (sessionStorage/IndexedDB on change, not at unload); restore UI on reload (check a state flag); avoid relying on `beforeunload` |
| Backgrounded/frozen | No critical work in timers (use SW for background sync where needed); persist state before freeze; handle `visibilitychange`; resume gracefully |
| Cold start / no cache | Explicit cache headers (immutable hashed assets), SW cache, HTTP caching plan |
| Storage quota | Wrap storage writes in try/catch with a quota-aware fallback (in-memory + warn); migrate critical data early; `navigator.storage.estimate()` |
| Single-core device | Cap worker pools to `navigator.hardwareConcurrency`; don't spawn N workers unconditionally; yield to main thread |

## Guide library (guides/ — 22)
Every failure class has a guide: symptom → root cause → canonical pattern →
before/after → re-verify command. Consult the guide for the class you're fixing
(offline-fallback, font-resilience, js-resilience, backgrounding-lifecycle,
crash-recovery, permission-denial-handling, abort-controller-timeouts,
heavy-ads-interventions, dns-network-failure, third-party-dependency-resilience,
service-worker-operations, realtime-reconnect, asset-starvation, low-memory,
cold-start-cache-strategy, css-resilience, storage-quota, single-core,
session-recovery, optimistic-ui-reconciliation, spa-deep-link-routing,
hydration-consistency).

## Process

1. **Read the audit report** (`audit.json`). Group findings by failure class.
2. **For each class**: pick the patterns above, check modern-web-guidance for a
   matching recipe, and apply fixes to the source when the user provides it
   (or produce a precise remediation plan with file/line targets).
3. **Fix + retest**: re-run the audit (`deno run -A harness/run-scenario.ts <url> --all --screenshot --out /tmp/reaudit-<site>`) and compare:
   - network failures under offline/dns-fail (should drop to ~0 with a SW)
   - fonts all `loaded` or graceful fallbacks under block-fonts
   - console errors under block-js/block-css (should be ~0)
   - nav under offline (should succeed via SW shell)
   - crash/background recovery signals
4. **Report the delta** as a table (scenario → before → after → verdict).

## Leak detection

For memory-related findings, use the CDP memory domains: `Memory.getDOMCounters`
(node/JS listener counts before vs after repeated interactions), 
`Memory.prepareForLeakDetection`, and heap snapshots via the HeapProfiler domain.
A growing DOM-node or listener count across repeated flows = a leak to fix
(event listener cleanup, detached nodes, closures retaining DOM).

## Rules

- Never weaken a test to make a fix pass — the audit assertions are the contract.
- If a pattern is missing from modern-web-guidance, apply the canonical pattern
  AND flag the guide gap (docs/GUIDES-GAP.md) so it can be authored.
- One failure class can need multiple guides (e.g. offline → SW shell + offline
  UI + state sync). Don't stop at the first pattern.
