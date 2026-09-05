# WebAssembly Tool Catalogue — managed default tools research

**Status:** analysis-only (no product code). Feeds the Wasm admission pipeline
(CAS + manifests + SPDX license fields, bundled-reviewed-only store policy,
WASI preview1 runtime, offscreen module workers, OPFS streams).

**Bead:** chrome-agent-platform-qazo
**Date:** 2026-09-05 · **Author:** cap-wasm-catalogue lane (k3)

## Admission criteria (as agreed with coordinator, incl. owner directive)

- **License is a recorded SPDX data field only — never a reject reason**
  (owner directive 2026-09-05: Paul handles licensing personally; include
  binaries aggressively).
- Verdicts are technical: WASI preview1 or browser-shim-able imports,
  memory32 (memory64 flagged), bounded size (~<5 MB ideal; large modules
  = investigate), deterministic build or pinned release artifact, no
  network imports, single-file module preferred, provenance.
- Verdicts: **admit-now** / **investigate** / **reject-as-wasm** (a native
  web API or adequate pure-JS alternative wins) / **not-found**.

Sizes are unpacked/package sizes unless noted. Where an exact release sha was
not captured during research it is marked *pin sha at admission time*.

---

## 1. Image processing

### wasm-vips — ADMIT-NOW (Paul's "liboxide/libs something" — verified)
- Repo: https://github.com/kleisauke/wasm-vips · npm: https://www.npmjs.com/package/wasm-vips
- License: MIT (third-party notices: aom BSD-2, brotli MIT, cgif MIT, etc.)
- Size: ~4.6 MB wasm binary
- WASI: no — Emscripten browser/Node module; parallel ops use SharedArrayBuffer
- Memory: 32-bit · Imports: Emscripten glue (no network)
- Determinism: pinned npm release, v0.0.18 (2026-06-09); *pin sha at admission*
- Provenance: Kleis Auke Wolthuizen (libvips maintainer); 66k weekly downloads
- Notes: full libvips pipeline model (source→ops→destination, streaming,
  parallel). Reads/writes JPEG/PNG/WebP/TIFF out of the box.
- Sources: https://www.libvips.org/2020/09/01/libvips-for-webassembly.html ·
  https://github.com/kleisauke/wasm-vips/blob/master/THIRD-PARTY-NOTICES.md

### photon-rs — ADMIT-NOW (lightweight alternative)
- Repo: https://github.com/silvia-odwyer/photon · crates: https://crates.io/crates/photon-rs
- License: Apache-2.0
- Size: sub-MB wasm (UNVERIFIED exact; ~500 KB class) — *measure at admission*
- WASI: no — wasm-bindgen browser/Node
- Memory: 32-bit · Imports: wasm-bindgen glue
- Determinism: crate v0.3.3; *pin sha at admission*
- Provenance: established project, 90+ image functions, 4–10× faster than JS
- Sources: https://silvia-odwyer.github.io/photon/ · https://docs.rs/photon-rs

### jSquash (Squoosh codecs) — ADMIT-NOW (codec suite)
- Repo: https://github.com/jamsinclair/jSquash
- License: Apache-2.0 (codecs carry their own: libavif, mozjpeg, oxipng…)
- Size: small per-codec modules (@jSquash/avif, /jpeg, /jxl, /oxipng, /png,
  /resize, /webp)
- WASI: no — browser + Web Worker target
- Memory: 32-bit · Determinism: per-package npm pins; *pin sha at admission*
- Provenance: derived from GoogleChromeLabs/squoosh
- Sources: https://deepwiki.com/GoogleChromeLabs/squoosh/3-codec-system ·
  https://web.dev/blog/squoosh-v2

### resvg — ADMIT-NOW (SVG rendering)
- Repo: https://github.com/linebender/resvg · crates: https://crates.io/crates/resvg
- License: Apache-2.0 OR MIT (relicensed from MPL-2.0, issue #838)
- Size: not captured — *measure at admission*
- WASI: wasm-guaranteed by project ("works everywhere Rust compiles, incl. WASM")
- Memory: 32-bit · Determinism: crate v0.47.0
- Sources: https://github.com/linebender/resvg/blob/main/CHANGELOG.md

### squoosh-kit — INVESTIGATE (redundant with jSquash; Bun-first repack)
- Repo: https://github.com/bnowak008/squoosh-kit

---

## 2. Compression (general)

### @bokuweb/zstd-wasm — ADMIT-NOW
- Repo: https://github.com/bokuweb/zstd-wasm · npm: https://www.npmjs.com/package/@bokuweb/zstd-wasm
- License: MIT (TS glue) + BSD-3-Clause (zstd, Facebook)
- Size: zstd.wasm 245.9 KB
- WASI: no — Emscripten-style browser/Node/Deno module
- Determinism: npm pin; *pin sha at admission*

### brotli-wasm — ADMIT-NOW
- Repo: https://github.com/httptoolkit/brotli-wasm · npm: https://www.npmjs.com/package/brotli-wasm
- License: Apache-2.0
- Version: 3.0.1 (2024-06) · 1.27M weekly downloads
- Size: ~1 MB class package; *measure wasm at admission*
- Provenance: httptoolkit (Tim Perry)

### compress-utils — INVESTIGATE (new, low adoption — 21 weekly dl)
- Repo: https://github.com/dupontcyborg/compress-utils
- License: MIT · v0.8.0 (2026)
- Covers zstd+brotli+zlib+bz2+lz4+xz+snappy, tree-shakeable
- Attractive single-package story; verify build provenance before admitting

### fflate / pako — REJECT-AS-WASM (pure JS; and CompressionStream covers gzip/deflate natively in Chrome)
- Sources: https://github.com/101arrowz/fflate ·
  https://nickb.dev/blog/wasm-compression-benchmarks-and-the-cost-of-missing-compression-apis/

---

## 3. Hashing / crypto

### hash-wasm — ADMIT-NOW
- Repo: https://github.com/Daninet/hash-wasm · npm: https://www.npmjs.com/package/hash-wasm
- License: MIT per npm (GitHub badge shows NOASSERTION — *verify LICENSE file at admission*)
- Size: per-function bundles 3–11 KB gzipped (blake3 9 KB, argon2 11 KB, bcrypt 11 KB)
- Algorithms: MD4/5, SHA-1/2/3, Keccak, BLAKE2b/s, BLAKE3, PBKDF2, Argon2,
  bcrypt, scrypt, Adler-32, CRC32/32C/64, RIPEMD-160, HMAC, xxHash, SM3, Whirlpool
- Determinism: npm v4.12.0 (2024-11); 933k weekly downloads
- Sources: https://github.com/Daninet/hash-wasm/blob/master/README.md

### blake3-wasm — ADMIT-NOW
- Repo: https://github.com/connor4312/blake3 · npm: https://www.npmjs.com/package/blake3-wasm
- License: MIT · v3.0.0 (2022-10) · 12.2M weekly downloads
- Size: blake3.wasm 42.9 KB
- Provenance: Connor Peet (Microsoft); official BLAKE3-team-adjacent bindings

### awasm-noble — ADMIT-NOW (best crypto provenance story)
- Repo: https://github.com/paulmillr/awasm-noble
- License: MIT
- Auditable, reproducible wasm binaries produced from audited JS source
  (noble test vectors, wycheproof); blake3 6–10 GB/s, ChaCha20 6.4 GB/s;
  wasm-SIMD + threaded-wasm + JS backends
- *Pin release + sha at admission*
- Sources: https://paulmillr.com/noble/

### noble-curves / noble-hashes — REJECT-AS-WASM (pure audited JS/TS; fine as JS tools if ever needed)
- https://github.com/paulmillr/noble-curves

---

## 4. Data formats

### sax-wasm — ADMIT-NOW (streaming XML/HTML/JSX)
- Repo: https://github.com/justinwilaby/sax-wasm · npm: https://www.npmjs.com/package/sax-wasm
- License: MIT
- Size: 125.8 KB package; Rust→wasm, streaming, fixed-memory
- WASI: no — browser/Node module · 129k weekly downloads

### expat-wasm — ADMIT-NOW (alternative: battle-tested expat core)
- Repo: https://github.com/hildjj/expat-wasm · npm: https://www.npmjs.com/package/expat-wasm
- License: MIT · Size: 263.1 KB · Emscripten build, 0 runtime deps

### vectorjson — INVESTIGATE (O(n) SIMD wasm JSON; 35 weekly dl, new)
- Repo: https://github.com/teamchong/vectorjson
- License: Apache-2.0 · Size: 1.3 MB unpacked
- Sources: https://registry.npmjs.org/vectorjson

### simdjson (npm) — REJECT-AS-WASM (Node native bindings, 37.4 MB, not wasm)
- https://github.com/luizperes/simdjson_nodejs · https://simdjson.org/

### noyalib-wasm — INVESTIGATE (YAML 1.2, pure Rust, zero-unsafe, cosign provenance; single-author, new)
- Repo: https://github.com/sebastienrousseau/noyalib-wasm
- License: recorded at admission · Size: ~338 KB after LTO · v0.0.23
- Sources: https://docs.rs/crate/noyalib-wasm/latest

### yaml-wasm (KSXGitHub) — INVESTIGATE (older Deno-era YAML wasm)
- https://github.com/KSXGitHub/yaml-wasm

### CSV — INVESTIGATE / roll-own (no maintained wasm CSV lib found; Rust `csv`
crate wasm-compilable via wasm-bindgen)

### protobuf — REJECT-AS-WASM / use JS (quick-protobuf is Rust codegen, not a
browser wasm package; protobuf-es is pure JS)
- https://github.com/tafia/quick-protobuf

### msgpack / cbor — REJECT-AS-WASM (@msgpack/msgpack, @jsonjoy.com/json-pack
are fast pure JS; native-speed adequate)
- https://github.com/msgpack/msgpack-javascript · https://registry.npmjs.org/@jsonjoy.com/json-pack

---

## 5. Text / string processing

### multilingual-stemmer — ADMIT-NOW
- Repo: https://github.com/MrRefactoring/multilingual-stemmer
- License: recorded at admission
- Snowball 3.0.1 stemmers for 33 languages, wasm, zero deps, TS-first,
  Node + browser

### icu (ICU4X JS bindings) — INVESTIGATE (17.9 MB unpacked; needs icu4x-datagen trimming)
- Repo: https://github.com/unicode-org/icu4x · npm: https://www.npmjs.com/package/icu
- License: Unicode-3.0 · v2.2.1
- Diplomat-generated wasm bindings; trim to segmentation/normalization subset
- Sources: https://github.com/unicode-org/icu4x/discussions/7251

### intl-segmenter-polyfill — REJECT-AS-WASM (Intl.Segmenter is native in
Chrome; ~350 KB gz ICU4C wasm only needed for other browsers)
- https://github.com/surferseo/intl-segmenter-polyfill

### icu-segmentation-wasm (echogarden) — INVESTIGATE (overlaps native Intl.Segmenter)
- https://github.com/echogarden-project/icu-segmentation-wasm

---

## 6. Regex

### rregex — ADMIT-NOW (ReDoS-safe linear-time regex — right for untrusted agent input)
- Repo: https://github.com/2fd/rregex · JSR: https://jsr.io/@rregex/rregex
- License: recorded at admission
- Dependency-free wasm build of the Rust `regex` crate: finite automata,
  guaranteed linear-time matching; no lookaround/backreferences (safety feature)
- npm + JSR + Deno packaging; *pin version+sha at admission*
- Sources: https://github.com/rust-lang/regex (linear-time guarantee)

### pcre2-wasm — NOT-FOUND (no maintained npm wasm port; rust regex covers the need)

---

## 7. Diffs

### diff-match-patch-wasm — ADMIT-NOW
- Repo: https://github.com/26F-Studio/diff-match-patch-wasm
- Core: https://crates.io/crates/diff-match-patch-rs (v0.3.2, Apache-2.0,
  Myers diff-match-patch port, Efficient + Compat modes, "wasm ready")
- Browser wasm wrapper on npm; *pin at admission*
- Sources: https://github.com/anubhabb/diff-match-patch-rs

### diffwtf-core — INVESTIGATE (pure-Rust Myers line diff + intra-line
refinement; no-unsafe, no-panic guarantee; new, single project)
- https://github.com/diffwtf/diffwtf · https://crates.io/crates/diffwtf-core

### similar (Rust crate) — INVESTIGATE / roll-own (no wasm wrapper found)

---

## 8. Math / numerics

### gmp-wasm — ADMIT-NOW (arbitrary precision)
- Repo: https://github.com/Daninet/gmp-wasm · npm: https://www.npmjs.com/package/gmp-wasm
- License: recorded at admission (GMP/MPFR carry LGPL — recorded per criteria)
- GMP + MPFR arbitrary-precision Integer/Rational/Float; browsers, workers,
  Node, Deno; high-level wrapper included
- Same author as hash-wasm (Daninet)

### @emnudge/wat-fft — ADMIT-NOW (FFT)
- Repo: https://github.com/EmNudge/wat-fft · npm: https://registry.npmjs.org/@emnudge/wat-fft
- License: ISC · Size: 96.8 KB
- Handwritten-WAT FFT; beats pffft-wasm by 20–95%; 2–3× fastest pure JS;
  f32 + f64 variants; 0 deps

### nalgebra — INVESTIGATE (officially wasm-supported incl. no_std, but no
maintained npm wasm wrapper — would need own wasm-bindgen build)
- https://github.com/dimforge/nalgebra · https://www.nalgebra.rs/docs/user_guide/wasm_and_embedded_targets/
- License: Apache-2.0 · v0.35.0

### MathTS — INVESTIGATE (AssemblyScript mathjs rewrite, new)
- https://github.com/danielsimonjr/MathTS

### big.js / decimal.js / bignumber.js — REJECT-AS-WASM (pure JS adequate)
- https://www.npmjs.com/package/big.js

---

## 9. Databases

### sqlite-wasm (official) — ADMIT-NOW (strongest provenance in the catalogue)
- Home: https://sqlite.org/wasm/doc/tip/about.md
- License: SQLite public-domain blessing
- First-class wasm deliverable of the SQLite project; OPFS persistence
  backend; Chrome's designated Web SQL replacement
- Determinism: official sqlite.org release artifacts; *pin at admission*
- Sources: https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system

### wa-sqlite — ADMIT-NOW (alternative / fallback)
- Repo: https://github.com/rhashimoto/wa-sqlite
- License: MIT
- JS-writable VFS layer; sync + Asyncify/JSPI builds; OPFS VFS examples

### sql.js — INVESTIGATE (superseded by official sqlite-wasm; no first-class OPFS)
- https://github.com/sql-js/sql.js

### duckdb-wasm — INVESTIGATE (size: ~71 MB unpacked; admit only if analytics use-case is real)
- Repo: https://github.com/duckdb/duckdb-wasm · npm: @duckdb/duckdb-wasm
- License: MIT · v1.33.1-dev20.0 observed
- Full OLAP + Arrow + Parquet/CSV/JSON; mvp/eh/coi build variants
- Sources: https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm/dist/

---

## 10. Audio / video basics

### eshaz/wasm-audio-decoders — ADMIT-NOW
- Repo: https://github.com/eshaz/wasm-audio-decoders
- License: MIT
- Packages: opus-decoder (85.5 KiB, v0.7.11, ~993k weekly dl),
  ogg-opus-decoder (114.3 KiB, v1.7.3, ~763k weekly dl; +4.0 MiB with
  Opus 1.5 ML speech enhancements), plus mp3/flac/vorbis
- libopus 1.5, streaming, built-in Web Worker support, up to 255 channels
- Sources: https://www.npmjs.com/package/opus-decoder ·
  https://github.com/eshaz/wasm-audio-decoders/blob/main/README.md

### ffmpeg.wasm (@ffmpeg/core-mt) — INVESTIGATE (enormous; only if real
transcode demand; prefer WebCodecs for most media work)
- Repo: https://github.com/ffmpegwasm/ffmpeg.wasm
- License recorded: GPL-2.0-or-later build / LGPL-2.1+ core parts
  (per owner directive: recorded, not gating)
- Size: ffmpeg-core.wasm 31.2–32.6 MB; mt build needs SharedArrayBuffer
- Sources: https://registry.npmjs.org/@ffmpeg/core-mt ·
  https://github.com/ffmpegwasm/ffmpeg.wasm-core/blob/n4.3.1-wasm/LICENSE.md

---

## 11. Geographic / GIS

### h3-js — ADMIT-NOW
- Repo: https://github.com/uber/h3-js · npm: https://www.npmjs.com/package/h3-js
- License: Apache-2.0 · v4.5.0 · 1.1M weekly downloads
- H3 C core transpiled via emscripten (wasm-backed); full C API parity

### h3o-wasm — ADMIT-NOW (Rust alternative)
- npm: https://www.npmjs.com/package/h3o-wasm
- License: BSD-3-Clause · Rust h3o implementation wrapped for wasm

### proj.js — INVESTIGATE (full PROJ via SWIG-JSE; beta)
- https://github.com/mmomtchev/proj.js ·
  https://www.mail-archive.com/proj@lists.osgeo.org/msg01514.html

### proj-wasm (clj-proj) — INVESTIGATE (experimental transpiled PROJ)
- https://www.npmjs.com/package/proj-wasm · https://github.com/willcohen/clj-proj

### m3s — INVESTIGATE (unified Geohash/MGRS/H3/Quadkey/S2/A5… via shared
Rust wasm core, Python + JS; new)
- https://github.com/nkarasiak/m3s

### turf.js — REJECT-AS-WASM (pure JS, adequate natively)

---

## 12. Documents / utility

### @embedpdf/pdfium — ADMIT-NOW (PDF)
- Repo: https://github.com/embedpdf/embed-pdf-viewer (packages/pdfium)
- npm: https://www.npmjs.com/package/@embedpdf/pdfium
- License: MIT wrapper · Size: 7.2 MB unpacked · 301k weekly downloads
- PDFium (Chrome's PDF engine) compiled to wasm; render + manipulate

### mupdf (official Artifex) — INVESTIGATE (dupes pdfium)
- npm: https://www.npmjs.com/package/mupdf · https://github.com/ArtifexSoftware/mupdf.js/
- License: AGPL (recorded per criteria) · official wasm build, ESM-only

### pulldown-cmark-wasm — ADMIT-NOW (CommonMark)
- npm: https://registry.npmjs.org/pulldown-cmark-wasm
- License: MIT · wasm-pack wrapper over pulldown-cmark; tiny

### comrak (@nick/comrak) — ADMIT-NOW (GFM markdown)
- Repo: https://github.com/nberlette/comrak-wasm · https://jsr.io/@nick/comrak
- License: MIT · Size: 1.4 MB unpacked · comrak crate → wasm, TS API

### @tybys/qrcodegen — ADMIT-NOW (best WASI fit in the catalogue)
- Repo: https://github.com/toyobayashi/qrcodegen · npm: https://www.npmjs.com/package/@tybys/qrcodegen
- License: MIT (nayuki QR-Code-generator core)
- Built with wasi-sdk (not Emscripten) → genuinely WASI-compiled, small
- Upstream: https://github.com/nayuki/QR-Code-generator

### zxing-wasm — ADMIT-NOW (barcode read + write)
- Repo: https://github.com/Sec-ant/zxing-wasm · npm: https://www.npmjs.com/package/zxing-wasm
- License: MIT (wrapper) + Apache-2.0 (zxing-cpp) + BSD-3-Clause (zint)
- v3.1.3 · 1.87M weekly downloads · Web/Node/Bun/Deno, typed ESM+CJS
- Sources: https://sec-ant.github.io/zxing-wasm/docs/

---

## Summary

| Verdict | Count | Highlights |
|---|---|---|
| admit-now | 20 | wasm-vips, photon-rs, jSquash, resvg, zstd-wasm, brotli-wasm, hash-wasm, blake3-wasm, awasm-noble, sax-wasm, expat-wasm, multilingual-stemmer, rregex, diff-match-patch-wasm, gmp-wasm, wat-fft, sqlite-wasm, wa-sqlite, h3-js, h3o-wasm, @embedpdf/pdfium, pulldown-cmark-wasm, comrak, @tybys/qrcodegen, zxing-wasm (list de-duped in beads) |
| investigate | 12 | compress-utils, vectorjson, noyalib-wasm, yaml-wasm, ICU4X, diffwtf-core, similar, nalgebra, MathTS, sql.js, duckdb-wasm, ffmpeg.wasm, proj.js, proj-wasm, m3s, mupdf, icu-segmentation-wasm, squoosh-kit (some listed in multiple cats) |
| reject-as-wasm | 6 | fflate/pako, simdjson-npm, protobuf, msgpack/cbor JS, intl-segmenter-polyfill, big.js/decimal.js, turf.js, noble JS |
| not-found | 1 | pcre2-wasm |

### Top-admit priority order (coordinator, 2026-09-05)
1. wasm-vips 2. photon-rs 3. jSquash 4. zstd-wasm + brotli-wasm
5. hash-wasm + blake3-wasm 6. rregex 7. sqlite-wasm + wa-sqlite
8. zxing-wasm 9. @embedpdf/pdfium

### Follow-ups for the admission pipeline
- Measure exact .wasm sizes + memory profiles at admission time (marked
  *measure at admission* above).
- Pin version + sha256 for every admitted artifact (marked *pin at admission*).
- Verify hash-wasm LICENSE file (npm says MIT, GitHub badge NOASSERTION).
- ffmpeg.wasm only behind a real transcode use-case; WebCodecs first.
