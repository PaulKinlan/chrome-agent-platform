# blake3-wasm (connor4312 v3.0.0) — Emscripten glue class evidence

Admission evidence for `chrome-agent-platform-fh9k`: admitting `blake3-wasm`
(connor4312 v3.0.0) as a managed Wasm tool with the Emscripten glue class.

## Upstream Provenance
- Repository: https://github.com/connor4312/blake3
- Package: `blake3-wasm@3.0.0` (https://www.npmjs.com/package/blake3-wasm)
- Author: Connor Peet <connor@peet.io> (Microsoft; official BLAKE3-team-adjacent bindings)
- License: MIT (`LICENSES/MIT.txt`)
- Tarball: `blake3-wasm-3.0.0.tgz`
  - SHA-512: `X410nN2AIX6k8gHQmXruQ9YV3U8fe7ZrfLMp88qBcGx5oEIGzz305HvquXoSTPdaR74EA99KHBTb8El9q0vjqQ==`
  - SHA-256: `83bad3dc00d9f4fcc97dab4ab1d32a87c32d1296a37db57c1b8e76a76514bd20`
  - Size: 43,040 bytes

## Extracted Assets
- `binaries/blake3.wasm`: 43,943 bytes, sha256 `7bc38ed8b469117059b43ab04c70b2a5506ab313a9ae2926dd338f072dbd310d`
- `glue/blake3.mjs`: 17,819 bytes, sha256 `7d03777d994e39a8a619a8c9fe20c1bcb11710b114fc2f280022a2a103052878`
- `adapter/cap-blake3-wasm-v1.mjs`: CAP-authored adapter binding `hash` operation to `hash_oneshot`
- `source/blake3.c`: C source for WebAssembly wrapper

## Emscripten Glue Class Characteristics
- Module imports 3 functions from `a`:
  - `a.a` -> `_emscripten_resize_heap` (params `[i32]`, results `[i32]`)
  - `a.b` -> `_emscripten_memcpy_big` (params `[i32, i32, i32]`, results `[]`)
  - `a.c` -> `___assert_fail` (params `[i32, i32, i32, i32]`, results `[]`)
- Standard 16 MiB unshared linear memory (`min: 256, max: 256` pages).
- Zero eval / zero dynamic execution in glue.
- Deterministic extraction via `extract.mjs`.
