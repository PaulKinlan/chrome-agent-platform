#!/usr/bin/env bash
# sed (minised 1.16, BSD-3-Clause) — reproducible WASI build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSROOT="${WASI_SYSROOT:?set WASI_SYSROOT to a wasi-sysroot-22.0 tree}"
RTDIR="${WASI_RT:?set WASI_RT to a dir with lib/wasm32-unknown-wasip1/libclang_rt.builtins.a + include/}"
CLANG="${CLANG:-clang}"
EXPECTED_CLANG="clang version 22.1.8"
EXPECTED_SHA="3e553ca399ce02c6d796cf80e08057ae41730f32f507d9bc2561e75faa4c2438"
ACTUAL_CLANG="$("$CLANG" --version | head -1)"
[[ "$ACTUAL_CLANG" == "$EXPECTED_CLANG" ]] || {
  printf 'unexpected compiler: %s\n' "$ACTUAL_CLANG" >&2
  exit 1
}
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
FLAGS="-O2 -DNDEBUG -g0 -ffile-prefix-map=$ROOT=/src -Wl,--strip-all -Wl,--initial-memory=4194304 -Wl,--max-memory=33554432"
mkdir -p "$ROOT/binaries" "$ROOT/metadata" "$ROOT/logs"
{
  echo "toolchain=$ACTUAL_CLANG"
  echo "sdk=wasi-sysroot-22.0"
  echo 'flags=-O2 -DNDEBUG -g0 -ffile-prefix-map=<source>=/src -Wl,--strip-all -Wl,--initial-memory=4194304 -Wl,--max-memory=33554432'
  "$CLANG" --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RTDIR" \
    -I"$SYSROOT/include/wasm32-wasip1" -I"$SYSROOT/include" \
    ${FLAGS[@]} "$ROOT/source/sedcomp.c" "$ROOT/source/sedexec.c" -o "$ROOT/binaries/sed.wasm"
  "$CLANG" --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RTDIR" \
    -I"$SYSROOT/include/wasm32-wasip1" -I"$SYSROOT/include" \
    ${FLAGS[@]} "$ROOT/source/sedcomp.c" "$ROOT/source/sedexec.c" -o "$ROOT/metadata/rebuild-sed.wasm"
  cmp "$ROOT/binaries/sed.wasm" "$ROOT/metadata/rebuild-sed.wasm"
  echo "reproducible: byte-identical"
} >> "$ROOT/logs/build.log" 2>&1
DIGEST="$(sha256sum "$ROOT/binaries/sed.wasm" | cut -d' ' -f1)"
[[ "$DIGEST" == "$EXPECTED_SHA" ]] || {
  printf 'unexpected sed digest: %s\n' "$DIGEST" >&2
  exit 1
}
printf '%s  binaries/sed.wasm\n' "$DIGEST" > "$ROOT/metadata/binary-sha256.txt"
echo "done"
