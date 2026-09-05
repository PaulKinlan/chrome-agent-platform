#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$ROOT/source"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C CARGO_INCREMENTAL=0
TOOLCHAIN="$(rustup run stable rustc --print sysroot)"
CARGO_SOURCE="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_SOURCE="${RUSTUP_HOME:-$HOME/.rustup}"
export RUSTC="$TOOLCHAIN/bin/rustc"
export RUSTDOC="$TOOLCHAIN/bin/rustdoc"
export RUSTFLAGS="--remap-path-prefix=$SOURCE=/src --remap-path-prefix=$CARGO_SOURCE=/cargo --remap-path-prefix=$RUSTUP_SOURCE=/rustup -C link-arg=--initial-memory=4194304 -C link-arg=--max-memory=33554432"
mkdir -p "$ROOT/binaries" "$ROOT/receipts"
rm -rf "$ROOT/target-first" "$ROOT/target-second"
: > "$ROOT/receipts/build.log"
RUST_VERSION="$(rustup run stable rustc --version)"
printf '%s\n' "$RUST_VERSION" | tee -a "$ROOT/receipts/build.log"
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
mv "$ROOT/binaries/awk-second.wasm" "$ROOT/receipts/rebuild-awk.wasm"
rm -rf "$ROOT/target-first" "$ROOT/target-second"
DIGEST="$(sha256sum "$ROOT/binaries/awk.wasm" | cut -d' ' -f1)"
BYTES="$(wc -c < "$ROOT/binaries/awk.wasm" | tr -d ' ')"
printf '%s  %s\n' "$DIGEST" "$ROOT/binaries/awk.wasm" | tee -a "$ROOT/receipts/build.log"
printf 'rustc=%s\nbinary_sha256=%s\nbinary_bytes=%s\nreproducible=byte-identical\n' \
  "$RUST_VERSION" "$DIGEST" "$BYTES" > "$ROOT/receipts/build-receipt.txt"
