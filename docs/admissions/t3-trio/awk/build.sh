#!/usr/bin/env bash
# awk (clean-room 0BSD + wasi-libc, pure-WASI preview-1) — reproducible build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SDK="${WASI_SDK_PATH:?set WASI_SDK_PATH to a wasi-sdk 18.1.2 root}"
CC="$SDK/bin/wasm32-wasip1-clang"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
FLAGS=(-O2 -DNDEBUG -Wall -Wextra -Werror -ffile-prefix-map="$ROOT"=/src -Wl,--strip-all -Wl,--initial-memory=524288 -Wl,--max-memory=33554432)
cd "$ROOT"
mkdir -p binaries metadata
rm -f metadata/build-receipt.txt
{
  echo "tool=awk"
  echo "toolchain=$($CC --version | head -1)"
  echo 'flags=-O2 -DNDEBUG -Wall -Wextra -Werror -ffile-prefix-map=<source-root>=/src -Wl,--strip-all -Wl,--initial-memory=524288 -Wl,--max-memory=33554432'
  echo "source_sha256=$(sha256sum source/main.c | cut -d' ' -f1)"
  "$CC" "${FLAGS[@]}" source/main.c -o binaries/awk.wasm
  "$CC" "${FLAGS[@]}" source/main.c -o metadata/rebuild-awk.wasm
  cmp binaries/awk.wasm metadata/rebuild-awk.wasm
  echo "binary_sha256=$(sha256sum binaries/awk.wasm | cut -d' ' -f1)"
  echo "binary_bytes=$(stat -c %s binaries/awk.wasm)"
  echo "reproducible=byte-identical"
} | tee metadata/build-receipt.txt
sha256sum binaries/awk.wasm > metadata/binary-sha256.txt
