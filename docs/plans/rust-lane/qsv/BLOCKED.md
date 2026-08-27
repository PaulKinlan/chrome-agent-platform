# qsv lane — BLOCKED on wasip1-native dependencies (honest build-feasibility finding)

Tool #6 (final) of the Rust lane queue (htmlq → numbat → bttf → tokei → xan → **qsv**).
This is a STOP-and-report, NOT a build/census proof: qsv cannot be built for
`wasm32-wasip1` without patching its dependency tree. No binary was produced, so
the five never-fabricate inputs remain honestly UNSET.

## The blocker (verified against the upstream source across three versions)

qsv ("quicksilver", `dathere/qsv`, `license = "MIT OR Unlicense"`) is a CLI, but
its default feature set and hard deps pull native/OS-targeted crates with no
`wasm32-wasip1` support:

1. **`default = ["jemallocator"]`** → `tikv-jemallocator 0.6–0.7`
   (`tikv-jemalloc-sys`, vendored C jemalloc `5.3.1`). A native-C allocator with
   no wasi target — the DEFAULT `cargo build` cannot link for wasip1 at all.
   (`--no-default-features` sidesteps this, but see #3 — it yields no runnable binary.)
2. **`memmap2 = "0.9"` (hard dep, not feature-gated)** — the `index`/`apply`
   memory-mapping path. `memmap2` gates `MmapInner` to `#[cfg(unix)]` /
   `#[cfg(windows)]` only (`wasm32-wasip1` is neither), the same wall class as
   tokei's `memmap 0.7`.
3. **`polars 0.53–0.55` (feature-driven, but hard-wired into the parquet/ipc/json
   streaming path)** — qsv's own Cargo.toml comments document the transitively
   forced `object_store/http` + DNS-resolver patch; a massive native-heavy tree
   that does not build for wasip1.
4. **Feature-gated binary**: with `--no-default-features` the `qsv` bin compiles
   to a non-functional stub (the real subcommand surface is gated behind
   `feature_capable` and friends); `cargo check`/`build` "finish" in 0.14s with an
   empty target dir — no runnable `.wasm` is emitted. So there is no minimal-but-
   useful build: either it links jemallocator (fails) or it is feature-empty.

Confirmed across: HEAD (≈22.0.1, `2fbe19c4`), tag `21.0.0`, tag `20.1.0` — all
carry `default = ["jemallocator"]` + hard `memmap2` + `polars`.

## Licence posture (the part that IS clear)

qsv itself is `MIT OR Unlicense` (permissive, no GPL family). The dependency tree
carries no GPL/AGPL/LGPL in the actually-resolvable build; the only copyleft-family
item is `r-efi` (target-specific, not in any wasip1 build — same as the htmlq/bttf
lanes already documented). So qsv is licence-admissible — the blocker is purely
build feasibility, not licence.

## Feasible path (NOT done — follow-up; the numbat-wrapper precedent)

qsv needs a PATCHED WRAPPER crate, not a direct build:
- Drop `jemallocator` via `--no-default-features` (or `default-features = false`
  + select only the pure-Rust core features — `select`/`filter`/`frequency`/`sort`
  /`join`/`dedup` are pure-Rust and do NOT need polars/memmap2/jemallocator);
- Re-enable the CORE subcommand features individually (the `feature_capable` gate
  is a build-time cfg, not a native dep), leaving `polars`/`apply`/`index`/`get_cloud`
  OFF;
- `[patch.crates-io]` `memmap2` → a wasip1 no-op stub ONLY if a core feature still
  pulls it; otherwise leave it unresolved by not enabling the `apply`/`index` path.
This mirrors the numbat core→wrapper resolution and the tokei patch plan.

## Status

- **BLOCKED** (build feasibility), licence-clean.
- Five never-fabricate inputs: UNSET (no binary → no sha256/size/import census).
- No push; docs/plans/rust-lane/qsv/ only.
