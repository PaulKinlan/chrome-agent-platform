#!/usr/bin/env bash
# cap-zxing (chrome-agent-platform-2htn) — reproducible WASI build.
# Fetches the pinned zxing-cpp v2.3.0 release tarball (sha256-verified) and
# compiles core/src + the CAP wrapper + pinned stb headers, twice; the two
# builds must be byte-identical.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SYSROOT="${WASI_SYSROOT:?set WASI_SYSROOT to a wasi-sysroot-22.0 tree}"
RTDIR="${WASI_RT:?set WASI_RT to a dir with lib/wasm32-unknown-wasip1/libclang_rt.builtins.a + include/}"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C

ZXING_VER=2.3.0
ZXING_SHA256=64e4139103fdbc57752698ee15b5f0b0f7af9a0331ecbdc492047e0772c417ba
STBI_SHA256=594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3
STBIW_SHA256=cbd5f0ad7a9cf4468affb36354a1d2338034f2c12473cf1a8e32053cb6914a05

CACHE="$ROOT/.cache"
mkdir -p "$CACHE" "$ROOT/build-a" "$ROOT/build-b" "$ROOT/logs"

TARBALL="$CACHE/zxing-cpp-$ZXING_VER.tar.gz"
if [ ! -f "$TARBALL" ]; then
  curl -sL -o "$TARBALL" "https://github.com/zxing-cpp/zxing-cpp/archive/refs/tags/v$ZXING_VER.tar.gz"
fi
echo "$ZXING_SHA256  $TARBALL" | sha256sum -c -
echo "$STBI_SHA256  $ROOT/src/stb_image.h" | sha256sum -c -
echo "$STBIW_SHA256  $ROOT/src/stb_image_write.h" | sha256sum -c -

SRC="$CACHE/zxing-cpp-$ZXING_VER"
[ -d "$SRC" ] || tar xzf "$TARBALL" -C "$CACHE"

# Version.h is a cmake-generated header; generate it deterministically here.
# Pin the template so a tarball change fails loudly instead of silently
# regenerating something different.
VH_SHA256=$(sha256sum "$SRC/core/Version.h.in" | cut -d' ' -f1)
[ "$VH_SHA256" = "675b0b3a0abca7a0c5ee6f827ac7f4ceffed521514036c72db2bdd4096a53484" ] || {
  echo "Version.h.in drifted ($VH_SHA256) — review before regenerating" >&2; exit 1; }
cat > "$SRC/core/src/Version.h" << 'VHEOF'
/*
* Copyright 2019 Nu-book Inc.
* Copyright 2023 Axel Waggershauser
*/
// SPDX-License-Identifier: Apache-2.0

#pragma once

#define ZXING_READERS
#define ZXING_WRITERS

// Version numbering
#define ZXING_VERSION_MAJOR 2
#define ZXING_VERSION_MINOR 3
#define ZXING_VERSION_PATCH 0

#define ZXING_VERSION_STR "2.3.0"
VHEOF

# -z stack-size: wasi-libc's default stack (64 KiB) is too small for stdio
# buffers + decoder frames; 1 MiB is the ceiling the default tier allows.
# --max-memory: the admission authority requires a declared ceiling;
# 2048 pages = the default tier cap.
# The second prefix-map keeps sysroot paths out of the recorded diagnostics.
FLAGS="-O2 -DNDEBUG -g0 -std=c++17 -Wno-deprecated-declarations -ffile-prefix-map=$ROOT=/src -ffile-prefix-map=$SYSROOT=/wasi-sysroot -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--max-memory=134217728"
{
  echo "toolchain=$(clang++ --version | head -1)"
  echo "sdk=$(basename "$SYSROOT") (path intentionally not recorded — evidence must stay relocation-neutral)"
  # Flag values carry no absolute paths: relative sources + /src + /wasi-sysroot maps.
  echo 'flags=-O2 -DNDEBUG -g0 -std=c++17 -Wno-deprecated-declarations -ffile-prefix-map=<root>=/src -ffile-prefix-map=<sysroot>=/wasi-sysroot -Wl,--strip-all -Wl,-z,stack-size=1048576 -Wl,--max-memory=134217728'
} > "$ROOT/logs/build.log"

build() { # build <output>
  find "$SRC/core/src" -name '*.cpp' | LC_ALL=C sort > "$CACHE/sources.txt"
  # All zxing-cpp C++ sources + the zueci ECI tables (the only .c that ships
  # in the release tarball; the libzint sources referenced by CMake come from
  # a git submodule that release tarballs omit — the native writers don't
  # need them) + the CAP wrapper + the fail-closed exception stubs.
  # zueci.c compiles as C. Warning classes that name absolute paths are
  # suppressed above, so recorded diagnostics stay relocation-neutral.
  clang --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RTDIR" \
    -O2 -DNDEBUG -g0 \
    -c "$SRC/core/src/libzueci/zueci.c" -o "$CACHE/zueci.o" \
    >> "$ROOT/logs/build.log" 2>&1
  clang++ --target=wasm32-wasip1 --sysroot="$SYSROOT" -resource-dir="$RTDIR" \
    $FLAGS "-Wno-#pragma-messages" -I"$SRC/core/src" -I"$ROOT/src" \
    "$ROOT/src/main.cpp" "$ROOT/src/cxa_stub.cpp" \
    $(cat "$CACHE/sources.txt" | tr '\n' ' ') \
    "$CACHE/zueci.o" -o "$1" \
    >> "$ROOT/logs/build.log" 2>&1
}

build "$ROOT/build-a/zxing.wasm"
build "$ROOT/build-b/zxing.wasm"
cmp "$ROOT/build-a/zxing.wasm" "$ROOT/build-b/zxing.wasm"
echo "reproducible: byte-identical" >> "$ROOT/logs/build.log"
sha256sum "$ROOT/build-a/zxing.wasm" | tee "$ROOT/SHA256SUMS"
echo "done"
