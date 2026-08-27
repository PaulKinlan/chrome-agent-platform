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
  failed "can't find crate for core/std". The AUTHORITATIVE pin is the build.sh
  env (`export RUSTC="$(rustup which --toolchain stable-x86_64-unknown-linux-gnu rustc)"`
  + the rustup-shim `~/.cargo/bin/cargo`); `rust-toolchain.toml` (committed,
  `channel = "stable"` + `targets = ["wasm32-wasip1"]`) documents the pin for
  when the lane is promoted.
- Tool #1: htmlq v0.4.0 (MIT, permissive — `cargo info htmlq`), upstream
  https://github.com/mgdm/htmlq, pinned commit 1361c8c46811dd7b961c3fe9c6b04f9318a345e8.
- BUILT: `cargo build --release --target wasm32-wasip1` → htmlq.wasm (~1.6 MB).
- CENSUS (binary): 16 imports, ALL `wasi_snapshot_preview1` (environ_sizes_get,
  clock_time_get, fd_close, fd_prestat_get, fd_write, path_open, proc_exit, …);
  1 linear memory; size fits the `default` tier (≤16 MB). Pure WASI Preview 1 —
  no wasm-bindgen/JS host imports.
- CENSUS (licence): htmlq-NOTICES.txt, generated from `cargo metadata --locked`
  against the COMMITTED Cargo.lock (the EXACT 77 packages the pinned build
  links). All permissive except 5 MPL-2.0 crates (cssparser@0.27.2,
  cssparser-macros@0.6.0, dtoa-short@0.3.3, selectors@0.22.0, thin-slice@0.1.1
  — file-level weak copyleft, admissible, FLAGGED). No GPL/AGPL/LGPL. Aggregated
  expression: "MIT AND Apache-2.0 AND MPL-2.0 AND Zlib AND Unlicense". Vendored
  MIT.txt + Apache-2.0.txt alongside.

## Reproducibility (honest caveat)
The build is reproducible at the CONFIG level (pinned toolchain + pinned commit
+ committed Cargo.lock), but NOT byte-level: the wasm sha256 differs across build
directories because rustc embeds build paths into the binary. Two independent
builds of the same commit produced sha 2046a314… vs c01c9f35… (same source, same
toolchain, different build dir). A byte-identical retained build would require a
path-stable build root + strip/remap flags — that is part of the retained-build
admission step, not this build/census proof.

## Recipe (see build.sh)
Pinned rustup toolchain (env, `rustup which --toolchain`) + rustup-shim cargo,
clone htmlq at the tag, `cargo build --release --target wasm32-wasip1`, copy the
.wasm. Build artifacts OUTSIDE the bundled tree (repo-root/.build/rust-lane,
gitignored); the lane's own `binaries/` is gitignored too.

## Remaining (the separate reviewed admission — NOT done this pass)
1. Register the lane in build-bundled-tool-packages.mjs PATHS + a frozen
   evidence tree (packages/bundled/evidence/rust/).
2. Author the bounded spec contract (stdin size / CSS-selector complexity /
   output cap / timeout) + the 5 never-fabricate inputs.
3. Generate manifest + SBOM (licence NOTICE + vendored texts done).
4. Inventory metadata review (catalog) + admission KATs + the drivable gate.
5. Byte-level reproducibility (path-remap) before the retained build is frozen.

## Lane queue (serial)
numbat, bttf, tokei, xan, qsv — each drops in via the same recipe.
