# Emscripten offscreen host evidence — xoeaa + 3mcu1 (partial)

The retained `extension/lib/emscripten-host-evidence.js` stores versioned
`pending.json` plus optional `unknown.json` or `closed.json` under a separate
`emscripten-host-evidence-v1/<outputRef.id>-<generation>/` OPFS directory.
Unlike service-worker run logs, these records are not compacted. Identity binds
execution ID, agent ID, injective stream owner, exact stdout ref, SW-issued
generation, package, graph digest and operation. The host creates its own
incarnation ID. Restarted hosts can read but cannot claim or overwrite a prior
incarnation's record. UNKNOWN or CLOSED prevents another `begin` for that ref
and generation. Missing, corrupt, unreadable and foreign records fail closed.
No original input, stream or artifact directory is removed by this ledger.

A pending record reads as UNKNOWN. `recordUnknown` persists typed timeout or
unproved termination. If a frame is observed after a CLOSED receipt, the same
host incarnation writes `invalidated.json`: future reads return UNKNOWN and no
later `begin` or `recordClosed` may supersede that revocation. The 3mcu1 host-owned writer can persist a narrow positive
CLOSED receipt only after it observes its own exclusive-lock probe, drained
queue, writer `close()` and independently re-read byte count and SHA-256. An
UNKNOWN and a CLOSED record for the same identity conflict and read as
unavailable. Restart may read CLOSED but cannot add it for a prior incarnation.
A `Worker.terminate()` call or successful worker message alone is not proof of
close or of producer completeness. The positive caller proof includes a ledger
reference for independent fresh reads. A crash before a terminal write leaves
pending UNKNOWN; an incomplete or corrupt terminal write is unavailable, never
success. A failed late-frame invalidation cannot prove producer quiescence,
which is why x9r8k also needs a separate stable producer-end declaration before
publication.

These modules remain **unwired** to the offscreen entry. The binary broker/host
refusal remains on. A host receipt is not SW live-run authority, a publication
check or permission for destructive cleanup. `x9r8k` and `9a1wj` are not
cleared by this preparatory proof. The host ledger is not a browser permission
boundary: same-origin Worker code can itself access OPFS. `197jd` tracks the
admission restriction on exact glue/adapter bytes; the residual assumption is
explicit. One offscreen host is assumed to be the writer of each record; any
future concurrent-host path needs crash-safe CAS rather than worker leases.

Focused tests: `tests/emscripten-host-evidence.test.ts` covers restart, foreign
identity and corrupt metadata; `tests/emscripten-host-writer.test.ts` covers
queue drain, exclusive lock, close failure, forced abort, and persistent CLOSED
versus UNKNOWN.
