# cap-zxing evidence (chrome-agent-platform-2htn)

CAP-authored WASI barcode tool: `read` / `write` over stdin→stdout, a
clean-room wrapper over zxing-cpp 2.3.0 (Apache-2.0) with stb_image /
stb_image_write (MIT OR public domain) at the PNG/JPEG boundary.

Why not the published `zxing-wasm` npm package (Sec-ant, v3.1.3): its shipped
wasm imports a minified Emscripten JS-glue module (78 imports from module
"a"), which the bundled WASI-preview1-only admission authority cannot host —
the same blocker class as wasm-vips in chrome-agent-platform-e5o8. The
catalogue lane's recommendation stands (zxing-cpp + zint are the right
engines); the hosting path is a source build, exactly as imageops did for
`image`. Pinned probe of the rejected artifact:
zxing-wasm@3.1.3 tarball, reader wasm sha256
2ebda08a93eea3efcd8399cda6b276e6a0b1de4fec60b4d8988a047de4c6d1ba
(imports measured via WebAssembly.Module.imports on 2026-09-05).

Contents:
- src/main.cpp — the CAP-authored tool (Apache-2.0)
- src/stb_image.h, src/stb_image_write.h — pinned stb headers
  (nothings/stb @ 2c980bb59875b0d32144a71867fbdebb2f77cd20, 2026-08-02;
  sha256 recorded in build.sh and verified at build time)
- build.sh — exact reproducible build: fetches the pinned zxing-cpp v2.3.0
  release tarball (sha256-verified), compiles all of core/src plus the wrapper
  with clang --target=wasm32-wasip1 (no cmake, no JS glue), twice, and asserts
  the two builds are byte-identical
- build-a/zxing.wasm, build-b/zxing.wasm — two independent builds,
  byte-identical
- sbom/cyclonedx-1.5.json — dependency components (zxing-cpp, stb_image,
  stb_image_write, wasi-libc from the SDK)
- LICENSES/ — zxing-cpp Apache-2.0 text, stb dual MIT/public-domain text

Toolchain (recorded in build.sh's log): clang 22.1.8, wasi-sysroot-22.0,
libclang_rt.builtins (wasm32-unknown-wasip1).
