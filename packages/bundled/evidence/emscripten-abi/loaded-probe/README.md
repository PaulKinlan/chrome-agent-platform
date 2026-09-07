# Loaded-extension A0 proof harness (test-only)

This directory supplies hash-pinned probe assets for
`scripts/emscripten-abi-loaded.ts`. It is not copied into the production tree,
registered as a tool, or admitted as a package. The harness first requires a
real production build, copies the complete extension byte-for-byte to durable
scratch, verifies exact current-source/copy manifest equality and the carried
historical manifest/CSP comparison against `snapshot.json`, and only then adds
these test assets to the private copy. It refuses any pre-existing reserved
probe path, including files, links, empty directories and descendants, before
copy/injection. Neighboring name prefixes are permitted.

The carried comparison allows only `version`/`version_name` to differ from the
historical manifest and pins all other fields. 6854's replacement execution-
relevant criterion is **PROPOSED, NOT APPROVED**; this candidate neither endorses
the overbroad pin nor implements a new metadata policy.

The browser proof is deliberately split:

1. Fresh extension-origin module workers run numeric, stb
   linear-colorspace/default-Mitchell downsampling, and clean main+side native
   goldens.
2. Embedded-JS side modules must reach the Emscripten 6.0.0 no-eval abort.
3. Each positive factory must reject both adversarial Wasm imports with a real
   engine `LinkError`, before guest code executes.
4. Only after the safe phase has zero measured external attempts, a separately
   labelled intentionally unsafe EM_JS control tries external fetch, OPFS, and
   a nested Worker. CDP attaches to workers while paused, enables request
   instrumentation, blocks the expected external fetch before delivery, and
   rejects every unexpected URL. Successful OPFS and nested-worker access prove
   why a Worker is not confinement; the request blocker is evidence safety,
   not the native authority boundary.

The browser records every observed local request, the complete hash-verified
runtime asset closure, worker targets configured before execution, copied
source/build closure, browser version, native result state, and a screenshot to
a run-specific directory under the durable evidence root.

## Historical results and remaining gates

Historical loaded RED and GREEN proof runs on production base
`77c3b19556693f86f647ebb346f19d6d49b83e17` are retained, not rerun or rewritten
by current-main integration. The RED failed worker setup with `Fetch.enable`.
The GREEN instead used `Network.enable` + `Network.setBlockedURLs`, correlating
request/failure events: numeric `42.5`, image `[128,128,128,255]`/status `1`,
clean main+side `42`, embedded-JS side graphs unsupported, six import refusals,
and an unsafe bridge reaching storage/a nested Worker with its attempted
external fetch inspector-blocked. No-eval is not confinement.

The artifact imports are **env or none**, not schema-1 WASI. Repeated compiler
builds used the same pinned installed SDK/cache, not independently provisioned
clean toolchains. The separate local compiler runner reports full-lifecycle
network behavior **not measured**. Historical loaded proof is not current-main
full-suite/browser verification, landing, package admission or a production
host. Source re-review and separately authorized current-main gates remain.

## Commands

Historical rebuild recipe for the unsafe control (not authorized during source
integration; never overwrite immutable retained compiler/probe evidence).
The SDK location below is relative to the external durable evidence root
(`CAP_DURABLE_ROOT`, default `$HOME/cap-evidence`), not the repository:

```sh
EMSDK_ROOT="${CAP_DURABLE_ROOT:-$HOME/cap-evidence}/astra/ltkj1/toolchain/emsdk" \
  packages/bundled/evidence/emscripten-abi/loaded-probe/build.sh
```

Static/local review commands (safe before browser authorization):

```sh
node packages/bundled/evidence/emscripten-abi/loaded-probe/local-import-refusal.mjs
npm run test:file -- tests/emscripten-abi-loaded-harness.test.ts
npm run test:file -- tests/harness-registry.test.ts
npm run test:file -- tests/harness-debug-port.test.ts
npm run test:file -- tests/scripts-exit-codes.test.ts
```

Future current-candidate loaded proof, **only after coordinator browser-slot authorization**:

```sh
npm run build:production
deno run -A scripts/emscripten-abi-loaded.ts
```

The first command builds the real shipped tree; the second uses the shared
`launchChrome()` and its current bounded browser slots, with a per-instance
outside-repo durable profile. It does not opt into a canonical lock or declare
itself load-sensitive. Shared quiet-window refusal semantics (exit 75 for a
load-sensitive gate) are unchanged. Do not wrap it in `flock` or name a debugging
port. A green run remains A0 evidence only: it is not vips, pthread, generic
`dlopen`, custody, schema-2, package-admission, or product-host evidence.
