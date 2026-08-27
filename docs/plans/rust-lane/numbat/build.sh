#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Rust → wasm32-wasip1 lane. Tool #2: numbat (MIT OR Apache-2.0) + thin WASI wrapper.
# Builds the RUNNABLE numbat-wasi.wasm (stdin → numbat core → stdout), pinned +
# PATH-independent. The wrapper's Cargo.lock is committed (git deps ignore the
# upstream lock).
set -euo pipefail

TOOLCHAIN="stable-x86_64-unknown-linux-gnu"
export RUSTC="$(rustup which --toolchain "$TOOLCHAIN" rustc)"
export CARGO="$HOME/.cargo/bin/cargo"

NUMBAT_VERSION="v1.24.0"
NUMBAT_SHA="79046422203060e296da41c8c762c506200d2c93"

ROOT=$(cd "$(dirname "$0")" && pwd)
WORK="${CARGO_BUILD_DIR:-$ROOT/../../../../.build/rust-lane}"
OUT="$ROOT/binaries"
mkdir -p "$WORK" "$OUT"

# The wrapper crate depends on numbat via git at the pinned rev (its committed
# Cargo.lock pins the transitive versions).
WRAPPER="$ROOT/wasi-wrapper"

"$CARGO" build --release --target wasm32-wasip1 --manifest-path "$WRAPPER/Cargo.toml" \
  --target-dir "$WORK/target" --locked

cp "$WORK/target/wasm32-wasip1/release/numbat-wasi.wasm" "$OUT/numbat-wasi.wasm"
echo "built: $OUT/numbat-wasi.wasm"
sha256sum "$OUT/numbat-wasi.wasm"
