# imageops evidence (chrome-agent-platform-e5o8)

CAP-authored WASI image tool: `info` / `resize` / `convert` over stdin→stdout,
a clean-room wrapper over the pure-Rust `image` crate (0.25.10, MIT OR
Apache-2.0). Created because wasm-vips (the catalogue's first image admit
candidate) needs Emscripten env imports + dynamic linking + pthreads, which the
bundled WASI-preview1-only admission authority cannot host (measurements in the
e5o8 bead comment, 2026-09-05); owner picked this path (option B).

Contents:
- Cargo.toml + Cargo.lock — exact dependency pins (23 locked packages)
- src/main.rs — the CAP-authored tool (Apache-2.0)
- build.sh — exact reproducible build (rustc/cargo 1.97.1, wasm32-wasip1)
- build-a/imageops.wasm, build-b/imageops.wasm — two independent builds,
  byte-identical (sha256 89ffdccb…, 721,475 bytes; WASI imports only: 8)
- sbom/cyclonedx-1.5.json — 22 dependency components from Cargo.lock
- LICENSES/ — image crate licence texts (Apache-2.0 + MIT)
