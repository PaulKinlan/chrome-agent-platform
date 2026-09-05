#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
WASI_SDK="${WASI_SDK:?set WASI_SDK to a wasi-sdk directory}"
CC="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"
EXPECTED_CLANG="clang version 18.1.2-wasi-sdk (https://github.com/llvm/llvm-project 26a1d6601d727a96f4301d0d8647b5a42760ae0c)"
declare -A EXPECTED_SHA=(
  [base64]=20d6324f4925ee8263322bb74eb818861f13fbd0d4ce080b13c2140b213232cf
  [grep]=04d32c115c9e3a979d59cfe27ea0e5ece616efd64ff958d4fcc96bb217191588
  [sort]=e0543d170ac9bd0cd55b274604b55add18c17c5d87169ebfdf25b4b7245a386a
  [tr]=bec02b43bdeb1997f9616d95499ce91010e124aecb1cad6e6bd97102c0956f3f
  [uniq]=973d78aa28f825019fbfb4aa9463dc6940a65d7da6de80590ba1a691443154df
  [wc]=ce303be0226d2675019191dddbcded6d83de100922fcc10e5ee48a058c0d27d5
)
ACTUAL_CLANG="$("$CC" --version | head -1)"
[[ "$ACTUAL_CLANG" == "$EXPECTED_CLANG" ]] || {
  printf 'unexpected compiler: %s\n' "$ACTUAL_CLANG" >&2
  exit 1
}
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
printf '%s\n' "$ACTUAL_CLANG" >> "$ROOT/receipts/build.log"
for tool in base64 grep sort tr uniq wc; do
  echo "building $tool" | tee -a "$ROOT/receipts/build.log"
  "$CC" "${FLAGS[@]}" "$ROOT/source/$tool.c" -o "$ROOT/binaries/$tool.wasm" 2>> "$ROOT/receipts/build.log"
  "$CC" "${FLAGS[@]}" "$ROOT/source/$tool.c" -o "$ROOT/rebuild/$tool.wasm" 2>> "$ROOT/receipts/build.log"
  cmp "$ROOT/binaries/$tool.wasm" "$ROOT/rebuild/$tool.wasm"
  digest="$(sha256sum "$ROOT/binaries/$tool.wasm" | cut -d' ' -f1)"
  [[ "$digest" == "${EXPECTED_SHA[$tool]}" ]] || {
    printf 'unexpected %s digest: %s\n' "$tool" "$digest" >&2
    exit 1
  }
  printf '%s  binaries/%s.wasm\n' "$digest" "$tool" | tee -a "$ROOT/receipts/build.log"
done
printf 'reproducible=byte-identical\n' >> "$ROOT/receipts/build.log"
