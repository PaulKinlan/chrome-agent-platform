# Bounded JS-minifier lane — provenance

Three genuine upstream engines, bundled as self-contained fresh-Worker scripts, landed as a
**disabled** (`admitted:false`, `canonicalNameClaim:false`, `canExecute:false`, `canGrant:false`)
`bundled-package` lane. No provider cutover; no tool-catalog route; the `runMinifier` API + the
descriptors are metadata only.

## Shipped worker bundles (exact bytes)

| Tool | File | Bytes | SHA-256 |
|---|---|---|---|
| `terser_bounded` | `extension/lib/terser-bounded.worker.js` | 476,767 | `fd64bfaad8e0a70e358e0f02480a5c79eedd5ca589e53626ba49bb6e0553eb24` |
| `csso_bounded` | `extension/lib/csso-bounded.worker.js` | 200,793 | `464cd0b38041d26e3bd4d7b123df1679623873c2e809e66a99e03c1583100888` |
| `html_minifier_terser_bounded` | `extension/lib/html-minifier-terser-bounded.worker.js` | 772,745 | `05064aff97f02d853d4ee446734159bddaf35afe749186f09d2193681c464baa` |

Host files: `extension/lib/js-minifier.js` (the `runMinifier` client, fresh Worker per call) and
`extension/lib/js-minifier-lifecycle.js` (the 1 MiB input / 1 MiB output / 3 s wall-timeout
envelope). These two files are the ONLY `workerHostSources` allowed by the shipped scan.

## Upstream archives (retained in D3, exact)

| Package | Archive SHA-256 |
|---|---|
| `terser 5.44.0` | `86b954e059e70d536a7918fdf7f2f74292e81e03f30a9ab4bd281484e7c9edfc` |
| `csso 5.0.5` | `f7605918aff2de20dd00b741edbc888f0f8ec0f79c060745c987a1ef50e54fd8` |
| `html-minifier-terser 7.2.0` | `eb47bb99cc849885fc0d2da65e86bab238c6536af1017bf8c6c51cc3a41fad03` |

## Dependency provenance (recorded, NOT fully closed)

- **`acorn@8.15.0`** — the terser worker's parser dependency. The lock-pinned npm tarball was
  ABSENT from the offline cache, so the build used the already-local Acorn tree at
  `vendor-runtime/node_modules/acorn` (copied + tree-hashed). **Local-tree digest:**
  `0cc57723a6daa3dea5274912289aaa624430eef50eb27674df11726d6e18447a`.
  This is a RECORD of the local-tree provenance, not an SRI verification of the upstream tarball.
  The lane remains `admitted:false` / `pending-owner-confirmation` until the exact `acorn@8.15.0`
  tarball is supplied through an approved offline source and its SRI is verified.
- **SBOM:** `tools/js-minifier/sbom/bounded-js-minifiers.cdx.json` (CycloneDX 1.5, 42 components).
- **Licence texts:** `tools/js-minifier/licenses/{terser-BSD-2-Clause,csso-MIT,
  html-minifier-terser-MIT}.txt` (the top-level BSD-2-Clause / MIT terms).
- **Build scripts:** `tools/js-minifier/scripts/` (the deterministic build overlay + the
  shipped-code scan used to produce the zero-finding static proof).

## Static proof

The shipped scan (`scripts/scan-shipped.mjs`, which the build runs over all 110+ shipped JS files)
rejects any `eval`/`Function`/`importScripts`, any `new Worker`/`SharedWorker`/`WorkerCtor` outside
the two `workerHostSources`, any dynamic `WebAssembly.instantiate`, and any `.wasm` fetch. The three
worker bundles pass this scan with zero findings.
