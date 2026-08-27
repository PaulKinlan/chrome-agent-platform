#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Rust → wasm32-wasip1 lane. Tool #2: numbat core (MIT OR Apache-2.0).
# HONEST: numbat core is a LIBRARY (no bin target) — this builds the rlib + proves
# the WASI build/census; the runnable .wasm needs the thin WASI entrypoint wrapper
# (the admission follow-up, see README.md "HONEST BLOCKER").
set -euo pipefail

TOOLCHAIN="stable-x86_64-unknown-linux-gnu"
export RUSTC="$(rustup which --toolchain "$TOOLCHAIN" rustc)"
export CARGO="$HOME/.cargo/bin/cargo"

NUMBAT_VERSION="v1.24.0"
NUMBAT_SHA="79046422203060e296da41c8c762c506200d2c93"

ROOT=$(cd "$(dirname "$0")" && pwd)
WORK="${CARGO_BUILD_DIR:-$ROOT/../../../../.build/rust-lane}"
SRC="$WORK/source/numbat"
mkdir -p "$WORK"

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$NUMBAT_VERSION" https://github.com/sharkdp/numbat.git "$SRC"
fi
test "$(git -C "$SRC" rev-parse HEAD)" = "$NUMBAT_SHA" || {
  echo "pinned commit mismatch: got $(git -C "$SRC" rev-parse HEAD) want $NUMBAT_SHA" >&2; exit 1; }

# Build the CORE lib to wasip1 (default features off: plotting + fetch-exchangerates).
"$CARGO" build --release --target wasm32-wasip1 -p numbat --no-default-features \
  --manifest-path "$SRC/Cargo.toml" --target-dir "$WORK/target"

echo "built (rlib only — no runnable .wasm; see README 'HONEST BLOCKER'): $WORK/target/wasm32-wasip1/release/libnumbat.rlib"
