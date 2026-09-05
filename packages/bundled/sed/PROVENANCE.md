# sed (minised) — the five never-fabricate inputs
1. source.repo: https://dl.exactcode.de/oss/minised/minised-1.16.tar.gz (release 1.16)
2. source.commit: n/a (release tarball; sha256 in metadata/source-tarball-sha256.txt)
3. binary.sha256: 3e553ca399ce02c6d796cf80e08057ae41730f32f507d9bc2561e75faa4c2438 (49,977 bytes; 64 initial / 512 maximum pages; REAL, from the built artifact)
4. build.log + toolchain: logs/build.log (clang 22.1.8 + wasi-sysroot-22.0); build.sh requires that compiler identity, two clean byte-identical outputs, and the admitted SHA-256
5. sbom: NOTICES.md (BSD-3-Clause) + source files (sedcomp.c, sedexec.c, sed.h)
All REAL — no fabricated values.
