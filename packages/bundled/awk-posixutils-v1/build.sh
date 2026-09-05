#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$ROOT/source"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C CARGO_INCREMENTAL=0
EXPECTED_RUST_VERSION="rustc 1.97.1 (8bab26f4f 2026-07-14)"
EXPECTED_SHA="e48cd71ae08b03a62e06cf3e0c21acdf051bd9ecfd7e83812be4307502f1fb23"
TOOLCHAIN="$(rustup run stable rustc --print sysroot)"
CARGO_SOURCE="${CARGO_HOME:-$HOME/.cargo}"
RUSTUP_SOURCE="${RUSTUP_HOME:-$HOME/.rustup}"
export RUSTC="$TOOLCHAIN/bin/rustc"
export RUSTDOC="$TOOLCHAIN/bin/rustdoc"
CARGO="$TOOLCHAIN/bin/cargo"
RUST_VERSION="$("$RUSTC" --version)"
[[ "$RUST_VERSION" == "$EXPECTED_RUST_VERSION" ]] || {
  printf 'unexpected compiler: %s\n' "$RUST_VERSION" >&2
  exit 1
}
export RUSTFLAGS="--remap-path-prefix=$SOURCE=/src --remap-path-prefix=$CARGO_SOURCE=/cargo --remap-path-prefix=$RUSTUP_SOURCE=/rustup -C link-arg=--initial-memory=4194304 -C link-arg=--max-memory=33554432"
mkdir -p "$ROOT/binaries" "$ROOT/receipts"
rm -rf "$ROOT/target-first" "$ROOT/target-second"
: > "$ROOT/receipts/build.log"
printf '%s\n' "$RUST_VERSION" | tee -a "$ROOT/receipts/build.log"
for pass in first second; do
  target="$ROOT/target-$pass"
  CARGO_TARGET_DIR="$target" "$CARGO" build \
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
[[ "$DIGEST" == "$EXPECTED_SHA" ]] || {
  printf 'unexpected awk digest: %s\n' "$DIGEST" >&2
  exit 1
}
BYTES="$(wc -c < "$ROOT/binaries/awk.wasm" | tr -d ' ')"
printf '%s  binaries/awk.wasm\n' "$DIGEST" | tee -a "$ROOT/receipts/build.log"
printf 'rustc=%s\nbinary_sha256=%s\nbinary_bytes=%s\nreproducible=byte-identical\n' \
  "$RUST_VERSION" "$DIGEST" "$BYTES" > "$ROOT/receipts/build-receipt.txt"
