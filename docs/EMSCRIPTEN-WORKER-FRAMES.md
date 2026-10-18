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
The next host integration must own the writer and durable evidence; its deadline
must remain armed before Worker startup and terminate any unacknowledged Worker.
UNKNOWN is mandatory on deadline, failed write, malformed frame or failed close.
Do not interpret a Worker terminal message or successful `postMessage` as an
OPFS no-writers fence.

Focused tests in `tests/emscripten-worker-frames.test.ts` pin one in-flight
frame, identity/extra-key rejection, delayed ACK until actual host push, failure
ACK and empty output. Real-Chrome OPFS lock behaviour belongs to n87j0 and
same-origin Worker admission restrictions to 197jd.
