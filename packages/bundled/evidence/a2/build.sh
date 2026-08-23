#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# toolchain: wasi-sdk clang 22.1.8 (host path scrubbed on repo migration)
SDK="${WASI_SDK:?set WASI_SDK to a wasi-sdk 22.1.8 install}"
CC="$SDK/bin/clang"
SYSROOT="$SDK/share/wasi-sysroot"
TOOLS=(base64 md5sum sha256sum sha512sum xxd uuid wc head tail cut)
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
FLAGS=(--target=wasm32-wasi --sysroot="$SYSROOT" -I"$ROOT/source" -O2 -DNDEBUG -Wall -Wextra -Werror -ffile-prefix-map="$ROOT"=/src -Wl,--strip-all -Wl,--initial-memory=131072 -Wl,--max-memory=33554432)
mkdir -p "$ROOT/binaries" "$ROOT/rebuild-check" "$ROOT/logs" "$ROOT/metadata"
: > "$ROOT/logs/build.log"
{
  echo "toolchain=$($CC --version | head -1)"
  echo "sdk=$SDK"
  printf 'flags='; printf '%q ' "${FLAGS[@]}"; echo
  for tool in "${TOOLS[@]}"; do
    sources=("$ROOT/source/$tool/main.c" "$ROOT/source/common.c")
    case "$tool" in md5sum|sha256sum|sha512sum) sources+=("$ROOT/source/digest.c");; esac
    echo "BUILD-1 $tool"
    "$CC" "${FLAGS[@]}" "${sources[@]}" -o "$ROOT/binaries/$tool.wasm"
    echo "BUILD-2 $tool"
    "$CC" "${FLAGS[@]}" "${sources[@]}" -o "$ROOT/rebuild-check/$tool.wasm"
    sha256sum "$ROOT/binaries/$tool.wasm" "$ROOT/rebuild-check/$tool.wasm"
    cmp "$ROOT/binaries/$tool.wasm" "$ROOT/rebuild-check/$tool.wasm"
    stat -c 'size=%s path=%n' "$ROOT/binaries/$tool.wasm"
  done
} >> "$ROOT/logs/build.log" 2>&1
(cd "$ROOT" && sha256sum binaries/*.wasm) > "$ROOT/metadata/binary-sha256.txt"
(cd "$ROOT" && sha256sum rebuild-check/*.wasm) > "$ROOT/metadata/rebuild-sha256.txt"
echo "two deterministic builds are byte-identical for all ${#TOOLS[@]} tools"
