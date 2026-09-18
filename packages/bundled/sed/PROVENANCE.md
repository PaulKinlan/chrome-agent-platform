# sed (minised) — the five never-fabricate inputs
1. source.repo: https://dl.exactcode.de/oss/minised/minised-1.16.tar.gz (release 1.16)
2. source.commit: n/a (release tarball; sha256 in metadata/source-tarball-sha256.txt)
3. binary.sha256: 2c06b0adbbdf33b6f051393a339548ab25219348c3667c96efc3b903cc3803e3 (REAL, from the built artifact)
4. build.log + toolchain: metadata/build-receipt.txt (clang 22.1.8 + wasi-sysroot-22.0, scrubbed)
5. sbom: sbom.cdx.json + NOTICES.md (BSD-3-Clause) + source files (sedcomp.c, sedexec.c, sed.h)
All REAL — no fabricated values.
