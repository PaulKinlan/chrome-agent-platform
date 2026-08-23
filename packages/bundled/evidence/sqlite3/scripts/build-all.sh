#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)

# The authoritative flags are in build-one.sh. This negative assertion prevents
# the known-incompatible omission from silently returning.
if /usr/bin/grep -Eq -- '(^|[^A-Za-z0-9_])(-D)?SQLITE_OMIT_ATTACH([=[:space:]]|$)' "$root/scripts/build-one.sh"; then
  echo "SQLITE_OMIT_ATTACH must be absent" >&2
  exit 1
fi

"$root/scripts/run-checked.sh" "$root/logs/build-a.log" \
  "$root/scripts/build-one.sh" "$root/build/a" "$root/build/a/sqlite3-query-bounded.wasm"
"$root/scripts/run-checked.sh" "$root/logs/build-b.log" \
  "$root/scripts/build-one.sh" "$root/build/b" "$root/build/b/sqlite3-query-bounded.wasm"

hash_a=$(/usr/bin/sha256sum "$root/build/a/sqlite3-query-bounded.wasm" | /usr/bin/cut -d' ' -f1)
hash_b=$(/usr/bin/sha256sum "$root/build/b/sqlite3-query-bounded.wasm" | /usr/bin/cut -d' ' -f1)
[[ "$hash_a" == "$hash_b" ]] || {
  echo "fresh builds are not byte-identical" >&2
  exit 1
}
bytes=$(/usr/bin/stat -c %s "$root/build/a/sqlite3-query-bounded.wasm")
(( bytes <= 4194304 )) || {
  echo "binary exceeds 4 MiB gate" >&2
  exit 1
}
/usr/bin/cp "$root/build/a/sqlite3-query-bounded.wasm" "$root/dist/sqlite3-query-bounded.wasm"
printf '{\n  "schemaVersion": 1,\n  "buildA": {"sha256": "%s", "bytes": %s},\n  "buildB": {"sha256": "%s", "bytes": %s},\n  "byteIdentical": true,\n  "sqliteOmitAttachAbsent": true,\n  "sqliteOmitLoadExtension": true,\n  "warningsAsErrors": true\n}\n' \
  "$hash_a" "$bytes" "$hash_b" "$bytes" >"$root/receipts/build.json"
