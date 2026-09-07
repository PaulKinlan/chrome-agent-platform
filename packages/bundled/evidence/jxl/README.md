# jxl evidence tree

Evidence tree for `cap.bundled.jxl` (1.0.0), a CAP-authored deterministic
WASI tool that decodes JPEG XL (JXL) images to PNG (chrome-agent-platform-agpu).

- Command: `jxl [--to png]` (v1).
- Stream I/O: base64 JXL text on stdin -> PNG bytes on stdout (the tool protocol
  re-encodes stdout as base64 for this tool); errors to stderr, exit 2.
- Invariants: frame 0 of the JPEG XL image is decoded to an sRGB PNG; width,
  height, and channels match the input; non-JXL garbage fails closed with exit 2.
- Bounded: decodes a 1 MP fixture in ~290 ms, well inside the executor's 5 s wall bound.
- Target: `wasm32-wasip1`; single-thread (no rayon); pure Rust (no C/cc/*-sys crates).
- Memory: default tier (max 128 MiB = 2048 pages); 20 pages initial; 506 pages peak for 1 MP fixture.
- Imports: `wasi_snapshot_preview1` only (args_get, args_sizes_get, clock_time_get,
  environ_get, environ_sizes_get, fd_read, fd_write, proc_exit, random_get).
- Build reproducibility: `build-a` == `build-b` byte-for-byte (sha in SHA256SUMS).
- Toolchain: rustc/cargo 1.97.1 (rustup stable), target wasm32-wasip1. Zero C/wasi-sdk dependencies. `build.sh` reproduces the artifact.
- Licences: jxl-oxide MIT OR Apache-2.0; png MIT OR Apache-2.0; brotli-decompressor
  BSD-3-Clause; base64 MIT OR Apache-2.0; the remaining crates MIT OR Apache-2.0 (see sbom/ and LICENSES/).
  Package expression: `MIT OR Apache-2.0` (NOTICES shipped in extension/wasm/licenses/).
- Measurement + native probe (ladder step 1): cap-evidence/cap-jxl/native-probe.md.
