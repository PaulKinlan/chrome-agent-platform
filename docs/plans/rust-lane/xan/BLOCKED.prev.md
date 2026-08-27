# xan lane — STOP-and-report: build BLOCKED (honest feasibility finding)

- xan = "The CSV magician" (the xsv-successor CSV/JSON/XLSX toolkit).
  Upstream https://github.com/medialab/xan, MIT OR Unlicense (xsv heritage,
  dual-licensed — licence-CLEAN, no GPL family).

## Verdict: BLOCKED (build), licence-clean — verified across two tags

xan is a CLI (`[[bin]] name = "xan"`) but CANNOT be built for wasm32-wasip1 on
STABLE without patching its dependency tree. STOP-and-report; no binary produced;
the five never-fabricate inputs remain honestly UNSET.

## The blocker (exact, verified against tags 0.59.0 AND 0.60.0)

`xan → pager@0.16.1 (the LATEST pager; target-gated [target.'cfg(not(windows))'.dependencies])
  → errno@0.2.8` — the LAST 0.2.x release before errno moved to 0.3, and it carries:

  ```rust
  // errno-0.2.8/src/lib.rs:20
  #![cfg_attr(target_os = "wasi", feature(thread_local))]
  ```

  `#![feature(thread_local)]` is NIGHTLY-only. Build fails on stable with
  `error[E0554]: #![feature] may not be used on the stable release channel`
  (reproduced: `cargo build --release --target wasm32-wasip1` on the pinned
  stable-x86_64-unknown-linux-gnu toolchain).

- errno's 0.3.x line REMOVED the feature gate (0.3.9/0.3.12/0.3.14 exist and
  build for wasi), but pager@0.16.1 declares `errno = "0.2"` (caret) — it cannot
  take 0.3 — and pager is the LATEST release (no newer pager to bump).
- `cargo update -p errno@0.2.8 --precise 0.3.14` is rejected (pager's `0.2` caret
  excludes 0.3; 0.2.8 is the only 0.2.x available).

### Secondary risks (moot until the build unblocks, but recorded)
- `rayon@1.12.0` (hard dep, parallel CSV) compiles for wasip1 but would PANIC at
  runtime when the global pool spawns (wasi-preview1 has no std::thread) — the
  tokei-class runtime risk.
- `jemallocator` is gated `cfg(all(target_env="musl", ...))` → NOT built for wasip1 (clean).
- `calamine` (XLSX read) + `rust_xlsxwriter` (XLSX write) + `flate2`(zlib-rs) are
  pure Rust → should build once errno unblocks.

## Unblock paths (NOT done — the recipe's STOP line)
1. Fork/patch `errno@0.2.8` to drop the `feature(thread_local)` gate for wasi (one
   line — thread_local! is stable since 1.59; the gate is vestigial), vendor the
   patch via `[patch.crates-io]`.
2. Or fork `pager` to allow errno 0.3.
3. Or drop the `pager` dep from xan (a fork removing `cfg(not(windows))` pager) —
   pager is only used for interactive `xan help` output, irrelevant to a WASI tool.

## Licence posture (clean)
- xan: MIT (LICENSE-MIT, © 2015-2024 Andrew Gallant, Guillaume Plique) + UNLICENSE
  (dual). No GPL/AGPL/LGPL in the xan tree itself.
- (The full dep-tree census is deferred: no binary built, so no lock-faithful
  census — the honest never-fabricate discipline.)

## Never-fabricate inputs
source.repo / source.commit / binary.sha256 / build.log+toolchain / sbom — ALL UNSET
(no binary was produced). Nothing invented.
