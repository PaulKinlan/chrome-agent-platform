#!/usr/bin/env bash
# date (clean-room 0BSD, pure-WASI preview-1) — reproducible build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${WASI_SDK:-/home/paulkinlan/co-do/wasm-tools/.wasi-sdk}"
CC="$SDK/bin/wasm32-wasip1-clang"
SYSROOT="$SDK/share/wasi-sysroot"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
FLAGS=(-O2 -DNDEBUG -Wall -Wextra -Werror -ffile-prefix-map="$ROOT"=/src -Wl,--strip-all -Wl,--initial-memory=131072 -Wl,--max-memory=33554432)
mkdir -p "$ROOT/binaries" "$ROOT/metadata" "$ROOT/logs"

{
  echo "toolchain=$($CC --version | head -1)"
  echo "sdk=$SDK"
  printf 'flags='; printf '%q ' "${FLAGS[@]}"; echo
  "$CC" "${FLAGS[@]}" "$ROOT/source/main.c" -o "$ROOT/binaries/date.wasm"
  "$CC" "${FLAGS[@]}" "$ROOT/source/main.c" -o "$ROOT/metadata/rebuild-date.wasm"
  cmp "$ROOT/binaries/date.wasm" "$ROOT/metadata/rebuild-date.wasm"
  echo "reproducible: byte-identical"
} >> "$ROOT/logs/build.log" 2>&1

sha256sum "$ROOT/binaries/date.wasm" > "$ROOT/metadata/binary-sha256.txt"
echo "date.wasm:"; sha256sum "$ROOT/binaries/date.wasm"
