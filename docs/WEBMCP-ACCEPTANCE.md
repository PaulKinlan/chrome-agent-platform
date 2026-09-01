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

Automated mode runs in three phases:

0. **The showcase, fresh profile, SHIPPED manifest, no API key**
   (CAP-FB-20260825-SITE-AGENT-SHOWCASE-01). The hub is opened first, then the
   Showcase Shop (`/shop`, five declared tools + a visible cart). On a fresh
   profile no page can report its tools before the one-time `scripting` grant
   (arming the MAIN-world probe needs it), so the composer chip must first read
   "Check open pages for site tools" within 3 s with nothing granted; its real
   click must grant exactly `scripting` (tabs stays ungranted, nothing
   enrolled), after which the offer chip "127.0.0.1:8934 offers 5 tools — use
   them?" must appear within 3 s. Before the offer click the site's tools cannot
   be invoked. ONE real click must enroll that exact tab, name the origin in the
   status line and flip the chip to "Using … · 5 tools". The composer task is
   addressed to the site by a real `@` mention pick (routed to the site's own
   worker) on the developer-flag demo model
   (`@demo-site-tool add_to_cart {"sku":"widget-basic"}`) and must change the
   page's cart (1 item, $4.50) in under 60 s from hub load, with the
   transcript's tool card naming `add_to_cart` and the final answer carrying
   the total. The service worker is then closed and re-woken (a fresh execution
   context is asserted): the origin is reported enrolled (never re-offered) and
   `cart_total` / a second `add_to_cart` still run without re-enrollment.
   Screenshots: `showcase-check.png`, `showcase-chip.png`, `showcase-grant.png`,
   `showcase-cart-changed.png`, `showcase-tool-card.png`.
1. **Fresh-profile, SHIPPED manifest (no pregrants).** Today's hub hides the
   Agents section until it has data, so on a fresh profile the first reachable
   gesture is the composer's "Check open pages for site tools" chip: its real
   click settles the JIT `scripting` grant (warningless, no prompt), the SW's
   `permissions.onAdded` nudge re-arms the already-open fixture tab's passive
   detector, its count lands, the Agents section appears, and ONE real **Find
   site tools** click opens the picker listing that tab. The older form of this
   phase (**Discover
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
