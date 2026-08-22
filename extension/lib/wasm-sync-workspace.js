// lib/wasm-sync-workspace.js — the per-job SYNCHRONOUS workspace model (Gate 2
// corrected). SOURCE ONLY AND UNREACHABLE.
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
    if (!part || part === "." || part === ".." ||
        new TextEncoder().encode(part).byteLength > SYNC_WORKSPACE_BOUNDS.maxSegmentBytes) {
      throw failClosed("EPERM");
    }
  }
  return path;
}

/** A per-job synchronous workspace: a Map-backed store keyed by the relative
 * path under the job's workspaceRoot. Every handle is a synchronous object;
 * open/stat/read/write/close never return a Promise. */
export function createSyncWorkspace({ root, now = () => 0 } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("sync_workspace_root");
  }
  const files = new Map(); // path -> { bytes: Uint8Array, mtime }
  const handles = new Map(); // handleId -> { path, handle }
  let nextHandleId = 1;

  const stat = (path) => {
    const p = boundedPath(path);
    const entry = files.get(p);
    if (!entry) {
      const e = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    }
    return { type: "file", size: entry.bytes.byteLength, mtime: entry.mtime };
  };

  const open = (path, options = {}) => {
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
    if (entry && truncate) {
      entry.bytes = new Uint8Array(0);
      entry.mtime = now();
    }
    if (!entry) {
      const fresh = { bytes: new Uint8Array(0), mtime: now() };
      files.set(p, fresh);
    }
    const current = files.get(p);
    const handleId = `h${nextHandleId++}`;
    if (handles.size >= SYNC_WORKSPACE_BOUNDS.maxOpenHandles) {
      const e = new Error("ENOSPC");
      e.code = "ENOSPC";
      throw e;
    }
    const handle = {
      read(position, length) {
        if (!Number.isSafeInteger(position) || position < 0 ||
            !Number.isSafeInteger(length) || length < 0) {
          throw failClosed("EINVAL");
        }
        if (position > current.bytes.byteLength) return new Uint8Array(0);
        const end = Math.min(position + length, current.bytes.byteLength);
        return current.bytes.slice(position, end);
      },
      write(position, bytes) {
        if (!Number.isSafeInteger(position) || position < 0 ||
            !(bytes instanceof Uint8Array)) {
          throw failClosed("EINVAL");
        }
        if (bytes.byteLength > SYNC_WORKSPACE_BOUNDS.maxFileBytes) {
          const e = new Error("EFBIG");
          e.code = "EFBIG";
          throw e;
        }
        if (position + bytes.byteLength > SYNC_WORKSPACE_BOUNDS.maxFileBytes) {
          const e = new Error("EFBIG");
          e.code = "EFBIG";
          throw e;
        }
        const out = new Uint8Array(
          Math.max(current.bytes.byteLength, position + bytes.byteLength),
        );
        out.set(current.bytes, 0);
        out.set(bytes, position);
        current.bytes = out;
        current.mtime = now();
        return bytes.byteLength;
      },
      stat() {
        return { type: "file", size: current.bytes.byteLength, mtime: current.mtime };
      },
      close() {
        handles.delete(handleId);
        return true;
      },
    };
    handles.set(handleId, { path: p, handle });
    return handle;
  };

  return Object.freeze({
    root,
    stat,
    open,
    // introspection for the no-Chrome tests (never an execution authority)
    _inspect: () => Object.freeze({
      files: Object.freeze([...files.keys()].sort()),
      openHandles: handles.size,
    }),
  });
}
