#!/usr/bin/env bash
# Reproduce packages/bundled/evidence/oxipng/build-a/oxipng.wasm
# byte-identically (see SHA256SUMS).
#
# Toolchain: rustc/cargo 1.97.1 (rustup stable, 8bab26f4f 2026-07-14), target
# wasm32-wasip1, --locked deps (Cargo.lock committed here). The one C
# dependency (libdeflate, via libdeflate-sys) is compiled by the cc crate with
# clang --target=wasm32-wasip1 -ffreestanding -nostdlib -DFREESTANDING (the
# crate's `freestanding` feature): NO WASI sysroot / wasi-sdk is needed or used,
# so the build depends on nothing outside rustup + clang. Source paths are
# remapped to canonical prefixes so no builder-local path is embedded.
# NOTE for this host: the system /usr/bin/rustc (Arch) shadows rustup and its
# wasm32-wasip1 std is broken — the toolchain bin dir must lead PATH.
set -euo pipefail
cd "$(dirname "$0")"
TC="${RUSTUP_TOOLCHAIN_BIN:-$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin}"
export RUSTFLAGS="-C link-arg=--max-memory=134217728 --remap-path-prefix=$(pwd)=/evidence/oxipng --remap-path-prefix=$HOME/.cargo/registry=/cargo-registry"
# The C objects must not embed builder paths either (cc passes the source path
# to clang; -ffile-prefix-map canonicalises what ends up in the object).
export CFLAGS_wasm32_wasip1="-ffile-prefix-map=$HOME/.cargo/registry=/cargo-registry"
PATH="$TC:$PATH" "$TC/cargo" build --release --target wasm32-wasip1 --locked
cp target/wasm32-wasip1/release/oxipng.wasm ./oxipng.wasm
# target/ is an intermediate: it embeds builder-local paths in fingerprint
# metadata and is never committed. Remove it after copying the artifact.
rm -rf target
