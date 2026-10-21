# regexops evidence tree

Evidence tree for `cap.bundled.regexops` (1.0.0), a CAP-authored deterministic
WASI tool for linear-time regex matching and bounded replacement
(chrome-agent-platform-nmc2 — the ReDoS-safe alternative to the npm `rregex`
admission attempted in tmdm).

- Subcommands:
  - `regexops match -p <pattern> [--max N]` — subject on stdin (UTF-8); JSON
    out: non-overlapping matches with byte spans + capture groups, capped at
    `--max` (default 32, hard cap 256) with an explicit `truncated` flag.
  - `regexops replace -p <pattern> -r <repl>` — subject on stdin; replaced
    text out.
- Bounds are IN THE BINARY (belt beyond the host wrapper): pattern <= 256
  chars, replacement <= 1024 chars; anything beyond exits 2.
- Match engine: the Rust `regex` crate (1.13.1) — RE2-style LINEAR-TIME
  guarantees, no backtracking, so no catastrophic ReDoS blowup exists to
  trigger.
- Stream I/O: stdin -> stdout, errors to stderr. No env, no clock, no
  randomness — deterministic by construction.
- Target: `wasm32-wasip1`
- Memory: default tier (max 128 MiB = 2048 pages).
- Imports: `wasi_snapshot_preview1` only.
- Build reproducibility: `build-a` == `build-b` byte-for-byte
  (`bash build.sh` twice; toolchain rustc/cargo 1.99.1 rustup stable,
  `--locked`, path remapping in `build.sh`).
- Licence: MIT OR Apache-2.0 (CAP-authored driver; `regex` and its workspace
  crates are MIT OR Apache-2.0 — see SBOM).
