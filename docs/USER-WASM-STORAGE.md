# User-uploaded WebAssembly storage

Settings → **WebAssembly files** saves an owner-selected file, name and description
in this browser. This increment stores files only. It does **not** compile, run,
admit, approve, or register them as callable tools. The description explains its
future use by agents without claiming that execution is already connected.

## Large data is a normal workload

There is no product-imposed file-size limit, file-count limit, import allowlist,
memory tier, or binary-validation gate. Malformed WebAssembly is still stored.
A `.wasm` chooser filter is a selection hint, not an executable-compatibility test.
Browser quota, allocation, unavailable-API and I/O failures are surfaced as errors;
none are translated into an invented size cap or silent truncation.

The owner-selected `File` travels to a packaged dedicated Worker through native
structured clone. It does not pass through `chrome.runtime.sendMessage`, base64,
a JSON array of bytes, or a whole-file `arrayBuffer()` allocation. The Worker reads
`File.stream()` with backpressure, hashes each chunk using the existing SHA-256
compression implementation, and writes it into OPFS. CPU hashing stays off the
Settings thread. The total file size does not determine the application's hashing
working state; browser-internal buffering and available storage remain platform
concerns. No elapsed-time cutoff is imposed on an upload.

Keep Settings open until the saved confirmation appears. If the page closes or
an upload is interrupted, the next store operation removes unpublished staging
files. A progress count describes bytes being written, not a committed save.

## Identity and duplicate names

The SHA-256 digest of the exact bytes is the identity. File names and descriptions
never become paths.

- **Same bytes, different labels:** one stored entry. The latest successful upload
  replaces the name and description, and preserves the original added time.
- **Different bytes, same name:** separate entries. Each row exposes its full digest
  so the owner can distinguish them.
- Names and descriptions are retained and rendered as text, including Unicode,
  newlines, and strings that resemble HTML. They are not executable instructions.

## OPFS persistence

The extension-private root is `cap-user-wasm-v1/`:

- `<sha256>.wasm` — exact owner bytes.
- `<sha256>.json` — version, digest, name, description, size and added-at timestamp.
- `upload-<uuid>.wasm` — unpublished staging file, removed after interruption.
- `delete-<sha256>.json` — committed deletion intent, removed when deletion finishes.

Every operation holds the same origin-wide Web Lock, including calls from different
Settings pages or Workers. A writable's successful `close()` commits that file.
After hashing and closing the staging bytes, native OPFS `move()` gives them their
digest name. Metadata commits **last**, publishing the upload. This is not described
as a multi-file transaction: interrupted publication is recovered explicitly.

A deletion first commits its intent, then removes the metadata and bytes. Recovery
completes interrupted deletions. An empty intent whose write/close never committed
is discarded without deleting the saved file. Updating labels cannot destroy an
existing entry when metadata commit fails.

`list()` reads directory entries and JSON only, never module contents. Recovery
removes unpublished leftovers while holding the lock. Corrupt committed metadata
or missing committed bytes produces a visible error rather than silently hiding a
saved file.

## Backup and reset

Factory reset enumerates and clears the extension's OPFS root, including these
files. The existing **Export All** also walks this namespace, but its legacy
whole-archive JSON/base64 transport and archive caps do not scale with unbounded
uploads. Keep the original files: a large profile export may fail. Bead
`chrome-agent-platform-11rm` tracks streaming export/restore without those caps;
it is separate from the unbounded storage path implemented here.

## Internal API

`createUserWasmStore({ storage, locks, now })` supplies injected platform primitives
for tests; production uses `navigator.storage`, `navigator.locks`, and `Date.now`.

```js
const store = createUserWasmStore();
const metadata = await store.put({ file, name, description });
const entries = await store.list();
const savedFile = await store.getFile(metadata.digest); // File, not buffered bytes
await store.remove(metadata.digest);
```

The Settings client only constructs its fixed packaged Worker from the exact
Settings document. It has no service-worker mutation route or model-facing tool.
The shipped-code scanner pins the constructor's source location and literal
packaged URL. No CSP, remote-script, bundled-package admission, or execution-host
allowlist is widened by storing an uploaded file.

## Verification

Focused tests cover exact-byte identity, metadata-only listing, duplicate behavior,
Unicode/HTML-like labels, streamed inputs above 64 MiB, concurrent contexts,
write/close/move faults, restart cleanup, deletion-intent faults, path traversal,
Settings-only client access, and the narrow Worker scanner exemption. Incremental
hashes are compared with native WebCrypto and the FIPS million-`a` vector.

`scripts/kat-user-wasm-store.ts` drives the real extension with a native chooser and
keyboard/mouse input. It checks actual row contents, real OPFS byte hashes, reload
persistence, duplicate labels, a 65 MiB + 3 byte invalid-Wasm file, denied
non-Settings client access, and removal after reload. It saves screenshots and a
machine-readable result with source-file hashes. A passing build alone does not
establish any of these behaviors. This gate makes no execution-compatibility claim.
