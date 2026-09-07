#!/usr/bin/env bash
# Build the A0 Emscripten ABI evidence twice from pinned, reviewable sources.
set -euo pipefail

cd "$(dirname "$0")"
: "${EMSDK_ROOT:?set EMSDK_ROOT to the pinned Emscripten 6.0.0 emsdk root}"
EMCC="$EMSDK_ROOT/upstream/emscripten/emcc"
[[ -x "$EMCC" ]] || { echo "missing emcc: $EMCC" >&2; exit 1; }
"$EMCC" --version | head -1 | grep -F "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.0" >/dev/null
[[ "$(git -C "$EMSDK_ROOT" rev-parse HEAD)" == d223ae73c6998296e3ab27cf81dc2c2c9fd383de ]] || {
  echo "wrong emsdk source commit" >&2
  exit 1
}

export LC_ALL=C
export TZ=UTC
export SOURCE_DATE_EPOCH=1788566400
readonly SOURCE="$PWD/source"
readonly COMMON=(
  -O2 --no-entry
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=worker
  -sDYNAMIC_EXECUTION=0
  -sFILESYSTEM=0
  -sALLOW_MEMORY_GROWTH=0
  -sINITIAL_MEMORY=16777216
)

build_once() {
  local out="$1"
  rm -rf "$out"
  mkdir -p "$out"

  "$EMCC" "$SOURCE/numeric.c" "${COMMON[@]}" \
    '-sEXPORTED_FUNCTIONS=["_cap_weighted_sum"]' \
    -o "$out/numeric.mjs"

  "$EMCC" "$SOURCE/image_resize.c" "${COMMON[@]}" \
    '-sEXPORTED_FUNCTIONS=["_cap_resize_rgba","_malloc","_free"]' \
    '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]' \
    -o "$out/image-resize.mjs"

  (
    cd "$out"
    "$EMCC" "$SOURCE/link_side.c" -O2 -sSIDE_MODULE=2 \
      '-sEXPORTED_FUNCTIONS=["_side_increment"]' -o link-side.wasm
    "$EMCC" "$SOURCE/link_main.c" link-side.wasm "${COMMON[@]}" \
      -sMAIN_MODULE=2 '-sEXPORTED_FUNCTIONS=["_cap_linked_compute"]' \
      -o link-main.mjs

    "$EMCC" "$SOURCE/link_side_em_asm.c" -O2 -sSIDE_MODULE=2 \
      '-sEXPORTED_FUNCTIONS=["_side_em_asm"]' -o negative-side-em-asm.wasm
    "$EMCC" "$SOURCE/link_main.c" negative-side-em-asm.wasm \
      -DSIDE_SYMBOL=side_em_asm "${COMMON[@]}" -sMAIN_MODULE=2 \
      '-sEXPORTED_FUNCTIONS=["_cap_linked_compute"]' \
      -o negative-main-em-asm.mjs

    "$EMCC" "$SOURCE/link_side_em_js.c" -O2 -sSIDE_MODULE=2 \
      '-sEXPORTED_FUNCTIONS=["_side_em_js"]' -o negative-side-em-js.wasm
    "$EMCC" "$SOURCE/link_main.c" negative-side-em-js.wasm \
      -DSIDE_SYMBOL=side_em_js "${COMMON[@]}" -sMAIN_MODULE=2 \
      '-sEXPORTED_FUNCTIONS=["_cap_linked_compute"]' \
      -o negative-main-em-js.mjs
  )

  "$EMCC" "$SOURCE/native_global_access.c" "${COMMON[@]}" \
    '-sEXPORTED_FUNCTIONS=["_cap_probe_ambient_global"]' \
    -o "$out/negative-global.mjs"
}

build_once build-a
build_once build-b
node inspect.mjs
node run-fixtures.mjs --all
