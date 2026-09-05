#!/usr/bin/env bash
# sed (minised 1.16, BSD-3-Clause) — reproducible WASI build.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSROOT="${WASI_SYSROOT:?set WASI_SYSROOT to a wasi-sysroot-22.0 tree}"
RTDIR="${WASI_RT:?set WASI_RT to a dir with lib/wasm32-unknown-wasip1/libclang_rt.builtins.a + include/}"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
FLAGS="-O2 -DNDEBUG -g0 -ffile-prefix-map=$ROOT=/src -Wl,--strip-all -Wl,--initial-memory=4194304 -Wl,--max-memory=33554432"
mkdir -p "$ROOT/binaries" "$ROOT/metadata" "$ROOT/logs"
{
  echo "toolchain=$(clang --version | head -1)"
  echo "sdk=$SYSROOT"
  printf 'flags='; printf '%q ' ${FLAGS[@]}; echo
  clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RTDIR" \
    -I"$SYSROOT/include/wasm32-wasip1" -I"$SYSROOT/include" \
    ${FLAGS[@]} "$ROOT/source/sedcomp.c" "$ROOT/source/sedexec.c" -o "$ROOT/binaries/sed.wasm"
  clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RTDIR" \
    -I"$SYSROOT/include/wasm32-wasip1" -I"$SYSROOT/include" \
    ${FLAGS[@]} "$ROOT/source/sedcomp.c" "$ROOT/source/sedexec.c" -o "$ROOT/metadata/rebuild-sed.wasm"
  cmp "$ROOT/binaries/sed.wasm" "$ROOT/metadata/rebuild-sed.wasm"
  echo "reproducible: byte-identical"
} >> "$ROOT/logs/build.log" 2>&1
sha256sum "$ROOT/binaries/sed.wasm" > "$ROOT/metadata/binary-sha256.txt"
echo "done"
