# Emscripten host-owned writer — 3mcu1 preparation

`extension/lib/emscripten-host-writer.js` is retained but **not yet wired** to
the offscreen Emscripten host. It opens the exact run/agent-owned stdout ref in
the host realm, probes `createWritable({mode:"exclusive"})` by attempting a
second exclusive open while the first writer is live, and fails closed if the
browser silently ignores the option or returns an unexpected lock error. No
siloed-mode fallback or writer claim is inferred from a successful first open.
A future custodian-worker sync-access fallback needs its own reviewed design
and real-browser probe; no unsafe fallback is silently selected here.

Frames are copied, sequence-checked, bounded **per frame** to 64 KiB and queued
with bounded pending count (backpressure, never a total output-byte ceiling).
The host rejects further frames at close, drains its queue, awaits writer close,
then independently re-reads the resulting file in 64 KiB windows and hashes
all bytes. A write, close, lock or re-read failure yields UNKNOWN, never a
positive result. Abort does not seal, publish, delete staging or replay native
work. `openAuditedHostOwnedEmscriptenWriter` composes the separate host evidence
ledger: pending is persisted before the writer opens, UNKNOWN is recorded on
failure, and CLOSED only after the drain/close/re-read proof. This composition
remains unwired to the offscreen entry, so it does not start native work.

Current host and worker exact-key envelopes carry no output ref or OPFS handle;
`tests/emscripten-host.test.ts` exercises the actual posted envelope and
`tests/emscripten-host-writer.test.ts` drives byte writes, failed close, forced
abort and the silently ignored exclusive-mode case against isolated OPFS fakes.
The byte-bearing broker and offscreen-host refusal remain enabled. A positive
host writer result is not SW live-run authority, durable final audit, permission
to seal, or publication. `197jd` must bound the remaining same-origin Worker
ability to reach OPFS independently; until then the no-OPFS-worker claim is a
bounded admission assumption, not a browser permission boundary.
