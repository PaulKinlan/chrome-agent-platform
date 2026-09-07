#!/usr/bin/env bash
# Reproduce packages/bundled/evidence/avif/build-a/avif.wasm byte-identically
# (see SHA256SUMS).
#
# Toolchain: rustc/cargo 1.97.1 (rustup stable, 8bab26f4f 2026-07-14), target
# wasm32-wasip1, --locked deps (Cargo.lock committed here). ravif and rav1e are
# pure Rust with default-features = false on BOTH (rav1e's defaults pull nasm/cc
# asm + rayon threading — impossible here; no SIMD asm means the software path),
# so the build needs nothing outside rustup. Source paths are remapped to
# canonical prefixes so no builder-local path is embedded.
# NOTE for this host: the system /usr/bin/rustc (Arch) shadows rustup and its
# wasm32-wasip1 std is broken — the toolchain bin dir must lead PATH.
set -euo pipefail
cd "$(dirname "$0")"
TC="${RUSTUP_TOOLCHAIN_BIN:-$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin}"
export RUSTFLAGS="-C link-arg=--max-memory=134217728 --remap-path-prefix=$(pwd)=/evidence/avif --remap-path-prefix=$HOME/.cargo/registry=/cargo-registry"
PATH="$TC:$PATH" "$TC/cargo" build --release --target wasm32-wasip1 --locked
cp target/wasm32-wasip1/release/avif.wasm ./avif.wasm
# target/ is an intermediate: it embeds builder-local paths in fingerprint
# metadata and is never committed. Remove it after copying the artifact.
rm -rf target
