# Emscripten staging authority (x9r8k)

**SW-internal staging only, never a model or publication route.** The model
broker and original scalar offscreen host still refuse binary execution.
The SW owns a non-enumerable `Symbol.for("cap.emscripten.stage-only")` function
bound to its real run-control, committed-registry and OPFS readers; no runtime
message from an extension page can invoke it. A dedicated offscreen host accepts
only the verified SW sender, hashes all declared assets again, runs the audited
host-owned writer, and returns only a host ledger locator. Even complete
independent agreement returns typed Worker-termination UNKNOWN. No artifact,
seal, publication or deletion entry point exists on this route.

`emscripten-sw-intent.js` reserves one output ref for one SW-issued run, custody
agent, sealed input ref, generation, package and operation in its own OPFS root
(`emscripten-sw-intent-v1`), outside compactable run logs. A verified intent
must be written before `createWasmStreamOutput` opens the output directory.
Reservations never reopen on replay, even with a new generation for the same
output ref. Every reservation carries an issued timestamp and a **24-hour
reconciliation deadline**; expiry refuses staging. This deadline is a review
trigger, **not permission for automatic deletion**.

The SW-only route must call `createWasmStreamOutput` directly with
`preserveOnFailure: true`. It must **never** call
`allocateEmscriptenJobStreams` or `allocateAuditedEmscriptenJobStreams`:
those legacy helpers omit preservation and can discard a partial output after
intent has been written. It must not call `verifyEmscriptenOutputSeal` as a
staging probe either; that helper can delete a failed output.

Staging output creation must pass `preserveOnFailure: true` and an **adapter**
callback: `onRetainedFailure(ref, reason)` receives the frozen stdout ref and
reason, while `intent.recordRetained({ identity, inputRef }, reason)` requires
SW-issued identity and the pre-sealed run-owned input ref. The callback must
first check `ref.id === identity.outputRef.id` and `ref.kind === "stdout"`; a
literal `onRetainedFailure: intent.recordRetained` is incorrect and fails to
write a marker. A post-intent creation failure retains any partial directory
and writes a typed
`retained-not-deleted` marker with that bounded reconciliation deadline.
A missing marker writer refuses before output creation. If the marker append
itself fails, creation returns `wasm_stream_retention_unavailable`, leaves the
partial directory and the pre-existing bounded reservation intact, and no
reader may treat an unreadable marker as ordinary pending authority. The
future trusted reconciler must inspect the exact retained record; neither
staging nor `verifyEmscriptenOutputSeal` is a safe cleanup probe.

`emscripten-staging-authority.js` independently re-reads that intent, exact
host `ledgerRef`, and unsealed stdout bytes in bounded chunks. Even when the
host's CLOSED proof and the SW's rehash agree, it returns typed
`emscripten_worker_termination_unproved`: a writer fence and the worker's
producer-end declaration do **not** attest literal Worker termination.
The existing `recordEmscriptenTerminalAudit` requires literal termination and
sealed output; it must not be called with a CLOSED alias or a fabricated
`isTerminated` callback. The binary publication guards stay on until separate review of restricted
same-origin Worker admission (197jd) and the independent literal termination
witness (uz7e3). Browser staging evidence, when recorded, proves no more than
UNKNOWN; `Worker.terminate()` and producer-end do not prove termination.
