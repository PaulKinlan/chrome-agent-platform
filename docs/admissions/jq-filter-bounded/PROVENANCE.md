# jq_filter_bounded — provenance (single-threaded PATCHED FORK)

- source.repo: https://github.com/jqlang/jq (pinned release jq-1.8.2, commit 34f7186b)
- source.commit: 34f7186b (jq-1.8.2 release commit)
- source.license: MIT (COPYING-jq.txt vendored verbatim)
- patch: single-threaded WASI preview-1 fork
  - `__thread` thread-locals -> `-femulated-tls` (emutls, internal — no TLS import)
  - pthread TLS/mutex/once -> single-slot/no-op shim (source/pthread-shim.c)
  - `-D_WASI_EMULATED_SIGNAL` + `-lwasi-emulated-signal` (decNumber includes signal.h)
  - `--without-oniguruma` (regex dep omitted; jq's default regex via decnum is retained)
- binary.sha256: b428286b49c45ea6d494defd16e46083cd04fc7a5541a3a35d756853ee7e613d
- binary.size: 501520 bytes (~490 KiB, tiny tier)
- imports: 19 (all wasi_snapshot_preview1; no JS, no threads) — see metadata/census.txt
- build: metadata/build.log + build.sh (clang 22.1.8 + wasi-sysroot-22.0 + wasi-rt)
- never-fabricate: build.log and binary.sha256 are REAL from this build; deterministic
  double-build byte-identity NOT yet re-run (single build) — honest.
- ran: `echo '{"name":"cap","tags":["a","b"]}' | jq '.name+"|"+(.tags|join(","))'` -> `"cap|a,b"`;
  `jq -n '1+1'` -> `2`
