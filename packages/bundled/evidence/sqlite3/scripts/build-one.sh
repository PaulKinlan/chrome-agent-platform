#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: build-one.sh BUILD_DIR OUTPUT_WASM" >&2
  exit 64
fi

root=$(cd "$(dirname "$0")/.." && pwd)
build_dir=$1
output=$2
archive="$root/sources/archives/sqlite-amalgamation-3460000.zip"
# toolchain: wasi-sdk clang 22.1.8 (host path scrubbed on repo migration)
compiler="${WASI_SDK:?set WASI_SDK to a wasi-sdk 22.1.8 install}/bin/clang"
expected_archive=712a7d09d2a22652fb06a49af516e051979a3984adb067da86760e60ed51a7f5
actual_archive=$(/usr/bin/sha256sum "$archive" | /usr/bin/cut -d' ' -f1)
[[ "$actual_archive" == "$expected_archive" ]] || {
  echo "retained archive digest mismatch" >&2
  exit 1
}
[[ -x "$compiler" ]] || {
  echo "pinned WASI SDK compiler is unavailable" >&2
  exit 1
}

rm -rf -- "$build_dir"
mkdir -p -- "$build_dir/extract" "$(dirname "$output")"
/usr/bin/unzip -q "$archive" -d "$build_dir/extract"
source_dir="$build_dir/extract/sqlite-amalgamation-3460000"

flags=(
  --target=wasm32-wasi
  -std=c11
  -O2
  -flto
  -Werror
  -fno-ident
  -ffile-prefix-map="$build_dir"=/build
  -DSQLITE_OMIT_LOAD_EXTENSION=1
  -DSQLITE_OMIT_SHARED_CACHE=1
  -DSQLITE_THREADSAFE=0
  -DSQLITE_DQS=0
  -DSQLITE_OMIT_DEPRECATED=1
  -DSQLITE_MAX_MEMORY=16777216
  -DSQLITE_MAX_PAGE_COUNT=4096
  -DSQLITE_DEFAULT_PAGE_SIZE=4096
  -DSQLITE_TEMP_STORE=3
  -I"$source_dir"
)
link_flags=(
  -Wl,--strip-all
  -Wl,--fatal-warnings
  -Wl,--initial-memory=4194304
  -Wl,--max-memory=33554432
  -Wl,--export-memory
  -Wl,-z,stack-size=262144
)

"$compiler" "${flags[@]}" -c "$source_dir/sqlite3.c" -o "$build_dir/sqlite3.o"
"$compiler" "${flags[@]}" -c "$root/src/sqlite3_query_main.c" -o "$build_dir/sqlite3_query_main.o"
"$compiler" --target=wasm32-wasi -O2 -flto -Werror \
  "$build_dir/sqlite3.o" "$build_dir/sqlite3_query_main.o" \
  "${link_flags[@]}" -o "$output"

[[ -s "$output" ]] || {
  echo "link did not produce a Wasm executable" >&2
  exit 1
}
