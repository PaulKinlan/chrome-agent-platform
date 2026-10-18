# Emscripten host-only binary runner — 3mcu1 staging

`extension/lib/emscripten-host-binary-runner.js` is a retained, **direct trusted
module call only**. No `chrome.runtime.onMessage`, Worker entry or service-worker
path imports it. The existing SW broker and `emscripten-host.js` continue to
reject byte-bearing native requests before constructor/native execution. This
prepares the lifecycle path for x9r8k; it is not a release gate or bypass.

The future trusted caller must supply a SW-issued exact ref/generation identity,
hash-verified asset job and bounded lifecycle. The runner accepts only a scalar
SemVer version and exact scalar args/operation; a verified wasm subarray is
copied to an exact-length transfer buffer so unverified sibling bytes never
cross to the Worker. Before Worker construction, the
runner durably begins host evidence and opens the host-only exclusive writer.
It structurally rejects nested objects/OPFS refs in the Worker envelope's args
and operation. It arms a deadline before posting the exact existing Worker job.
Each frame is identity-checked, written by the host, then ACKed. Success means a
null terminal result with matching Worker incarnation followed by channel drain,
close, terminal lock probe, independent byte re-read/hash and verified CLOSED
record. A returned CLOSED proof carries `ledgerRef` (root, exact ref/generation
key and host incarnation), which the future SW caller must re-read before any
irreversible publication. A frame arriving after terminal while close is pending
poisons the attempt immediately; an observed frame after CLOSED durably writes
`invalidated.json`, making later reads UNKNOWN even across restart. Invalidation
is monotonic and a prior CLOSED proof must never bypass the fresh ledger read.
Malformed frame, worker error and deadline abort to durable UNKNOWN; none seal,
publish or delete original input/output staging. **CLOSED proves only the host
writer's committed byte count and lock fence, not producer completeness.** x9r8k
must require a separate stable producer-end declaration, fresh SW run authority
and artifact-state checks before publication. A crash or failed invalidation
append cannot itself prove producer quiescence; until that declaration exists,
binary publication remains refused.

`tests/emscripten-host-binary-runner.test.ts` drives fake Workers through the
real host writer and ledger with isolated OPFS storage; it asserts that no SW or
offscreen-message route imports the new module. This is **not** a loaded-Chrome
artifact or a native package execution claim. The browser lock journey (n87j0)
and same-origin Worker admission restriction (197jd) are separate prerequisites.
