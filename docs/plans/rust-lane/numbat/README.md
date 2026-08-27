# numbat → wasm32-wasip1 lane — build/census proof (HONEST: library, not a CLI)

numbat core v1.24.0. Upstream https://github.com/sharkdp/numbat — a statically
typed language for scientific computation with physical units. Licence
**MIT OR Apache-2.0** (permissive). Pinned commit
`79046422203060e296da41c8c762c506200d2c93` (tag `v1.24.0`).

## Build proof (REAL, not fabricated)
`cargo build --release --target wasm32-wasip1 -p numbat --no-default-features`
succeeds cleanly (14s). The two default features are dropped for WASI:
- `plotting` (→ `plotly`, a heavy non-WASI graph stack)
- `fetch-exchangerates` (→ network; not credential-free)

## CENSUS (licence) — numbat-NOTICES.txt
62 crates in the ACTUALLY-BUILT tree (`cargo tree --locked -p numbat
--no-default-features -e normal,build --target wasm32-wasip1`). All permissive
(MIT / Apache-2.0 / BSD-2-Clause / Unlicense / BSL-1.0 / Unicode-3.0) except
ONE MPL-2.0 (`option-ext@0.2.0`, file-level weak copyleft, FLAGGED). NO
GPL/AGPL/LGPL. Aggregate: MIT AND Apache-2.0 AND BSD-2-Clause AND Unlicense AND
BSL-1.0 AND Unicode-3.0 AND MPL-2.0.

## HONEST BLOCKER — numbat core is a LIBRARY, not a CLI
The lane recipe (htmlq) assumes a drop-in CLI binary (`cargo build` → a `.wasm`
from a `main`). **numbat core has no `bin` target** — it builds an `rlib`, so no
runnable `.wasm` is produced by the lib build alone. The CLI/REPL (rustyline +
TTY) lives in `numbat-cli` and is NOT WASI-compatible.

To produce a runnable WASI tool, the remaining step is a thin **WASI entrypoint
wrapper bin** (~50 lines) in this lane:
1. read the numbat program text from stdin (bounded ≤2 KiB),
2. build a `numbat::Context` (prelude modules are embedded via `rust-embed`;
   exchange rates are bundled in `numbat-exchange-rates`),
3. interpret/format the result and write it to stdout (≤64 KiB cap),
4. exit 0/1.

This wrapper is the admission follow-up (with the spec contract + the five
never-fabricate inputs), NOT part of this build/census proof — reported
honestly, exactly like the jq lane's B1–B3.

## CENSUS (binary) — deferred
No `.wasm` is built yet (see blocker), so the import/memory census (the htmlq
proof's 16-imports/1-memory/1.6MB figures) is deferred to the wrapper admission
step. The core rlib does link `wasi_snapshot_preview1` via `getrandom` (rand's
entropy) and `libc`, so the eventual binary will be WASI-preview1-pure.

## Reproducibility (honest caveat, carried from the htmlq lane)
Config-level reproducible (pinned toolchain + pinned commit + committed
Cargo.lock), NOT byte-level: rustc embeds build paths. Byte-level reproducibility
is part of the retained-build admission step.

## Five never-fabricate inputs (documented, UNVERIFIED this pass)
- source.repo: https://github.com/sharkdp/numbat
- source.commit: 79046422203060e296da41c8c762c506200d2c93 (tag v1.24.0) — VERIFIED
- binary.sha256: UNSET (no binary yet — see blocker)
- build.log+toolchain: UNSET (retained build is the admission step)
- sbom: UNSET (manifest+SBOM generation is the admission step)
