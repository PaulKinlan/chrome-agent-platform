# WebMCP discovery — headed acceptance (the executable manual macro)

The production-path acceptance is `scripts/webmcp-acceptance.ts`. It drives the
REAL loaded-MV3 path: the hub "Discover this page" → the tab picker → the exact
picked tab, the real permission request, dynamic registration + current-tab
injection of both packaged discovery scripts, CDP `Debugger.scriptParsed`
evidence, `[WebMCP]` console lifecycle events, and extension-only
`tools.invoke` → production `invokeSiteTool` → exact approved tab/document →
isolated → MAIN invocation with a visible page side effect, plus the
re-enrollment singleton and reload + cross-document navigation re-sync.

## Why a manual step exists

Headless Chromium **auto-denies prompted optional permissions** (probed
2026-08-18: a real Input click and `--enable-automation` both return
`granted: false`), and CI here has no display/Xvfb. The OS-level "Allow" click
on Chrome's tabs permission bubble is browser chrome — not automatable via CDP.
The shipped manifest permanently grants `<all_urls>` host access, so no host
prompt exists. Everything before and after the tabs gesture is fully automated.

## Running the macro (headed)

Prerequisite: a machine with a display (`$DISPLAY` set) and Chromium at
`/usr/bin/chromium`.

```sh
deno run -A scripts/webmcp-acceptance.ts --headed
```

The script drives the real UI and pauses once:

1. **MANUAL STEP 1 of 1** — after the real click on "Discover this page",
   Chrome shows the **tabs** permission prompt. Click **Allow**.
   (The script polls `chrome.permissions.contains` until the grant lands.)

Before the fixture tab is picked, the script separately asserts that the
manifest's install-granted `<all_urls>` access covers the fixture origin. The
picker's real click requests the optional scripting capability without making
an impossible host-prompt claim.

Every other assertion runs unattended: exact-tab injection, scriptParsed URLs
for `content/main-world.js` + `content/content-script.js`, console lifecycle
events, discovery before/after reload + navigation, the invoked side effect,
the declared-vs-global collision, the negative rejections, the singleton, and
screenshots. The run writes a machine-verifiable
`webmcp-acceptance-manifest.json` (`permissionGrant: "manual-user-allow"`,
`overallStatus: "ATTESTED"` only when every check passes) to `test-artifacts/`
by default or to `WEBMCP_ARTIFACT_DIR` when set.

## Automated mode (what CI can honestly attest)

```sh
WEBMCP_ARTIFACT_DIR=/tmp/webmcp-evidence-$(git rev-parse --short HEAD) \
  deno run -A scripts/webmcp-acceptance.ts
```

Writing outside the repository keeps the post-commit worktree clean, allowing
the manifest's `testedSourceCommit` + empty `worktreeDirtyFiles` to identify the
exact tested bytes. Loads a **test variant** of the extension that is byte-identical to the shipped
one EXCEPT `manifest.json` pre-holds `scripting` + `tabs`: it unions them into
the required list, preserves every boot-critical permission, and removes their
optional declarations so nothing is duplicated. The shipped `<all_urls>` host
access is unchanged. Every check runs for real; the manifest records
`permissionGrant: "test-manifest-pregranted"` and `overallStatus: OPEN` — the
tabs permission-prompt gesture itself remains unattested until a headed run
completes the single manual step above.

### Pre-detector branch bases

Fresh-profile discovery depends on main's passive WebMCP detector and its
HMAC-authenticated, document-scoped detection registry. This permissions branch
predates those product files, so its picker cannot discover an unenrolled page
without becoming circular. On such a base the harness writes `NOT RUNNABLE`
evidence with the dependent steps listed in `notRun`; it never records a false
green run. The complete automated acceptance is a required post-merge gate on
the merged tree.

## Trust boundary

The bridge key is delivered to MAIN and ISOLATED through extension-private
channels and never through `window.postMessage`; authenticated sequences protect
the transport from ordinary message injection/replay. This does **not** make the
page realm trustworthy. MAIN shares that realm, and the page owns its exposed
tools, side effects, exceptions, and return values. Those remain untrusted,
bounded page data; authority comes only from service-worker sender identity,
exact tab/document binding, enrollment-generation fencing, and owner approval.
