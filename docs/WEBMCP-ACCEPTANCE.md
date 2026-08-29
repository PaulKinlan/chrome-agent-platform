# WebMCP discovery acceptance

The production-path acceptance is `scripts/webmcp-acceptance.ts`. It drives the
real loaded MV3 extension: hub **Find site tools** → tab picker → exact picked
tab → dynamic registration and immediate injection of both packaged discovery
scripts. CDP `Debugger.scriptParsed` proves that `content/main-world.js` and
`content/content-script.js` executed; console lifecycle events prove both worlds
started.

The journey then verifies declared and inferred discovery, production
`tools.invoke` dispatch to the exact approved tab/document, a visible page side
effect, bridge fencing negatives, re-enrollment singleton behavior, reload
re-injection, and cross-document navigation re-sync.

## Run

```sh
WEBMCP_ARTIFACT_DIR="$HOME/cap-evidence/webmcp-$(git rev-parse --short HEAD)" \
  deno run -A scripts/webmcp-acceptance.ts
```

The current shipped manifest grants `scripting`, `tabs`, and host access at
install. The acceptance therefore loads the production extension unchanged in
headless Chromium: there is no test-only manifest variant and no permission
prompt to bypass. Its manifest records `permissionGrant: "install-manifest"`
and reports `overallStatus: "ATTESTED"` only when every check passes.

Writing evidence outside the repository keeps a post-commit worktree clean, so
the manifest's `testedSourceCommit` and empty `worktreeDirtyFiles` identify the
exact tested bytes. Evidence includes picker, visible invocation, and reload
screenshots plus the observed script and console URLs.

## Trust boundary

The bridge key is delivered to MAIN and ISOLATED through extension-private
channels and never through `window.postMessage`; authenticated sequences protect
the transport from ordinary message injection/replay. This does **not** make the
page realm trustworthy. MAIN shares that realm, and the page owns its exposed
tools, side effects, exceptions, and return values. Those remain untrusted,
bounded page data; authority comes only from service-worker sender identity,
exact tab/document binding, enrollment-generation fencing, and owner approval.
