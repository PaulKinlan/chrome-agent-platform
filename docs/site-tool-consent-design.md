# Site-Tool Consent Point (eo4d) — design, one page (v2, Paul's decision)

## Decision (Paul, voice 2026-09-05)

NO per-call prompts. **A card on the FIRST call of a given site-tool; after
that, enrollment-as-consent** — he installed the origin, trusts the surface
(the UI is visible during runs). Two hard requirements ride alongside:

1. **A clear audit trail** of every site↔agent interaction — what the site
   did via the agent, and vice versa.
2. **An easy disable surface** per site/tool afterward.

## The consent rule (v2)

| Call | Card? |
|---|---|
| First call of tool T from site S, ever (per profile) | **YES — "Use *T* from *S*?"** Allow/Deny. |
| Every later call of T from S | No card. Enrollment carries it. |
| After Disable (see below) | Back to first-call state: next call cards again. |

No annotations, no site cooperation required — the card is about the FIRST
use, not about what the site declares. Simple, predictable, one card ever
per tool unless revoked.

## Requirement 1 — the audit ledger

Every site-tool call (card or not) appends one immutable ledger row:

    { at, origin, tool, runId, decision: auto|allow|deny, argDigest }

- Backed by the same store the delegation ledger uses
  (agent-delegation.js) — per-origin key, append-only, capped in entries
  NOT in bytes (dptw: no size caps).
- The Settings → Site tools page renders it inline per site: "what this
  site did via your agent, and when". Reverse direction (agent did X on
  the site) already lands in the existing run/diagnostics logs; the new
  ledger covers the site-side surface the demo finding asked for.
- Denials audit too — an audit trail that hides refusals is half a trail.

## Requirement 2 — easy disable

Per site (blanket) and per tool (surgical), straight from the Settings →
Site tools row:

- **Disable site**: flips the site's approval off — next call of ANY of
  its tools cards again. One click, reversible by re-enabling.
- **Disable tool**: same, scoped to one tool. Sits beside the existing
  per-site revoke that already exists; the new bit is that disable RE-ARMS
  the first-call card rather than silently re-approving on next enroll.

Mechanically: `siteMemory(origin).approvals` already keys per-tool grants
for non-enrolled origins; the v2 model moves enrolled origins onto the
same map — `approved[T]` present means "first call consumed", absent means
"next call cards". Disabling = deleting the key. Enrollment no longer
short-circuits `isApproved`; it only seeds the store.

## Implementation shape

- tools.js `isApproved`: enrolled origins now consult the same per-tool
  map (delete the enrollment short-circuit — ~6 lines).
- webmcp-authority.js: new reason `tool-not-consumed` when the map lacks
  the tool; the existing guard flow already surfaces authority failures
  as owner cards through the approval bridge (approval-bridge-audit.js is
  the exact seam).
- New `site-tool-audit.js`: append + read the ledger rows (reuses the
  delegation-ledger store; ~80 lines).
- Settings → Site tools: per-site + per-tool disable buttons + inline
  ledger list (~100 lines UI).
- Tests: isApproved flip (enrolled first-call cards, second doesn't),
  audit row appended on every call incl. deny, disable re-arms the card,
  ledger renders. ~180 lines implementation + ~150 lines tests.

No schema migrations — the approvals map and the delegation-ledger store
already exist.
