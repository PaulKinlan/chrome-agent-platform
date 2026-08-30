# Permission-state matrix acceptance (headless — no headed dependency)

Owner directive (2026-08-30): there is **no headed-browser dependency**. Every
permission-state behavior the product owns is attested headless by
`scripts/permission-matrix-acceptance.ts`; a display is never required.

## The three mechanisms (all empirically verified 2026-08-30)

| Class | Permissions | Headless behavior | What the matrix asserts |
|---|---|---|---|
| Warningless | `contextMenus`, `scripting`, … | `chrome.permissions.request` **auto-grants** from a trusted CDP click | Full JIT lifecycle: Enable → granted → Turn off → absent → retry Enable → granted |
| Warned | `tabGroups`, `history`, `bookmarks`, … | The request **pends** (no prompt shown); closing the requesting page cancels it | Honest deny path: pending → cancel → settled absent → retry affordance intact on a fresh Settings page |
| Variant pre-held | any optional permission | Moving it to manifest `permissions[]` grants it **at install**, no prompt, no display | Granted state + API-functional (`chrome.history.search` resolves) + honest panel (no bogus Turn off) |

The variant builder is `scripts/permission-variant.mjs`: byte-identical
extension copy with the chosen permissions moved, a `VARIANT-INTEGRITY.json`
sha256 manifest asserting only `manifest.json` differs, and fail-closed
refusals (undeclared or already-required permissions are rejected).

## Running

```sh
deno run -A scripts/permission-matrix-acceptance.ts            # headless (canonical)
deno run -A scripts/permission-matrix-acceptance.ts --headed   # optional extra
```

`--headed` runs the identical checks without `--headless=new` (a human may
resolve a warned prompt while it pends; what is asserted is that nothing
grants *silently*). Headed is an extra, never a requirement. Evidence lands in
`test-artifacts/permission-matrix-manifest.json` (override:
`PERMISSION_MATRIX_ARTIFACT_DIR`).

## Honest exclusions — claimed nowhere as covered

1. **Chrome's native permission prompt bubble** — its rendering and its
   Allow/Deny buttons are Chrome's own code, not this product's. The product
   behaviors around it (request issued from a genuine gesture, pending state,
   cancellation, denial surface, grant handling) are all matrix-covered.
2. **The extension action-icon click** (transient `activeTab`) — no CDP
   mechanism synthesizes a toolbar click. The persistent grant paths it
   authorizes are covered through their equivalents (the capture success path
   is journey-covered: `screenshot: capture SUCCEEDS for the granted origin`).
3. **`showDirectoryPicker`** — a native OS dialog; remains a one-time manual
   smoke for the /files feature.

## What this replaced

`scripts/headed-acceptance.ts` (the 2026-08-27 macro) gated the Settings
capability lifecycle on a human clicking OS prompts and refused to run without
a display. Its permission-lifecycle coverage is superseded by this matrix; the
script remains as an optional manual-evidence extra only.
