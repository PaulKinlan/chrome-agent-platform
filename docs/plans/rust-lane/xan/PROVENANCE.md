# xan (patched fork) — RUNNABLE admission (serial WASI)

- Upstream: https://github.com/medialab/xan (MIT OR Unlicense, xsv heritage)
- Pinned commit: ae02022bf700b5b414c7481ebf69f207f38314ad (tag 0.60.0)
- Patches (ours, four intents):
  1. Drop the `pager` dependency for WASI (interactive `less` paging does not
     exist under WASI): gate the dep + call sites behind
     `cfg(all(not(windows), not(target_os = "wasi")))` + a wasi no-op arm in
     `help.rs` — removes the `pager@0.16.1 → errno@0.2.8` nightly-only chain.
  2. Install the **rayon-wasi serial shim** via `[patch.crates-io]` (see
     ../rayon-wasi/README.md) — replaces rayon's thread pool with serial
     equivalents so the parallel subcommands (sort/count/bins/parallel/aggregate)
     RUN under wasi-preview1 instead of panicking on thread spawn.
  3. Replace **namedlock** (GPL-2.0+) with the **namedlock-wasi** no-op stub —
     file locking is meaningless under wasip1 single-threading.
  4. Replace **priority-queue** (LGPL-3.0 OR MPL-2.0) with the
     **priority-queue-wasi** Vec-backed stub — top-k sizes are small, O(n) is fine.

## Five never-fabricate inputs
- source.repo: https://github.com/medialab/xan.git — REAL
- source.commit: ae02022bf700b5b414c7481ebf69f207f38314ad — REAL (git rev-parse HEAD)
- binary.sha256: d8a1246ccf7c06d02b88656344909a677af58e5fd3d28464800c5815f5d4bd06 — REAL
- build.log+toolchain: rustup stable-x86_64-unknown-linux-gnu + wasm32-wasip1; `cargo build --release --target wasm32-wasip1` — REAL (1m07s)
- sbom: cargo metadata --locked (352 packages) + cargo tree --locked -e normal,build --target wasm32-wasip1 — REAL

## Binary census (REAL)
- xan.wasm: 13,024,176 bytes (~12.4 MiB) → DEFAULT tier (≤16 MiB)
- imports: 25 functions, ALL `wasi_snapshot_preview1` (pure WASI Preview 1)
- memories: 0 imported; 0 thread/atomic imports (serial shim proven)

## RUNNABLE (verified via node:wasi)
- `printf 'name,age\nAlice,30\nBob,25\n' | xan count` → `2`
- `printf 'name,age\nAlice,30\nBob,25\n' | xan select name` → `name\nAlice\nBob`

## Serial-semantics disclosure
The `--parallel` flag is accepted but runs serially (the rayon shim). Results are
identical (par_iter order was unspecified; serial is strictly deterministic).
No speed-up — a documented limitation, not a correctness risk.
