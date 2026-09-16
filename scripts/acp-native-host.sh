#!/bin/sh
# acp-native-host.sh — the executable a Chrome native messaging manifest names.
# A manifest can only name ONE program (no arguments), so this wrapper execs the
# real host with the harness it should run. Harness/cwd/adapter come from the
# environment (CAP_ACP_HARNESS / CAP_ACP_CWD / CAP_ACP_ADAPTER), defaulting to pi.
#
#   npm run acp:native:install     writes the manifest that points here
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$HOME/.deno/bin/deno" ]; then DENO="$HOME/.deno/bin/deno"
elif command -v deno >/dev/null 2>&1; then DENO="$(command -v deno)"
else echo "deno not found on PATH — the ACP native host needs it" >&2; exit 1; fi
exec "$DENO" run -A "$ROOT/scripts/acp-native-host.ts"
