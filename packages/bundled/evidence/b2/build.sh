#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
# toolchain: wasi-sdk clang 22.1.8 (host path scrubbed on repo migration)
WASI_SDK="${WASI_SDK:?set WASI_SDK to a wasi-sdk 22.1.8 install}"
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
