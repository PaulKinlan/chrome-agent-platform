# WebMCP discovery — headed acceptance (the executable manual macro)

The production-path acceptance is `scripts/webmcp-acceptance.ts`. It drives the
REAL loaded-MV3 path: static detection-only MAIN + isolated scripts passively
attest HTTP(S) pages before enrollment; the hub "Discover this page" → the tab
picker → the exact picked tab; the real permission request; dynamic registration
+ current-tab injection of both packaged discovery scripts; CDP
`Debugger.scriptParsed` evidence; `[WebMCP]` console lifecycle events; and extension-only
`tools.invoke` → production `invokeSiteTool` → exact approved tab/document →
isolated → MAIN invocation with a visible page side effect, plus the
re-enrollment singleton and reload + cross-document navigation re-sync.

## Permissions: no prompt exists in this flow

`scripting` and `tabs` are OPTIONAL on the shipped manifest, but the discovery
flow never shows a permission prompt (probed 2026-08-30):

- **`scripting` is warningless** once install-granted `<all_urls>` host access
  is held: `chrome.permissions.request({permissions:["scripting"]})` settles
  **silently — no prompt — even headless**, as long as a real user gesture
  issues it. The hub's "Discover this page" click requests it JIT before the
  tab listing; the service worker's `permissions.onAdded` listener then nudges
  every open tab's passive detector to re-arm (their first arm predated the
  grant), so a fresh profile never deadlocks behind a picker that cannot open.
- **`tabs` is warned** ("read your browsing history") but the picker doesn't
  need it: install-granted `<all_urls>` already exposes tab URLs/titles to
  `chrome.tabs.query`. The capability governs tab *control* (open/navigate/
  close), not this listing.

Because no OS-level prompt exists, **headed mode needs no manual step** — the
full acceptance runs unattended on the shipped extension.

## Running the macro (headed)

Prerequisite: a machine with a display (`$DISPLAY` set) and Chromium at
`/usr/bin/chromium`.

```sh
deno run -A scripts/webmcp-acceptance.ts --headed
```

The script drives the real UI on the SHIPPED manifest (fresh profile), fully
unattended:

1. The script clicks **Discover this page** for real. The gesture issues the
   JIT **scripting** request, which settles granted **silently** (no prompt —
   asserted, not assumed); the SW re-arms the already-open fixture tab's
   passive detector; the picker opens listing the fixture tab.
2. Every later step — row pick, enrollment, injection, invocation — runs
   automatically and is asserted.

Before the fixture tab is picked, the script separately asserts that the
manifest's install-granted `<all_urls>` access covers the fixture origin. The
picker's real click re-requests the (already granted) scripting capability
without making an impossible host-prompt claim.

Every other assertion runs unattended: exact-tab injection, scriptParsed URLs
for `content/main-world.js` + `content/content-script.js`, console lifecycle
events, discovery before/after reload + navigation, the invoked side effect,
the declared-vs-global collision, the negative rejections, the singleton, and
screenshots. The run writes a machine-verifiable
`webmcp-acceptance-manifest.json` (`permissionGrant: "jit-silent-no-prompt"`,
`overallStatus: "ATTESTED"` only when every check passes) to `test-artifacts/`
by default or to `WEBMCP_ARTIFACT_DIR` when set.

## Automated mode (what CI can honestly attest)

```sh
WEBMCP_ARTIFACT_DIR=/tmp/webmcp-evidence-$(git rev-parse --short HEAD) \
  deno run -A scripts/webmcp-acceptance.ts
```

Writing outside the repository keeps the post-commit worktree clean, allowing
the manifest's `testedSourceCommit` + empty `worktreeDirtyFiles` to identify the
exact tested bytes.

Automated mode runs in two phases:

1. **Fresh-profile, SHIPPED manifest (no pregrants).** ONE real **Discover
   this page** click must carry the whole chain: the JIT `scripting` request
   settles granted (warningless — provable headless), the SW's
   `permissions.onAdded` nudge re-arms the already-open fixture tab's passive
   detector, its first snapshot registers, and the picker opens listing that
   tab. A silently empty picker — the fresh-profile deadlock — fails the run.
2. **Deep checks on a test variant** that is byte-identical to the shipped
   one EXCEPT `manifest.json` pre-holds `scripting` + `tabs`: it unions them
   into the required list, preserves every boot-critical permission, and
   removes their optional declarations so nothing is duplicated. `scripting`
   also lets the picker read Chrome's current top-level `documentId` from an
   isolated no-op `InjectionResult`; this preserves document-scoped
   reattestation without adding a `webNavigation` grant. The shipped
   `<all_urls>` host access is unchanged.

Every check runs for real; the manifest records the split grant provenance and
`overallStatus: OPEN` — the shipped-manifest fresh-profile picker path IS
attested headless, while the deep path runs on the pregranted variant (the
permission-state matrix mechanism — see docs/PERMISSION-MATRIX.md). A headed
run attests every step on shipped bytes (`permissionGrant:
"jit-silent-no-prompt"`, `overallStatus: ATTESTED` when every check passes);
headed is an optional extra, never a requirement.


## Trust boundary

The bridge key is delivered to MAIN and ISOLATED through extension-private
channels and never through `window.postMessage`; authenticated sequences protect
the transport from ordinary message injection/replay. This does **not** make the
page realm trustworthy. MAIN shares that realm, and the page owns its exposed
tools, side effects, exceptions, and return values. Those remain untrusted,
bounded page data; authority comes only from service-worker sender identity,
exact tab/document binding, enrollment-generation fencing, and owner approval.
