# tokei (patched fork) — spec contract (RUNNABLE admission)

- toolId/argv0/route: a bounded `tokei` count surface (path arg → language table)
- request: one path argument (argv), the directory is host-preopened
- response: stdout table (Language/Files/Lines/Code/Comments/Blanks), bounded
- memory/imports/timeout: default tier ≤16MiB (2.10 MiB); 20 pure-WASI imports
  (all wasi_snapshot_preview1), 1 memory, NO threads/atomics/JS; bounded wall-time
- error contract: raw stderr never forwarded; bounded diagnostics; exit 1 on
  a missing/unknown path, exit 0 on success
- runtime: serial (the rayon shim + serial walk) — `--parallel` accepted but
  serial; deterministic order; no speed-up (documented, not a correctness risk)
- licence: MIT OR Apache-2.0 (tokei) + permissive deps (see tokei-NOTICES.md);
  NO GPL/LGPL/AGPL in the built tree
