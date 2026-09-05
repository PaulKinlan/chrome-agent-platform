#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
WASI_SDK="${WASI_SDK:?set WASI_SDK to a wasi-sdk directory}"
CC="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
FLAGS=(
  --target=wasm32-wasip1
  --sysroot="$SYSROOT"
  -O3 -DNDEBUG -g0
  "-ffile-prefix-map=$ROOT=/src"
  -Wl,--strip-all
  -Wl,--initial-memory=4194304
  -Wl,--max-memory=33554432
)
mkdir -p "$ROOT/binaries" "$ROOT/rebuild" "$ROOT/receipts"
: > "$ROOT/receipts/build.log"
"$CC" --version | head -1 >> "$ROOT/receipts/build.log"
for tool in base64 grep sort tr uniq wc; do
  echo "building $tool" | tee -a "$ROOT/receipts/build.log"
  "$CC" "${FLAGS[@]}" "$ROOT/source/$tool.c" -o "$ROOT/binaries/$tool.wasm" 2>> "$ROOT/receipts/build.log"
  "$CC" "${FLAGS[@]}" "$ROOT/source/$tool.c" -o "$ROOT/rebuild/$tool.wasm" 2>> "$ROOT/receipts/build.log"
  cmp "$ROOT/binaries/$tool.wasm" "$ROOT/rebuild/$tool.wasm"
  sha256sum "$ROOT/binaries/$tool.wasm" | tee -a "$ROOT/receipts/build.log"
done
printf 'reproducible=byte-identical\n' >> "$ROOT/receipts/build.log"
