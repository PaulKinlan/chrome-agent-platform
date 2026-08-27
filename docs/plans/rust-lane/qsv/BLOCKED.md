# qsv lane — PATCH attempt via the rayon shim: honest STOP (precise blockers, supersedes the prior diagnosis)

Pin: upstream qsv 22.0.1, commit `0dbd4c50252c5a33686a0fae0a7cce9e7b65036d` (dathere/qsv, MIT OR Unlicense). No binary produced — the five never-fabricate inputs remain UNSET.

## What was RESOLVED + verified (the "easy tranche" items were never the real blocker)
1. **rustc 1.98 wall** — RESOLVED: `rustup toolchain install 1.98.0` succeeded; wasm32-wasip1 target added for it. qsv 22.0.1 now resolves.
2. **jemallocator default** — trivially dropped via `--no-default-features`.
3. **rayon** — the rayon-wasi serial shim applied via `[patch.crates-io]` (the xan/tokei precedent). Confirmed it no longer blocks.

## The REAL blockers (all verified by building `cargo build --release --target wasm32-wasip1 --no-default-features --features feature_capable` on rustc 1.98)
The core `feature_capable` build fails BEFORE any link because the async/network stack + mmap enter the NORMAL (non-dev) dependency graph:

1. **reqwest 0.13.4 → tokio 1.53 + socket2 0.6.5 — no wasip1 support** (tokio `compile_error!("Only features sync,macros,io-util,rt,time are supported on wasm")`; socket2 `compile_error!("Socket2 doesn't support the compile target")`). reqwest is a DIRECT NON-OPTIONAL dep of qsv (Cargo.toml:375) AND is pulled transitively via `jsonschema 0.49` feature `resolve-http` (Cargo.toml:245-249). reqwest is used in CORE files, not just network subcommands: src/clitypes.rs, src/cmd/apply.rs, src/cmd/describegpt.rs(+session.rs), src/cmd/profile.rs(+dcat_discover.rs), src/cmd/pro.rs — a `feature_capable` build genuinely requires it.
2. **memmap2 0.9.11 — no wasip1** — a direct non-optional dep (Cargo.toml:253) used in src/cmd/transpose.rs + src/odhtcache.rs, AND via `blake3 = { features = ["rayon","mmap"] }` (Cargo.toml:162).
3. **self_cell 1.3.0 (Apache-2.0 OR GPL-2.0-only, dual) in the NORMAL tree** — the GPL side contaminates the shipped expression (house rule: no GPL in the built tree). The prior diagnosis's actix-governor/actix-web hits were `[dev-dependencies]` (correctly NOT shipped); self_cell is the real normal-tree GPL hit.

## Precise patch recipe (the deep-patch fork, in order)
1. reqwest → `optional = true` + a `network` feature; gate the 6 core files' reqwest use behind it (clitypes/apply/describegpt/profile/pro + the fetch/get/geocode commands already have their own features).
2. jsonschema: drop `resolve-http` + `tls-aws-lc-rs` (keep `resolve-file`) so it stops pulling reqwest.
3. memmap2 → in-memory reads in src/cmd/transpose.rs + src/odhtcache.rs (read_to_end instead of Mmap), OR a `[patch.crates-io]` memmap2 no-op stub; drop blake3's `mmap` feature (keep `rayon` which the shim covers).
4. self_cell → replace (it's a tiny crate — a local `self_cell` reimpl or an alternative) so the dual-GPL side leaves the tree.
5. Full census of the ~951-package normal tree (now resolvable on 1.98) with the audit discipline (cargo tree --locked AND rlib absence).

## Honest disposition
This is the DEEP-patch tranche, not an "easy" admission — the core itself is entangled with reqwest/mmap (not gated behind the network features as the first plan assumed). Real, multi-file fork; no binary fabricated.
