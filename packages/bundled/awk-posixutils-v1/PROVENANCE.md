# awk — posixutils-rs WASI provenance

- **Upstream:** [`rustcoreutils/posixutils-rs`](https://github.com/rustcoreutils/posixutils-rs)
- **Pinned commit:** `5cce7459837d8614fd9e2ce31312d6d31d114020`
- **Upstream package:** `posixutils-awk` 0.8.0
- **License:** MIT (`source/LICENSE`)
- **Target:** `wasm32-wasip1`, WASI Preview 1
- **Toolchain:** Rust 1.97.1; `build.sh` resolves the installed toolchain, requires the exact recorded `rustc` identity, and invokes its `cargo`/`rustc` binaries directly.
- **Binary:** `binaries/awk.wasm`, 1,064,871 bytes, SHA-256 `e48cd71ae08b03a62e06cf3e0c21acdf051bd9ecfd7e83812be4307502f1fb23`; build and dependency paths are remapped, with no absolute build-host path in the binary.
- **Memory declaration:** 64 initial pages, 512 maximum pages (4–32 MiB)

## Auditable WASI adaptation

The vendored source is narrowed to the `awk`, `plib`, and `gettext-rs` crates and locked by `source/Cargo.lock`. The adaptation is source-visible:

- `plib` selects `locale_wasi.rs` and `regex_wasi.rs` on WASI. POSIX ERE uses pinned `revera` 0.2.1.
- locale selection is deterministically the C locale.
- `system()` returns `-1` on WASI.
- command input/output pipes fail explicitly because WASI provides no subprocess authority.
- ordinary stdin record processing, fields, variables, functions, arrays, expressions, regex, and formatted output remain the upstream parser/interpreter rather than the former clean-room subset.

`./build.sh` starts with two clean Cargo target directories, requires byte-for-byte equality and the admitted SHA-256, retains the independent rebuild at `receipts/rebuild-awk.wasm`, and writes path-independent deterministic identity fields to `receipts/build-receipt.txt`. It performs no source download; Cargo dependencies and checksums are pinned by the lockfile. The extension still revalidates the package manifest, inventory digest, CAS hash, imports, and memory declaration immediately before every execution.
