# tokei (patched fork) — provenance

- upstream: https://github.com/XAMPPRocky/tokei — MIT OR Apache-2.0
- pinned commit: 8cdd6fa3a54f8cd69442d2f00effb29aa3110353 (tag v14.0.0)
- patches (this repo, docs/plans/rust-lane/):
  - rayon-wasi/ (serial shim, MIT OR Apache-2.0) — [patch.crates-io] rayon
  - home-wasi/ (home_dir env stub, MIT OR Apache-2.0) — [patch.crates-io] home
  - ignore-wasi/ (fork of ignore-0.4.22: wasi from_path/from_entry_os, MIT OR
    Apache-2.0; upstream ignore is Unlicense OR MIT) — [patch.crates-io] ignore
  - tokei src/utils/fs.rs: build_parallel → serial build() (thread-free walk)
- binary.sha256: SEE metadata/sha256.txt (reproducible — byte-identical rebuild)
- never-fabricate inputs: source.commit pinned + verified; binary.sha256 real;
  build log + toolchain = the build.sh above; SBOM = census in NOTICES.

## Status
BUILD + CENSUS proven. RUNNABLE count is the remaining gap (BLOCKED.runtime.md).
