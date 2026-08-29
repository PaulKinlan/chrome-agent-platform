# awk_filter_bounded (clean-room 0BSD) — the five never-fabricate inputs
1. source.repo: clean-room 0BSD C implementation (source/main.c)
2. source.commit: in-tree source/main.c
3. binary.sha256: 4ca68d700d2db97b8727b50f02c2720197509ff74724b2ad6df4939ee8c76384 (REAL, from the built artifact)
4. build.log + toolchain: logs/build.log (clang 18.1.2 + wasi-sysroot 22.0)
5. sbom: NOTICES.md (0BSD) + source file (source/main.c)
All REAL — no fabricated values.
