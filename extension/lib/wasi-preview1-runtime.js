// lib/wasi-preview1-runtime.js — pure WASI Preview 1 host-call emulation.
//
// SOURCE ONLY AND UNREACHABLE. This module accepts injected bounded memory and
// workspace adapters. It never constructs OPFS handles, fetches package bytes,
// instantiates WebAssembly, creates a Worker, registers a route, or contacts a
// provider/network. A separately reviewed successor must own those boundaries.

import { WASM_PACKAGE_LIMITS } from "./wasm-package-authority.js";
import {
  createFdRecord,
  createWasiJob,
  FD_KIND,
  PATH_CLASS_RIGHTS,
  WASI_CLOCK,
  WASI_ERRNO,
  WASI_FDFLAGS,
  WASI_FILETYPE,
  WASI_HOST_HARD_LIMITS,
  WASI_LOOKUPFLAGS,
  WASI_OFLAGS,
  WASI_RIGHTS,
  WASI_WHENCE,
  WasiProcExit,
} from "./wasm-host-types.js";

export const REBUILT_TOOL_COUNT = 37;
export const REBUILT_WASI_IMPORTS = Object.freeze([
  "args_get",
  "args_sizes_get",
  "clock_time_get",
  "fd_close",
  "fd_fdstat_get",
  "fd_read",
  "fd_seek",
  "fd_write",
  "proc_exit",
]);

export const SUPPORTED_WASI_PREVIEW1_IMPORTS = Object.freeze([
  "args_get",
  "args_sizes_get",
  "clock_time_get",
  "environ_get",
  "environ_sizes_get",
  "fd_close",
  "fd_fdstat_get",
  "fd_fdstat_set_flags",
  "fd_filestat_get",
  "fd_prestat_dir_name",
  "fd_prestat_get",
  "fd_read",
  "fd_readdir",
  "fd_seek",
  "fd_tell",
  "fd_write",
  "path_filestat_get",
  "path_open",
  "proc_exit",
  "random_get",
]);

const SUPPORTED_IMPORT_SET = new Set(SUPPORTED_WASI_PREVIEW1_IMPORTS);
const U64_MAX = 0xffff_ffff_ffff_ffffn;
// Keep the original fd 3 `.` preopen for relative-path compatibility and add
// one exact alias for the retained bounded filesystem tools' absolute guest
// mount. wasi-libc normalizes `.` to the empty fallback prefix and selects the
// longer `/job` component prefix for `/job/...`, then passes class-relative
// host paths such as `inputs/f.bin`. Both aliases bind the SAME per-job
// workspace with the SAME rights; no new storage authority exists.
const PREOPEN_NAMES = Object.freeze({ 3: ".", 4: "/job" });
const STATIC_FD_COUNT = 5;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

class HostFault extends Error {
  constructor(errno) {
    super(`WASI errno ${errno}`);
    this.errno = errno;
  }
}

function fault(errno) {
  throw new HostFault(errno);
}

function plainData(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function dataSnapshot(value, keys, code, { exact = true } = {}) {
  try {
    if (!plainData(value)) throw new TypeError(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      exact &&
      JSON.stringify(Object.keys(descriptors).sort()) !==
        JSON.stringify([...keys].sort())
    ) {
      throw new TypeError(code);
    }
    const out = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) throw new TypeError(code);
      out[key] = descriptor.value;
    }
    return out;
  } catch (error) {
    if (error instanceof TypeError && error.message === code) throw error;
    throw new TypeError(code);
  }
}

function mapAdapterError(error) {
  if (error instanceof HostFault) return error.errno;
  let code = "";
  try {
    const descriptor = error && typeof error === "object"
      ? Object.getOwnPropertyDescriptor(error, "code")
      : null;
    if (
      descriptor && "value" in descriptor &&
      typeof descriptor.value === "string"
    ) {
      code = descriptor.value;
    }
  } catch { /* hostile adapter errors collapse to EIO */ }
  return ({
    EACCES: WASI_ERRNO.EACCES,
    EEXIST: WASI_ERRNO.EEXIST,
    EFBIG: WASI_ERRNO.EFBIG,
    EISDIR: WASI_ERRNO.EISDIR,
    ENOENT: WASI_ERRNO.ENOENT,
    ENOSPC: WASI_ERRNO.ENOSPC,
    ENOTDIR: WASI_ERRNO.ENOTDIR,
    EPERM: WASI_ERRNO.EPERM,
  })[code] ?? WASI_ERRNO.EIO;
}

function asU32(value) {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0xffff_ffff) {
    fault(WASI_ERRNO.EINVAL);
  }
  return value >>> 0;
}

function asU64(value) {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    fault(WASI_ERRNO.EINVAL);
  }
  return value;
}

function asI64(value) {
  if (
    typeof value !== "bigint" || value < -0x8000_0000_0000_0000n ||
    value > 0x7fff_ffff_ffff_ffffn
  ) fault(WASI_ERRNO.EINVAL);
  return value;
}

function rangesOverlap(aStart, aLength, bStart, bLength) {
  if (aLength === 0 || bLength === 0) return false;
  return aStart < bStart + bLength && bStart < aStart + aLength;
}

function freezeArrayRows(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

export function validateWasiImportSet(imports) {
  if (!Array.isArray(imports) || imports.length > 1024) {
    throw new TypeError("wasi_import_shape");
  }
  const out = [];
  for (const item of imports) {
    const row = dataSnapshot(
      item,
      ["kind", "module", "name"],
      "wasi_import_shape",
    );
    if (
      row.module !== "wasi_snapshot_preview1" || row.kind !== "function" ||
      typeof row.name !== "string" || !SUPPORTED_IMPORT_SET.has(row.name)
    ) {
      throw new TypeError("unsupported_wasi_import");
    }
    out.push({ module: row.module, name: row.name, kind: row.kind });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  for (let index = 1; index < out.length; index++) {
    if (out[index - 1].name === out[index].name) {
      throw new TypeError("duplicate_wasi_import");
    }
  }
  return freezeArrayRows(out);
}

export function revalidateAuditedMemory(value) {
  const input = dataSnapshot(
    value,
    ["audit", "binaryBytes", "declaredMaxPages", "tier"],
    "memory_audit_shape",
  );
  const tier = WASM_PACKAGE_LIMITS.TIERS[input.tier];
  if (!tier || tier.admission !== "allowed" || input.tier === "large") {
    throw new TypeError("memory_tier_blocked");
  }
  if (
    !Number.isSafeInteger(input.binaryBytes) || input.binaryBytes < 8 ||
    input.binaryBytes > tier.maxBytes
  ) throw new TypeError("memory_binary_bound");
  if (
    !Number.isSafeInteger(input.declaredMaxPages) ||
    input.declaredMaxPages < 0 || input.declaredMaxPages > tier.maxPages
  ) throw new TypeError("memory_declaration_bound");
  const audit = dataSnapshot(
    input.audit,
    ["bytes", "imports", "measured", "ok"],
    "memory_audit_shape",
    { exact: false },
  );
  if (
    audit.ok !== true || audit.bytes !== input.binaryBytes ||
    !Array.isArray(audit.imports)
  ) throw new TypeError("memory_audit_shape");
  const measured = dataSnapshot(
    audit.measured,
    ["imported", "memoryInitial", "memoryMax", "tier"],
    "memory_audit_mismatch",
  );
  if (
    measured.tier !== input.tier || typeof measured.imported !== "boolean" ||
    !Number.isSafeInteger(measured.memoryInitial) ||
    !Number.isSafeInteger(measured.memoryMax) || measured.memoryInitial < 0 ||
    measured.memoryInitial > measured.memoryMax ||
    measured.memoryMax > input.declaredMaxPages ||
    measured.memoryMax > tier.maxPages
  ) throw new TypeError("memory_audit_mismatch");
  const imports = validateWasiImportSet(audit.imports);
  return Object.freeze({
    tier: input.tier,
    binaryBytes: input.binaryBytes,
    memoryInitial: measured.memoryInitial,
    memoryMax: measured.memoryMax,
    imported: measured.imported,
    imports,
  });
}

function validateMemory(memory) {
  if (!memory || typeof memory !== "object") {
    throw new TypeError("memory_accessor");
  }
  for (const method of ["size", "read", "write"]) {
    if (typeof memory[method] !== "function") {
      throw new TypeError("memory_accessor");
    }
  }
  return memory;
}

function validateWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") {
    throw new TypeError("workspace_adapter");
  }
  for (const method of ["open", "readdir", "stat"]) {
    if (typeof workspace[method] !== "function") {
      throw new TypeError("workspace_adapter");
    }
  }
  return workspace;
}

function syncResult(value) {
  if (value && typeof value.then === "function") fault(WASI_ERRNO.EIO);
  return value;
}

function validHandle(handle) {
  if (!handle || typeof handle !== "object") return false;
  return ["close", "read", "stat", "write"].every((name) =>
    typeof handle[name] === "function"
  );
}

// PURE behavioral planner for fd_fdstat_set_flags (linkage-only slice). The
// syscall delegates to it — the KAT tests exercise this exact function with
// primitive inputs (no FD seeding, no rights mutation). Semantics: the
// FD_FDSTAT_SET_FLAGS right is required (ENOTCAPABLE — no current descriptor
// has it); a requested known-bit change → ENOTSUP; the exact no-change →
// SUCCESS. Change semantics are deliberately unsupported in this slice.
export function planFdstatSetFlags(currentFlags, rights, requested) {
  if ((rights & WASI_RIGHTS.FD_FDSTAT_SET_FLAGS) !== WASI_RIGHTS.FD_FDSTAT_SET_FLAGS) {
    return WASI_ERRNO.ENOTCAPABLE;
  }
  if (requested !== currentFlags) return WASI_ERRNO.ENOTSUP;
  return WASI_ERRNO.SUCCESS;
}

export const WASI_READDIR_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxNameBytes: 255,
  direntBytes: 24,
});

// Exact retained wasi-libc opendir compatibility profile. Any tuple drift is a
// design stop, never a reason to widen this allowlist. The libc under-requests
// the two read-only rights its directory stream actually uses: enumerate and
// stat children. The host adds exactly those bits; requested inheriting
// WRITE/SET_SIZE bits are stripped forever and DIR-base path_open is forbidden.
export const WASI_LIBC_OPENDIR_PROFILE = Object.freeze({
  dirflags: WASI_LOOKUPFLAGS.SYMLINK_FOLLOW,
  oflags: WASI_OFLAGS.DIRECTORY,
  requestedBase: 0x200026n,
  requestedInheriting: 0x600066n,
  fdflags: WASI_FDFLAGS.NONBLOCK,
  granted: 0x244026n,
});

function compareBytes(a, b) {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

// Pure deterministic WASI dirent planner. It owns no descriptor, workspace, or
// memory authority; the syscall validates those boundaries before copying the
// returned bytes into guest memory.
export function planFdReaddir(entries, cookie, bufLen) {
  try {
    if (!Array.isArray(entries) || entries.length > WASI_READDIR_LIMITS.maxEntries) {
      return Object.freeze({ errno: WASI_ERRNO.EIO, bufused: 0, packed: new Uint8Array(0) });
    }
    if (typeof cookie !== "bigint" || cookie < 0n || cookie > U64_MAX ||
        !Number.isSafeInteger(bufLen) || bufLen < 0 || bufLen > 0xffff_ffff) {
      return Object.freeze({ errno: WASI_ERRNO.EINVAL, bufused: 0, packed: new Uint8Array(0) });
    }
    const rows = entries.map((entry) => {
      const row = dataSnapshot(entry, ["name", "type"], "readdir_entry");
      if (typeof row.name !== "string" || !new Set(["file", "directory"]).has(row.type) ||
          !row.name || row.name === "." || row.name === ".." ||
          row.name.includes("/") || row.name.includes("\0")) throw new TypeError("readdir_entry");
      const bytes = encoder.encode(row.name);
      if (bytes.byteLength > WASI_READDIR_LIMITS.maxNameBytes) throw new TypeError("readdir_entry");
      return { type: row.type, bytes };
    });
    rows.sort((a, b) => compareBytes(a.bytes, b.bytes));
    if (cookie >= BigInt(rows.length)) {
      return Object.freeze({ errno: WASI_ERRNO.SUCCESS, bufused: 0, packed: new Uint8Array(0) });
    }
    const chunks = [];
    let used = 0;
    for (let index = Number(cookie); index < rows.length; index++) {
      const row = rows[index];
      const length = WASI_READDIR_LIMITS.direntBytes + row.bytes.byteLength;
      if (length > bufLen - used) break;
      const chunk = new Uint8Array(length);
      const view = new DataView(chunk.buffer);
      view.setBigUint64(0, BigInt(index + 1), true);
      view.setBigUint64(8, 0n, true);
      view.setUint32(16, row.bytes.byteLength, true);
      view.setUint32(20, row.type === "directory" ? WASI_FILETYPE.DIRECTORY : WASI_FILETYPE.REGULAR_FILE, true);
      chunk.set(row.bytes, WASI_READDIR_LIMITS.direntBytes);
      chunks.push(chunk);
      used += length;
    }
    const packed = new Uint8Array(used);
    let cursor = 0;
    for (const chunk of chunks) {
      packed.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return Object.freeze({ errno: WASI_ERRNO.SUCCESS, bufused: used, packed });
  } catch {
    return Object.freeze({ errno: WASI_ERRNO.EIO, bufused: 0, packed: new Uint8Array(0) });
  }
}

export function createWasiPreview1Runtime({
  job: rawJob,
  memory: rawMemory,
  workspace: rawWorkspace,
  isCancelled = () => false,
  randomFill = (bytes) => crypto.getRandomValues(bytes),
  monotonicNowNs = () => BigInt(Math.floor(performance.now() * 1_000_000)),
} = {}) {
  const job = createWasiJob(rawJob);
  const memory = validateMemory(rawMemory);
  const workspace = validateWorkspace(rawWorkspace);
  if (
    typeof isCancelled !== "function" || typeof randomFill !== "function" ||
    typeof monotonicNowNs !== "function"
  ) throw new TypeError("runtime_dependency");

  const state = {
    hostCalls: 0,
    pathCalls: 0,
    fileBytes: 0,
    stdinOffset: 0,
    stdout: [],
    stdoutBytes: 0,
    stderr: [],
    stderrBytes: 0,
    lastClock: 0n,
  };
  const fds = new Map();
  const freeFds = [];
  const rootRights = WASI_RIGHTS.PATH_OPEN | WASI_RIGHTS.PATH_CREATE_FILE |
    WASI_RIGHTS.PATH_FILESTAT_GET | WASI_RIGHTS.FD_READDIR;
  const inheritedRights = PATH_CLASS_RIGHTS.inputs.rights |
    PATH_CLASS_RIGHTS.scratch.rights | PATH_CLASS_RIGHTS.output.rights;

  function putFd(record) {
    fds.set(record.fd, createFdRecord(record));
  }
  putFd({
    fd: 0,
    kind: FD_KIND.STDIN,
    filetype: WASI_FILETYPE.CHARACTER_DEVICE,
    flags: 0,
    rights: WASI_RIGHTS.FD_READ,
    rightsInheriting: 0n,
    offset: 0n,
    path: "",
    handle: null,
  });
  putFd({
    fd: 1,
    kind: FD_KIND.STDOUT,
    filetype: WASI_FILETYPE.CHARACTER_DEVICE,
    flags: 0,
    rights: WASI_RIGHTS.FD_WRITE,
    rightsInheriting: 0n,
    offset: 0n,
    path: "",
    handle: null,
  });
  putFd({
    fd: 2,
    kind: FD_KIND.STDERR,
    filetype: WASI_FILETYPE.CHARACTER_DEVICE,
    flags: 0,
    rights: WASI_RIGHTS.FD_WRITE,
    rightsInheriting: 0n,
    offset: 0n,
    path: "",
    handle: null,
  });
  for (const fd of [3, 4]) {
    putFd({
      fd,
      kind: FD_KIND.PREOPEN,
      filetype: WASI_FILETYPE.DIRECTORY,
      flags: 0,
      rights: rootRights,
      rightsInheriting: inheritedRights,
      offset: 0n,
      path: PREOPEN_NAMES[fd],
      handle: null,
    });
  }

  function memorySize() {
    const size = syncResult(memory.size());
    if (!Number.isSafeInteger(size) || size < 0 || size > 0xffff_ffff) {
      fault(WASI_ERRNO.EFAULT);
    }
    return size;
  }

  function span(pointer, length) {
    const ptr = asU32(pointer);
    const len = asU32(length);
    const size = memorySize();
    if (ptr > size || len > size - ptr) fault(WASI_ERRNO.EFAULT);
    return { ptr, len };
  }

  function readBytes(pointer, length) {
    const { ptr, len } = span(pointer, length);
    const bytes = syncResult(memory.read(ptr, len));
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== len) {
      fault(WASI_ERRNO.EFAULT);
    }
    return new Uint8Array(bytes);
  }

  function writeBytes(pointer, bytes) {
    if (!(bytes instanceof Uint8Array)) fault(WASI_ERRNO.EFAULT);
    const { ptr } = span(pointer, bytes.byteLength);
    syncResult(memory.write(ptr, new Uint8Array(bytes)));
  }

  function writeU32(pointer, value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      fault(WASI_ERRNO.EOVERFLOW);
    }
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    writeBytes(pointer, bytes);
  }

  function writeU64(pointer, value) {
    if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
      fault(WASI_ERRNO.EOVERFLOW);
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    writeBytes(pointer, bytes);
  }

  function beginCall({ path = false } = {}) {
    state.hostCalls++;
    if (state.hostCalls > job.quota.hostCalls) return WASI_ERRNO.E2BIG;
    let cancelled;
    try {
      cancelled = isCancelled() === true;
    } catch {
      return WASI_ERRNO.ECANCELED;
    }
    if (cancelled) return WASI_ERRNO.ECANCELED;
    if (path && ++state.pathCalls > job.quota.pathCalls) {
      return WASI_ERRNO.E2BIG;
    }
    return WASI_ERRNO.SUCCESS;
  }

  function syscall(implementation, options) {
    return (...args) => {
      const gate = beginCall(options);
      if (gate !== WASI_ERRNO.SUCCESS) return gate;
      try {
        const result = implementation(...args);
        if (!Number.isInteger(result) || result < 0 || result > 0xffff) {
          return WASI_ERRNO.EIO;
        }
        return result;
      } catch (error) {
        if (error instanceof WasiProcExit) throw error;
        return mapAdapterError(error);
      }
    };
  }

  function fdFor(value) {
    const fd = asU32(value);
    const record = fds.get(fd);
    if (!record) fault(WASI_ERRNO.EBADF);
    return record;
  }

  function replaceOffset(record, offset) {
    putFd({ ...record, offset });
  }

  function requireRight(record, right) {
    if ((record.rights & right) !== right) fault(WASI_ERRNO.ENOTCAPABLE);
  }

  function parseIovecs(iovsPointer, iovsLength, resultPointer, { allowOversize = false } = {}) {
    const count = asU32(iovsLength);
    if (count > WASI_HOST_HARD_LIMITS.MAX_IOVECS) fault(WASI_ERRNO.E2BIG);
    const tableBytes = count * 8;
    const table = span(iovsPointer, tableBytes);
    const result = span(resultPointer, 4);
    if (rangesOverlap(table.ptr, table.len, result.ptr, result.len)) {
      fault(WASI_ERRNO.EINVAL);
    }
    const tableSnapshot = readBytes(table.ptr, table.len);
    const tableView = new DataView(
      tableSnapshot.buffer,
      tableSnapshot.byteOffset,
      tableSnapshot.byteLength,
    );
    const rows = [];
    let total = 0;
    for (let index = 0; index < count; index++) {
      const base = index * 8;
      const pointer = tableView.getUint32(base, true);
      const length = tableView.getUint32(base + 4, true);
      const data = span(pointer, length);
      if (
        rangesOverlap(data.ptr, data.len, table.ptr, table.len) ||
        rangesOverlap(data.ptr, data.len, result.ptr, result.len)
      ) fault(WASI_ERRNO.EINVAL);
      for (const prior of rows) {
        if (rangesOverlap(data.ptr, data.len, prior.ptr, prior.len)) {
          fault(WASI_ERRNO.EINVAL);
        }
      }
      total += data.len;
      if (!Number.isSafeInteger(total)) fault(WASI_ERRNO.E2BIG);
      // The MAX_IO_BYTES_PER_CALL cap is preserved for FILE reads and ALL
      // writes. For STDIN reads an advertised iovec length is NOT a promise to
      // consume that many bytes — a tool may advertise a large buffer while
      // the actual job stdin is tiny (short-read on EOF). The table/pointer/
      // overlap checks above still reject OOB/overlap; the copy below is
      // bounded by the REAL remaining stdin bytes (already ≤ the validated
      // stdin quota), so no large allocation ever happens.
      if (!allowOversize && total > WASI_HOST_HARD_LIMITS.MAX_IO_BYTES_PER_CALL) {
        fault(WASI_ERRNO.E2BIG);
      }
      rows.push(data);
    }
    return rows;
  }

  function statHandle(record) {
    if (record.kind !== FD_KIND.FILE) {
      return {
        type: new Set([FD_KIND.PREOPEN, FD_KIND.DIR]).has(record.kind)
          ? "directory"
          : "character",
        size: record.kind === FD_KIND.STDIN ? job.stdin.length : Number(record.offset),
      };
    }
    return validateStat(syncResult(record.handle.stat()));
  }

  function validateStat(value) {
    if (
      !plainData(value) || !new Set(["file", "directory"]).has(value.type) ||
      !Number.isSafeInteger(value.size) || value.size < 0 ||
      value.size > job.quota.fileSize
    ) fault(WASI_ERRNO.EIO);
    return value;
  }

  function filetypeFor(stat) {
    if (stat.type === "directory") return WASI_FILETYPE.DIRECTORY;
    if (stat.type === "file") return WASI_FILETYPE.REGULAR_FILE;
    return WASI_FILETYPE.CHARACTER_DEVICE;
  }

  function writeFdstat(pointer, record) {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, record.filetype);
    view.setUint16(2, record.flags, true);
    view.setBigUint64(8, record.rights, true);
    view.setBigUint64(16, record.rightsInheriting, true);
    writeBytes(pointer, bytes);
  }

  function writeFilestat(pointer, stat) {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    view.setUint8(16, filetypeFor(stat));
    view.setBigUint64(24, 1n, true);
    view.setBigUint64(32, BigInt(stat.size), true);
    // atim/mtim/ctim remain zero: the host exposes no wall-clock identity.
    writeBytes(pointer, bytes);
  }

  function decodePath(pointer, length) {
    const bytes = readBytes(pointer, length);
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > WASI_HOST_HARD_LIMITS.MAX_PATH_BYTES
    ) fault(WASI_ERRNO.ENAMETOOLONG);
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      fault(WASI_ERRNO.EINVAL);
    }
    if (
      text.includes("\0") || text.includes("\\") || text.startsWith("/") ||
      text.endsWith("/")
    ) fault(WASI_ERRNO.EPERM);
    const parts = text.split("/");
    if (parts.length < 2 || !Object.hasOwn(PATH_CLASS_RIGHTS, parts[0])) {
      fault(WASI_ERRNO.EPERM);
    }
    for (const part of parts) {
      const encoded = encoder.encode(part);
      if (!part || part === "." || part === "..") fault(WASI_ERRNO.EPERM);
      if (encoded.byteLength > WASI_HOST_HARD_LIMITS.MAX_PATH_SEGMENT_BYTES) {
        fault(WASI_ERRNO.ENAMETOOLONG);
      }
      for (const byte of encoded) {
        if (byte < 0x20 || byte === 0x7f) fault(WASI_ERRNO.EINVAL);
      }
    }
    return Object.freeze({
      path: text,
      root: parts[0],
      policy: PATH_CLASS_RIGHTS[parts[0]],
    });
  }

  function validateDirText(text, { allowRoot, requireClass }) {
    if (allowRoot && text === ".") return Object.freeze({ path: ".", root: "." });
    if (text.includes("\0") || text.includes("\\") || text.startsWith("/") || text.endsWith("/")) {
      fault(WASI_ERRNO.EPERM);
    }
    const parts = text.split("/");
    if (requireClass && !Object.hasOwn(PATH_CLASS_RIGHTS, parts[0])) {
      fault(WASI_ERRNO.EPERM);
    }
    for (const part of parts) {
      const encoded = encoder.encode(part);
      if (!part || part === "." || part === "..") fault(WASI_ERRNO.EPERM);
      if (encoded.byteLength > WASI_HOST_HARD_LIMITS.MAX_PATH_SEGMENT_BYTES) {
        fault(WASI_ERRNO.ENAMETOOLONG);
      }
      for (const byte of encoded) {
        if (byte < 0x20 || byte === 0x7f) fault(WASI_ERRNO.EINVAL);
      }
    }
    return Object.freeze({ path: text, root: parts[0] });
  }

  function readDirText(pointer, length) {
    const bytes = readBytes(pointer, length);
    if (bytes.byteLength === 0 || bytes.byteLength > WASI_HOST_HARD_LIMITS.MAX_PATH_BYTES) {
      fault(WASI_ERRNO.ENAMETOOLONG);
    }
    try {
      return decoder.decode(bytes);
    } catch {
      fault(WASI_ERRNO.EINVAL);
    }
  }

  // Directory-only grammar: the exact preopen root token `.` plus class roots
  // and bounded descendants. The file decoder above stays byte-identical.
  function decodeDirPath(pointer, length) {
    return validateDirText(readDirText(pointer, length), {
      allowRoot: true,
      requireClass: true,
    });
  }

  // Resolve a directory-relative libc path against the immutable subtree bound
  // into a DIR descriptor. Traversal cannot be expressed by the grammar; the
  // containment check remains as a defense against later decoder changes.
  function resolveDirBasePath(record, pointer, length) {
    if (record.kind === FD_KIND.PREOPEN) return decodeDirPath(pointer, length);
    const relative = validateDirText(readDirText(pointer, length), {
      allowRoot: true,
      requireClass: false,
    }).path;
    const base = record.path;
    const joined = relative === "."
      ? base
      : base === "."
      ? relative
      : `${base}/${relative}`;
    const resolved = validateDirText(joined, {
      allowRoot: true,
      requireClass: true,
    });
    if (base !== "." && resolved.path !== base && !resolved.path.startsWith(`${base}/`)) {
      fault(WASI_ERRNO.EPERM);
    }
    return resolved;
  }

  function allocateFd() {
    if (fds.size - STATIC_FD_COUNT >= job.quota.dynamicFds) fault(WASI_ERRNO.ENOSPC);
    if (freeFds.length) return freeFds.shift();
    let fd = 4;
    while (fds.has(fd)) fd++;
    if (fd > 0xffff_ffff) fault(WASI_ERRNO.ENOSPC);
    return fd;
  }

  const argsBytes = job.args.map((arg) => encoder.encode(`${arg}\0`));
  const argvBytes = argsBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0);

  const implementation = {
    args_sizes_get: (argcPtr, argvBufSizePtr) => {
      const argc = span(argcPtr, 4);
      const size = span(argvBufSizePtr, 4);
      if (rangesOverlap(argc.ptr, argc.len, size.ptr, size.len)) {
        fault(WASI_ERRNO.EINVAL);
      }
      writeU32(argc.ptr, job.args.length);
      writeU32(size.ptr, argvBytes);
      return WASI_ERRNO.SUCCESS;
    },

    args_get: (argvPtr, argvBufPtr) => {
      const table = span(argvPtr, job.args.length * 4);
      const buffer = span(argvBufPtr, argvBytes);
      if (rangesOverlap(table.ptr, table.len, buffer.ptr, buffer.len)) {
        fault(WASI_ERRNO.EINVAL);
      }
      let cursor = buffer.ptr;
      for (let index = 0; index < argsBytes.length; index++) {
        writeU32(table.ptr + index * 4, cursor);
        writeBytes(cursor, argsBytes[index]);
        cursor += argsBytes[index].byteLength;
      }
      return WASI_ERRNO.SUCCESS;
    },

    environ_sizes_get: (countPtr, bufferSizePtr) => {
      const count = span(countPtr, 4);
      const size = span(bufferSizePtr, 4);
      if (rangesOverlap(count.ptr, count.len, size.ptr, size.len)) {
        fault(WASI_ERRNO.EINVAL);
      }
      writeU32(count.ptr, 0);
      writeU32(size.ptr, 0);
      return WASI_ERRNO.SUCCESS;
    },

    environ_get: (environPtr, environBufPtr) => {
      span(environPtr, 0);
      span(environBufPtr, 0);
      return WASI_ERRNO.SUCCESS;
    },

    fd_prestat_get: (fdValue, prestatPtr) => {
      const record = fdFor(fdValue);
      if (record.kind !== FD_KIND.PREOPEN) fault(WASI_ERRNO.EBADF);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setUint32(
        4,
        encoder.encode(record.path).byteLength,
        true,
      );
      writeBytes(prestatPtr, bytes);
      return WASI_ERRNO.SUCCESS;
    },

    fd_prestat_dir_name: (fdValue, pathPtr, pathLength) => {
      const record = fdFor(fdValue);
      if (record.kind !== FD_KIND.PREOPEN) fault(WASI_ERRNO.EBADF);
      const requested = asU32(pathLength);
      const name = encoder.encode(record.path);
      if (requested < name.byteLength) fault(WASI_ERRNO.ENAMETOOLONG);
      span(pathPtr, requested);
      writeBytes(pathPtr, name);
      return WASI_ERRNO.SUCCESS;
    },

    fd_fdstat_get: (fdValue, statPtr) => {
      const record = fdFor(fdValue);
      span(statPtr, 24);
      writeFdstat(statPtr, record);
      return WASI_ERRNO.SUCCESS;
    },

    // fd_fdstat_set_flags — least-authority linkage-only slice
    // (CAP-FB-20260822-WASI-FDSTAT-FLAGS-01): the import is callable so the
    // markdown binary links, but CHANGE semantics are deliberately unsupported
    // in this slice. Error order: fdFor (EBADF) → the requested value shape
    // (> 0xffff or any bit outside the known 0x1f mask → EINVAL) → requireRight
    // (the FD_FDSTAT_SET_FLAGS right is never granted to any descriptor →
    // ENOTCAPABLE for every current fd) → a known-bit change → ENOTSUP →
    // exact no-change → SUCCESS. No rights grants and no flags/rights mutation
    // anywhere. (Full APPEND/NONBLOCK semantics are explicitly deferred — see
    // the GPT fd_fdstat_set_flags design, deferred by the coordinator.)
    fd_fdstat_set_flags: (fdValue, flagsValue) => {
      const record = fdFor(fdValue); // unknown fd → EBADF
      const requested = asU32(flagsValue);
      const knownFlags = WASI_FDFLAGS.APPEND | WASI_FDFLAGS.DSYNC |
        WASI_FDFLAGS.NONBLOCK | WASI_FDFLAGS.RSYNC | WASI_FDFLAGS.SYNC;
      if (requested > 0xffff || (requested & ~knownFlags) !== 0) {
        // a value outside the u16 flags space or with unknown bits → EINVAL
        fault(WASI_ERRNO.EINVAL);
      }
      // the pure behavioral planner decides — single source of truth, KAT-tested
      return planFdstatSetFlags(record.flags, record.rights, requested);
    },

    fd_filestat_get: (fdValue, statPtr) => {
      const record = fdFor(fdValue);
      if (new Set([FD_KIND.FILE, FD_KIND.DIR]).has(record.kind)) {
        requireRight(record, WASI_RIGHTS.FD_FILESTAT_GET);
      }
      span(statPtr, 64);
      writeFilestat(statPtr, statHandle(record));
      return WASI_ERRNO.SUCCESS;
    },

    fd_readdir: (fdValue, bufValue, bufLenValue, cookieValue, bufusedPtrValue) => {
      const record = fdFor(fdValue); // EBADF wins
      const buf = asU32(bufValue);
      const bufLen = asU32(bufLenValue);
      const cookie = asU64(cookieValue);
      // Security binding: rights + kind precede every guest-memory span.
      requireRight(record, WASI_RIGHTS.FD_READDIR);
      if (!new Set([FD_KIND.PREOPEN, FD_KIND.DIR]).has(record.kind)) {
        fault(WASI_ERRNO.ENOTDIR);
      }
      const bufused = span(bufusedPtrValue, 4);
      const output = span(buf, bufLen);
      if (rangesOverlap(output.ptr, output.len, bufused.ptr, bufused.len)) {
        fault(WASI_ERRNO.EINVAL);
      }
      const entries = syncResult(workspace.readdir(
        record.kind === FD_KIND.PREOPEN ? "." : record.path,
      ));
      const plan = planFdReaddir(entries, cookie, bufLen);
      if (plan.errno !== WASI_ERRNO.SUCCESS) return plan.errno;
      writeBytes(output.ptr, plan.packed);
      writeU32(bufused.ptr, plan.bufused);
      return WASI_ERRNO.SUCCESS;
    },

    path_filestat_get: (fdValue, flagsValue, pathPtr, pathLength, statPtr) => {
      const base = fdFor(fdValue);
      if (!new Set([FD_KIND.PREOPEN, FD_KIND.DIR]).has(base.kind)) {
        fault(WASI_ERRNO.EBADF);
      }
      requireRight(base, WASI_RIGHTS.PATH_FILESTAT_GET);
      const flags = asU32(flagsValue);
      if (flags !== 0 || (flags & WASI_LOOKUPFLAGS.SYMLINK_FOLLOW)) {
        fault(WASI_ERRNO.ENOTSUP);
      }
      const resolved = resolveDirBasePath(base, pathPtr, pathLength);
      span(statPtr, 64);
      const stat = validateStat(syncResult(workspace.stat(resolved.path)));
      writeFilestat(statPtr, stat);
      return WASI_ERRNO.SUCCESS;
    },

    path_open: (
      fdValue,
      dirflagsValue,
      pathPtr,
      pathLength,
      oflagsValue,
      rightsBaseValue,
      rightsInheritingValue,
      fdflagsValue,
      openedFdPtr,
    ) => {
      const preopen = fdFor(fdValue);
      if (preopen.kind !== FD_KIND.PREOPEN) fault(WASI_ERRNO.EBADF);
      const dirflags = asU32(dirflagsValue);
      const oflags = asU32(oflagsValue);
      const fdflags = asU32(fdflagsValue);
      if (
        oflags &
        ~(WASI_OFLAGS.CREAT | WASI_OFLAGS.DIRECTORY | WASI_OFLAGS.EXCL |
          WASI_OFLAGS.TRUNC)
      ) fault(WASI_ERRNO.EINVAL);
      if (oflags & WASI_OFLAGS.DIRECTORY) {
        const rightsBase = asU64(rightsBaseValue);
        const rightsInheriting = asU64(rightsInheritingValue);
        // Exact retained wasi-libc opendir tuple; no field is widened. The
        // requested inheriting write/resize bits are stripped, while the two
        // missing read-only traversal bits are added and reported truthfully.
        if (
          dirflags !== WASI_LIBC_OPENDIR_PROFILE.dirflags ||
          oflags !== WASI_LIBC_OPENDIR_PROFILE.oflags ||
          rightsBase !== WASI_LIBC_OPENDIR_PROFILE.requestedBase ||
          rightsInheriting !== WASI_LIBC_OPENDIR_PROFILE.requestedInheriting ||
          fdflags !== WASI_LIBC_OPENDIR_PROFILE.fdflags
        ) fault(WASI_ERRNO.ENOTCAPABLE);
        const resolvedDir = decodeDirPath(pathPtr, pathLength);
        const stat = validateStat(syncResult(workspace.stat(resolvedDir.path)));
        if (stat.type !== "directory") fault(WASI_ERRNO.ENOTDIR);
        span(openedFdPtr, 4);
        const fd = allocateFd();
        putFd({
          fd,
          kind: FD_KIND.DIR,
          filetype: WASI_FILETYPE.DIRECTORY,
          flags: WASI_LIBC_OPENDIR_PROFILE.fdflags,
          rights: WASI_LIBC_OPENDIR_PROFILE.granted,
          rightsInheriting: WASI_LIBC_OPENDIR_PROFILE.granted,
          offset: 0n,
          path: resolvedDir.path,
          handle: null,
        });
        try {
          writeU32(openedFdPtr, fd);
        } catch (error) {
          fds.delete(fd);
          freeFds.push(fd);
          freeFds.sort((a, b) => a - b);
          throw error;
        }
        return WASI_ERRNO.SUCCESS;
      }

      // Existing FILE-open branch below stays byte-for-byte equivalent.
      if (dirflags !== 0 || (dirflags & WASI_LOOKUPFLAGS.SYMLINK_FOLLOW)) {
        fault(WASI_ERRNO.ENOTSUP);
      }
      if (fdflags & ~(WASI_FDFLAGS.APPEND)) fault(WASI_ERRNO.ENOTSUP);
      if ((oflags & WASI_OFLAGS.EXCL) && !(oflags & WASI_OFLAGS.CREAT)) {
        fault(WASI_ERRNO.EINVAL);
      }
      const rightsBase = asU64(rightsBaseValue);
      const rightsInheriting = asU64(rightsInheritingValue);
      if (rightsInheriting !== 0n) fault(WASI_ERRNO.ENOTCAPABLE);
      const resolved = decodePath(pathPtr, pathLength);
      if ((rightsBase & ~resolved.policy.rights) !== 0n) {
        fault(WASI_ERRNO.ENOTCAPABLE);
      }
      const read = (rightsBase & WASI_RIGHTS.FD_READ) !== 0n;
      const write = (rightsBase & WASI_RIGHTS.FD_WRITE) !== 0n;
      if (
        (read && !resolved.policy.readable) ||
        (write && !resolved.policy.writable)
      ) fault(WASI_ERRNO.ENOTCAPABLE);
      const mutatingFlags = WASI_OFLAGS.CREAT | WASI_OFLAGS.EXCL |
        WASI_OFLAGS.TRUNC;
      if (
        !resolved.policy.writable &&
        ((oflags & mutatingFlags) || (fdflags & WASI_FDFLAGS.APPEND))
      ) fault(WASI_ERRNO.EACCES);
      if (
        ((oflags & mutatingFlags) || (fdflags & WASI_FDFLAGS.APPEND)) && !write
      ) fault(WASI_ERRNO.ENOTCAPABLE);
      span(openedFdPtr, 4);
      const fd = allocateFd();
      let handle;
      try {
        handle = syncResult(workspace.open(
          resolved.path,
          Object.freeze({
            read,
            write,
            create: Boolean(oflags & WASI_OFLAGS.CREAT),
            exclusive: Boolean(oflags & WASI_OFLAGS.EXCL),
            truncate: Boolean(oflags & WASI_OFLAGS.TRUNC),
            append: Boolean(fdflags & WASI_FDFLAGS.APPEND),
          }),
        ));
        if (!validHandle(handle)) fault(WASI_ERRNO.EIO);
        const stat = validateStat(syncResult(handle.stat()));
        if (stat.type !== "file") fault(WASI_ERRNO.EISDIR);
        const offset = fdflags & WASI_FDFLAGS.APPEND ? BigInt(stat.size) : 0n;
        putFd({
          fd,
          kind: FD_KIND.FILE,
          filetype: WASI_FILETYPE.REGULAR_FILE,
          flags: fdflags,
          rights: rightsBase,
          rightsInheriting: 0n,
          offset,
          path: resolved.path,
          handle,
        });
        writeU32(openedFdPtr, fd);
      } catch (error) {
        if (fds.get(fd)?.handle === handle) fds.delete(fd);
        try {
          if (handle && typeof handle.close === "function") {
            syncResult(handle.close());
          }
        } catch { /* guarded cleanup only */ }
        throw error;
      }
      return WASI_ERRNO.SUCCESS;
    },

    fd_read: (fdValue, iovsPtr, iovsLength, nreadPtr) => {
      const record = fdFor(fdValue);
      if (!new Set([FD_KIND.STDIN, FD_KIND.FILE]).has(record.kind)) {
        fault(WASI_ERRNO.EBADF);
      }
      requireRight(record, WASI_RIGHTS.FD_READ);
      const rows = parseIovecs(iovsPtr, iovsLength, nreadPtr, {
        allowOversize: record.kind === FD_KIND.STDIN,
      });
      let total = 0;
      for (const row of rows) {
        if (row.len === 0) continue;
        let bytes;
        if (record.kind === FD_KIND.STDIN) {
          // Short-read on EOF: copy at most the REAL remaining stdin bytes
          // (≤ the already-validated stdin quota) — never the advertised
          // length, so an oversized advertised buffer cannot allocate.
          const remaining = job.stdin.length - state.stdinOffset;
          if (remaining <= 0) break;
          const take = Math.min(row.len, remaining);
          bytes = new Uint8Array(
            job.stdin.slice(state.stdinOffset, state.stdinOffset + take),
          );
        } else {
          const remaining = job.quota.fileBytes - state.fileBytes;
          if (remaining <= 0) {
            if (total === 0) fault(WASI_ERRNO.EFBIG);
            break;
          }
          const requested = Math.min(row.len, remaining);
          const position = record.offset + BigInt(total);
          if (position > BigInt(Number.MAX_SAFE_INTEGER)) {
            fault(WASI_ERRNO.EOVERFLOW);
          }
          bytes = syncResult(record.handle.read(Number(position), requested));
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > requested) {
            fault(WASI_ERRNO.EIO);
          }
          bytes = new Uint8Array(bytes);
        }
        writeBytes(row.ptr, bytes);
        if (record.kind === FD_KIND.FILE) state.fileBytes += bytes.byteLength;
        total += bytes.byteLength;
        if (record.kind === FD_KIND.STDIN) {
          state.stdinOffset += bytes.byteLength;
        }
        if (bytes.byteLength < row.len) break;
      }
      if (record.kind === FD_KIND.FILE) {
        replaceOffset(record, record.offset + BigInt(total));
      } else replaceOffset(record, BigInt(state.stdinOffset));
      writeU32(nreadPtr, total);
      return WASI_ERRNO.SUCCESS;
    },

    fd_write: (fdValue, iovsPtr, iovsLength, nwrittenPtr) => {
      const record = fdFor(fdValue);
      if (
        !new Set([FD_KIND.STDOUT, FD_KIND.STDERR, FD_KIND.FILE]).has(
          record.kind,
        )
      ) fault(WASI_ERRNO.EBADF);
      requireRight(record, WASI_RIGHTS.FD_WRITE);
      const rows = parseIovecs(iovsPtr, iovsLength, nwrittenPtr);
      let total = 0;
      for (const row of rows) {
        if (row.len === 0) continue;
        let allowed = row.len;
        if (record.kind === FD_KIND.STDOUT) {
          allowed = Math.min(
            allowed,
            job.quota.stdoutBytes - state.stdoutBytes,
          );
        } else if (record.kind === FD_KIND.STDERR) {
          allowed = Math.min(
            allowed,
            job.quota.stderrBytes - state.stderrBytes,
          );
        } else {
          const position = record.offset + BigInt(total);
          if (position > BigInt(Number.MAX_SAFE_INTEGER)) {
            fault(WASI_ERRNO.EOVERFLOW);
          }
          const sizeRemaining = BigInt(job.quota.fileSize) - position;
          if (sizeRemaining <= 0n) allowed = 0;
          else {allowed = Math.min(
              allowed,
              job.quota.fileBytes - state.fileBytes,
              Number(sizeRemaining),
            );}
        }
        if (allowed <= 0) {
          if (total === 0) fault(WASI_ERRNO.EFBIG);
          break;
        }
        const bytes = readBytes(row.ptr, allowed);
        let written = bytes.byteLength;
        if (record.kind === FD_KIND.STDOUT) {
          state.stdout.push(bytes);
          state.stdoutBytes += written;
        } else if (record.kind === FD_KIND.STDERR) {
          state.stderr.push(bytes);
          state.stderrBytes += written;
        } else {
          written = syncResult(
            record.handle.write(Number(record.offset + BigInt(total)), bytes),
          );
          if (
            !Number.isSafeInteger(written) || written < 0 ||
            written > bytes.byteLength
          ) fault(WASI_ERRNO.EIO);
          state.fileBytes += written;
        }
        total += written;
        if (written < row.len) break;
      }
      replaceOffset(record, record.offset + BigInt(total));
      writeU32(nwrittenPtr, total);
      return WASI_ERRNO.SUCCESS;
    },

    fd_seek: (fdValue, offsetValue, whenceValue, newOffsetPtr) => {
      const record = fdFor(fdValue);
      if (record.kind !== FD_KIND.FILE) fault(WASI_ERRNO.ESPIPE);
      requireRight(record, WASI_RIGHTS.FD_SEEK);
      const offset = asI64(offsetValue);
      const whence = asU32(whenceValue);
      let base;
      if (whence === WASI_WHENCE.SET) base = 0n;
      else if (whence === WASI_WHENCE.CUR) base = record.offset;
      else if (whence === WASI_WHENCE.END) {
        base = BigInt(statHandle(record).size);
      } else fault(WASI_ERRNO.EINVAL);
      const next = base + offset;
      if (next < 0n) fault(WASI_ERRNO.EINVAL);
      if (next > BigInt(Number.MAX_SAFE_INTEGER)) fault(WASI_ERRNO.EOVERFLOW);
      if (next > BigInt(job.quota.fileSize)) fault(WASI_ERRNO.EFBIG);
      span(newOffsetPtr, 8);
      writeU64(newOffsetPtr, next);
      replaceOffset(record, next);
      return WASI_ERRNO.SUCCESS;
    },

    fd_tell: (fdValue, offsetPtr) => {
      const record = fdFor(fdValue);
      if (record.kind !== FD_KIND.FILE) fault(WASI_ERRNO.ESPIPE);
      requireRight(record, WASI_RIGHTS.FD_TELL);
      writeU64(offsetPtr, record.offset);
      return WASI_ERRNO.SUCCESS;
    },

    fd_close: (fdValue) => {
      const fd = asU32(fdValue);
      if (fd <= 2) return WASI_ERRNO.SUCCESS;
      const record = fdFor(fd);
      if (!new Set([FD_KIND.FILE, FD_KIND.DIR]).has(record.kind)) {
        fault(WASI_ERRNO.EBADF);
      }
      if (record.kind === FD_KIND.FILE) syncResult(record.handle.close());
      fds.delete(fd);
      freeFds.push(fd);
      freeFds.sort((a, b) => a - b);
      return WASI_ERRNO.SUCCESS;
    },

    random_get: (bufferPtr, lengthValue) => {
      const length = asU32(lengthValue);
      if (length > WASI_HOST_HARD_LIMITS.MAX_RANDOM_BYTES_PER_CALL) {
        fault(WASI_ERRNO.E2BIG);
      }
      span(bufferPtr, length);
      const bytes = new Uint8Array(length);
      const returned = syncResult(randomFill(bytes));
      if (returned !== undefined && returned !== bytes) fault(WASI_ERRNO.EIO);
      writeBytes(bufferPtr, bytes);
      return WASI_ERRNO.SUCCESS;
    },

    clock_time_get: (clockIdValue, precisionValue, timePtr) => {
      const id = asU32(clockIdValue);
      asU64(precisionValue);
      if (id === WASI_CLOCK.REALTIME) return WASI_ERRNO.ENOTSUP;
      if (id !== WASI_CLOCK.MONOTONIC) fault(WASI_ERRNO.EINVAL);
      span(timePtr, 8);
      let now = syncResult(monotonicNowNs());
      if (typeof now === "number" && Number.isSafeInteger(now) && now >= 0) {
        now = BigInt(now);
      }
      if (typeof now !== "bigint" || now < 0n || now > U64_MAX) {
        fault(WASI_ERRNO.EIO);
      }
      if (now < state.lastClock) now = state.lastClock;
      writeU64(timePtr, now);
      state.lastClock = now;
      return WASI_ERRNO.SUCCESS;
    },
  };

  const wasi = {};
  for (const name of SUPPORTED_WASI_PREVIEW1_IMPORTS) {
    const pathCall = name === "path_open" || name === "path_filestat_get" ||
      name === "fd_readdir";
    wasi[name] = syscall(implementation[name], { path: pathCall });
  }
  wasi.proc_exit = (codeValue) => {
    const gate = beginCall();
    if (gate !== WASI_ERRNO.SUCCESS) return gate;
    try {
      const code = asU32(codeValue);
      throw new WasiProcExit(code);
    } catch (error) {
      if (error instanceof WasiProcExit) throw error;
      return mapAdapterError(error);
    }
  };
  Object.freeze(wasi);

  function concat(parts, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  return Object.freeze({
    imports: Object.freeze({ wasi_snapshot_preview1: wasi }),
    assertImports: validateWasiImportSet,
    snapshot() {
      return Object.freeze({
        context: job.context,
        quota: job.quota,
        counters: Object.freeze({
          hostCalls: state.hostCalls,
          pathCalls: state.pathCalls,
          fileBytes: state.fileBytes,
          stdinBytesRead: state.stdinOffset,
          stdoutBytes: state.stdoutBytes,
          stderrBytes: state.stderrBytes,
          openDynamicFds: fds.size - STATIC_FD_COUNT,
        }),
        stdout: concat(state.stdout, state.stdoutBytes),
        stderr: concat(state.stderr, state.stderrBytes),
      });
    },
  });
}
