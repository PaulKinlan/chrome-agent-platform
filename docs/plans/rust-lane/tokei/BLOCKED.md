# tokei lane — BLOCKED on wasip1-native dependencies (honest build-feasibility finding)

Tool #4 of the Rust lane queue (htmlq → numbat → bttf → **tokei** → xan → qsv).
This is a STOP-and-report, NOT a build/census proof: tokei cannot be built
directly for `wasm32-wasip1`.

## The blocker (verified against the upstream source, all three recent tags)

tokei is a CLI (`[[bin]]`, `license = "MIT OR Apache-2.0"`), but unlike bttf it
pulls native-OS-targeted crates that have NO `wasm32-wasip1` support:

1. `grep-searcher 0.1.7` (hard dep, used for `LineIter`/`LineStep` in the lexer)
   → `memmap 0.7.0`. `memmap` gates `MmapInner` to `#[cfg(unix)]`/`#[cfg(windows)]`
   only, so the wasip1 build fails with "use of undeclared type `MmapInner`".
2. `dirs 3.0.1` (hard dep) → `home 0.5.x`. `home_dir_inner` is gated to
   `#[cfg(any(unix, target_os="redox"))]`, so the build fails with
   "use of undeclared ... home_dir_inner". (This is the v13/v14 failure; v12.1.2
   fails first on memmap.)
3. `rayon` (hard dep, parallel counting). Compiles for wasip1 (std::thread stubs)
   but would PANIC at runtime when the pool spawns — a separate runtime risk even
   after the build blockers are shimmed.

Confirmed across tags: v12.1.2 (memmap), v13.0.0 (grep-searcher 0.1.13 — still
memmap2/native), v14.0.0 (home 0.5.9). None build for wasip1 without patching.

## Licence posture (the part that IS clear)

Full resolve (`cargo metadata --locked`, 137 packages) is ALL permissive —
MIT / MIT OR Apache-2.0 / Apache-2.0 / BSD-2-Clause / BSD-3-Clause /
Unlicense / Zlib / CC0-1.0 / BSL-1.0 / (LLVM-exception). ZERO GPL/AGPL/LGPL/MPL
in the FULL resolve. So tokei is licence-admissible — the blocker is purely
build feasibility, not licence.

## Feasible path (NOT done — this is the follow-up, the numbat-wrapper precedent)

tokei needs a PATCHED WRAPPER crate (not a direct build):
- `[patch.crates-io]` `memmap` → a wasip1 no-op stub (return `Err`/"unsupported"
  from `Mmap`; grep-searcher's mmap is for search, tokei's LineStep path can use
  a buffered-reader fallback), OR patch grep-searcher to a non-mmap reader;
- `home` → a wasip1 stub returning `None`;
- `rayon` single-threaded (default-features=false + `rayon::ThreadPoolBuilder`
  with 1 thread) or replace with a serial fallback.
This is a "patch-shim" admission, one tier harder than the direct-bin crates
(htmlq/bttf). Recommend the coordinator re-scope tokei as a patch-shim ticket
rather than a direct-build one, and skip ahead to xan/qsv if those are direct bins.

## Never-fabricate note
No binary was produced, so there is NO sha256 / import census / byte size to
report — all five never-fabricate inputs remain legitimately UNSET. Nothing here
is invented.
