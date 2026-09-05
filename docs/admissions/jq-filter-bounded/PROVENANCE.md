# jq — provenance (single-threaded WASI adaptation)

- **Upstream:** [`jqlang/jq`](https://github.com/jqlang/jq), release 1.8.2, commit `34f7186b`.
- **Pinned release archive SHA-256:** `71b8d6e8f5fe81f6c6d0d110e3892251f6ce76ed095abd315e26e6e1193af3af`.
- **License:** MIT (`COPYING-jq.txt`, vendored verbatim).
- **WASI adaptation:** `-femulated-tls`; a single-threaded pthread TLS/mutex/once shim; wasi-libc emulated signals for decNumber; Oniguruma omitted because it is not WASI-compatible in this profile. Regex built-ins that depend on Oniguruma are therefore unavailable; jq's real parser, JSON streaming, filters, expressions, object/array operations, reductions, and formatter remain upstream jq 1.8.2.
- **Toolchain:** clang 22.1.8, wasi-sysroot 22.0, WASI Preview 1.
- **Binary:** 501,520 bytes, SHA-256 `b428286b49c45ea6d494defd16e46083cd04fc7a5541a3a35d756853ee7e613d`.
- **Imports:** 19, all `wasi_snapshot_preview1` (see `metadata/census.txt`); no JS or thread imports.
- **Reproducibility:** `build.sh` extracts the hash-pinned archive into two independent build roots, builds both, and requires byte identity. `metadata/rebuild-jq.wasm` is byte-identical to the admitted binary.

Direct WASI probes include `jq -c '. | select(.value == "MATCH")'` over the deterministic 100 MiB JSON-lines fixture. Final admission additionally requires execution of these exact CAS bytes through the loaded extension's OPFS worker path.
