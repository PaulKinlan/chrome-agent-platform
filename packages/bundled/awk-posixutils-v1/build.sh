#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$ROOT/source"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C CARGO_INCREMENTAL=0
TOOLCHAIN="$(rustup run stable rustc --print sysroot)"
export RUSTC="$TOOLCHAIN/bin/rustc"
export RUSTDOC="$TOOLCHAIN/bin/rustdoc"
export RUSTFLAGS="--remap-path-prefix=$SOURCE=/src -C link-arg=--initial-memory=4194304 -C link-arg=--max-memory=33554432"
mkdir -p "$ROOT/binaries" "$ROOT/receipts"
: > "$ROOT/receipts/build.log"
rustup run stable rustc --version | tee -a "$ROOT/receipts/build.log"
for pass in first second; do
  target="$ROOT/target-$pass"
  CARGO_TARGET_DIR="$target" rustup run stable cargo build \
    --manifest-path "$SOURCE/Cargo.toml" \
    --package posixutils-awk --bin awk --release --locked --target wasm32-wasip1 \
    2>> "$ROOT/receipts/build.log"
  cp "$target/wasm32-wasip1/release/awk.wasm" "$ROOT/binaries/awk-$pass.wasm"
done
cmp "$ROOT/binaries/awk-first.wasm" "$ROOT/binaries/awk-second.wasm"
mv "$ROOT/binaries/awk-first.wasm" "$ROOT/binaries/awk.wasm"
rm "$ROOT/binaries/awk-second.wasm"
sha256sum "$ROOT/binaries/awk.wasm" | tee -a "$ROOT/receipts/build.log"
printf 'reproducible=byte-identical\n' >> "$ROOT/receipts/build.log"
