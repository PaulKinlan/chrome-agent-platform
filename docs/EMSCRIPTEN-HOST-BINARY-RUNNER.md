# Emscripten host-only binary runner — 3mcu1 staging

`extension/lib/emscripten-host-binary-runner.js` is a retained, **direct trusted
module call only**. No `chrome.runtime.onMessage`, Worker entry or service-worker
path imports it. The existing SW broker and `emscripten-host.js` continue to
reject byte-bearing native requests before constructor/native execution. This
prepares the lifecycle path for x9r8k; it is not a release gate or bypass.

The future trusted caller must supply a SW-issued exact ref/generation identity,
hash-verified asset job and bounded lifecycle. Before Worker construction, the
runner durably begins host evidence and opens the host-only exclusive writer.
It structurally rejects nested objects/OPFS refs in the Worker envelope's args
and operation. It arms a deadline before posting the exact existing Worker job.
Each frame is identity-checked, written by the host, then ACKed. Success means a
null terminal result with matching Worker incarnation followed by channel drain,
close, terminal lock probe, independent byte re-read/hash and verified CLOSED
record. Malformed frame, worker error and deadline abort to durable UNKNOWN;
none seal, publish or delete original input/output staging. The caller must
still independently re-check live SW run authority and artifact state before
any publication; the host receipt is only a narrow writer-lifecycle fact.

`tests/emscripten-host-binary-runner.test.ts` drives fake Workers through the
real host writer and ledger with isolated OPFS storage; it asserts that no SW or
offscreen-message route imports the new module. This is **not** a loaded-Chrome
artifact or a native package execution claim. The browser lock journey (n87j0)
and same-origin Worker admission restriction (197jd) are separate prerequisites.
