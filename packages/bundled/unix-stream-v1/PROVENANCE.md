# Streaming Unix kernels — provenance

- **Source:** authored in this repository for the Chrome Agent Platform.
- **License:** MIT (`LICENSE-MIT`).
- **Tools:** `base64`, `grep`, `sort`, `tr`, `uniq`, and `wc`.
- **Target:** `wasm32-wasip1`, WASI Preview 1.
- **Toolchain:** wasi-sdk clang 18.1.2.
- **Memory declaration:** 64 initial pages, 512 maximum pages (4–32 MiB).
- **Rebuild:** `WASI_SDK=/path/to/wasi-sdk ./build.sh`; each source is built twice and `cmp` must prove byte identity.
- **Execution profile:** stdin/stdout are synchronous OPFS access-handle adapters. All kernels except `sort` consume bounded chunks and retain at most a line or fixed transform state. `sort.wasm` is a run kernel; the host creates line-complete OPFS runs (4 MiB or 32,768 records), treats an oversized single line as a file-backed singleton, and pairwise-merges runs with ranged comparison. These are working-set parameters, not input/output ceilings.

## Binary identities

| Tool | Bytes | SHA-256 |
|---|---:|---|
| base64 | 15,346 | `20d6324f4925ee8263322bb74eb818861f13fbd0d4ce080b13c2140b213232cf` |
| grep | 83,434 | `04d32c115c9e3a979d59cfe27ea0e5ece616efd64ff958d4fcc96bb217191588` |
| sort | 35,917 | `e0543d170ac9bd0cd55b274604b55add18c17c5d87169ebfdf25b4b7245a386a` |
| tr | 37,263 | `bec02b43bdeb1997f9616d95499ce91010e124aecb1cad6e6bd97102c0956f3f` |
| uniq | 32,627 | `973d78aa28f825019fbfb4aa9463dc6940a65d7da6de80590ba1a691443154df` |
| wc | 28,861 | `ce303be0226d2675019191dddbcded6d83de100922fcc10e5ee48a058c0d27d5` |

Lexical ordering is unsigned byte order in the C locale. Numeric ordering compares optional-sign decimal prefixes without binary floating-point conversion; the Wasm run comparator and OPFS merge comparator implement the same rule and use full-line byte order as the deterministic tie-break.

The package generator verifies exact binary hashes and the admission scanner verifies imports and declared memory against the actual bytes. Semantic KATs, negative cases, and loaded-extension 100 MiB receipts are separate admission gates; a direct Node WASI run is not extension proof.
