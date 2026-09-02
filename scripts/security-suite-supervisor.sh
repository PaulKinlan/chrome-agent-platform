#!/usr/bin/env bash
# Canonical entry point for npm run test:security. The exclusive flock is held
# before the Node supervisor may create evidence/profile/server/browser state.
set -Eeuo pipefail
umask 077

readonly LOCK="/tmp/cap-serialized-chrome-acceptance.lock"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec 9>"$LOCK"
# Announce the queue and the acquisition so a caller can budget the supervisor's
# OWN time rather than the time it spent waiting behind another lane's Chrome
# (CAP-FB-20260830-SUITE-HONESTY-01: the custody self-tests timed out
# load-dependently because their 20 s included this wait).
echo "CAP_SECURITY_LOCK_WAIT $(date +%s%3N)"
flock -x 9
echo "CAP_SECURITY_LOCK_ACQUIRED $(date +%s%3N)"
exec node "$SCRIPT_DIR/security-suite-supervisor.mjs"
