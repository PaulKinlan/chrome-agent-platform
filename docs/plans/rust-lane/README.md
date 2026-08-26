# Rust → wasm32-wasip1 lane — build/census proof (NOT yet admitted)

This is a WORK-IN-PROGRESS lane plan. The recipe below is PROVEN (builds htmlq to
a WASI-pure .wasm + full dependency-tree licence census), but the lane is NOT yet
registered in scripts/build-bundled-tool-packages.mjs, has no frozen evidence
tree, and has no reviewed manifest/SBOM/spec-contract/inventory metadata — so it
intentionally does NOT live under packages/bundled/rust/ yet (that tree is
drift-verified generator output).

## Proven in this pass
- Toolchain: Rust (rustup stable 1.97.1) + `wasm32-wasip1` std.
  BLOCKER FOUND + RESOLVED: the Arch `/usr/bin/rustc` ships an EMPTY wasip1 std
  and shadows rustup in PATH — cargo silently resolved the system rustc and
  failed "can't find crate for core/std". Pin the EXPLICIT toolchain
  (`rustup run stable-x86_64-unknown-linux-gnu`) + `rust-toolchain.toml`
  (channel + target) so resolution cannot fall back to /usr/bin.
- Tool #1: htmlq v0.4.0 (MIT, permissive — `cargo info htmlq`), upstream
  https://github.com/mgdm/htmlq, pinned commit 1361c8c46811dd7b961c3fe9c6b04f9318a345e8.
- BUILT: `cargo build --release --target wasm32-wasip1` → htmlq.wasm (~1.6 MB).
- CENSUS (binary): 16 imports, ALL `wasi_snapshot_preview1` (environ_sizes_get,
  clock_time_get, fd_close, fd_prestat_get, fd_write, path_open, proc_exit, …);
  1 linear memory; size fits the `default` tier (≤16 MB). Pure WASI Preview 1 —
  no wasm-bindgen/JS host imports.
- CENSUS (licence): full dependency-tree audit in htmlq-NOTICES.txt — 110
  resolved packages, all permissive except 5 MPL-2.0 crates (cssparser,
  selectors, dtoa-short, thin-slice, cssparser-macros — file-level weak copyleft,
  admissible, FLAGGED). No GPL/AGPL/LGPL. Aggregated expression:
  "MIT AND Apache-2.0 AND BSD-2-Clause AND Unicode-3.0 AND MPL-2.0 AND Unlicense".

## Recipe (see build.sh)
Pinned explicit rustup toolchain + rust-toolchain.toml, clone htmlq at the tag,
`cargo build --release --target wasm32-wasip1`, copy the .wasm. Build artifacts
OUTSIDE the bundled tree (repo-root/.build/rust-lane, gitignored).

## Remaining (the separate reviewed admission — NOT done this pass)
1. Register the lane in build-bundled-tool-packages.mjs PATHS + a frozen
   evidence tree (packages/bundled/evidence/rust/).
2. ~~Add a NOTICES entry~~ — DONE: htmlq-NOTICES.txt (dep-tree licence audit).
3. Author the bounded spec contract (stdin size / CSS-selector complexity /
   output cap / timeout) + the 5 never-fabricate inputs.
4. Generate manifest + SBOM (licence NOTICE done).
5. Inventory metadata review (catalog) + admission KATs + the drivable gate.

## Lane queue (serial)
numbat, bttf, tokei, xan, qsv — each drops in via the same recipe.
