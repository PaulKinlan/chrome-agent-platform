# compressops evidence tree

Evidence tree for `cap.bundled.compressops` (1.0.0), a CAP-authored deterministic
WASI tool for zstd and brotli compression, decompression, and frame inspection.

- Subcommands:
  - `compressops zstd [-d] [-l 1..19]`
  - `compressops brotli [-d] [-q 0..11]`
  - `compressops info`
- Stream I/O: stdin -> stdout, errors to stderr.
- Target: `wasm32-wasip1`
- Memory: default tier (max 128 MiB = 2048 pages).
- Imports: `wasi_snapshot_preview1` only.
- Build reproducibility: `build-a` == `build-b` byte-for-byte.
