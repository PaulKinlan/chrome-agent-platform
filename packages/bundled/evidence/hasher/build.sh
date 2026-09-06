#!/usr/bin/env bash
# Reproduce packages/bundled/evidence/hasher/build-a/hasher.wasm
# byte-identically (see SHA256SUMS).
#
# Toolchain: rustup stable, target wasm32-wasip1, --locked deps (Cargo.lock
# committed here). Source paths are remapped to canonical prefixes so no
# builder-local path is embedded.
# NOTE for this host: the system /usr/bin/rustc (Arch) shadows rustup and its
# wasm32-wasip1 std is broken — the toolchain bin dir must lead PATH.
set -euo pipefail
cd "$(dirname "$0")"
TC="${RUSTUP_TOOLCHAIN_BIN:-$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin}"
export RUSTFLAGS="-C link-arg=--max-memory=134217728 --remap-path-prefix=$(pwd)=/evidence/hasher --remap-path-prefix=$HOME/.cargo/registry=/cargo-registry"
PATH="$TC:$PATH" "$TC/cargo" build --release --target wasm32-wasip1 --locked
cp target/wasm32-wasip1/release/hasher.wasm ./hasher.wasm
