#!/usr/bin/env bash
# Canonical entry point for npm run test:security. The exclusive flock is held
# before the Node supervisor may create evidence/profile/server/browser state.
set -Eeuo pipefail
umask 077

readonly LOCK="/tmp/cap-serialized-chrome-acceptance.lock"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec 9>"$LOCK"
flock -x 9
exec node "$SCRIPT_DIR/security-suite-supervisor.mjs"
