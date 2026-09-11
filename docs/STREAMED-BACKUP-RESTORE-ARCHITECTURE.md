# Streamed Backup and Restore Architecture

**Status:** Authoritative Architectural Design (chrome-agent-platform-2g90 / 11rm follow-up)  
**Seams:** `extension/lib/data-archive.js`, `extension/options/options.js`, `extension/background/service-worker.js`, `tests/data-archive.test.ts`  
**Goal:** Eliminate the 512 MiB and 100,000 file export caps and eliminate IPC message buffering by transitioning from monolithic JSON/base64 IPC payloads to client-side streaming TAR backup/restore.

---

## 1. Problem Statement & Confirmed Source Evidence

### 1.1 The Existing Architecture & Hard Caps
In the current implementation (originating from `chrome-agent-platform-ykb`), data backup and restore are implemented as monolithic operations coordinated through Service Worker message handlers:

1. **Hardcoded Ceilings in Source (`extension/lib/data-archive.js:104-105`)**:
   ```javascript
   export const MAX_ARCHIVE_OPFS_FILES = 100_000;
   export const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MiB
   ```
   Enforced in `buildArchive()` (`lines 365-376`):
   ```javascript
   if (snapshot.files.length > maxFiles) {
     throw new ArchiveFormatError("archive-too-many-files", ...);
   }
   if (snapshot.totalBytes > maxBytes) {
     throw new ArchiveFormatError("archive-too-large", ...);
   }
   ```
2. **Monolithic In-Memory Base64 Transformation (`extension/lib/data-archive.js:378-406`)**:
   - Every file in the entire OPFS tree is read into memory at once:
     ```javascript
     const opfsEntries = snapshot.files.map(({ path, bytes }) => {
       try { data = FATAL_DECODER.decode(bytes); encoding = "utf8"; }
       catch { data = b64Encode(bytes); encoding = "base64"; }
       return { path, encoding, data };
     });
     ```
   - Binary files (Wasm modules, image/audio artifacts) suffer a **33% Base64 expansion**.
   - The entire archive is serialized into a single monolithic string: `JSON.stringify(archive)`.
3. **IPC Message Buffering Bottleneck (`service-worker.js:7651-7675` & `options.js:3184-3200`)**:
   - The Service Worker sends the entire monolithic string as an IPC response to the Options page:
     ```javascript
     // service-worker.js
     return { ok: true, bundle, manifest: JSON.parse(bundle).manifest };
     ```
     ```javascript
     // options.js
     const res = await chrome.runtime.sendMessage({ type: "owner.export.all" });
     const blob = new Blob([res.bundle], { type: "application/json" });
     ```
   - During import, the reverse occurs: `options.js` reads `file.text()` and transmits the entire string over IPC in a single `chrome.runtime.sendMessage({ type: "owner.import.all", bundle })`.

### 1.2 Failure Modes
- **Chrome IPC Message Buffer Overflow**: `chrome.runtime.sendMessage` in Chromium has an internal IPC buffer limit (typically 64 MiB). Backups exceeding ~64 MiB fail immediately with a channel disconnection or message length exception.
- **V8 String Allocation Limits**: In V8, single strings cannot exceed 512 MiB or 1 GiB. Attempting `JSON.stringify` or `file.text()` on large datasets throws `RangeError: Invalid string length`.
- **Service Worker OOM & Termination**: Buffering hundreds of megabytes of base64 strings in the background Service Worker easily trips the extension process memory limit, causing Chromium to terminate the extension background process.
- **Mismatch with Unbounded Storage**: The platform has eliminated artificial storage caps elsewhere (`dptw` removed size bounds across tools, storage, and rendering). Retaining a 512 MiB / 100k cap on Export All prevents users with large workspaces or local models from backing up their data.

---

## 2. Hard Constraints & Environment Boundaries

1. **Zero Server Dependency**:
   The backup and restore operations must run completely client-side inside the user's browser. No external proxy, cloud bucket, or remote sync server is involved.
2. **No Arbitrary Caps**:
   The solution must not simply raise the limit from 512 MiB to 1 GiB or 2 GiB. It must support arbitrarily large user profiles with $O(1)$ constant memory overhead.
3. **Strict Service Worker Bundle Budget (Critical)**:
   The Store Service Worker bundle budget is strictly capped at **3,000,000 bytes**.
   Following recent landings, the unminified Store SW bundle currently sits with **under 350 bytes of headroom**.
   **Invariant:** The streaming archive implementation **MUST NOT** be added to `service-worker.js`.
4. **MV3 Background Lifecycle**:
   Service workers are subject to termination after 30 seconds of perceived inactivity. Long-running multi-gigabyte streams inside the Service Worker risk sudden termination unless complex keep-alive ports are maintained.
5. **Origin-Keyed Storage Sharing**:
   Under the Chromium extension security model, all extension contexts (`options/options.html`, `background/service-worker.js`, `ntp/ntp.html`) share the **exact same origin** (`chrome-extension://<id>`).
   Consequently, `navigator.storage.getDirectory()` in the Options page window accesses the **identical OPFS directory tree** as the Service Worker.

---

## 3. The Target Architecture: Client-Driven Streaming Archive

### 3.1 Core Architecture Decision
Instead of having the Service Worker assemble an archive and transmit it over IPC, **the streaming export and restore pipelines are driven directly in the Options page (`extension/options/options.js`)**, with the Service Worker providing only lightweight state quiescence coordination.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Options Page (options.js)                       │
│                                                                        │
│  1. Prompt User File Handle:                                           │
│     const handle = await window.showSaveFilePicker(...)                │
│     const writable = await handle.createWritable()                     │
│                                                                        │
│  2. Lightweight Preflight / Quiesce with SW:                           │
│     await chrome.runtime.sendMessage({ type: "backup.prepare" })       │
│                                                                        │
│  3. Stream Directly from OPFS to User Disk:                            │
│     const root = await navigator.storage.getDirectory()                │
│     for file of walk(root):                                            │
│       writeTarHeader(writable, file.path, file.size)                   │
│       pipeFileChunksTo(writable, fileHandle)  // 64 KiB chunks         │
│                                                                        │
│  4. Notify SW of Completion:                                           │
│     await chrome.runtime.sendMessage({ type: "backup.complete" })      │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Advantages of Options-Driven Streaming
1. **Zero Impact on Service Worker Bundle**: All streaming TAR logic, file tree walking, and stream pumping reside in the Options bundle, which has no 3 MB limit.
2. **Zero IPC Payload Bottleneck**: Bytes flow directly from OPFS handles to the native disk stream via the browser kernel. Zero bytes are passed through `chrome.runtime.sendMessage`.
3. **True Constant-Memory Streaming ($O(1)$ RAM)**: Memory consumption is bounded by the chunk buffer size (64 KiB), whether exporting 5 MB or 50 GB.
4. **Immunity to MV3 Worker Termination**: The transfer runs in the open Options tab; it cannot be killed by the 30-second background worker idle timer.
5. **Live, Non-Blocking Progress**: The Options document directly tracks byte counts and file names, updating the UI smoothly without IPC chatter.

---

## 4. Archive Container Format: Standard Uncompressed TAR

### 4.1 Why Standard TAR?
- **Streamable by Construction**: TAR consists of sequential 512-byte header blocks followed by raw file data padded to 512-byte boundaries, terminated by two 512-byte zero blocks.
- **No Central Directory Requirement**: Unlike ZIP, which requires writing a central directory at the end of the archive and buffering file entry offsets, TAR can be written in a single forward pass.
- **Zero Base64 Overhead**: Raw binary files (Wasm modules, images, SQLite/OPFS blocks) are written byte-exact with 0% encoding inflation.
- **Universal Inspection**: A user can inspect or extract the backup using standard OS commands:
  ```bash
  tar -tvf cap-backup.tar
  tar -xvf cap-backup.tar -C ./restore-dir
  ```
- **Lightweight Implementation**: A pure JavaScript streaming TAR encoder/decoder requires only ~1.5 KB of code and zero third-party dependencies.

### 4.2 Archive Internal Layout
```
cap-backup.tar
├── manifest.json       # Archive metadata: formatVersion: 2, timestamp, extension version
├── kv.json             # chrome.storage.local dump (sanitized, provider/MCP shapes only)
├── alarms.json         # Scheduled routine configurations
└── opfs/               # Exact OPFS filesystem tree
    ├── master/         # Master agent memory and timeline
    ├── agents/         # Per-site and named-agent memories
    ├── artifacts/      # User artifacts and code bodies
    └── runs/           # Durable run WAL journals
```

---

## 5. Security & Secret Exclusion Policy

The secret exclusion policy established in `data-archive.js` remains strictly non-negotiable:
1. **Provider API Keys**: Stored in `chrome.storage.local` under `providerConfig`. During export, the provider configuration is sanitized: the bundle records *which* providers were configured and their default models, but `apiKey` is stripped.
2. **MCP Auth Headers**: Global and per-agent MCP server transport configurations are serialized, but authorization headers (`transport.headers`) are stripped.
3. **Ephemeral & Internal State**: `cap:webmcpBridgeNonces`, `cap:importBackup`, and transient caches are excluded.
4. **Owner-Approval HMAC & Private Keys**: Internal security keys (such as `owner-approval-hmac` under `chrome-agent-platform-private/`) are excluded via `isExcludedOpfsPath()`.

---

## 6. Transactional Restore Pipeline (Write-Before-Wipe)

To ensure that an interrupted restore never leaves the extension with corrupted or partial state, the streaming restore follows a three-phase transactional protocol:

### Phase 1: Streamed Provisional Extraction
1. Options page opens the backup file via `showOpenFilePicker()` and obtains a `ReadableStream`.
2. Options reads the leading `manifest.json` and verifies magic (`cap-archive` or legacy `cap-export`), format version, and policy.
3. Options streams all `opfs/**` entries into a temporary staging folder in OPFS: `.staging-restore-<timestamp>/`.
4. Decodes and verifies every file byte-for-byte against the entry sizes in the TAR headers.

### Phase 2: State Quiescence & Confirmation
1. Options displays the validated manifest to the owner (number of files, settings keys, and alarms).
2. The owner confirms the replacement dialog.
3. Options sends a lightweight quiescence command to the Service Worker:
   `await chrome.runtime.sendMessage({ type: "restore.quiesce" })`
   The SW halts active task runs, pauses alarm schedules, and prevents new mutations.

### Phase 3: Atomic Swap & Commit
1. Options commits `kv.json` into `chrome.storage.local` (writing pre-existing keys into a rollback journal `cap:importBackup`).
2. Options moves files from `.staging-restore-<timestamp>/` into their final OPFS locations.
3. Options restores alarms via `chrome.alarms`.
4. Options notifies the Service Worker:
   `await chrome.runtime.sendMessage({ type: "restore.commit" })`
   The SW drops all in-memory caches via `durableRuns.forgetCachedState()` and `invalidateAgent()`, then resumes operations.
5. If any error occurs prior to Phase 3 commit, `.staging-restore-<timestamp>/` is deleted and live profile state is untouched.

### Backward Compatibility (Legacy v1 JSON Backups)
When the user selects an import file:
- The streaming reader inspects the first 16 bytes.
- If it starts with `{"magic":"cap-export"` (ASCII JSON), it routes the file to the legacy `parseArchive` / `importArchive` pipeline.
- If it starts with a standard TAR header, it routes to the streaming TAR pipeline.

---

## 7. Project Breakdown & Bead Hierarchy

Because full streamed backup and restore requires library development, UI driver updates, quiescence coordination, and end-to-end verification, it must be executed as a sequenced project rather than a monolithic change:

```
[EPIC] chrome-agent-platform-2g90: Streamed Backup & Restore for Unbounded Profiles
  │
  ├── Stage 1: [CAP-BACKUP-STREAM-01] Pure JS streaming TAR encoder & parser library
  ├── Stage 2: [CAP-BACKUP-STREAM-02] Service Worker quiescence & cache invalidation hooks
  ├── Stage 3: [CAP-BACKUP-STREAM-03] Options page streaming export driver (File System Access)
  ├── Stage 4: [CAP-BACKUP-STREAM-04] Options page streaming restore driver & legacy v1 fallback
  └── Stage 5: [CAP-BACKUP-STREAM-05] End-to-end real-browser verification KAT (>100MB OPFS profile)
```

### Stage 1: Pure JS Streaming TAR Library (`extension/lib/tar-stream.js`)
- **Deliverable:** Standalone module exporting `createTarEncoderStream()` and `createTarDecoderStream()`.
- **Properties:**
  - Implements POSIX ustar format (512-byte headers, octal numbers, checksums, null padding).
  - Works over Web Streams API (`ReadableStream`, `WritableStream`, `TransformStream`).
  - Unit tests in `tests/tar-stream.test.ts` asserting byte-exact extraction with standard Unix `tar`.
- **SW Bundle Impact:** 0 bytes (imported only by Options).

### Stage 2: Zero-SW-Byte Quiescence & Cache Invalidation (Budget Constraint)
- **Deliverable:** Architectural reuse of existing Service Worker routes and direct Options-driven alarm management.
- **Strict Budget Invariant:** **0 bytes added to `service-worker.js`**.
  - The Service Worker bundle has virtually zero headroom (~106 bytes). Adding new routes to `service-worker.js` is prohibited.
  - **Zero-Byte Design**:
    1. *Alarms Quiescence & Restore*: The Options page has direct access to the `chrome.alarms` API in the extension origin. Pausing, listing, clearing, and re-creating alarms is driven 100% inside `options.js` without any SW route addition.
    2. *Agent & Memory Cache Invalidation*: Reuses the existing `invalidate-agent` route already registered in `service-worker.js`.
    3. *Active Run Suspension*: Reuses existing `run.cancel` route if an active execution is in flight.
    4. *Durable Runs Cache*: Re-evaluated lazily on next task run.
  - **Net SW Bundle Impact:** **Exactly 0 bytes**.

### Stage 3: Options Streaming Export Driver
- **Deliverable:** Update `extension/options/options.js` to wire the "Export All" button to `window.showSaveFilePicker()` and `tar-stream.js`.
- **Properties:**
  - Streams OPFS files directly to disk in 64 KiB chunks.
  - Constant memory usage ($O(1)$ RAM).
  - Eliminates 512 MiB and 100k file caps.
  - Smooth progress indicator in UI.

### Stage 4: Options Streaming Restore Driver
- **Deliverable:** Update `extension/options/options.js` to wire the "Import Backup" button to `window.showOpenFilePicker()`.
- **Properties:**
  - Three-phase transactional restore (`.staging-restore/` -> confirmation -> commit).
  - Auto-detection and fallback for legacy v1 JSON backups.

### Stage 5: End-to-End Browser Acceptance KAT
- **Deliverable:** `scripts/kat-streamed-backup.ts` and automated test.
- **Properties:**
  - Populates a test profile with large files (>100 MiB across multiple directories).
  - Drives export via CDP, verifies exported TAR with OS `tar`, modifies profile, restores, and asserts 100% byte-exact recovery.
