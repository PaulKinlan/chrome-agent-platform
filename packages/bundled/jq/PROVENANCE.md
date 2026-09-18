# jq_filter_bounded — provenance (single-threaded PATCHED FORK)

- source.repo: https://github.com/jqlang/jq (pinned release jq-1.8.2, commit 34f7186b)
- source.commit: 34f7186b (jq-1.8.2 release commit)
- source.license: MIT (COPYING-jq.txt vendored verbatim)
- patch: single-threaded WASI preview-1 fork
  - `__thread` thread-locals -> `-femulated-tls` (emutls, internal — no TLS import)
  - pthread TLS/mutex/once -> single-slot/no-op shim (source/pthread-shim.c, installed as source/pthread.h)
  - `-D_WASI_EMULATED_SIGNAL` + `-lwasi-emulated-signal` (decNumber includes signal.h)
  - `--without-oniguruma` (regex dep omitted; jq's default regex via decnum is retained)
- binary.sha256: 55543604db368e4526cf1e7554312863323797c128b68bb08acea053055cb8c0
- binary.size: 501522 bytes (~490 KiB, tiny tier)
- imports: 19 (all wasi_snapshot_preview1; no JS, no threads) — see metadata/census.txt
- build: metadata/build-receipt.txt + build.sh (clang 22.1.8 + wasi-sysroot-22.0 + wasi-rt)
- never-fabricate: build receipt, binary sha256, and SBOM are REAL from retained builds;
  binaries/jq.wasm and metadata/rebuild-jq.wasm are byte-identical (deterministic
  double-build re-run, clang 22.1.8 + wasi-sysroot-22.0).
- ran: `echo '{"name":"cap","tags":["a","b"]}' | jq '.name+"|"+(.tags|join(","))'` -> `"cap|a,b"`;
  `jq -n '1+1'` -> `2`
