# qsv lane — PATCH attempt: honest STOP (deeper than the "easy" tranche-1 assumption)

Candidate (real evidence only; NO fabricated admission). Pin: upstream qsv 22.0.1
commit `8d8b57b896464ef7d7c7f906d50ce1aa4a442950` (dathere/qsv, MIT OR Unlicense).

## What I actually tried + found (all reproducible)

1. **rustc version wall**: the installed toolchain is rustc 1.97.1; qsv 22.0.1
   requires rustc 1.98 (`qsv@22.0.1 requires rustc 1.98`, `qsv-stats@0.55.0`,
   `qsv_currency@0.8.0`). `cargo build --target wasm32-wasip1 --no-default-features
   --features feature_capable` fails BEFORE any native link — the toolchain is too old.

2. **The "just drop jemallocator" assumption is wrong — polars is NOT the core
   blocker.** `cargo metadata --no-default-features --features feature_capable`
   resolves 581 packages and does NOT pull polars/object_store. The REAL
   wasip1-native blockers in the CORE graph are:
   - `memmap2 0.9.11` — used in CORE files (src/cmd/count.rs, src/cmd/transpose.rs,
     src/odhtcache.rs, src/clitypes.rs), not feature-gated.
   - `rayon 1.12` + rayon-core — parallel execution (runtime-panic risk on wasip1
     stubbed threads, the tokei class).
   - the async/network stack: `reqwest 0.13.4` + `tokio 1.53.1` + `tokio-rustls 0.26`
     + `rustix 1.1.4` — an async-TLS stack with no wasip1 support.

3. **GPL-family licence hits in the CORE graph** (house rule: no GPL in the built
   tree): `actix-governor 0.10.0` = GPL-3.0-or-later, `self_cell 1.3.0` =
   Apache-2.0 OR GPL-2.0-only (dual, but the GPL side is in the graph), `r-efi
   5.3.0/6.0.0` = MIT OR Apache-2.0 OR LGPL-2.1-or-later. These must be removed or
   the expression is GPL-contaminated.

## Precise patch plan (the real "patch" — NOT a feature flag)

A patched fork requires, in order:
1. Rust toolchain ≥1.98 (environment) OR pin an older qsv that builds on 1.97.
2. Rewrite `memmap2` → in-memory file reads in the 4 core files (count/transpose/
   odhtcache/clitypes) — real code changes.
3. Strip the async/network stack from core (reqwest/tokio/rustls/rustix): gate the
   network subcommands (fetch/get/geocode/etc.) behind a `network` feature and
   remove the transitive async deps from the core subset.
4. rayon → serial (or a wasip1 thread shim) for the core subcommands.
5. Remove/replace the GPL-family crates (actix-governor, self_cell, r-efi) so the
   shipped expression is GPL-free.

This is a multi-file fork (core src/ edits + Cargo.toml feature surgery + dep
replacement) — the "tranche 1 easy" classification was wrong for qsv. It belongs
with the deep-patch tranche (alongside tokei), not the easy drop-a-default-feature
tranche. NO binary produced; the five never-fabricate inputs remain honestly UNSET.

## Census (real, for the record)
feature_capable subset = 581 resolved packages; licence distribution:
MIT 406, Apache-2.0 54, MIT/Apache-2.0 29, Unicode-3.0 18, Zlib 14, Unlicense 11,
BSD-3-Clause 8, CC0-1.0 4, ISC 4, BSD-2-Clause 2, MPL-2.0 1, BSL-1.0 1, CDLA 1,
0BSD 1, MIT-0 1, bzip2 1, **GPL-3.0-or-later 1 (actix-governor)**.
