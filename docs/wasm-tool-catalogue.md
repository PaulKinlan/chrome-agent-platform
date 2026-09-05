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

### wasm-vips — SUPERSEDED (2026-09-05, e5o8 owner decision: option B)
- Measured at admission: vips.wasm 5,084,535 bytes (5.08 MB), imports env×89 (Emscripten) + wasi_snapshot_preview1×10 + GOT.func (dynamic linking); side modules vips-heif/jxl/resvg are GOT-linked side modules; glue uses SharedArrayBuffer/pthreads. The bundled WASI-preview1-only authority cannot host it; it moves to the Emscripten-module host epic (chrome-agent-platform-ltkj / CAP-FB-20260905-EMSCRIPTEN-RUNTIME-01).
- Shipped instead: **imageops** (cap.bundled.imageops 1.0.0) — CAP-authored clean-room WASI tool over the pure-Rust `image` crate 0.25.10 (MIT OR Apache-2.0): info/resize/convert (png/jpeg/webp), stdin→stdout, 721,475 bytes, 8 WASI imports, sha256 cbcf9ec3f51d6b82c3c03e306696cf1ccb8896ba230ad9d0f0c9211eb7de2a6a, byte-reproducible (build-a == build-b). Evidence: packages/bundled/evidence/imageops/.

### wasm-vips — ADMIT-NOW (catalogue verdict history — see the SUPERSEDED note above) (Paul's "liboxide/libs something" — verified)
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

---

# v2 expansion — deep sweep (2026-09-05, cap-wasm-deep-sweep lane, k3)

Same admission criteria as v1 (license = recorded field only; verdicts
technical). Sizes unverified → *measure at admission*.

## 13. Syntax highlighting / editor parsing

### web-tree-sitter — ADMIT-NOW
- Repo: https://github.com/tree-sitter/tree-sitter (JS/WASM bindings) · npm: https://www.npmjs.com/package/web-tree-sitter
- License: MIT (tree-sitter core; each grammar carries its own, mostly MIT)
- Size: runtime small; each grammar is a separate .wasm (~0.3–2 MB class) — *measure per grammar at admission*
- WASI: no — Emscripten browser/Node module
- Memory: 32-bit · Determinism: npm pin + per-grammar pins
- Notes: incremental parsing; grammars compiled with tree-sitter CLI to .wasm
  and loaded by path/URL — fits per-language lazy loading in module workers.
- Sources: https://www.npmjs.com/package/web-tree-sitter · https://tree-sitter-tree-sitter.mintlify.app/api/javascript/overview

### vscode-oniguruma / oniguruma wasm (TextMate grammars) — INVESTIGATE
- Repo: https://github.com/microsoft/vscode-oniguruma
- License: MIT · Size: onig.wasm ~1.4 MB class — *measure at admission*
- Notes: only needed for TextMate-grammar compat (Shiki default engine).
  Shiki alternative: oniguruma-to-es translates to native JS RegExp (no
  wasm) — and v1's rregex already covers ReDoS-safe general regex.
  Admit only if TextMate grammar support becomes a product requirement.
- Sources: https://shiki.style/guide/regex-engines

### Shiki / highlight.js / Prism — REJECT-AS-WASM (JS libs; the wasm inside Shiki is oniguruma above)

## 14. Parsers & grammars
Covered by §13 web-tree-sitter (grammar-per-language wasm model). No separate
admit needed. Kaitai Struct → see §57.

## 15. Formatters & linters

### dprint wasm plugins — ADMIT-NOW (sandboxed-plugin model matches the platform)
- Repo: https://github.com/dprint/dprint · plugins: https://dprint.dev/plugins/
- License: MIT (dprint + markdown/json/toml/typescript plugins)
- Size: per-plugin .wasm (~1–3 MB class) — *measure at admission*
- WASI: dprint wasm-plugin ABI (not preview1; needs @dprint/formatter JS host)
- Notes: plugins for markdown, JSON, TOML, TypeScript; some languages still
  process-plugin only (not wasm). The JS host API: @dprint/formatter.
- Sources: https://dprint.dev/plugins/ · https://www.npmjs.com/package/@dprint/formatter

### @wasm-fmt/* family (clang-format, ruff_fmt, gofmt, zig_fmt, …) — ADMIT-NOW (clang-format); family INVESTIGATE
- Repo: https://github.com/wasm-fmt (per-tool repos, e.g. wasm-fmt/clang-format)
- License: Apache-2.0 WITH LLVM-exception (clang-format); per-repo for others
- Size: per-tool wasm — *measure at admission*
- WASI: no — wasm-bindgen-style browser/Node/bundler builds
- Notes: browser usage needs explicit WASM init. Single-author org (tamasfe);
  provenance moderate → verify build reproducibility at admission.
- Sources: https://www.npmjs.com/package/@wasm-fmt/clang-format · https://github.com/wasm-fmt/ruff_fmt · https://github.com/wasm-fmt/gofmt · https://github.com/wasm-fmt/zig_fmt

### @biomejs/wasm-web — INVESTIGATE
- Repo: https://github.com/biomejs/biome · npm: https://www.npmjs.com/package/@biomejs/wasm-web
- License: MIT OR Apache-2.0
- Notes: formats/lints JS/TS/JSX/JSON/HTML/CSS/GraphQL in-browser; API is
  version-locked to the matching wasm distribution; verify size + API
  stability. (Prettier/Biome-in-JS remain the pure-JS fallback.)

### @ruff-wasm (Astral) — INVESTIGATE (browser Python lint+format; experimental API)
- Repo: https://github.com/astral-sh/ruff/tree/main/crates/ruff_wasm
- License: MIT · Notes: per-target builds (web/bundler/nodejs); API explicitly
  experimental — pin exact version. Sources: https://github.com/astral-sh/ruff/blob/main/crates/ruff_wasm/README.md

## 16. Language runtimes / REPLs

### quickjs-emscripten — ADMIT-NOW (sandboxed JS-in-JS for untrusted agent snippets)
- Repo: https://github.com/justjake/quickjs-emscripten · npm: https://www.npmjs.com/package/quickjs-emscripten
- License: MIT · Variants incl. small release builds — *measure at admission*
- WASI: no — Emscripten; browser+Node. Memory: 32-bit.
- Sources: https://www.npmjs.com/package/quickjs-emscripten

### wasmoon (Lua 5.4) — ADMIT-NOW
- Repo: https://github.com/ceifa/wasmoon · License: MIT
- Notes: small wasm; browser+Node; Lua glue API. *Measure at admission.*

### ruby.wasm (@ruby/*-wasm-wasi) — INVESTIGATE (large; WASI-first)
- Repo: https://github.com/ruby/ruby.wasm · License: Ruby (BSD-2-Clause-style)
- Notes: official CRuby ports for browser + WASI (e.g. @ruby/4.0-wasm-wasi);
  multi-MB — *measure at admission*; WASI preview1 builds exist.

### @php-wasm/web — INVESTIGATE (30 MB unpacked per npm; WordPress Playground lineage)
- npm: https://www.npmjs.com/package/@php-wasm/web · License: *record at admission*
- Notes: 30 MB unpacked is download-inflated; Playground uses chunked/lazy
  builds. Admit only behind a real "run PHP snippets" use-case.

### javy (Bytecode Alliance) — INVESTIGATE (JS→WASI component toolchain, not a browser runtime per se)
- Repo: https://github.com/bytecodealliance/javy · License: Apache-2.0

### Pyodide — see dedicated §58–60 (three-tier section per owner scope expansion).

## 17. Assemblers / disassemblers / binary tooling

### wabt.js (WABT) — ADMIT-NOW
- Repo: https://github.com/WebAssembly/wabt · npm: wabt
- License: Apache-2.0 · Notes: wat2wasm/wasm2wat/wasm-objdump etc. in browser;
  canonical Bytecode-Alliance-adjacent provenance. *Measure at admission.*

### binaryen (npm) — ADMIT-NOW
- Repo: https://github.com/WebAssembly/binaryen · npm: https://www.npmjs.com/package/binaryen
- License: Apache-2.0 · Notes: wasm-opt + full IR toolchain as JS/wasm build.

### capstone.js / disasm-web — INVESTIGATE (native-code disassembly in browser)
- Repos: https://github.com/capstone-engine/capstone (upstream, BSD-3) ·
  capstone.js Emscripten port · https://github.com/ColinIanKing/disasm-web class projects
- Notes: verify port freshness (Capstone 5) + multi-arch size before admit.

## 18. Code search / indexing

### ripgrep-wasm — INVESTIGATE
- Repo: https://github.com/NathanHimpens/ripgrep-wasm
- Notes: WASI-targeted rg; browser fit (fs shimming, stdin/stdout) unverified.
  v1's rregex + OPFS streams may cover most need. *Verify browser path at admission.*

### tree-sitter based structural search — reuse §13 (no separate admit).

## 19. Markup pipelines

### pandoc-wasm — INVESTIGATE (huge; official; universal converter)
- Repo: https://github.com/pandoc/pandoc-wasm
- License: GPL-2.0-or-later (recorded; not gating per owner directive)
- Size: ~55.7 MB unpacked — the size problem is real; *measure/lazy-load at admission*
- WASI: Asterius/GHC wasm build; browser+Node; no post-install download needed
- Notes: converts Markdown/DOCX/HTML/TeX/EPUB/ODT and dozens more. The
  "any-format ↔ any-format" tool Paul described (Calibre-ish flows). Size makes
  it an on-demand OPFS-cached tool, never bundled.
- Sources: https://github.com/pandoc/pandoc-wasm/ · https://pandoc.org/app/

### typst.ts (@myriaddreamin/typst-ts-web-compiler) — ADMIT-NOW (modern LaTeX-class typesetting)
- Repo: https://github.com/Myriad-Dreamin/typst.ts · npm: @myriaddreamin/typst-ts-web-compiler
- License: Apache-2.0 (Typst) · Size: compiler wasm ~12 MB incl. fonts — *measure at admission*
- WASI: no — wasm-bindgen browser builds; separate renderer module
- Sources: https://www.npmjs.com/package/@myriaddreamin/typst-ts-web-compiler · https://myriad-dreamin.github.io/typst.ts/cookery/get-started.html

### Asciidoctor.js — REJECT-AS-WASM (Opal-compiled JS, not wasm; adequate as JS if ever needed)

## 20. TeX / LaTeX

### SwiftLaTeX — INVESTIGATE (full PdfTeX/XeTeX in browser)
- Repo: https://github.com/swiftlatex/swiftlatex
- License: AGPL-3.0 (recorded) · Size: large TeX trees — lazy-fetch model
- Notes: complete browser LaTeX→PDF. Heavy; alternative: typst.ts (§19) covers
  most "typeset a document" needs at 1/5 the weight.

### tectonic-wasm — INVESTIGATE (single-result provenance; verify)
- Repo: https://github.com/nl5887/tectonic-wasm
- Notes: claims browser LaTeX→PDF with bundled+CDN packages; single-author;
  Tectonic's Rust core is wasm-friendly in principle. Verify freshness.

## 21. Typography / fonts

### harfbuzzjs — ADMIT-NOW (text shaping)
- Repo: https://github.com/harfbuzz/harfbuzzjs
- License: MIT (HarfBuzz "old MIT") · Size: hb.wasm ~800 KB class — *measure at admission*
- WASI: yes — WASI build loaded with a tiny JS shim. Memory: 32-bit.
- Notes: official HarfBuzz wasm distribution.

### subset-font (HarfBuzz-based) — ADMIT-NOW (font subsetting, TTF/OTF/WOFF/WOFF2, variable axes)
- npm: https://www.npmjs.com/package/subset-font · License: MIT
- Notes: built on harfbuzzjs; fits "generate a subset font for this document".

### woff2 (Google) — covered by subset-font for subset/encode; standalone woff2 wasm = INVESTIGATE if needed.

## 22. E-books

### kepubify (browser build) — ADMIT-NOW (EPUB→KEPUB)
- Site: https://pgaskin.net/kepubify/try/ · Repo: https://github.com/pgaskin/kepubify
- License: MIT · Notes: Go→wasm browser build already shipping; small.

### ebook-converter-wasm (Calibre ebook-convert port) — INVESTIGATE
- Repo: https://github.com/Luc4sguilherme/ebook-converter-wasm
- Notes: ports Calibre's converter (DOCX/EPUB inputs); maturity unverified —
  if real, this is the Calibre-ish flow Paul asked for. Verify build + size.

### EPUB structure handling — covered by pandoc-wasm (§19) + zip tooling (§55); epub.js/foliate are JS (no wasm need).

## 23. Office formats

### LibreOffice wasm (core/static) — INVESTIGATE (tech-preview, enormous, but strategic)
- Repo: https://github.com/LibreOffice/core/blob/master/static/README.wasm.md
- License: MPL-2.0 (recorded)
- Notes: Emscripten build of LO core ("LibreOffice Technology"); ZetaOffice/
  ZetaJS (allotropia, Collabora-adjacent) packages it commercially. Not a
  near-term admit; watch. Sources: https://blog.allotropia.de/2024/11/08/announcing-zetaoffice-a-new-libreoffice-technology-product-for-web-mobile-desktop/

### docx-wasm (bokuweb/docx-rs) — ADMIT-NOW (DOCX generation)
- Repo: https://github.com/bokuweb/docx-rs · npm: docx-wasm
- License: MIT · Notes: Rust docx writer compiled to wasm; browser+Node.
  (Reading DOCX: pandoc-wasm §19, or JS mammoth.)
- Sources: https://github.com/bokuweb/docx-rs

### XLSX/PPTX — REJECT-AS-WASM (SheetJS/exceljs/pptxgenjs are adequate JS; revisit if a native engine appears)

## 24. PDF deepen (v1 §12 admitted @embedpdf/pdfium; mupdf investigate)

### qpdf-wasm — ADMIT-NOW (PDF structure surgery: split/merge/encrypt/linearize)
- Repo: https://github.com/neslinesli93/qpdf-wasm · npm: qpdf-wasm
- License: Apache-2.0 (QPDF) · Notes: browser-ready build; qpdf-run wrapper
  does typed-array in/out in Web Workers. Complements pdfium (render) with
  structure ops. *Measure at admission.*

### pdfcpu wasm — INVESTIGATE (Go pdfcpu wasm examples exist; freshness flagged)
- Repo: https://github.com/pdfcpu/pdfcpu · License: Apache-2.0
- Notes: overlaps qpdf-wasm; keep as fallback.

### OCRmyPDF-style flow — COMPOSITION, not a candidate: tesseract-wasm (§25) + qpdf-wasm + pdfium cover it in-pipeline.

## 25. OCR

### tesseract-wasm — ADMIT-NOW
- Repo: https://github.com/robertknight/tesseract-wasm
- License: Apache-2.0 (Tesseract) · Size: eng traineddata ~2.1 MB compressed +
  engine wasm — *measure at admission*
- WASI: no — Emscripten; browser+Node; SIMD where available; multilingual models
- Sources: https://github.com/robertknight/tesseract-wasm

### ocrs (RTen) — INVESTIGATE (modern ML OCR; browser path unverified)
- Repo: https://github.com/robertknight/ocrs
- License: MIT/Apache-2.0 · Notes: Rust OCR on RTen runtime + ONNX models;
  browser wasm demos exist in repo history; verify model packaging.

### PaddleOCR wasm — NOT-FOUND (no maintained browser wasm build located)

## 26. Diagramming

### @hpcc-js/wasm-graphviz — ADMIT-NOW (DOT→SVG)
- Repo: https://github.com/hpcc-systems/hpcc-js-wasm
- License: Apache-2.0 · Notes: maintained Graphviz wasm; Viz.js v3 is a thin
  wrapper over it. Browser+Node. *Measure at admission.*
- Sources: https://hpcc-systems.github.io/hpcc-js-wasm/packages/graphviz/README.html

### plantuml-wasm — INVESTIGATE (TeaVM/JVM→wasm class projects; no canonical build)
- Notes: most PlantUML-in-browser demos route through a server; Graphviz covers
  the layout substrate. Mark server-dependency risk.

### mermaid/d3 — REJECT-AS-WASM (pure JS, adequate natively)

## 27. Databases — deepen (v1 §9: sqlite-wasm + wa-sqlite admitted; duckdb-wasm investigate)

### PGlite (Postgres in wasm) — ADMIT-NOW
- Repo: https://github.com/electric-sql/pglite
- License: Apache-2.0 · Size: ~3–3.7 MB gzipped (dist ~10 MB class) — *measure at admission*
- WASI: no — Emscripten wasm of Postgres + JS host; browser/Node/Bun/Deno
- Memory: 32-bit · Notes: real Postgres wire semantics + extensions (pgvector,
  PostGIS). OPFS persistence is an open upstream request (issue #9) — today
  persistence is IndexedDB; verify OPFS at admission.
- Sources: https://github.com/electric-sql/pglite · https://github.com/electric-sql/pglite/issues/9

### duckdb-wasm — remains INVESTIGATE (v1; ~71 MB unpacked). Analytics-grade; httpfs range-request streaming is its superpower — admit when a real OLAP use-case lands.

## 28. Vector search

### sqlite-vec — ADMIT-NOW (vectors inside the already-admitted SQLite)
- Repo: https://github.com/asg017/sqlite-vec
- License: MIT/Apache-2.0 · Size: tiny extension wasm — *measure at admission*
- Notes: float/int8/binary vectors; compiles into official sqlite-wasm builds;
  pre-v1 (breaking-change warning recorded). Fits OPFS-persisted agent memory.

### hnswlib-wasm — INVESTIGATE (early-stage per own docs)
- Repo: https://github.com/ShravanSunder/hnswlib-wasm · License: Apache-2.0 (hnswlib)

### usearch-wasm — INVESTIGATE (unum-cloud/usearch has JS/wasm builds; single-binary SIMD ANN)
- Repo: https://github.com/unum-cloud/usearch · License: Apache-2.0

## 29. Notebooks

### JupyterLite + xeus — ADMIT-NOW (the notebook surface; Pyodide kernel covers §58)
- Repos: https://github.com/jupyterlite/jupyterlite · https://github.com/jupyterlite/xeus
- License: BSD-3-Clause · Notes: fully client-side Jupyter, statically served;
  wasm kernels (xeus-python via emscripten-forge, xeus-lua, xeus-sqlite…);
  no server. Fits the hub as an artifact surface. Size per-kernel — *measure at admission*.
- Sources: https://github.com/jupyterlite/xeus

## 30. Visualization / renderers

### canvaskit-wasm (Skia) — INVESTIGATE (6 MB wasm / 24.4 MB unpacked; only if HTML Canvas genuinely insufficient)
- npm: https://www.npmjs.com/package/canvaskit-wasm · License: BSD-3-Clause (Skia, Google)
- Notes: WebGL-backed Skia Canvas API; bundler config needed to serve
  canvaskit.wasm. Native Canvas2D covers most agent needs — admit for
  pixel-exact rendering/font shaping parity use-cases.
- Sources: https://www.npmjs.com/package/canvaskit-wasm · https://blog.form.dev/canvaskit/topics/bundler-integration

### vega/plotly/echarts — REJECT-AS-WASM (pure JS, adequate natively)

## 31. Columnar / dataframes

### parquet-wasm — ADMIT-NOW (read/write Parquet via Arrow)
- Repo: https://github.com/kylebarron/parquet-wasm
- License: MIT/Apache-2.0 · Notes: sync API needs whole buffer upfront;
  async/HTTP-range reads available; IPC + experimental zero-copy FFI back to JS.
  *Measure at admission.* Sources: https://kylebarron.dev/parquet-wasm/

### apache-arrow JS — REJECT-AS-WASM (arrow-js is pure JS and adequate for IPC/FFI glue)

### polars wasm — NOT-FOUND (nodejs-polars is native N-API; no maintained browser wasm build located)

## 32. Search engines

### tantivy-wasm (phiresky) — ADMIT-NOW (the tantivy Paul named)
- Repo: https://github.com/phiresky/tantivy-wasm
- License: MIT/Apache-2.0 (Tantivy) · Size: release wasm ~1.5 MB (demo-reported)
- Notes: on-demand index loading via HTTP Range requests — demo queried a 14 GB
  index downloading ~1.5 MB (project-reported, verify). Pairs with OPFS-cached
  per-origin indexes. Sources: https://github.com/phiresky/tantivy-wasm

### pagefind — ADMIT-NOW (static-site search; wasm + chunked index)
- Repo: https://github.com/CloudCannon/pagefind · License: MIT
- Notes: index built at publish time, queried via wasm with lazy chunks.

### stork — INVESTIGATE (Rust+wasm prebuilt-index search; maintenance slowed)
- Repo: https://github.com/jameslittle230/stork · License: Apache-2.0

### xapian-wasm — NOT-FOUND (no maintained browser wasm port located)

### flexsearch/minisearch/lunr — REJECT-AS-WASM (pure JS, adequate for small corpora)

## 33. Scientific data formats

### h5wasm — ADMIT-NOW (HDF5 read/write)
- Repo: https://github.com/usnistgov/h5wasm
- License: MIT (NIST; public-domain-ish USGov portions) · Notes: browser+Node
  HDF5 via wasm-compiled HDF5; *measure at admission*.
- Sources: https://github.com/usnistgov/h5wasm

### netcdf/GRIB2/Zarr wasm ecosystem — INVESTIGATE (sibling projects by h5wasm author and others; maturity varies; netcdfjs is pure JS for classic NetCDF-3)

### FITS (astronomy) — INVESTIGATE (JS FITS parsers exist; no canonical wasm build found)

## 34. Audio — deepen (v1 §10 admitted eshaz/wasm-audio-decoders)

### @wasm-audio-decoders/flac et al. — ADMIT-NOW (deepen v1 entry with sizes)
- Repo: https://github.com/eshaz/wasm-audio-decoders
- License: LGPL-2.1 (FLAC core; recorded) · Size: FLAC pkg 67.2 KiB minified
- Notes: sync + Web Worker modes; FLAC/Ogg-FLAC full bit depths. Boundary:
  WebCodecs decodes common codecs natively — wasm decoders fill gaps +
  gapless/streaming control.
- Sources: https://www.npmjs.com/package/@wasm-audio-decoders/flac

## 35. Video — deepen (v1: ffmpeg.wasm INVESTIGATE)

### @ffmpeg/core-mt — remains INVESTIGATE, size now captured
- npm: https://www.npmjs.com/package/@ffmpeg/core-mt
- License: GPL-2.0-or-later (recorded) · Size: 32.6 MB wasm, 62.7 MB unpacked
- Notes: WebCodecs first for decode/encode; ffmpeg.wasm only for mux/filter
  graphs WebCodecs can't express. If admitted: OPFS-cached, never bundled.

### mediabunny/mp4box — REJECT-AS-WASM (pure JS mux/demux, adequate natively)

## 36. Image — deepen (v1 §1)

### opencv.js (official OpenCV wasm build) — INVESTIGATE (size is build-config dependent)
- Docs: https://docs.opencv.org/5.0/js_tutorials/js_setup/js_setup/js_setup.html
- License: Apache-2.0 · Notes: official build tooling produces wasm by default;
  --disable_single_file separates .wasm. Admit only a purpose-built minimal
  module set (full builds are 8+ MB). *Measure per build at admission.*

### @uswriting/exiftool (ExifTool via Perl→wasm) — INVESTIGATE (metadata read/write, any format)
- npm: https://www.npmjs.com/package/@uswriting/exiftool
- License: Perl Artistic/GPL dual (ExifTool; recorded)
- Notes: zeroperl-class Perl wasm runtime; covers every metadata format —
  the metadata tool. Verify size + startup cost.

### libraw-wasm / dcraw-wasm — INVESTIGATE (camera RAW: CR2/NEF/ARW/DNG)
- npm: https://www.npmjs.com/package/libraw-wasm · https://www.npmjs.com/package/dcraw-wasm
- License: LGPL-2.1 OR CDDL-1.0 (LibRaw; recorded) · dcraw: public-domain-style
- Notes: decode + thumbnails + metadata. vips/jSquash don't do RAW — real gap.

## 37. 3D / CAD

### draco3d (Google Draco wasm) — ADMIT-NOW (mesh/point-cloud compression)
- Repo: https://github.com/google/draco · npm: draco3d
- License: Apache-2.0 · Notes: official wasm decoders/encoders ship in npm pkg.
- Sources: https://google.github.io/draco/

### meshoptimizer (meshopt_decoder.wasm) — ADMIT-NOW
- Repo: https://github.com/zeux/meshoptimizer · License: MIT
- Notes: ships wasm decoder; glTF EXT_meshopt_compression standard path.
- Sources: https://meshoptimizer.org/

### basis-universal wasm transcoder — ADMIT-NOW (GPU texture transcode)
- Repo: https://github.com/BinomialLLC/basis_universal · License: Apache-2.0
- Notes: official wasm transcoder build in-tree.

### occt-wasm / opencascade.js / brepjs — INVESTIGATE (real CAD kernel in browser: STEP/B-Rep)
- npm: https://www.npmjs.com/package/occt-wasm · https://ocjs.org/ · https://brepjs.dev/
- License: LGPL-2.1 with linking exception (OpenCascade; recorded)
- Notes: huge kernel; brepjs is a higher-level TS API over occt-wasm. Admit
  behind a CAD-viewer use-case; measure per-build.

## 38. Speech

### sherpa-onnx wasm (k2-fsa) — ADMIT-NOW (STT + TTS, ONNX models, documented wasm builds)
- Docs: https://k2-fsa.github.io/sherpa/onnx/tts/wasm/build.html
- License: Apache-2.0 · Notes: official wasm build docs; models fetched
  separately (OPFS-cacheable). *Measure runtime at admission.*

### whisper.cpp wasm wrappers — INVESTIGATE (wrapper maturity varies; models multi-hundred-MB)
- Repo: https://github.com/ggerganov/whisper.cpp (emscripten examples) +
  TS wrappers (e.g. whisper.wasm-class packages)
- License: MIT · Notes: platform LOCAL-MODELS architecture may subsume this —
  coordinate before admitting.

### piper-tts-web — INVESTIGATE (Piper TTS in browser)
- Repo: https://github.com/Poket-Jony/piper-tts-web · License: MIT (Piper)
- Notes: manual asset copying today; verify packaging.

### vosk-browser — INVESTIGATE (from prior knowledge: Apache-2.0 browser wasm STT; verify freshness)
- Repo: https://github.com/alphacep/vosk-browser

## 39. Retro emulation

### js-dos (DOSBox + DOSBox-X wasm) — ADMIT-NOW
- Repo: https://github.com/caiiiycuk/js-dos · https://js-dos.com/dosbox-x.html
- License: GPL-2.0 (DOSBox; recorded)
- Notes: DOS + Win9x-class software in browser/Node; DOSBox-X backend reaches
  Windows 98/ME. Mature, maintained, the standard for in-browser DOS.

### EmulatorJS (RetroArch wasm cores) — ADMIT-NOW
- Repo: https://github.com/EmulatorJS/EmulatorJS
- License: GPL-3.0 (recorded) · Notes: self-hosted frontend over RetroArch wasm
  cores (NES/SNES/GBA/PSX/arcade…). Core-per-system lazy loading fits OPFS.

### MAME wasm / Emularity — INVESTIGATE (archive.org's Emularity bundles JS/wasm MAME; heavyweight)
- Source: https://archive.org/details/emularity_engine_v1

## 40. Game engines

### Godot/Defold/Bevy wasm exports — REJECT-AS-WASM (application frameworks, not callable agent tools; the agent platform ships tools, not games)

## 41. Browser-in-browser — the "kite" investigation

### Identification (for Paul to confirm)
No single canonical "Kite browser in wasm" exists. Candidates found:
1. **kite-project/hope** (2015–2016, archived): a literal "Kite" browser
   project — a Boot2Gecko/Firefox-OS-derived web experience. Dead since 2016.
   https://github.com/kite-project/hope
2. **Kiwix JS** — offline ZIM web reader (PWA + browser extension); the
   "offline web inside the browser" tool. Likely the name-match if Paul
   remembers offline reading. https://github.com/kiwix/kiwix-js
3. **The current browser-in-browser state of the art (HN, 2026)** — most
   likely what Paul saw recently:
   - **Firefox compiled to WASM (Puter/coolelectronics)** — full Gecko + XUL UI
     in wasm; WASM JSPI + WebGL passthrough; networking via wisp-protocol
     TCP-over-WebSocket relay (TLS done by OpenSSL-in-wasm client-side).
     Ran firefox-wasm inside firefox-wasm. HN: https://news.ycombinator.com/item?id=48926939
   - **WebkitWasm (theogbob)** — working WebKit port to wasm.
     https://github.com/theogbob/WebkitWasm
   - **trevorlinton/webkit.js** — the older WebKit-in-browser ancestor.

### firefox-wasm (Puter) — INVESTIGATE (flagship browser-in-browser; single-process, relay-dependent, JSPI required)
- License: MPL-2.0 (Firefox; recorded) · Notes: enormous engineering; network
  requires a TCP relay (wisp); sandboxing degraded (no fission/multiprocess) —
  fine as a tool surface, wrong as a security boundary.

### WebkitWasm — INVESTIGATE (less polished than the Firefox port; no JIT)

### Kiwix JS — ADMIT-NOW (offline ZIM web reader — Wikipedia/StackExchange/etc. offline)
- Repo: https://github.com/kiwix/kiwix-js · License: GPL-3.0 (recorded)
- Notes: wasm decoders (zstd/lzma) inside; ZIM archives are OPFS-cacheable;
  gives every agent an offline web corpus. This is a knowledge-worker tool,
  not a novelty.

### v86 (x86 PC emulator, wasm JIT) — ADMIT-NOW (run real Linux/BSD + old browsers in a tab)
- Repo: https://github.com/copy/v86 · License: BSD-2-Clause
- Notes: wasm-JIT x86 emulator; boots Linux (32-bit); can run legacy browsers
  (old Netscape/Mosaic via oldweb.today-style images). The general
  "computer inside the browser" primitive.
- Sources: https://github.com/copy/v86 · https://copy.sh/v86/

### BrowserBox / Hyperbeam / neko — REJECT-AS-WASM (remote-browser streaming services, not wasm; different product)
- Sources: https://github.com/m1k1o/neko

### oldweb.today / WRP — DOCUMENTED, not candidates (server-rendered legacy browsing proxies)
- Sources: https://github.com/oldweb-today/oldweb-today · https://github.com/tenox7/wrp

## 42. Terminal / shells / coreutils

### wasmer-js (WASIX) — INVESTIGATE (run WASI/WASIX pkgs incl. bash/coreutils in browser)
- Docs: https://docs.wasmer.io/runtime/js/ · License: MIT (Wasmer)
- Notes: SharedArrayBuffer + threads needed; MV3 CSP check at admission.

### coreutils/busybox wasm — INVESTIGATE (via WASIX packages or direct ports; provenance per-package)

## 43. Version control

### wasm-git (libgit2→wasm) — INVESTIGATE
- Repo: https://github.com/petersalomonsen/wasm-git
- License: GPL-2.0-with-linking-exception (libgit2; recorded)
- Notes: real git in browser; compare isomorphic-git (pure JS, mature).
  Admit wasm-git only if libgit2 behaviors (worktrees, filters) are needed.

### isomorphic-git — REJECT-AS-WASM (pure JS, adequate)

## 44. Computer algebra (CAS)

### Giac (giacwasm.js) — ADMIT-NOW (serious CAS; Xcas engine)
- Site: https://www-fourier.univ-grenoble-alpes.fr/~parisse/giacjs/README.md
- License: GPL-3.0 (recorded) · Notes: official browser wasm build + worker
  model; full symbolic CAS (algebra, calculus, solve). *Measure at admission.*

### SymEngine.js — ADMIT-NOW (fast symbolic core, ES module + TS types)
- Site: http://symengine.fizzwizzledazzle.dev/ · Repo: symengine/symengine (wasm build)
- License: MIT · Notes: lighter than Giac; pair with MathJax/KaTeX for display.

### Maxima-on-wasm (ECL+Emscripten) — INVESTIGATE
- Site: https://maxima-on-wasm.pages.dev/ · License: GPL (recorded)

### SymPy — via Pyodide (§58 tier 1); no separate admit.

## 45. R / statistics

### webR — ADMIT-NOW (R in wasm, browser+Node)
- Docs: https://docs.r-wasm.org/webr/latest/ · npm: webr
- License: GPL-2.0-or-later (R; recorded) · Notes: runs R locally, no server;
  growing wasm package repo; API under active development (pin versions).
  The knowledge-worker stats tool.

### jstat / simple-statistics — REJECT-AS-WASM (pure JS, adequate for small stats)

## 46. Plotting

### gnuplot-wasm — INVESTIGATE (experimental; v0.1.0-class, SVG output)
- Repo: https://github.com/stereobooster/gnuplot-wasm · License: gnuplot license (recorded)

### matplotlib — via Pyodide (§58). vega/plotly JS — REJECT-AS-WASM (§30).

## 47. Physics engines

### @dimforge/rapier2d / rapier3d — ADMIT-NOW (official wasm builds)
- Docs: https://rapier.rs/docs/user_guides/javascript/getting_started_js/
- License: Apache-2.0 · Notes: official npm wasm packages; async init;
  deterministic-cross-platform physics. *Measure at admission.*

### box2d-wasm — ADMIT-NOW
- Repo: https://github.com/Birch-san/box2d-wasm · License: MIT/Zlib (Box2D; recorded)

### ammo.js — INVESTIGATE (older Emscripten Bullet port; maintenance unclear)
- Repo: https://github.com/kripken/ammo.js/ · License: Zlib (Bullet; recorded)

## 48. Simulation / circuits

### ngspice wasm (EEcircuit, spice-ts) — INVESTIGATE (real SPICE in browser)
- Repos: https://github.com/eelab-dev/EEcircuit · https://github.com/mfiumara/spice-ts
- License: BSD-3-Clause (ngspice; recorded) · Notes: multiple independent
  ngspice→wasm efforts; spice-ts offers a TS solver + optional ngspice backend.
  Verify which has the cleanest module boundary.

### Fluid sims — NOT-FOUND as libraries (WebGL demos, not reusable wasm modules)

## 49. Math deepen (v1 §8 admitted gmp-wasm + @emnudge/wat-fft)

### wasm-flint (sagemathinc) — INVESTIGATE (FLINT/MPIR/MPFR; number theory)
- Repo: https://github.com/sagemathinc/wasm-flint
- License: LGPL-2.1-or-later (FLINT; recorded) · Notes: SageMath-adjacent
  provenance; admit if number-theory use-cases land. gmp-wasm covers bignum.

## 50. Calendars / dates

### ical.js (Mozilla kewisch) — REJECT-AS-WASM (pure JS, adequate; parses iCalendar RFC 5545 + jCal + vCard + jCard)
- Repo: https://github.com/kewisch/ical.js/ · License: MPL-2.0

### libical wasm — NOT-FOUND (C lib exists; no browser-ready wasm build located)

## 51. Finance math

### quantlib-wasm — INVESTIGATE (real QuantLib via Emscripten)
- npm: https://www.npmjs.com/package/quantlib-wasm · License: BSD-3-Clause (QuantLib; recorded)
- Notes: browser+Node; verify maintenance + size. quantlib.js is a partial JS
  reimplementation (not wasm) — fallback.

## 52. Units / conversion — REJECT-AS-WASM (convert-units JS adequate; Pint via Pyodide §58 tier 2 for heavy cases)

## 53. i18n / dictionaries / spellcheck

### hunspell-wasm — ADMIT-NOW (the hunspell Paul named)
- npm: https://www.npmjs.com/package/hunspell-wasm
- License: GPL-2.0/LGPL-2.1/MPL-1.1 tri (Hunspell; recorded)
- Notes: wasm bindings, browser-ready; dictionaries (.dic/.aff) are OPFS-cacheable data.

### harper.js (Automattic) — ADMIT-NOW (offline grammar checker — beyond spellcheck)
- Repo: https://github.com/automattic/harper
- License: Apache-2.0 · Notes: Rust→wasm, runs fully offline, harper.js
  browser integration. Strong provenance (Automattic). Fits agent text QA.

### ICU4X — remains INVESTIGATE (v1 §5; needs icu4x-datagen trimming)

## 54. Email / contacts

### postal-mime — REJECT-AS-WASM (pure JS, browser/worker/serverless; adequate for RFC 822/MIME)
- Repo: https://github.com/postalsys/postal-mime/ · License: MIT

### wasm email-parser projects — INVESTIGATE (exist as apps, not clean libs; postal-mime likely sufficient)

## 55. Archives

### libarchive.js — ADMIT-NOW (ZIP/7z/RAR v4+v5/TAR + gzip/bzip2/xz…)
- npm: https://www.npmjs.com/package/libarchive.js
- License: BSD-2-Clause (libarchive; recorded)
- Notes: the universal extractor; worker model; *measure at admission*.

### 7z-wasm — INVESTIGATE (7-Zip proper in wasm; needed only for 7z WRITE — libarchive reads 7z)
- License: LGPL-2.1 (7-Zip; recorded)

### unrar wasm — NOT-FOUND as maintained standalone (libarchive.js covers RAR v4/v5 read)

## 56. Security tooling

### @kanru/rage-wasm — ADMIT-NOW (age-compatible encryption, Rust rage→wasm)
- npm: https://registry.npmjs.org/@kanru/rage-wasm
- License: MIT OR Apache-2.0 (rage; recorded) · Notes: kanru (Mozilla) provenance;
  browser-ready. The modern file-encryption tool.

### age-encryption (FiloSottile) — REJECT-AS-WASM (official age JS lib is pure TS and adequate); wage — INVESTIGATE (beta)

### yara-x wasm bindings — INVESTIGATE (official VirusTotal direction, PR #598; browser playground exists)
- Repo: https://github.com/VirusTotal/yara-x · License: BSD-3-Clause (recorded)
- Sources: https://github.com/VirusTotal/yara-x/pull/598

### minisign wasm — NOT-FOUND (no maintained build located)

### clamav wasm — NOT-FOUND (no viable browser build; yara-x covers pattern scanning)

## 57. Networking / protocols

### libcurl.js (ading2210) — INVESTIGATE (libcurl+wolfSSL→wasm, HTTPS over wisp TCP-relay)
- Repo: https://github.com/ading2210/libcurl.js/
- License: curl license (recorded) · Notes: the real-TLS-in-browser trick behind
  firefox-wasm (§41); relay-dependent. Sources: https://news.ycombinator.com/item?id=48926939

### sshclient-wasm — INVESTIGATE (SSH over WebSocket relay; packet-level hooks)
- Repo: https://github.com/VerdigrisTech/sshclient-wasm · License: *record at admission*

### wpcapng (libpcapng→wasm) — INVESTIGATE (in-browser PCAP/PCAPNG parsing)
- Repo: https://github.com/stricaud/wpcapng · License: BSD-3-Clause (libpcap; recorded)

### kaitai-struct wasm — INVESTIGATE (binary-format parsing DSL; JS runtime is pure JS and adequate for most; wasm parser project exists)

### ping/traceroute/telnet — NOT-FOUND (impossible without raw sockets; relay-dependent only — document as platform limitation)

## 58. Python / Pyodide — TIER 1 (built set via loadPackage; per owner scope expansion 2026-09-05)

### Pyodide core + built packages — ADMIT-NOW (pre-bundle tier)
- Docs: https://pyodide.org/en/stable/usage/packages-in-pyodide.html · https://pyodide.org/en/stable/usage/loading-packages.html
- License: MPL-2.0 (Pyodide; each package its own — numpy BSD-3, pandas BSD-3,
  scipy BSD-3, scikit-learn BSD-3, matplotlib PSF-based, regex Apache-2.0,
  PyYAML MIT, cryptography Apache-2.0/BSD-3 — all recorded, none gating)
- Import mechanics: `pyodide.loadPackage([...])` from JS — prebuilt, pinned per
  Pyodide release, less overhead than micropip. **Pre-bundle the core +
  lazy-OPFS-cache the package set**, pinned to an exact Pyodide version.
- Built set includes: numpy, pandas, scipy, scikit-learn, matplotlib, regex,
  PyYAML, cryptography (+ ~100 more; exact set varies per Pyodide release —
  pin the release and snapshot its manifest at admission).
- Sizes: multi-MB per scientific package — *measure per package at admission*;
  packages load on demand, never all upfront.
- Sources: https://pyodide.org/en/stable/usage/packages-in-pyodide.html

## 59. Python / Pyodide — TIER 2 (micropip, PyPI pure wheels)

### micropip — ADMIT-NOW (per-run install tier)
- Docs: https://micropip.pyodide.org/en/stable/project/usage.html
- License: MIT (recorded)
- Import mechanics: `micropip.install(...)` from Python — installs pure-Python
  wheels from PyPI at run time, plus wasm/emscripten wheels when available.
  **Per-run install into an OPFS-backed venv; never pre-bundle.** Packages with
  unsupported native extensions fail — honest error, suggest tier 3 path.
- Long-tail coverage: this is the "every Python library a knowledge worker
  knows" story for pure-Python (requests-free flows, dateutil, rich, typer,
  attrs, pydantic…).

## 60. Python / Pyodide — TIER 3 (pyodide-build, C/Rust extensions)

### pyodide-build + cibuildwheel pyodide platform — INVESTIGATE / DEFER (PEP 783 pending)
- Docs: https://pyodide-build.readthedocs.io/en/latest/how-to/cibuildwheel.html · https://peps.python.org/pep-0783/
- License: MPL-2.0 (recorded)
- Import mechanics: out-of-tree wheels built per-Pyodide-version via
  `pyodide build` or `CIBW_PLATFORM=pyodide`; served and micropip-installed.
  **Defer until PEP 783 (wasm wheel tagging) lands**; wheels are
  Pyodide-version-specific, so admission = version-locked build pipeline.
  Decision: build infra needed before any tier-3 admit.

## 61. AI / ML inference (boundary with LOCAL-MODELS architecture)

### onnxruntime-web (wasm backend) — ADMIT-NOW (universal ONNX runner; all ONNX ops on wasm/CPU)
- Docs: https://onnxruntime.ai/docs/tutorials/web/
- License: MIT · Notes: wasm backend = full op coverage; WebGL/WebGPU/WebNN
  are subsets. The fallback engine when LOCAL-MODELS doesn't cover a model.

### transformers.js — ADMIT-NOW (model zoo glue over onnxruntime-web)
- Docs: https://huggingface.co/docs/transformers.js/api/backends/onnx
- License: Apache-2.0 · Notes: defaults to CPU/wasm in browser; models are
  OPFS-cacheable HF artifacts. Cross-ref whisper/§38.

### tflite wasm — INVESTIGATE (only if a TF-Lite-specific model is required)

## 62. Bioinformatics

### biowasm (samtools, bcftools, bedtools, minimap2, seqtk…) — ADMIT-NOW
- Docs: https://biowasm.com/documentation
- License: MIT (biowasm glue; per-tool licenses recorded: samtools/bcftools MIT/Expat…)
- Notes: the canonical genomics-to-wasm project; Aioli runtime runs tools in
  Web Workers on local files — no upload. Exactly the platform's model.

## 63. Chemistry

### RDKit.js (@rdkit/rdkit) — ADMIT-NOW (official RDKit wasm/JS)
- Repo: https://github.com/rdkit/rdkit-js
- License: BSD-3-Clause (RDKit; recorded)
- Notes: SMILES parse, depiction (SVG), descriptors, substructure. Maintenance
  governance in transition — pin a release and record maintainer state.

### Indigo wasm — INVESTIGATE (EPAM Indigo toolkit has wasm builds; overlaps RDKit)

## 64. Geo — deepen (v1 §11 admitted h3-js + h3o-wasm)

### gdal3.js — ADMIT-NOW (GDAL in browser: gdal_translate/ogr2ogr/gdalwarp/gdaltransform)
- Site: https://gdal3.js.org/ · License: MIT/X11 (GDAL; recorded)
- Notes: raster+vector conversion/reprojection in wasm; the geo ETL tool.
  *Measure at admission* (GDAL is big; check which drivers are in the build).

### geotiff.js — REJECT-AS-WASM boundary note (pure JS with wasm codec plugins; adequate natively; gdal3.js covers the heavy cases)
- Site: https://geotiffjs.github.io/geotiff.js/

## 65. PRODUCTIVITY (owner scope expansion 2026-09-05)

The category is real but mostly JS-boundary — the wasm value comes from
composition of already-catalogued admits:

- **Calendars/tasks**: ical.js (§50, JS adequate) + libical-wasm NOT-FOUND;
  taskwarrior-wasm NOT-FOUND. Cron/rrule: JS adequate.
- **Notes/writing QA**: harper.js (§53) + hunspell-wasm (§53) + v1 markdown
  admits (pulldown-cmark, comrak) + typst.ts (§19) for publishable output.
- **Personal search**: tantivy-wasm (§32) + sqlite-vec (§28) over OPFS —
  the "search my stuff" primitive.
- **Contacts/email**: ical.js vCard support (§50) + postal-mime (§54, JS).
- **Time/date math**: Temporal is now native-ish; JS libs adequate — REJECT-AS-WASM.
- Verdict for the category itself: **no new wasm admits needed**; document the
  composition map above in the catalogue so the product team wires admits
  into productivity flows.
