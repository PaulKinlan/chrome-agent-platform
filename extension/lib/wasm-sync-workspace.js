// lib/wasm-sync-workspace.js — the per-job SYNCHRONOUS workspace model (Gate 2
// corrected; scratch S1 foundation). Used only inside each fresh Settings-preview
// Worker.
//
// The LANDED WASI runtime's adapters are SYNCHRONOUS: the runtime turns any
// Promise-returning adapter operation into EIO (wasi-preview1-runtime.js
// syncResult). A cross-context postMessage RPC can therefore NEVER execute a
// WASI file operation. This module supplies a REAL synchronous in-memory file
// store with stat/open/read/write/close semantics, created PER JOB inside the
// worker and bound to the job's workspaceRoot (never a shared host map). The
// future OPFS adapter is a reviewed successor that must provide synchronous
// semantics in the worker realm (e.g. an OPFS-backed sync store).
//
// This module never touches OPFS/chrome/network; it is a plain bytes store.

export const SYNC_WORKSPACE_BOUNDS = Object.freeze({
  maxPathBytes: 1024,
  maxSegmentBytes: 255,
  maxFileBytes: 10 * 1024 * 1024,
  maxOpenHandles: 64,
  maxDirEntries: 4096,
  maxDirNameBytes: 255,
});

// Class-scoped immutable seed budgets (scratch S1). The inputs class keeps the
// predecessor fixture bound (8 files / 32 KiB each / 256 KiB total); the
// scratch class permits one resize-sized working file per job (8 files /
// 10 MiB each / 10 MiB aggregate, tied to SYNC_WORKSPACE_BOUNDS.maxFileBytes).
// The outer WORKSPACE_SEED_LIMITS carries only the combined row ceiling; the
// per-class maxima live on the class budgets, never a global sum.
export const INPUT_SEED_LIMITS = Object.freeze({
  maxFiles: 8,
  maxFileBytes: 32 * 1024,
  maxTotalBytes: 256 * 1024,
});

export const SCRATCH_FILE_LIMITS = Object.freeze({
  maxFiles: 8,
  maxFileBytes: SYNC_WORKSPACE_BOUNDS.maxFileBytes,
  maxTotalBytes: SYNC_WORKSPACE_BOUNDS.maxFileBytes,
});

export const WORKSPACE_SEED_LIMITS = Object.freeze({
  maxFiles: INPUT_SEED_LIMITS.maxFiles + SCRATCH_FILE_LIMITS.maxFiles,
  inputs: INPUT_SEED_LIMITS,
  scratch: SCRATCH_FILE_LIMITS,
});

// Explicit scratch-directory caps (the S2 transactional directory slice). The
// maxDirs bound matches the handle cap; maxDirDepth bounds the nesting. These
// bound the explicit directories set ONLY — the implicit-prefix directories
// remain governed by the file grammar.
export const SCRATCH_DIR_LIMITS = Object.freeze({
  maxDirs: 64,
  maxDirDepth: 32,
});

function failClosed(code) {
  const error = new Error(`sync-workspace: ${code}`);
  error.code = code;
  return error;
}

function boundedPath(path) {
  if (typeof path !== "string" || path.length === 0 ||
      path.length > SYNC_WORKSPACE_BOUNDS.maxPathBytes) {
    throw failClosed("ENAMETOOLONG");
  }
  const bytes = new TextEncoder().encode(path);
  if (bytes.byteLength > SYNC_WORKSPACE_BOUNDS.maxPathBytes) {
    throw failClosed("ENAMETOOLONG");
  }
  for (const part of path.split("/")) {
    const segmentBytes = new TextEncoder().encode(part);
    if (!part || part === "." || part === ".." ||
        segmentBytes.byteLength > SYNC_WORKSPACE_BOUNDS.maxSegmentBytes) {
      throw failClosed("EPERM");
    }
    for (const byte of segmentBytes) {
      if (byte < 0x20 || byte === 0x7f) throw failClosed("EINVAL");
    }
  }
  return path;
}

// The stable seed failure: BOTH the message AND the .code are "job-seed" so
// every layer (createWasiJob, the worker envelope, the SW) sees the code.
function seedFail() {
  const error = new TypeError("job-seed");
  error.code = "job-seed";
  throw error;
}

const EMPTY_WORKSPACE_SEED = Object.freeze({ files: Object.freeze([]) });

function exactOwnDataValues(value, expectedKeys, expectedPrototype) {
  if (typeof value !== "object" || value === null ||
      Array.isArray(value) || Object.getPrototypeOf(value) !== expectedPrototype) seedFail();
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeySet = new Set(expectedKeys);
  if (ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !expectedKeySet.has(key))) seedFail();
  const values = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) seedFail();
    values[key] = descriptor.value;
  }
  return values;
}

// One bounded dense BYTE-array validator shared by BOTH classes (no looser
// scratch parser), producing ONE fresh dense result in a single pass. Exact
// Array.prototype, a safe own-data `length` within the caller-supplied
// maximum, exactly `length + 1` own keys (one exact `length`, no symbols,
// every other a canonical decimal index in [0,length)), and every index an
// own data descriptor (no getter/setter/hole) whose value is an integer
// 0..255, copied directly into the single fresh dense array. Avoids any second
// O(n) key/index structure or a values+dense double copy, which matters for a
// 10 MiB scratch byte array.
function exactDenseArrayValues(value, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) seedFail();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maxLength) seedFail();
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) seedFail();
  let sawLength = false;
  for (const key of ownKeys) {
    if (typeof key !== "string") seedFail();
    if (key === "length") {
      if (sawLength) seedFail();
      sawLength = true;
      continue;
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length ||
        String(index) !== key) seedFail();
  }
  if (!sawLength) seedFail();
  const values = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) seedFail();
    values.push(descriptor.value);
  }
  return values;
}

// One bounded dense BYTE-array validator shared by BOTH classes (no looser
// scratch parser), producing EXACTLY ONE fresh dense result via its OWN single
// indexed walk — never routed through the values helper, so no intermediate
// full values array exists at the 10 MiB boundary. Same exact shape/
// prototype/key/setter/proxy/value/error semantics as the row validator: exact
// Array.prototype, a safe own-data `length` within the caller-supplied
// maximum, exactly `length + 1` own keys (one exact `length`, no symbols,
// every other a canonical decimal index in [0,length)), every index an own
// data descriptor (no getter/setter/hole) whose value is an integer 0..255,
// all checked in the SAME pass that builds the one dense result.
function exactDenseByteArray(value, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) seedFail();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maxLength) seedFail();
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1) seedFail();
  let sawLength = false;
  for (const key of ownKeys) {
    if (typeof key !== "string") seedFail();
    if (key === "length") {
      if (sawLength) seedFail();
      sawLength = true;
      continue;
    }
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length ||
        String(index) !== key) seedFail();
  }
  if (!sawLength) seedFail();
  const dense = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) seedFail();
    const byte = descriptor.value;
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) seedFail();
    dense.push(byte);
  }
  return dense;
}

function classForPath(path) {
  return path.split("/")[0];
}

// Validate a trusted workspace seed. The schema is EXACTLY
// `workspaceSeed: { files: [{ path, bytes }] }`. Every layer must be a plain
// ordinary object/array with only the exact OWN DATA properties: no getters,
// sparse indexes, extra string/symbol keys, or custom/null prototypes. Proxy
// traps are caught and normalized to the stable job-seed failure (transparent
// non-trapping proxies are not distinguishable in JavaScript). Paths are
// unique relative `inputs/<file>` OR `scratch/<file>` rows (mixed classes are
// fine; the class is derived from the FIRST segment — never a carried field)
// and bytes are dense integers 0..255. Returns a deep-frozen canonical clone.
export function validateWorkspaceSeed(seed) {
  try {
    const outer = exactOwnDataValues(seed, ["files"], Object.prototype);
    const seedFiles = exactDenseArrayValues(outer.files, WORKSPACE_SEED_LIMITS.maxFiles);
    const seen = new Set();
    const classCounts = { inputs: 0, scratch: 0 };
    const classTotals = { inputs: 0, scratch: 0 };
    const files = [];
    for (const row of seedFiles) {
      const file = exactOwnDataValues(row, ["path", "bytes"], Object.prototype);
      const path = file.path;
      if (typeof path !== "string" || path.includes("\0") ||
          path.startsWith("/") || path.includes("\\")) seedFail();
      boundedPath(path);
      const segments = path.split("/");
      if (segments.length < 2) seedFail();
      const className = segments[0];
      if (className !== "inputs" && className !== "scratch") seedFail();
      if (seen.has(path)) seedFail();
      seen.add(path);
      const budget = className === "inputs" ? INPUT_SEED_LIMITS : SCRATCH_FILE_LIMITS;
      // Project the class count BEFORE walking a potentially 10 MiB byte array.
      if (classCounts[className] + 1 > budget.maxFiles) seedFail();
      // One fresh dense result directly (the byte-range check is inside the
      // validator — no values+dense double array).
      const dense = exactDenseByteArray(file.bytes, budget.maxFileBytes);
      if (classTotals[className] + dense.length > budget.maxTotalBytes) seedFail();
      classCounts[className] += 1;
      classTotals[className] += dense.length;
      files.push(Object.freeze({ path, bytes: Object.freeze(dense) }));
    }
    // A seeded file may never also name an implicit directory, in BOTH
    // directions: no exact file may be a strict prefix of another file path.
    // (Cross-class prefixes cannot occur because the first segment differs,
    // but one global set keeps the invariant from being weakened.)
    for (const path of seen) {
      const prefix = `${path}/`;
      if ([...seen].some((candidate) => candidate.startsWith(prefix))) seedFail();
    }
    return Object.freeze({ files: Object.freeze(files) });
  } catch {
    seedFail();
  }
}

export function createSyncWorkspace({ root, now = () => 0, seed = EMPTY_WORKSPACE_SEED, testFaults = null } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("sync_workspace_root");
  }
  const validated = validateWorkspaceSeed(seed);
  // Explicit empty scratch directories (the S2 slice): a Set of exact paths,
  // additive to the implicit-prefix inference — a lock dir can exist with zero
  // files beneath it. Per-job, never shared, never persisted.
  const directories = new Set(); // exactPath
  const files = new Map(); // path -> { path, className, bytes: Uint8Array, mtime }
  for (const file of validated.files) {
    // clone to a genuine Uint8Array ONLY inside the per-job workspace; the
    // class is derived from the first path segment, never a carried field.
    files.set(file.path, {
      path: file.path,
      className: classForPath(file.path),
      bytes: new Uint8Array(file.bytes),
      mtime: 0,
    });
  }
  const handles = new Map(); // handleId -> { path, handle }
  // One exact deterministic handle-id allocator: monotonically allocate h1,
  // h2, … only when no recycled id exists; otherwise consume the numerically
  // lowest recycled id. A recycle helper deduplicates, sorts numerically and
  // rejects ids that are still active.
  const recycledHandleIds = [];
  let nextHandleId = 1;
  const snapshotAllocator = () => ({ recycled: [...recycledHandleIds], next: nextHandleId });
  const restoreAllocator = (snapshot) => {
    recycledHandleIds.length = 0;
    recycledHandleIds.push(...snapshot.recycled);
    nextHandleId = snapshot.next;
  };
  const reserveHandleId = () => {
    if (recycledHandleIds.length) return recycledHandleIds.shift();
    return nextHandleId++;
  };
  const recycleHandleId = (id) => {
    if (handles.has(`h${id}`)) throw failClosed("EIO"); // still active — internal invariant
    if (!recycledHandleIds.includes(id)) {
      recycledHandleIds.push(id);
      recycledHandleIds.sort((a, b) => a - b);
    }
  };

  // Deterministic creation metadata: validate now() outputs before storing
  // them; malformed/Promise/throw fails closed BEFORE any mutation.
  const validatedNow = () => {
    const mtime = now();
    if (typeof mtime !== "number" || !Number.isSafeInteger(mtime) || mtime < 0) {
      throw failClosed("EINVAL");
    }
    return mtime;
  };

  // Per-class accounting (seeded + committed + provisional rows).
  const countFiles = (className) => {
    let count = 0;
    for (const entry of files.values()) if (entry.className === className) count++;
    return count;
  };
  const totalBytes = (className) => {
    let total = 0;
    for (const entry of files.values()) if (entry.className === className) total += entry.bytes.byteLength;
    return total;
  };
  const projectedTotalAfterResize = (path, newLength) => {
    const className = classForPath(path);
    let total = 0;
    for (const entry of files.values()) {
      if (entry.className !== className) continue;
      total += entry.path === path ? newLength : entry.bytes.byteLength;
    }
    return total;
  };

  const stat = (path) => {
    const p = path === "." ? "." : boundedPath(path);
    const entry = p === "." ? null : files.get(p);
    const prefix = p === "." ? "" : `${p}/`;
    const isDirectory = p === "." || directories.has(p) ||
      [...directories].some((dir) => dir.startsWith(prefix)) ||
      [...files.keys()].some((key) => key.startsWith(prefix));
    // Defense in depth: validateWorkspaceSeed forbids this for trusted seeds,
    // but the mutable in-memory adapter still fails closed if a later file
    // write ever creates an exact-file/implicit-directory collision.
    if (entry && isDirectory) throw failClosed("ENOTDIR");
    if (entry) return { type: "file", size: entry.bytes.byteLength, mtime: entry.mtime };
    if (isDirectory) return { type: "directory", size: 0, mtime: 0 };
    const error = new Error("ENOENT");
    error.code = "ENOENT";
    throw error;
  };

  const readdir = (path) => {
    const p = path === "." ? "." : boundedPath(path);
    const prefix = p === "." ? "" : `${p}/`;
    if (p !== "." && !directories.has(p) &&
        ![...directories].some((dir) => dir.startsWith(prefix)) &&
        ![...files.keys()].some((key) => key.startsWith(prefix))) {
      throw failClosed("ENOENT");
    }
    const children = new Map();
    // explicit empty directories under this path contribute their children
    for (const dir of directories) {
      if (prefix && !dir.startsWith(prefix)) continue;
      const relative = prefix ? dir.slice(prefix.length) : dir;
      if (!relative) continue;
      const slash = relative.indexOf("/");
      const name = slash < 0 ? relative : relative.slice(0, slash);
      const bytes = new TextEncoder().encode(name);
      if (!name || name === "." || name === ".." || name.includes("/") ||
          name.includes("\0") || bytes.byteLength > SYNC_WORKSPACE_BOUNDS.maxDirNameBytes) {
        throw failClosed("EIO");
      }
      const prior = children.get(name);
      if (prior && prior !== "directory") throw failClosed("EIO");
      children.set(name, "directory");
      if (children.size > SYNC_WORKSPACE_BOUNDS.maxDirEntries) throw failClosed("EIO");
    }
    for (const key of files.keys()) {
      if (prefix && !key.startsWith(prefix)) continue;
      const relative = prefix ? key.slice(prefix.length) : key;
      if (!relative) continue;
      const slash = relative.indexOf("/");
      const name = slash < 0 ? relative : relative.slice(0, slash);
      const type = slash < 0 ? "file" : "directory";
      const bytes = new TextEncoder().encode(name);
      if (!name || name === "." || name === ".." || name.includes("/") ||
          name.includes("\0") || bytes.byteLength > SYNC_WORKSPACE_BOUNDS.maxDirNameBytes) {
        throw failClosed("EIO");
      }
      const prior = children.get(name);
      if (prior && prior !== type) throw failClosed("EIO");
      children.set(name, type);
      if (children.size > SYNC_WORKSPACE_BOUNDS.maxDirEntries) throw failClosed("EIO");
    }
    const rows = [...children].map(([name, type]) => ({ name, type, bytes: new TextEncoder().encode(name) }));
    rows.sort((a, b) => {
      const length = Math.min(a.bytes.length, b.bytes.length);
      for (let index = 0; index < length; index++) {
        if (a.bytes[index] !== b.bytes[index]) return a.bytes[index] - b.bytes[index];
      }
      return a.bytes.length - b.bytes.length;
    });
    return Object.freeze(rows.map(({ name, type }) => Object.freeze({ name, type })));
  };

  // One shared handle factory for the normal open AND the transaction, so the
  // read/write/stat/close behavior is identical. A provisional handle (owned
  // by a not-yet-committed transaction) may be stat()ed but its read/write/
  // close fail EINVAL without mutation until the transaction commits; rollback
  // is the sole provisional cleanup. The provisional state is a MUTABLE holder
  // so the commit can flip it to fully functional.
  const makeHandle = (p, entry, handleId, id, provisionalHolder) => {
    const handle = {
      read(position, length) {
        if (provisionalHolder.value) throw failClosed("EINVAL");
        if (!Number.isSafeInteger(position) || position < 0 ||
            !Number.isSafeInteger(length) || length < 0) {
          throw failClosed("EINVAL");
        }
        if (position > entry.bytes.byteLength) return new Uint8Array(0);
        const end = Math.min(position + length, entry.bytes.byteLength);
        return entry.bytes.slice(position, end);
      },
      write(position, bytes) {
        if (provisionalHolder.value) throw failClosed("EINVAL");
        if (!Number.isSafeInteger(position) || position < 0 ||
            !(bytes instanceof Uint8Array)) {
          throw failClosed("EINVAL");
        }
        if (bytes.byteLength > SYNC_WORKSPACE_BOUNDS.maxFileBytes ||
            position + bytes.byteLength > SYNC_WORKSPACE_BOUNDS.maxFileBytes) {
          const e = new Error("EFBIG");
          e.code = "EFBIG";
          throw e;
        }
        const newLength = Math.max(entry.bytes.byteLength, position + bytes.byteLength);
        if (entry.className === "scratch" &&
            projectedTotalAfterResize(p, newLength) > SCRATCH_FILE_LIMITS.maxTotalBytes) {
          const e = new Error("ENOSPC");
          e.code = "ENOSPC";
          throw e;
        }
        // Validate the clock BEFORE any byte mutation so a malformed/Promise/
        // throwing now() fails atomically (no bytes changed, no mtime stale).
        const mtime = validatedNow();
        const out = new Uint8Array(newLength);
        out.set(entry.bytes, 0);
        out.set(bytes, position);
        entry.bytes = out;
        entry.mtime = mtime;
        return bytes.byteLength;
      },
      stat() {
        return { type: "file", size: entry.bytes.byteLength, mtime: entry.mtime };
      },
      close() {
        if (provisionalHolder.value) throw failClosed("EINVAL");
        if (!handles.has(handleId)) return false; // second direct close is a no-op/false
        handles.delete(handleId);
        recycleHandleId(id);
        return true;
      },
    };
    return Object.freeze(handle);
  };

  // The collision predicate used by the transaction (and the generic missing-
  // scratch create): exact file EEXIST; descendant implicit-directory EISDIR;
  // strict-ancestor exact FILE EISDIR. Implicit ancestor directories are valid.
  const scratchCollisionError = (p) => {
    if (files.has(p)) {
      const e = new Error("EEXIST");
      e.code = "EEXIST";
      return e;
    }
    const prefix = `${p}/`;
    for (const key of files.keys()) {
      if (key.startsWith(prefix)) return failClosed("EISDIR");
    }
    const segments = p.split("/");
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join("/");
      if (files.has(ancestor)) return failClosed("EISDIR");
    }
    return null;
  };

  // The one active-provisional transaction slot.
  let activeTransaction = null;

  // Synchronous, missing-only transactional scratch-file create.
  // workspace.createScratchFile(path) -> frozen { handle, commit, rollback }.
  // Preflight (NO mutation, in exact order); apply is synchronous; the state
  // machine is PROVISIONAL -> COMMITTED / ROLLED_BACK.
  const createScratchFile = (path) => {
    // 0. Reentry wins: another provisional transaction exists -> EINVAL; the
    //    new path is not inspected.
    if (activeTransaction !== null) throw failClosed("EINVAL");
    // 1. boundedPath plus the exact class/child gate; wrong class/root -> EPERM.
    const p = boundedPath(path);
    const segments = p.split("/");
    if (segments[0] !== "scratch" || segments.length < 2) throw failClosed("EPERM");
    // 2. exact existing file -> EEXIST.
    // 3. descendant implicit-directory collision -> EISDIR.
    // 4. strict ancestor-file collision -> EISDIR.
    const collision = scratchCollisionError(p);
    if (collision !== null) throw collision;
    // 5. scratch-file count 7->8 succeeds, 8->9 fails.
    if (countFiles("scratch") >= SCRATCH_FILE_LIMITS.maxFiles) throw failClosed("ENOSPC");
    // 6. the current scratch aggregate must be valid; the new zero-byte row
    //    leaves the projected total unchanged.
    if (totalBytes("scratch") > SCRATCH_FILE_LIMITS.maxTotalBytes) throw failClosed("ENOSPC");
    // 7. open-handle cap, checked with existing rows so the file count does
    //    not mask the handle-cap precedence.
    if (handles.size >= SYNC_WORKSPACE_BOUNDS.maxOpenHandles) throw failClosed("ENOSPC");
    // 8. validate deterministic creation metadata from now() BEFORE any
    //    insertion or id reservation.
    const mtime = validatedNow();
    // Apply (synchronous): snapshot the allocator and mark the one active
    // transaction; insert an identity-held provisional entry; reserve exactly
    // one handle/id and construct the frozen handle; return the frozen record.
    const allocatorSnapshot = snapshotAllocator();
    const id = reserveHandleId();
    const handleId = `h${id}`;
    const provisional = { path: p, className: "scratch", bytes: new Uint8Array(0), mtime };
    let handle = null;
    let state = "provisional";
    const provisionalHolder = { value: true };
    try {
      files.set(p, provisional);
      handle = makeHandle(p, provisional, handleId, id, provisionalHolder);
      handles.set(handleId, { path: p, handle });
      let txRecord;
      txRecord = Object.freeze({
        handle,
        commit() {
          if (state !== "provisional") throw failClosed("EINVAL");
          // Fault-injection seam, never reachable from the product path (the option is
          // deleting the provisional row BEFORE the identity check exercises
          // supplied only by the no-Chrome unit tests): deleting the provisional row
          if (testFaults?.identityCorrupt === true) files.delete(p);
          if (activeTransaction !== txRecord ||
              files.get(p) !== provisional || handles.get(handleId)?.handle !== handle) {
            throw failClosed("EIO");
          }
          try {
            if (testFaults?.commitThrow) throw new Error("injected commit fault");
            // `COMMITTED` is the linearization point; the handle becomes fully
            // functional; clear the active slot.
            state = "committed";
            provisionalHolder.value = false;
            activeTransaction = null;
            return handle;
          } catch (error) {
            // P3: an unexpected first-commit-path exception normalizes to
            // stable coded EIO, forces COMMITTED, clears the slot if it still
            // identity-matches, and NEVER rolls back/deletes/recycles. The
            // file row and handle remain committed; later rollback() is
            // EINVAL and the owner may close the committed handle normally.
            state = "committed";
            provisionalHolder.value = false;
            if (activeTransaction === txRecord) activeTransaction = null;
            const coded = failClosed("EIO");
            throw coded;
          }
        },
        rollback() {
          if (state !== "provisional") throw failClosed("EINVAL");
          if (activeTransaction !== txRecord ||
              files.get(p) !== provisional || handles.get(handleId)?.handle !== handle) {
            throw failClosed("EIO");
          }
          // Remove exactly the provisional file + handle; restore the exact
          // allocator snapshot; clear the active slot; transition once.
          handles.delete(handleId);
          if (files.get(p) === provisional) files.delete(p);
          restoreAllocator(allocatorSnapshot);
          activeTransaction = null;
          state = "rolled-back";
          return true;
        },
      });
      activeTransaction = txRecord;
      return txRecord;
    } catch (error) {
      // Guarded unwind: any unexpected insertion/handle-construction/freeze
      // failure removes only identity-matching provisional state, restores the
      // allocator snapshot, clears the active slot and rethrows a stable coded
      // failure. A partially prepared transaction is never returned.
      if (handles.has(handleId) && handles.get(handleId).handle === handle) {
        handles.delete(handleId);
      }
      if (files.get(p) === provisional) files.delete(p);
      restoreAllocator(allocatorSnapshot);
      if (activeTransaction === null) {
        const coded = error?.code ? error : failClosed("EIO");
        throw coded;
      }
      throw error;
    }
  };

  // The parent-exists check: the parent of a scratch path must be an existing
  // directory (explicit, implicit-prefix, or the scratch root).
  const directoryExists = (path) => {
    if (path === "scratch") return true; // the class root always exists
    if (directories.has(path)) return true;
    const prefix = `${path}/`;
    return [...files.keys()].some((key) => key.startsWith(prefix));
  };

  // Transactional synchronous scratch-directory create. prepare validates (no
  // mutation), commit is the atomic Set add, rollback is the inverse Set delete
  // (used by the later path_create_directory syscall wrapper for caller-failure
  // atomicity). Rejects during a provisional FILE transaction (the S1 reentry).
  const createDirectory = (path) => {
    if (activeTransaction !== null) throw failClosed("EINVAL");
    const p = boundedPath(path);
    const segments = p.split("/");
    if (segments[0] !== "scratch" || segments.length < 2) throw failClosed("EPERM");
    if (segments.length - 1 > SCRATCH_DIR_LIMITS.maxDirDepth) throw failClosed("ENAMETOOLONG");
    const parent = segments.slice(0, -1).join("/");
    if (!directoryExists(parent)) throw failClosed("ENOENT");
    if (directories.has(p)) throw failClosed("EEXIST");
    if (files.has(p)) throw failClosed("EEXIST");
    const prefix = `${p}/`;
    if ([...files.keys()].some((key) => key.startsWith(prefix))) throw failClosed("EEXIST");
    if (directories.size >= SCRATCH_DIR_LIMITS.maxDirs) throw failClosed("ENOSPC");
    directories.add(p);
    return Object.freeze({
      path: p,
      commit: () => true,
      rollback: () => { directories.delete(p); return true; },
    });
  };

  // Transactional synchronous scratch-directory remove. empty-only: no files
  // under the path AND no explicit subdirs. The root/scratch is never removable.
  const removeDirectory = (path) => {
    if (activeTransaction !== null) throw failClosed("EINVAL");
    const p = boundedPath(path);
    const segments = p.split("/");
    if (segments[0] !== "scratch" || segments.length < 2) throw failClosed("EPERM");
    if (!directories.has(p)) throw failClosed("ENOTDIR");
    const prefix = `${p}/`;
    if ([...files.keys()].some((key) => key.startsWith(prefix))) throw failClosed("ENOTEMPTY");
    if ([...directories].some((dir) => dir.startsWith(prefix))) throw failClosed("ENOTEMPTY");
    directories.delete(p);
    return Object.freeze({
      path: p,
      commit: () => true,
      rollback: () => { directories.add(p); return true; },
    });
  };

  const open = (path, options = {}) => {
    // The one-provisional reentry rule covers open() too: while a transaction
    // is provisional, any state-touching allocation must fail EINVAL so a
    // rollback's allocator-snapshot restore can never duplicate a handle id.
    if (activeTransaction !== null) throw failClosed("EINVAL");
    const p = boundedPath(path);
    const entry = files.get(p);
    const create = options.create === true;
    const exclusive = options.exclusive === true;
    const truncate = options.truncate === true;
    if (!entry && !create) {
      const e = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    }
    if (entry && exclusive) {
      const e = new Error("EEXIST");
      e.code = "EEXIST";
      throw e;
    }
    // Missing-create: the scratch class goes through the same
    // validation/cap/collision machinery via an INTERNAL immediately-committed
    // transaction (so the handle-cap row leak and directory collisions cannot
    // bypass the primitive). Inputs/other classes stay non-creatable here.
    let committedTxHandle = null;
    if (!entry && create) {
      if (classForPath(p) === "scratch") {
        const tx = createScratchFile(p);
        tx.commit();
        committedTxHandle = tx.handle;
      } else {
        const e = new Error(classForPath(p) === "inputs" ? "EACCES" : "EPERM");
        e.code = e.message;
        throw e;
      }
    }
    // The handle cap is checked BEFORE any truncate/now()/id reservation on
    // the NON-transaction path. The transaction path already enforced the cap
    // in its own preflight (step 7), so the committed handle is returned first.
    if (committedTxHandle !== null) {
      return committedTxHandle; // already registered by the transaction
    }
    const current = files.get(p);
    if (handles.size >= SYNC_WORKSPACE_BOUNDS.maxOpenHandles) {
      const e = new Error("ENOSPC");
      e.code = "ENOSPC";
      throw e;
    }
    if (truncate && entry) {
      // Validate the clock BEFORE the bytes reset so a malformed now() fails
      // atomically (no truncation, no stale mtime).
      const mtime = validatedNow();
      entry.bytes = new Uint8Array(0);
      entry.mtime = mtime;
    }
    const id = reserveHandleId();
    const handleId = `h${id}`;
    const handle = makeHandle(p, current, handleId, id, { value: false });
    handles.set(handleId, { path: p, handle });
    return handle;
  };

  return Object.freeze({
    root,
    stat,
    readdir,
    open,
    createScratchFile,
    createDirectory,
    removeDirectory,
    // introspection for the no-Chrome tests (never an execution authority)
    // Test-safe canonical introspection (copy-only, frozen; never an execution
    // authority): the canonical bytes/mtimes/handles/allocator snapshot so the
    // tests can prove byte/mtime/allocator identity after every failure.
    _inspect: () => Object.freeze({
      files: Object.freeze([...files.keys()].sort()),
      directories: Object.freeze([...directories].sort()),
      entries: Object.freeze([...files.entries()].map(([path, entry]) => Object.freeze({
        path,
        className: entry.className,
        bytes: Object.freeze([...entry.bytes]),
        mtime: entry.mtime,
      }))),
      handles: Object.freeze([...handles.entries()].map(([id, record]) => Object.freeze({ id, path: record.path }))),
      openHandles: handles.size,
      activeTransaction: activeTransaction !== null,
      allocator: Object.freeze({
        recycled: Object.freeze([...recycledHandleIds]),
        next: nextHandleId,
      }),
    }),
  });
}
