#!/usr/bin/env bash
# Reproduce packages/bundled/evidence/imageops/build-a/imageops.wasm
# byte-identically (see SHA256SUMS).
#
# Toolchain: rustc/cargo 1.97.1 (rustup stable, 8bab26f4f 2026-07-14), target
# wasm32-wasip1, --locked deps (Cargo.lock committed here). Source paths are
# remapped to canonical prefixes so no builder-local path is embedded.
# NOTE for this host: the system /usr/bin/rustc (Arch) shadows rustup and its
# wasm32-wasip1 std is broken — the toolchain bin dir must lead PATH.
set -euo pipefail
cd "$(dirname "$0")"
TC="${RUSTUP_TOOLCHAIN_BIN:-$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin}"
export RUSTFLAGS="-C link-arg=--max-memory=134217728 --remap-path-prefix=$(pwd)=/evidence/imageops --remap-path-prefix=$HOME/.cargo/registry=/cargo-registry"
PATH="$TC:$PATH" "$TC/cargo" build --release --target wasm32-wasip1 --locked
cp target/wasm32-wasip1/release/imageops.wasm ./imageops.wasm
