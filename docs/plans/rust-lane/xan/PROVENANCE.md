# xan (patched fork) — build/census proof — RUNNABLE admission BLOCKED on rayon

- Upstream: https://github.com/medialab/xan (MIT OR Unlicense, xsv heritage)
- Pinned commit: ae02022bf700b5b414c7481ebf69f207f38314ad (tag 0.60.0, annotated ^{commit})
- Patch (ours, one intent): drop the `pager` dependency for the WASI target —
  pager is only used for interactive `xan help`/`xan view` paging via a real
  `less` terminal, which WASI does not have. The change gates the dep AND the two
  call sites behind `cfg(all(not(windows), not(target_os = "wasi")))` (+ a wasi
  no-op arm in `help.rs`). This removes the `pager@0.16.1 → errno@0.2.8`
  nightly-`feature(thread_local)` chain that blocked the stable build.

## Five never-fabricate inputs
- source.repo: https://github.com/medialab/xan.git — REAL
- source.commit: ae02022bf700b5b414c7481ebf69f207f38314ad — REAL (git rev-parse HEAD)
- binary.sha256: 668e4955b659d4399475c6cb56a6da772e5e58ed83eefad871dea6bb3e8f2be4 — REAL (sha256sum of the built wasm)
- build.log+toolchain: rustup stable-x86_64-unknown-linux-gnu + wasm32-wasip1; `cargo build --release --target wasm32-wasip1` — REAL (build succeeded 1m21s)
- sbom: cargo metadata --locked (352 packages) + cargo tree --locked -e normal,build --target wasm32-wasip1 (the BUILT set) — REAL

## Binary census (REAL, from the built artifact)
- xan.wasm: 13,246,073 bytes (~12.6 MB) → DEFAULT tier (≤16 MB)
- imports: 25, ALL `wasi_snapshot_preview1` (pure WASI Preview 1, no JS/bindgen)
- memory: 1 (inline-defined; 0 imported memories)

## RUNNABLE admission: BLOCKED (honest — build proof only)
The binary BUILDS but is NOT verified runnable and is NOT admitted. Precise
blocker: `rayon` is a hard dependency used in 5 core code paths
(src/cmd/sort.rs, src/cmd/bins.rs, src/cmd/parallel.rs,
src/collections/counter.rs, src/moonblade/agg/aggregators/numbers.rs). rayon's
thread pool spawns `std::thread`, which wasi-preview1 does not support — the pool
init (global or explicit ThreadPoolBuilder) PANICS at runtime. Core subcommands
(sort, count, bins, parallel, numeric aggregations) would panic. Unblock:
serial-fallback patch (par_sort_unstable→sort, par_iter→iter, drop ThreadPoolBuilder)
across the 5 sites — tranche-2 depth, not done here. Never-fabricate: the five
inputs above are REAL but do NOT constitute a runnable admission.
