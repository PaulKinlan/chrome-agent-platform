# numbat → wasm32-wasip1 lane — BUILD + CENSUS PROOF (wrapper done, not yet admitted)

numbat core v1.24.0 + a thin WASI entrypoint wrapper (`wasi-wrapper/`). Upstream
https://github.com/sharkdp/numbat — a statically typed language for scientific
computation with physical units. Licence **MIT OR Apache-2.0** (permissive).
Pinned commit `79046422203060e296da41c8c762c506200d2c93` (tag `v1.24.0`).

## What shipped (the runnable WASI tool)
The wrapper reads a numbat program from stdin (≤2 KiB), evaluates it with the
built-in prelude (`BuiltinModuleImporter`, embedded via rust-embed — NO
filesystem/network), and prints the result (≤64 KiB). No plotting/exchangerates
default features. Error contract: bounded diagnostics, exit 0/1.

## Build proof (REAL)
`cargo build --release --target wasm32-wasip1` (wrapper crate) succeeds cleanly
(20s). Pins via the lane env (`rustup which --toolchain stable-x86_64-unknown-linux-gnu
rustc` + rustup-shim cargo) — PATH-independent. The wrapper's Cargo.lock is
COMMITTED (git deps ignore the upstream lock, so this pins the actual versions).

## CENSUS (binary) — REAL
- **18 imports, ALL `wasi_snapshot_preview1`** (pure WASI Preview 1, no JS/bindgen):
  args_sizes_get, args_get, random_get, environ_get, environ_sizes_get,
  clock_time_get, fd_close, fd_fdstat_get, fd_filestat_get, fd_prestat_get,
  fd_prestat_dir_name, fd_read, fd_readdir, fd_seek, fd_write, path_filestat_get,
  path_open, proc_exit
- 1 linear memory
- **1,757,747 bytes (~1.68 MiB) → default tier (≤16 MiB) ✓**
- sha256: `805ce2d14f3b735e500b82b06fd719397413f1b2f5f29901d201768d6324ef67`

## CENSUS (licence) — numbat-NOTICES.txt (lock-faithful)
67 crates in the wrapper's ACTUAL built tree (method: `cargo tree --locked -e
normal,build --target wasm32-wasip1` → 74 nodes − 3 workspace members − 4
proc-macros; see the NOTICES header for the exact derivation). All permissive
(MIT/Apache-2.0/BSD-2-Clause/Unlicense/BSL-1.0/Unicode-3.0) except
(`option-ext@0.2.0`, file-level weak copyleft, FLAGGED). NO GPL/AGPL/LGPL **in the
built tree**. (r-efi@5.3.0 is LGPL-2.1-or-later but target-specific to
wasm32-unknown-unknown and NOT built — excluded, documented in the NOTICES.)
Aggregate: MIT AND Apache-2.0 AND BSD-2-Clause AND Unlicense AND BSL-1.0 AND
Unicode-3.0 AND MPL-2.0.

## Reproducibility (honest caveat, carried from the htmlq lane)
Config-level reproducible (pinned toolchain + pinned commit + committed
Cargo.lock), NOT byte-level (rustc embeds build paths). Byte-level reproducibility
is the retained-build admission step.

## Five never-fabricate inputs
- source.repo: https://github.com/sharkdp/numbat ✓
- source.commit: 79046422203060e296da41c8c762c506200d2c93 (tag v1.24.0) ✓ VERIFIED
- binary.sha256: 805ce2d14f3b735e500b82b06fd719397413f1b2f5f29901d201768d6324ef67 ✓ REAL (from the built artifact)
- build.log+toolchain: REAL — the build output (toolchain stable 1.97.1 + wasm32-wasip1) is reproducible via build.sh; a retained byte-for-byte build log is the retained-build step
- sbom: UNSET (manifest+SBOM generation is the remaining admission step)

## Remaining (the reviewed admission — NOT done)
1. Register the lane in build-bundled-tool-packages.mjs + frozen evidence tree.
2. The bounded spec contract (the wrapper enforces ≤2 KiB in / ≤64 KiB out; the
   formal spec-contract.md + admission KATs are the next step).
3. Manifest + SBOM.
4. Byte-level reproducibility (path-remap) before the retained build is frozen.
