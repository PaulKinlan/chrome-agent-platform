# sed (minised) — the five never-fabricate inputs
1. source.repo: https://dl.exactcode.de/oss/minised/minised-1.16.tar.gz (release 1.16)
2. source.commit: n/a (release tarball; sha256 in metadata/source-tarball-sha256.txt)
3. binary.sha256: d95860b960d73af024b05c20d13410d7b942ff33ac0502de97ec4f24525c107a (REAL, from the built artifact)
4. build.log + toolchain: logs/build.log (clang 22.1.8 + wasi-sysroot-22.0)
5. sbom: NOTICES.md (BSD-3-Clause) + source files (sedcomp.c, sedexec.c, sed.h)
All REAL — no fabricated values.
