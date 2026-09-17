#!/bin/sh
# acp-native-host.sh — the executable a Chrome native messaging manifest names.
# A manifest can only name ONE program (no arguments), so this wrapper execs the
# real host with the harness it should run. Harness/cwd/adapter come from the
# environment (CAP_ACP_HARNESS / CAP_ACP_CWD / CAP_ACP_ADAPTER), defaulting to pi.
#
#   npm run acp:native:install     writes the manifest that points here
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Chrome spawns this with CHROME's environment: the user's bin dirs (where pi,
# claude, codex live) are absent. Source the PATH captured at install time, and
# fall back to the login profiles, so the adapter can actually find its CLI.
if [ -f "$HOME/.cap-acp/path.env" ]; then . "$HOME/.cap-acp/path.env"; fi
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) PATH="$HOME/.local/bin:$PATH" ;;
esac
export PATH
if [ -x "$HOME/.deno/bin/deno" ]; then DENO="$HOME/.deno/bin/deno"
elif command -v deno >/dev/null 2>&1; then DENO="$(command -v deno)"
else echo "deno not found on PATH — the ACP native host needs it" >&2; exit 1; fi
exec "$DENO" run -A "$ROOT/scripts/acp-native-host.ts"
