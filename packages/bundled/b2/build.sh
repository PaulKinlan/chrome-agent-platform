#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
WASI_SDK=/home/paulkinlan/co-do/wasm-tools/.wasi-sdk
CC="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"
PASS=${1:?usage: build.sh PASS_NAME}
OUT="$ROOT/binaries/$PASS"
mkdir -p "$OUT"
for tool in sort uniq tr grep diff patch; do
  set -x
  "$CC" --target=wasm32-wasi --sysroot="$SYSROOT" -std=c17 -O2 -Wall -Wextra -Werror \
    -Wl,--max-memory=33554432 -Wl,-z,stack-size=131072 \
    -o "$OUT/$tool.wasm" "$ROOT/source/$tool/main.c"
  set +x
done
set -x
"$CC" --target=wasm32-wasi --sysroot="$SYSROOT" -std=c17 -O2 -Wall -Wextra -Werror \
  -Wl,--max-memory=33554432 -Wl,-z,stack-size=131072 \
  -I"$ROOT/source/toml2json/upstream" \
  -o "$OUT/toml2json.wasm" "$ROOT/source/toml2json/main.c" "$ROOT/source/toml2json/upstream/toml.c"
set +x
