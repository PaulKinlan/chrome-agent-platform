# Emscripten job-worker frame channel (3mcu1, partial)

The job Worker's exact input envelope remains unchanged: no output ref, OPFS
handle, directory or storage API is issued. For a future admitted `buffer`
result, `emscripten-worker.js` calls the pure `emscripten-worker-frames.js`
transport. It posts one copied, transferable 64 KiB frame at a time and waits
for a host ACK before posting another. The final result carries `null`, not a
binary payload. ACKs bind session, package, operation, worker incarnation and
sequence, but confer **backpressure only**, not authorization to write or
publish. The host receiver helper validates exact frame keys, bounded bytes and
identity, awaits the host-owned `push()` before ACK, and aborts on mismatch.

This is a protocol preparation, not a live feature. The host and SW still
refuse byte-bearing requests **before native construction**; the host does not
yet call the frame receiver, and this path cannot produce or publish an artifact.
The separate direct-module host-only runner (3mcu1) owns the writer and durable
evidence; its deadline remains armed before job posting and ends an unacknowledged
Worker in UNKNOWN. The legacy `emscripten-host.js` validator still requires a
`Uint8Array` buffer result **and** refuses buffer requests up front. x9r8k must
route an authorized binary request through the host-only runner's null terminal
plus writer `{frames,bytes,sha256}` proof, rather than merely importing the
receiver into that legacy path or relaxing its refusal. UNKNOWN is mandatory on
deadline, failed write, malformed frame or failed close.
Do not interpret a Worker terminal message or successful `postMessage` as an
OPFS no-writers fence.

Focused tests in `tests/emscripten-worker-frames.test.ts` pin one in-flight
frame, identity/extra-key rejection, delayed ACK until actual host push, failure
ACK and empty output. A real module Worker test runs a synthetic adapter result
through the Worker entry, confirms two transferred frames and a null terminal
result; it does not claim a loaded-Chrome or OPFS integration check. Real-Chrome OPFS lock behaviour belongs to n87j0 and
same-origin Worker admission restrictions to 197jd.
