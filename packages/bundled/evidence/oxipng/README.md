# oxipng evidence tree

Evidence tree for `cap.bundled.oxipng` (1.0.0), a CAP-authored deterministic
WASI tool that optimises a PNG without changing its pixels (chrome-agent-platform-m3vb).

- Command: `oxipng [-o 0..6] [--strip safe|all]` (effort default 2; strip default safe).
- Stream I/O: base64 PNG text on stdin -> optimised PNG bytes on stdout (the tool
  protocol re-encodes stdout as base64 for this tool); errors to stderr, exit 2.
- Invariants: the decoded pixels are identical; output size <= input size (the
  original bytes come back when nothing is smaller); width/height preserved.
  Colour type / bit depth MAY be reduced losslessly (e.g. opaque RGBA -> RGB).
- Bounded: a 3.5 s internal deadline stops optimisation trials and returns the
  best result so far, inside the executor's 5 s wall.
- Target: `wasm32-wasip1`; single-thread (no rayon); no zopfli.
- Memory: default tier (max 128 MiB = 2048 pages); 17 pages initial.
- Imports: `wasi_snapshot_preview1` only (args_get, args_sizes_get, random_get,
  environ_get, environ_sizes_get, clock_time_get, fd_read, fd_write, proc_exit).
- Build reproducibility: `build-a` == `build-b` byte-for-byte (sha in SHA256SUMS).
- Toolchain: rustc/cargo 1.97.1 (rustup stable) + clang 22.1.8 for the one C
  dependency, libdeflate 1.26 (via libdeflate-sys), compiled with the crate's
  `freestanding` feature (`-ffreestanding -nostdlib -DFREESTANDING`): no WASI
  sysroot or wasi-sdk is used. `build.sh` reproduces the artifact.
- Licences: oxipng MIT; libdeflate MIT; libdeflater/libdeflate-sys Apache-2.0;
  the remaining crates MIT OR Apache-2.0 (see sbom/ and LICENSES/). Package
  expression: `MIT AND Apache-2.0` (NOTICES shipped in extension/wasm/licenses/).
- Measurement + native probe (ladder step 1): cap-evidence/cap-oxipng/native-probe.md.
