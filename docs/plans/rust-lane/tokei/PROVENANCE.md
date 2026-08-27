# tokei (patched fork) — provenance

- upstream: https://github.com/XAMPPRocky/tokei — MIT OR Apache-2.0
- pinned commit: 8cdd6fa3a54f8cd69442d2f00effb29aa3110353 (tag v14.0.0)
- patches (this repo, docs/plans/rust-lane/):
  - rayon-wasi/ (serial shim, MIT OR Apache-2.0) — [patch.crates-io] rayon
  - home-wasi/ (home_dir env stub, MIT OR Apache-2.0) — [patch.crates-io] home
  - ignore-wasi/ (fork of ignore-0.4.22: wasi from_path/from_entry_os, MIT OR
    Apache-2.0; upstream ignore is Unlicense OR MIT) — [patch.crates-io] ignore
  - tokei src/utils/fs.rs: build_parallel → serial build() (thread-free walk)
- binary.sha256: 94b92edc10c4f3844d1aa30ed6baf948fb4fdd00165909ae28e2b55e97cf02a3 (2,200,912 bytes, ~2.10 MiB default tier; 20 imports ALL wasi_snapshot_preview1, 1 memory, no threads/JS)
- never-fabricate inputs: source.commit pinned + verified; binary.sha256 real;
  build log + toolchain = the build.sh above; SBOM = census in NOTICES.

## RUNNABLE (verified via node:wasi)
- `tokei .` over extension/lib (preopened) → 112 files, 42,217 lines across
  JavaScript + Plain Text, EXIT 0. Counts are real (not the prior 0-files gap).

## Root-cause notes (the runtime gap, now fixed)
1. The rayon-wasi shim was INCOMPLETE: missing `par_bridge` (IntoParallelIterator),
   `par_iter_mut` (IntoParallelRefMutIterator, incl. BTreeMap) and rayon's 2-arg
   `reduce`. A stale Cargo.lock pinned the REAL rayon, whose par_bridge spawns a
   channel + threads → hangs on wasi-preview1. Fixed: completed the shim +
   `cargo update -p rayon -p home -p ignore` in build.sh + patched tokei's single
   `.reduce(identity, op)` → std `.fold(init, op)` (equivalent).
2. The serial walk cloned `tx` instead of consuming it, so the crossbeam channel
   never closed and `rx.into_iter()` blocked forever. Fixed: `drop(tx)` after the
   walk (see wasi-serial.patch).

## Status
BUILD + CENSUS proven. RUNNABLE count is the remaining gap (BLOCKED.runtime.md).
