# chrome-agent-platform-11rm.1: Backpressured TAR/PAX Encoder

## Deliverable & Scope
- Code: `extension/lib/tar-stream.js` — pure Web Streams API streaming ustar + PAX regular-file TAR encoder.
- Reachability: `scripts/check-reachability.mjs` updated with RETAINED entry for `lib/tar-stream.js` (13 retained total).
- Tests: `tests/tar-stream.test.ts` (9 tests covering name validation, lossless safe-integer size validation, POSIX PAX length formatting, 8GiB ustar-to-PAX transition, multi-file GNU tar interop, backpressure and first-chunk emission, short/long body mismatches, cancellation, and falsification mutants).
- Bounded Large Probes: `cap-evidence/tar-stream-large-probe.ts` (520 MiB streaming payload without memory accumulation with SHA-256 bit-for-bit check + 100,005 streaming entries without array accumulation).
- Real-Chrome Acceptance: `cap-evidence/11rm1-tar-stream-acceptance.ts` (drives `encodeTarStream` directly in Chromium OPFS using native `WritableStream`, reads back the TAR file, verifies 512-byte ustar header, magic `ustar\0`, and exact byte flow).

## Verification & Falsification Summary
1. **Multi-file GNU Tar Interoperability**:
   `tar -tvf` and `tar -xvf` extract exact file contents (empty file, binary file, Unicode emoji path, >100-character long path).
2. **Ustar to PAX Size Transition**:
   Pins $8,589,934,591$ (fits in 11 octal digits `77777777777 `) vs $8,589,934,592$ (ustar size `00000000000 `, true size formatted as PAX decimal `19 size=8589934592\n`).
3. **Backpressure & Bounded Memory**:
   - `encodeTarStream` awaits sink backpressure (`await writer.write(chunk)`).
   - Source generator paused on held sink write; only first chunk emitted before pausing.
   - 520 MiB streaming payload: heap growth was $1.31\text{ MiB}$ ($O(1)$ memory bound).
   - 100,005 entries streamed: heap growth was $2.95\text{ MiB}$ ($O(1)$ memory bound).
4. **Falsification Mutants**:
   - Checksum byte corruption: rejected by GNU tar with exit code 2.
   - Truncated ustar header (bypassing PAX): fails exact filename assertion.
   - Short body: throws `Entry "short.txt" body shorter than declared size`.
   - Long body: throws `Entry "long.txt" body exceeded declared size`.
   - Cancellation signal: aborts writer immediately and stops generator.
5. **Real-Chrome Acceptance**:
   Chromium loaded extension, navigated to Options page, created source file in OPFS, streamed to `backup.tar` in OPFS via `encodeTarStream`, read back and verified header magic `ustar\0` and exact bytes. Screenshot and JSON evidence captured in `cap-evidence/cap-11rm1-evidence-*`.
