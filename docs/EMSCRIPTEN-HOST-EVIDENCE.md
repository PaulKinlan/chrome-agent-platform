# Emscripten offscreen host evidence — xoeaa (partial)

The retained `extension/lib/emscripten-host-evidence.js` stores a versioned
`pending.json` and optional `unknown.json` under a dedicated
`emscripten-host-evidence-v1/<outputRef.id>-<generation>/` OPFS directory.
Unlike service-worker run-log rows, these records are not compacted by run
retention. The identity binds execution ID, agent ID, injective stream owner,
exact stdout ref, SW-issued generation, package, graph digest and operation.
The host creates its own incarnation ID. Restarted hosts may read evidence but
cannot claim or overwrite a prior incarnation's pending record. Once UNKNOWN
is recorded, `begin` refuses the same ref/generation even for the original host:
UNKNOWN can never authorize native replay. An offscreen restart without a known
terminal event remains the typed implicit `writer_fence_unavailable`; a restarted
incarnation cannot annotate a prior host's pending record with a fabricated
`offscreen_restart` reason. Invalid,
corrupt, unreadable and foreign records fail closed. The original sealed input
and shared stream/artifact directories are never removed by this module.

**No positive terminal proof exists here.** A pending record reads as `unknown`;
`recordUnknown` records a typed failure such as timeout or unproved termination.
There is deliberately no `quiescent` state, publish API, or cleanup authority.
`Worker.terminate()` and a successful message do not prove an OPFS writer was
flushed/closed. This module is not yet imported by the offscreen entry, and the
Emscripten binary broker/host guard remains on. It cannot unblock x9r8k or
9a1wj. ADR nv5g0 requires g2dje's host-managed writer leases, explicit close
acknowledgment and independently durable no-writers fence before a later slice
may record positive terminal evidence. Future integration must durably begin
before native construction; if the host crashes before or during an UNKNOWN
write, the surviving pending row is still UNKNOWN, never success.

The host ledger is a separate failure-state witness, not a browser permission
boundary: reviewed extension-origin Worker code may itself access origin OPFS.
Untrusted native code must not receive this root or arbitrary handles. The
ledger's one-host-writer assumption must be replaced with a crash-safe CAS or
exclusive lease before any future positive terminal state is implemented.
Tests: `tests/emscripten-host-evidence.test.ts` covers restart, foreign tuple,
wrong generation, corrupted metadata and UNKNOWN-only results.
