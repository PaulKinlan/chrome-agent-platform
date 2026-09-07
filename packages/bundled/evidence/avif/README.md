# avif evidence tree

Evidence tree for `cap.bundled.avif` (1.0.0), a CAP-authored WASI tool that
encodes an image to AVIF on-device (chrome-agent-platform-ou4x). Chrome cannot
encode AVIF from canvas (cap-evidence/cap-avif/native-probe.md) — this fills
that gap.

- Command: `avif [--quality 1..100 (default 80)] [--speed 1..10 (default 10)]`.
- Stream I/O: base64 PNG/JPEG/WebP text on stdin -> raw AVIF bytes on stdout
  (the tool protocol re-encodes stdout as base64 for this tool); errors to
  stderr, exit 2.
- Output: bytes beginning with the AVIF `ftyp`/`avif` brand box. A
  high-entropy (noise) source can encode LARGER than the PNG input — that is
  honest lossy encoding of incompressible data, not a defect; the dispatch
  fixture is a compressible image (cap-evidence/cap-avif/fit-report.md).
- Bounded: measured wall at speed 10 is ~280 ms (512×512) / ~840 ms
  (1024×768); worst in the matrix 2,886 ms (1024×768 speed 8) — inside the
  executor's 5 s wall (PREVIEW_LIMITS.wallMs). Default speed 10 for headroom.
- Target: `wasm32-wasip1`; single-thread (default-features = false on ravif AND
  rav1e: no nasm/cc SIMD asm, no rayon). Pure Rust — no WASI sysroot needed.
- Memory: default tier (max 128 MiB = 2048 pages); 21 pages initial.
- Imports: `wasi_snapshot_preview1` only (args_get, args_sizes_get, random_get,
  environ_get, environ_sizes_get, clock_time_get, fd_read, fd_write, proc_exit,
  sched_yield — sched_yield is rav1e's software path via parking_lot; the shim
  implements it as an honest no-op, the m3vb clock_time_get precedent).
- Build reproducibility: `build-a` == `build-b` byte-for-byte (sha in SHA256SUMS).
- Toolchain: rustc/cargo 1.97.1 (rustup stable) for wasm32-wasip1; no clang/C
  dependency. See build.sh.
