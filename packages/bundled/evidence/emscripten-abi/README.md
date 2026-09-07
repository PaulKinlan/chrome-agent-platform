# Emscripten 6.0.0 ABI build evidence (A0 compiler checkpoint)

This directory is source/build evidence for `chrome-agent-platform-ltkj.1`. It
is **not** an admitted package, product runtime, loader, or schema change. None
of these files is copied into `extension/`, and every `negative-*` artifact is
adversarial evidence that must remain outside production loading.

## What was built

All generated JavaScript uses Emscripten 6.0.0 with `MODULARIZE=1`,
`EXPORT_ES6=1`, `ENVIRONMENT=worker`, `DYNAMIC_EXECUTION=0`, `FILESYSTEM=0`, a
fixed 16 MiB unshared memory, and explicit native exports.

- `numeric`: genuine native floating-point multiply/add; `6 * 7 + 0.5 = 42.5`.
- `image-resize`: a thin C wrapper around pinned `stb_image_resize2`. It uses
  `stbir_resize_uint8_linear`, meaning linear colorspace, with stb's default
  Mitchell filter for this downsampling case (Catmull–Rom is the default for
  upsampling). The local proof resizes a 2×2 red/green/blue/white image to one
  pixel `[128,128,128,255]`; this is library code, not a no-op stand-in.
- `link-main` + `link-side`: `MAIN_MODULE=2`/`SIDE_MODULE=2`, no `EM_ASM` or
  `EM_JS`; the main's pinned `dylink.0` dependency is `link-side.wasm`, and
  native input 35 returns 42.
- `negative-main-em-asm` + `negative-side-em-asm`: actual side import
  `env.emscripten_asm_const_int (i32,i32,i32)->i32`; loading aborts with
  `DYNAMIC_EXECUTION=0 was set, cannot eval`.
- `negative-main-em-js` + `negative-side-em-js`: actual side import
  `env.side_js_increment (i32)->i32`; loading aborts with the same diagnostic.
- `negative-global`: native code calls the real emitted
  `env.cap_ambient_global_probe ()->i32` bridge. It returns `0x434150` after
  observing `globalThis.fetch` and `globalThis.WebAssembly`, proving that
  no-eval alone is not confinement.

`artifact-report.json` contains every emitted glue/Wasm byte length and SHA-256,
every Wasm import module/symbol/kind/function signature or object type, named
export kinds, linear-memory and table types, total imported-plus-defined global
counts, tag types, and decoded `dylink.0` memory/table and dependency metadata. This evidence
decoder is not a full typed-export/global decoder or an admission validator. All
15 assets from repeated `build-a` and `build-b` builds using the same pinned
installed SDK/cache are byte-identical. This is not independent clean-toolchain
provisioning or a hermetically retained SDK/cache. Every glue file has zero `eval(...)` calls and zero
`new Function(...)` constructors. Generated worker glue still references its
ambient JS realm for runtime setup and asset reads; the confined claim is only
that the positive native fixtures import no Emval, EM_JS, EM_ASM, arbitrary
property-call, network, storage, or worker bridge. A Worker by itself is not an
authority boundary.

`runtime-report.json` records harmless local Node execution. Main Wasm bytes are
provided directly. The link fixture's generated `file:` asset read is
intercepted by an exact in-memory map to the pinned side bytes during factory
initialization. The runner restores `fetch` before calling native exports and
therefore labels full-lifecycle network behavior **not measured**; it makes no
zero-network claim. This does not substitute for shipped-extension CSP and CDP
request evidence.

## Pinned rebuild

The complete compiler/archive/dependency/source pin set is in
`provenance.json`. The historical toolchain archives and installed SDK/cache
were recorded under `astra/ltkj1/` relative to the external durable evidence
root (`CAP_DURABLE_ROOT`, default `$HOME/cap-evidence`); these are external
historical records, not tracked repository files or product runtime inputs. The sealed recovery preserves archives and
metadata, not a hermetic copy of the SDK manager/cache. Reprovisioning remains
unverified; do not rebuild or refresh the retained evidence to update source docs.

```sh
EMSDK_ROOT="${CAP_DURABLE_ROOT:-$HOME/cap-evidence}/astra/ltkj1/toolchain/emsdk" \
  packages/bundled/evidence/emscripten-abi/build.sh
npm run test:file -- tests/emscripten-abi-evidence.test.ts
```

The build script refuses any emsdk source commit other than
`d223ae73c6998296e3ab27cf81dc2c2c9fd383de` or compiler version other than
6.0.0. It rebuilds both output trees, regenerates the static report, and runs
all harmless local fixtures.

## Compatibility verdict and boundary

| Fixture | Measured compiler/local result | Admission implication |
|---|---|---|
| Numeric thin native | PASS | ABI candidate only |
| stb linear-colorspace/default-Mitchell downsample | PASS | Representative image operation only; not vips |
| Main + side, no embedded JS | PASS | No-eval eager side linking exists in 6.0.0 |
| Side `EM_ASM` | UNSUPPORTED | Reject this graph |
| Side `EM_JS` | UNSUPPORTED | Reject this graph |
| Native ambient-global `EM_JS` | UNSAFE DEMONSTRATED | Reject any such bridge |
| wasm-vips 0.0.18 | REJECTED BASELINE, not executed | Preserve historical evidence unchanged |

This resolves the 6.0.0 source-comment discrepancy narrowly: a harmless
main+side graph works under no-eval, while side modules carrying embedded JS hit
the guarded linker abort. It does not establish generic `dlopen`, late linking,
constructor, vips, pthread, custody, revocation, or production authority support.
These fixtures use an **env ABI or no imports**, not the unchanged schema-1
WASI contract.

## Historical loaded proof and current candidate

Historical loaded **RED and GREEN runs exist** on the production copy based on
`77c3b19556693f86f647ebb346f19d6d49b83e17`; that is the old base, not an A0
implementation commit. The RED worker setup used unsupported `Fetch.enable`;
it remains a setup failure, not a native assertion or the GREEN mechanism.
The GREEN uses `Network.enable` + `Network.setBlockedURLs` and correlates
request/failure events. It records numeric `42.5`, RGBA `[128,128,128,255]`
with status `1`, clean main+side `42`, two embedded-JS aborts, and six native
import refusals. The unsafe bridge reaches storage and a nested Worker; its
attempted external request is inspector-blocked for harness safety. No-eval is
not confinement, and inspector blocking is not product authority.

The future source candidate in `loaded-probe/` and
`scripts/emscripten-abi-loaded.ts` requires a current production build, verifies
a durable byte-identical copy, then injects only snapshot-pinned test assets.
Its reserved probe path must be absent before any copy/injection, including
empty directories and dangling links. Historical source/evidence and generated
assets remain unchanged by this integration.

This historical browser observation is not current-main/full-suite/landing
verification or a production runtime/admission claim. Independent source
re-review, current-main full-suite and authorized browser gates remain required.
The carried manifest comparison still permits only `version`/`version_name`
and pins all other fields plus CSP. That overbroad comparison is not endorsed:
6854's minimal execution-relevant replacement is **PROPOSED, NOT APPROVED**;
no new metadata policy is implemented here.
