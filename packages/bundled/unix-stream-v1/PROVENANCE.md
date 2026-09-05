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
| base64 | 15,285 | `ea4b7dd02802ecdd531c0af71e0589e87918bd256002e2ccb767ac9b4fc9c003` |
| grep | 83,434 | `04d32c115c9e3a979d59cfe27ea0e5ece616efd64ff958d4fcc96bb217191588` |
| sort | 43,236 | `c72ce617adb6153487ed5f425e6de98a918aca4ddfcfd24f2884c9bc13e3d7b1` |
| tr | 37,201 | `0ddf0696ce441f33a16a1b113ab9b582435c220003b450418e6aa0fab74e55c3` |
| uniq | 32,627 | `973d78aa28f825019fbfb4aa9463dc6940a65d7da6de80590ba1a691443154df` |
| wc | 28,861 | `ce303be0226d2675019191dddbcded6d83de100922fcc10e5ee48a058c0d27d5` |

The package generator verifies exact binary hashes and the admission scanner verifies imports and declared memory against the actual bytes. Semantic KATs, negative cases, and loaded-extension 100 MiB receipts are separate admission gates; a direct Node WASI run is not extension proof.
