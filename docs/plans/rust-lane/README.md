# Rust → wasm32-wasip1 lane — standup + htmlq admission proof (NOT yet admitted)

This is a WORK-IN-PROGRESS lane plan. The recipe below is PROVEN (builds htmlq to
a WASI-pure .wasm), but the lane is NOT yet registered in
scripts/build-bundled-tool-packages.mjs, has no frozen evidence tree, and has no
reviewed manifest/SBOM/inventory metadata — so it intentionally does NOT live
under packages/bundled/rust/ yet (that tree is drift-verified generator output).

## Proven in this pass
- Toolchain: Rust (rustup stable 1.97.1) + `wasm32-wasip1` std.
  BLOCKER FOUND + RESOLVED: the Arch `/usr/bin/rustc` ships an EMPTY wasip1 std
  and shadows rustup in PATH — cargo silently resolved the system rustc and
  failed "can't find crate for core/std". Pin `RUSTC=$(rustup which rustc)` +
  `CARGO=$HOME/.cargo/bin/cargo`.
- Tool #1: htmlq v0.4.0 (MIT, permissive — `cargo info htmlq`), upstream
  https://github.com/mgdm/htmlq, pinned commit 1361c8c46811dd7b961c3fe9c6b04f9318a345e8.
- BUILT: `cargo build --release --target wasm32-wasip1` → htmlq.wasm (~1.6 MB).
- CENSUS: 16 imports, ALL `wasi_snapshot_preview1` (environ_sizes_get,
  clock_time_get, fd_close, fd_prestat_get, fd_write, path_open, proc_exit, …);
  1 linear memory; size fits the `default` tier (≤16 MB). Pure WASI Preview 1 —
  no wasm-bindgen/JS host imports.

## Recipe (see build.sh)
Pinned rustc + cargo, clone htmlq at the tag, `cargo build --release --target
wasm32-wasip1`, copy the .wasm. Build artifacts OUTSIDE the bundled tree
(repo-root/.build/rust-lane, gitignored).

## Remaining (the separate reviewed admission — NOT done this pass)
1. Register the lane in build-bundled-tool-packages.mjs PATHS + a frozen
   evidence tree (packages/bundled/evidence/rust/).
2. Author the bounded spec contract (stdin size / CSS-selector complexity /
   output cap / timeout) + the 5 never-fabricate inputs.
3. Generate manifest + SBOM + licence NOTICE (htmlq MIT + dep tree).
4. Inventory metadata review (catalog) + admission KATs + the drivable gate.
