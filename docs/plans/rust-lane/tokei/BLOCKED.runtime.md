# tokei — BUILD + census DONE; runtime count is the remaining gap

## What's PROVEN
- **BUILD**: tokei v14.0.0 builds for wasm32-wasip1 with three patch layers:
  1. `rayon` → rayon-wasi serial shim (reused, [patch.crates-io]).
  2. `home` → home-wasi stub (home_dir from HOME env; etcetera only calls home_dir).
  3. `ignore` → ignore-wasi fork (the `from_path`/`from_entry_os` "unsupported
     platform" stubs replaced with fs::metadata-based impls) + tokei's
     `get_all_files` switched from `build_parallel()` (scoped-thread spawn →
     panic on wasi) to the serial `build()`.
  - memmap2 0.9.4 (via grep-searcher) compiles for wasip1 as-is (no stub needed).
- **Reproducible**: rebuild is byte-identical (sha256 in metadata/sha256.txt).
- **Binary**: 2,246,692 bytes (~2.14 MiB) default tier; 21 imports ALL
  wasi_snapshot_preview1; 1 memory; NO threads/atomics/JS.
- **Census (lock-faithful)**: 129 packages in the built tree, all permissive.
  ONE MPL-2.0 (colored@2.1.0 — file-level weak copyleft, flagged). NO
  GPL/LGPL/AGPL.

## The remaining runtime gap (honest)
The wasm EXITS 0 with no panic (the "failed to spawn thread" is resolved), but
the serial directory walk enumerates 0 files — tokei prints an empty table.
The walk entry construction (ignore-wasi from_entry_os / serial Walk descent)
needs the house wasi runtime's fd/readdir instrumentation to pin the exact
failure. NOT yet a runnable admission — no fabricated "counts code" claim.
