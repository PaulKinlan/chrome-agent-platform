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
unproved termination. The 3mcu1 host-owned writer can persist a narrow positive
CLOSED receipt only after it observes its own exclusive-lock probe, drained
queue, writer `close()` and independently re-read byte count and SHA-256. An
UNKNOWN and a CLOSED record for the same identity conflict and read as
unavailable. Restart may read CLOSED but cannot add it for a prior incarnation.
A `Worker.terminate()` call or successful worker message alone is not proof of
close. A crash before a terminal write leaves pending UNKNOWN; an incomplete or
corrupt terminal write is unavailable, never success.

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

## The OPFS platform facts the writer rests on are pinned, not assumed (n87j0)

The host-owned writer above turns a terminal state into a fact about the host's
own resources, and the exclusive-lock probe is the part that asks the platform a
question. Four browser facts carry that weight, and they used to live only as
prose in `extension/lib/run-log-wal.js` and in the g2dje ADR. They are now
MEASURED by `npm run test:opfs` (`scripts/opfs-real-browser.ts`) — one page and
one dedicated worker per measurement in a real browser, with the measured Chrome
version printed (recorded on Chrome 154.0.8037.92, 2026-10-18):

| fact | measured |
| --- | --- |
| `createSyncAccessHandle()` | exclusive per file: a second open throws `NoModificationAllowedError`; a different file is unaffected |
| `createWritable()` (no mode) | siloed (an unclosed write is invisible to readers) and NOT mutually exclusive: two concurrent writables are both accepted and the last close wins — so the single-writer rule is conventional, not platform-enforced |
| an OPEN default writable | still refuses a sync access handle (`NoModificationAllowedError`) — the nuance the "does not lock the file" shorthand elides |
| `createWritable({mode:"exclusive"})` | honoured by the shipped Chrome: accepted, refuses a second exclusive writable, and refuses both a default writable and a worker's sync access handle |
| `Worker.terminate()` | releases the terminated realm's sync access handle; another worker re-acquires it in ~1 ms (control: a LIVE holder blocks the same probe) |

The last two rows are what make the writer's exclusive-lock probe and g2dje's
alternative (iii) — a host-side probe AFTER `terminate()` — meaningful rather than
decorative, and the control row is what makes the release measurement mean
anything at all. A behaviour change FAILS the harness, naming x9r8k, ltkj.7 and
ltkj.8 and both Chrome versions; a newer Chrome with the same behaviour passes and
reports the version it measured. If it fails, the decision needs re-reading, not
the expectation updating.

The measurement cannot live in `tests/`: `docs/CHROME-TEST-CONTRACT.md` §2.1 and
`tests/chrome-test-contract.test.ts` make `chrome-profile-location.test.ts` the
SOLE real-browser test there. The mechanical half is
`tests/opfs-platform-facts-pin.test.ts`, selected in the fast gate by its static
imports of `wasm-stream-files.js`, `emscripten-custody.js` and
`emscripten-host.js`. It fails if the four assertions stop being made or their
harness/npm wiring is lost, if `wasm-stream-files.js` or `run-log-wal.js` starts
passing a `mode` to `createWritable` (the pin measured DEFAULT mode), or if a NEW
file calls `createSyncAccessHandle` — the callers are declared with reasons,
because the exclusivity and teardown facts apply to the contexts that actually
hold handles.
