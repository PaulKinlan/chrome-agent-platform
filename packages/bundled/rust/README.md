# Rust → wasm32-wasip1 lane

## Provenance
- Toolchain: Rust (rustup stable, pinned to the toolchain that has the full
  `wasm32-wasip1` std — `rustup target add wasm32-wasip1`). The Arch system
  `/usr/bin/rustc` ships an EMPTY wasip1 std and shadows rustup in PATH, so the
  build pins `RUSTC=$(rustup which rustc)` + `CARGO=$HOME/.cargo/bin/cargo`.
- Tool #1: **htmlq** — "Like jq, but for HTML" (CSS-selector HTML extractor).
  - version: v0.4.0 (commit 1361c8c46811dd7b961c3fe9c6b04f9318a345e8)
  - licence: **MIT** (permissive — verified via `cargo info htmlq`)
  - upstream: https://github.com/mgdm/htmlq

## Census (built binary)
- size: ~1.6 MB (fits the `default` tier, max 16 MB)
- imports: 16, ALL from `wasi_snapshot_preview1` (environ_sizes_get,
  clock_time_get, fd_close, fd_prestat_get, fd_write, path_open, proc_exit, …)
  — pure WASI Preview 1, no wasm-bindgen/JS host imports
- memory: 1 linear memory

## Recipe (drop-in for the rest of the lane)
1. Pin the crate (tag + commit SHA), verify licence is permissive (cargo info).
2. Add a NOTICES entry for the crate + its dep tree.
3. Re-run `build.sh PASS_NAME` (the recipe is tool-agnostic).
4. Author the bounded spec contract (stdin size / selector / output / timeout
   bounds) + the 5 never-fabricate inputs.
5. Separate reviewed admission (manifest + SBOM + inventory metadata).

## Lane queue (serial)
numbat, bttf, tokei, xan, qsv — each drops in via the same recipe.
