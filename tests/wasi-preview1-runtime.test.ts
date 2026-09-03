// CAP-FB-20260822-WASM-EXECUTION-HOST-01 — pure unreachable Gate 1.
// No Chrome, Worker, OPFS, route, provider, byte fetch, or Wasm instantiation.
// @ts-nocheck: faithful in-memory adapters intentionally exercise dynamic syscall shapes.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  createFdRecord,
  createWasiContext,
  createWasiJob,
  createWasiQuota,
  FD_KIND,
  PATH_CLASS_RIGHTS,
  WASI_CLOCK,
  WASI_ERRNO,
  WASI_FDFLAGS,
  WASI_FILETYPE,
  WASI_HOST_DEFAULT_QUOTA,
  WASI_HOST_HARD_LIMITS,
  WASI_LOOKUPFLAGS,
  WASI_OFLAGS,
  WASI_RIGHTS,
  WASI_WHENCE,
  WasiProcExit,
} from "../extension/lib/wasm-host-types.js";
import {
  createWasiPreview1Runtime,
  isExactRetainedTouchCreateTuple,
  isExactSqliteDbReadOpenTuple,
  isExactSqliteDbWriteOpenTuple,
  planFdReaddir,
  planFdFilestatSetSize,
  planFileOpenDirflags,
  planPathFilestatLookup,
  planPathFilestatSetTimes,
  RETAINED_TOUCH_CREATE_PROFILE,
  SQLITE_DB_OPEN_PROFILE,
  REBUILT_TOOL_COUNT,
  REBUILT_WASI_IMPORTS,
  revalidateAuditedMemory,
  SUPPORTED_WASI_PREVIEW1_IMPORTS,
  validateWasiImportSet,
  WASI_LIBC_OPENDIR_PROFILE,
} from "../extension/lib/wasi-preview1-runtime.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

class TestMemory {
  constructor(size = 64 * 1024) {
    this.bytes = new Uint8Array(size);
  }
  size() {
    return this.bytes.byteLength;
  }
  read(offset, length) {
    return this.bytes.slice(offset, offset + length);
  }
  write(offset, bytes) {
    if (this.failWriteAt === offset) {
      throw new Error("injected memory write failure");
    }
    this.bytes.set(bytes, offset);
  }
  put(offset, bytes) {
    this.bytes.set(bytes, offset);
    return bytes.byteLength;
  }
  putText(offset, value) {
    return this.put(offset, enc.encode(value));
  }
  u32(offset) {
    return new DataView(this.bytes.buffer).getUint32(offset, true);
  }
  u64(offset) {
    return new DataView(this.bytes.buffer).getBigUint64(offset, true);
  }
  setU32(offset, value) {
    new DataView(this.bytes.buffer).setUint32(offset, value, true);
  }
  text(offset, length) {
    return dec.decode(this.bytes.slice(offset, offset + length));
  }
}

class MemoryWorkspace {
  scratchTotalBytes() {
    let total = 0;
    for (const [path, row] of this.files) {
      if (path.startsWith("scratch/")) total += row.bytes.byteLength;
    }
    return total;
  }
  constructor({ partialRead = Infinity, partialWrite = Infinity } = {}) {
    this.files = new Map([
      ["inputs/in.txt", { type: "file", bytes: enc.encode("abcdef") }],
      ["scratch/work.txt", { type: "file", bytes: enc.encode("12345") }],
      ["output/existing.txt", { type: "file", bytes: enc.encode("hidden") }],
    ]);
    // R3 equivalence rows: S2's explicit-directory Set (exists with NO
    // descendants, unlike an implicit dir which requires one).
    this.dirs = new Set();
    this.stats = []; // stat-argument spy (path per call)
    this.partialRead = partialRead;
    this.partialWrite = partialWrite;
    this.opened = [];
    this.closed = 0;
  }
  stat(path) {
    this.stats.push(path);
    const row = this.files.get(path);
    const prefix = path === "." ? "" : `${path}/`;
    const directory = path === "." || this.dirs.has(path) || [...this.files.keys()].some((key) => key.startsWith(prefix));
    if (row && directory) throw Object.assign(new Error("ambiguous"), { code: "ENOTDIR" });
    if (row) return { type: row.type, size: row.bytes.byteLength, atimNs: row.atimNs ?? 0n, mtimNs: row.mtimNs ?? 0n };
    if (directory) return { type: "directory", size: 0, atimNs: 0n, mtimNs: 0n };
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }
  setTimes(path, { atimNs, mtimNs } = {}) {
    const row = this.files.get(path);
    if (!row) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (atimNs !== undefined) row.atimNs = atimNs;
    if (mtimNs !== undefined) row.mtimNs = mtimNs;
  }
  createScratchFile(path) {
    if (!path.startsWith("scratch/")) throw Object.assign(new Error("perm"), { code: "EPERM" });
    if (this.files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    const row = { type: "file", bytes: new Uint8Array(), atimNs: 0n, mtimNs: 0n };
    this.files.set(path, row);
    let committed = false;
    return {
      handle: {
        stat: () => ({ type: "file", size: row.bytes.byteLength }),
        read: (offset, length) => row.bytes.slice(offset, offset + length),
        write: (offset, bytes) => {
          const end = offset + bytes.byteLength;
          if (end > row.bytes.byteLength) {
            const grown = new Uint8Array(end); grown.set(row.bytes); row.bytes = grown;
          }
          row.bytes.set(bytes, offset);
          return bytes.byteLength;
        },
        close: () => { committed = true; },
      },
      commit: () => { committed = true; return true; },
      rollback: () => { if (!committed) this.files.delete(path); return true; },
    };
  }
  createDirectory(path) {
    if (this.files.has(path) || this.dirs.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent !== "scratch" && !this.dirs.has(parent) &&
        ![...this.files.keys()].some((k) => k.startsWith(`${parent}/`))) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    this.dirs.add(path);
    return { commit: () => true, rollback: () => { this.dirs.delete(path); return true; } };
  }
  removeDirectory(path) {
    if (!this.dirs.has(path)) throw Object.assign(new Error("notdir"), { code: "ENOTDIR" });
    const prefix = `${path}/`;
    if ([...this.files.keys()].some((k) => k.startsWith(prefix))) {
      throw Object.assign(new Error("notempty"), { code: "ENOTEMPTY" });
    }
    this.dirs.delete(path);
    return { commit: () => true, rollback: () => { this.dirs.add(path); return true; } };
  }
  unlinkFile(path) {
    const row = this.files.get(path);
    if (!row) {
      const isDir = this.dirs.has(path) || [...this.files.keys()].some((k) => k.startsWith(`${path}/`));
      if (isDir) throw Object.assign(new Error("isdir"), { code: "EISDIR" });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    this.files.delete(path);
    return { commit: () => true, rollback: () => { this.files.set(path, row); return true; } };
  }
  readdir(path) {
    const prefix = path === "." ? "" : `${path}/`;
    const hasChildren = [...this.files.keys()].some((key) => key.startsWith(prefix));
    if (path !== "." && !this.dirs.has(path) && !hasChildren) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    const names = new Map();
    for (const key of this.files.keys()) {
      if (prefix && !key.startsWith(prefix)) continue;
      const relative = prefix ? key.slice(prefix.length) : key;
      const slash = relative.indexOf("/");
      const name = slash < 0 ? relative : relative.slice(0, slash);
      names.set(name, slash < 0 ? "file" : "directory");
    }
    // explicit-directory union (S2): child explicit dirs list as directories.
    for (const dir of this.dirs) {
      if (prefix && !dir.startsWith(prefix)) continue;
      const relative = prefix ? dir.slice(prefix.length) : dir;
      const slash = relative.indexOf("/");
      if (slash < 0 && relative) names.set(relative, "directory");
      else if (slash >= 0) names.set(relative.slice(0, slash), "directory");
    }
    return [...names].map(([name, type]) => ({ name, type }));
  }
  open(path, options) {
    let row = this.files.get(path);
    if (options.exclusive && row) {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    }
    if (!row) {
      if (!options.create) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      row = { type: "file", bytes: new Uint8Array() };
      this.files.set(path, row);
    }
    if (options.truncate) row.bytes = new Uint8Array();
    this.opened.push({ path, options });
    let closed = false;
    return {
      read: (offset, length) => {
        if (closed) throw new Error("closed");
        const count = Math.min(length, this.partialRead);
        return row.bytes.slice(offset, offset + count);
      },
      write: (offset, bytes) => {
        if (closed) throw new Error("closed");
        const count = Math.min(bytes.byteLength, this.partialWrite);
        const end = offset + count;
        if (end > row.bytes.byteLength) {
          const grown = new Uint8Array(end);
          grown.set(row.bytes);
          row.bytes = grown;
        }
        row.bytes.set(bytes.slice(0, count), offset);
        return count;
      },
      setSize: (size) => {
        if (closed) throw new Error("closed");
        if (size === row.bytes.byteLength) return;
        if (size > row.bytes.byteLength) {
          const out = new Uint8Array(size);
          out.set(row.bytes);
          row.bytes = out;
        } else {
          row.bytes = row.bytes.slice(0, size);
        }
      },
      stat: () => {
        if (closed) throw new Error("closed");
        return { type: row.type, size: row.bytes.byteLength };
      },
      close: () => {
        if (!closed) this.closed++;
        closed = true;
      },
    };
  }
}

function rawJob(
  {
    args = ["tool", "--flag"],
    stdin = enc.encode("stdin-data"),
    quota = {},
    tier = "tiny",
  } = {},
) {
  return {
    args,
    context: {
      executionId: "exec-1",
      callId: "call-1",
      origin: "https://example.test",
      workspaceRoot: "tool-jobs/exec-1/call-1/",
    },
    quota,
    stdin,
    tier,
    acceptedExitCodes: [0],
    stdoutEncoding: "utf8",
    workspaceSeed: { files: [] },
  };
}

function harness(options = {}) {
  const memory = options.memory ?? new TestMemory();
  const workspace = options.workspace ?? new MemoryWorkspace();
  const runtime = createWasiPreview1Runtime({
    job: rawJob(options.job),
    memory,
    workspace,
    isCancelled: options.isCancelled,
    randomFill: options.randomFill,
    monotonicNowNs: options.monotonicNowNs,
  });
  return {
    memory,
    workspace,
    runtime,
    wasi: runtime.imports.wasi_snapshot_preview1,
  };
}

function setIovecs(memory, table, rows) {
  rows.forEach((row, index) => {
    memory.setU32(table + index * 8, row.pointer);
    memory.setU32(table + index * 8 + 4, row.length);
  });
}

function putPath(memory, pointer, path) {
  return memory.putText(pointer, path);
}

function openPath(
  h,
  path,
  rights,
  { oflags = 0, fdflags = 0, openedPtr = 3000, preopenFd = 3 } = {},
) {
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, path);
  const errno = h.wasi.path_open(
    preopenFd,
    0,
    pathPtr,
    length,
    oflags,
    rights,
    0n,
    fdflags,
    openedPtr,
  );
  return { errno, fd: h.memory.u32(openedPtr) };
}

function openDir(h, path, overrides = {}) {
  const pathPtr = overrides.pathPtr ?? 2000;
  const openedPtr = overrides.openedPtr ?? 3000;
  const length = putPath(h.memory, pathPtr, path);
  const profile = {
    dirflags: WASI_LIBC_OPENDIR_PROFILE.dirflags,
    oflags: WASI_LIBC_OPENDIR_PROFILE.oflags,
    rightsBase: WASI_LIBC_OPENDIR_PROFILE.requestedBase,
    rightsInheriting: WASI_LIBC_OPENDIR_PROFILE.requestedInheriting,
    fdflags: WASI_LIBC_OPENDIR_PROFILE.fdflags,
    preopenFd: 4,
    ...overrides,
  };
  const errno = h.wasi.path_open(
    profile.preopenFd,
    profile.dirflags,
    pathPtr,
    length,
    profile.oflags,
    profile.rightsBase,
    profile.rightsInheriting,
    profile.fdflags,
    openedPtr,
  );
  return { errno, fd: h.memory.u32(openedPtr) };
}

function decodeDirents(bytes) {
  const rows = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const nameLength = view.getUint32(16, true);
    rows.push({
      next: view.getBigUint64(0, true),
      ino: view.getBigUint64(8, true),
      type: view.getUint32(20, true),
      name: dec.decode(bytes.slice(offset + 24, offset + 24 + nameLength)),
    });
    offset += 24 + nameLength;
  }
  return rows;
}

Deno.test("WASI host types: constants, job/context/quota and FD records are strict and frozen", () => {
  for (
    const value of [
      WASI_ERRNO,
      WASI_FILETYPE,
      WASI_RIGHTS,
      WASI_HOST_HARD_LIMITS,
      WASI_HOST_DEFAULT_QUOTA,
      PATH_CLASS_RIGHTS,
    ]
  ) assert(Object.isFrozen(value));
  assert(Object.isFrozen(PATH_CLASS_RIGHTS.inputs));
  const context = createWasiContext(rawJob().context);
  const quota = createWasiQuota({ stdoutBytes: 10 });
  const job = createWasiJob({ ...rawJob(), quota: { stdoutBytes: 10 } });
  const fd = createFdRecord({
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
  for (
    const value of [context, quota, job, job.context, job.args, job.stdin, fd]
  ) assert(Object.isFrozen(value));
  assertEquals(quota.stdoutBytes, 10);
  assertEquals(quota.stderrBytes, WASI_HOST_DEFAULT_QUOTA.stderrBytes);
  assertThrows(
    () => createWasiContext({ ...rawJob().context, secret: "x" }),
    TypeError,
    "context_shape",
  );
  assertThrows(
    () =>
      createWasiContext({
        ...rawJob().context,
        workspaceRoot: "tool-jobs/other/call-1/",
      }),
    TypeError,
    "context_workspace_root",
  );
  assertThrows(
    () => createWasiJob({ ...rawJob(), tier: "large" }),
    TypeError,
    "job_tier",
  );
  // dptw: no stdin byte ceiling — a stdin past the removed 1 MiB quota is
  // accepted whole (shape checks — non-Uint8Array — still fail).
  const bigStdinJob = createWasiJob({ ...rawJob(), stdin: new Uint8Array(1024 * 1024 + 1) });
  assertEquals(bigStdinJob.stdin.length, 1024 * 1024 + 1, "big stdin accepted whole");
  assertThrows(
    () => createWasiJob({ ...rawJob(), stdin: "not-bytes" }),
    TypeError,
    "job_stdin",
  );
  assertThrows(
    () => createWasiJob({ ...rawJob(), args: ["bad\ud800"] }),
    TypeError,
    "job_args",
  );
  assertEquals(createWasiJob({ ...rawJob(), args: ["valid-😀"] }).args, [
    "valid-😀",
  ]);
  assertThrows(
    () =>
      createWasiQuota({ hostCalls: WASI_HOST_HARD_LIMITS.MAX_HOST_CALLS + 1 }),
    TypeError,
    "quota_hostCalls",
  );
  const hostileQuota = {};
  Object.defineProperty(hostileQuota, "hostCalls", {
    enumerable: true,
    get() {
      throw new Error("getter called");
    },
  });
  assertThrows(() => createWasiQuota(hostileQuota), TypeError, "quota_shape");
  assertThrows(
    () => createFdRecord({ ...fd, rights: -1n }),
    TypeError,
    "fd_rights",
  );
});

Deno.test("WASI imports: 37-tool measured union is explicit; foreign/unknown imports fail closed", () => {
  assertEquals(REBUILT_TOOL_COUNT, 37);
  assertEquals(REBUILT_WASI_IMPORTS, [
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
  assert(SUPPORTED_WASI_PREVIEW1_IMPORTS.includes("fd_tell"));
  assert(SUPPORTED_WASI_PREVIEW1_IMPORTS.includes("random_get"));
  const records = REBUILT_WASI_IMPORTS.map((name) => ({
    module: "wasi_snapshot_preview1",
    name,
    kind: "function",
  }));
  assertEquals(
    validateWasiImportSet(records).map((row) => row.name),
    REBUILT_WASI_IMPORTS,
  );
  for (
    const bad of [
      [{ module: "env", name: "fd_write", kind: "function" }],
      [{
        module: "wasi_snapshot_preview1",
        name: "sock_open",
        kind: "function",
      }],
      [{ module: "wasi_snapshot_preview1", name: "fd_write", kind: "memory" }],
    ]
  ) {
    assertThrows(
      () => validateWasiImportSet(bad),
      TypeError,
      "unsupported_wasi_import",
    );
  }
  assertThrows(
    () => validateWasiImportSet([records[0], records[0]]),
    TypeError,
    "duplicate_wasi_import",
  );
  const hostile = { module: "wasi_snapshot_preview1", kind: "function" };
  Object.defineProperty(hostile, "name", {
    enumerable: true,
    get() {
      throw new Error("import getter invoked");
    },
  });
  assertThrows(
    () => validateWasiImportSet([hostile]),
    TypeError,
    "wasi_import_shape",
  );
});

Deno.test("WASI memory gate: exact package tiers and scanner readback are revalidated without instantiation", () => {
  const audit = {
    ok: true,
    bytes: 100,
    measured: { memoryInitial: 1, memoryMax: 8, imported: false, tier: "tiny" },
    imports: [{
      module: "wasi_snapshot_preview1",
      name: "fd_write",
      kind: "function",
    }],
  };
  const result = revalidateAuditedMemory({
    audit,
    binaryBytes: 100,
    declaredMaxPages: 8,
    tier: "tiny",
  });
  assertEquals(result.memoryMax, 8);
  assert(Object.isFrozen(result));
  assertThrows(
    () =>
      revalidateAuditedMemory({
        audit,
        binaryBytes: 100,
        declaredMaxPages: 8,
        tier: "large",
      }),
    TypeError,
    "memory_tier_blocked",
  );
  assertThrows(
    () =>
      revalidateAuditedMemory({
        audit: { ...audit, bytes: 99 },
        binaryBytes: 100,
        declaredMaxPages: 8,
        tier: "tiny",
      }),
    TypeError,
    "memory_audit_shape",
  );
  assertThrows(
    () =>
      revalidateAuditedMemory({
        audit: { ...audit, measured: { ...audit.measured, memoryMax: 9 } },
        binaryBytes: 100,
        declaredMaxPages: 8,
        tier: "tiny",
      }),
    TypeError,
    "memory_audit_mismatch",
  );
  assertThrows(
    () =>
      revalidateAuditedMemory({
        audit: {
          ...audit,
          imports: [{ module: "env", name: "fd_write", kind: "function" }],
        },
        binaryBytes: 100,
        declaredMaxPages: 8,
        tier: "tiny",
      }),
    TypeError,
    "unsupported_wasi_import",
  );
  const hostile = { audit, binaryBytes: 100, declaredMaxPages: 8 };
  Object.defineProperty(hostile, "tier", {
    enumerable: true,
    get() {
      throw new Error("tier getter invoked");
    },
  });
  assertThrows(
    () => revalidateAuditedMemory(hostile),
    TypeError,
    "memory_audit_shape",
  );
});

Deno.test("WASI args/environment KAT: LE pointers, UTF-8 argv and an exactly empty environment", () => {
  const h = harness();
  assertEquals(h.wasi.args_sizes_get(100, 104), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(100), 2);
  assertEquals(h.memory.u32(104), 12);
  assertEquals(h.wasi.args_get(200, 300), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(200), 300);
  assertEquals(h.memory.u32(204), 305);
  assertEquals(h.memory.text(300, 12), "tool\0--flag\0");
  assertEquals(h.wasi.environ_sizes_get(400, 404), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(400), 0);
  assertEquals(h.memory.u32(404), 0);
  assertEquals(h.wasi.environ_get(0, 0), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.args_sizes_get(100, 100), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.args_get(200, 202), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.args_get(0xfffffff0, 0), WASI_ERRNO.EFAULT);
  assertThrows(
    () => createWasiJob({ ...rawJob(), args: ["bad\0arg"] }),
    TypeError,
    "job_args",
  );
});

Deno.test("WASI preopen/fd stat KAT: fd3 dot + fd4 /job aliases have identical bounded descriptor rights", () => {
  const h = harness();
  assertEquals(h.wasi.fd_prestat_get(3, 100), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[100], 0);
  assertEquals(h.memory.u32(104), 1, "fd3 dot name length");
  assertEquals(h.wasi.fd_prestat_dir_name(3, 120, 0), WASI_ERRNO.ENAMETOOLONG);
  assertEquals(h.wasi.fd_prestat_dir_name(3, 120, 1), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.text(120, 1), ".");

  assertEquals(h.wasi.fd_prestat_get(4, 140), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[140], 0);
  assertEquals(h.memory.u32(144), 4, "fd4 /job name length");
  for (const shortLength of [0, 1, 2, 3]) {
    assertEquals(
      h.wasi.fd_prestat_dir_name(4, 160, shortLength),
      WASI_ERRNO.ENAMETOOLONG,
      `short /job preopen buffer ${shortLength}`,
    );
  }
  assertEquals(h.wasi.fd_prestat_dir_name(4, 160, 4), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.text(160, 4), "/job");
  assertEquals(h.wasi.fd_prestat_get(5, 100), WASI_ERRNO.EBADF, "libc scan stops at fd5");
  assertEquals(h.wasi.fd_prestat_dir_name(5, 160, 4), WASI_ERRNO.EBADF);

  assertEquals(h.wasi.fd_fdstat_get(0, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[200], WASI_FILETYPE.CHARACTER_DEVICE);
  const rootRights = WASI_RIGHTS.PATH_OPEN |
    WASI_RIGHTS.PATH_CREATE_FILE |
    WASI_RIGHTS.PATH_FILESTAT_GET |
    WASI_RIGHTS.FD_READDIR |
    // R11: the lock-pair + journal-unlink path rights (both preopen aliases).
    WASI_RIGHTS.PATH_CREATE_DIRECTORY |
    WASI_RIGHTS.PATH_REMOVE_DIRECTORY |
    WASI_RIGHTS.PATH_UNLINK_FILE;
  const inheritedRights = PATH_CLASS_RIGHTS.inputs.rights |
    PATH_CLASS_RIGHTS.scratch.rights |
    PATH_CLASS_RIGHTS.output.rights;
  for (const [fd, pointer] of [[3, 240], [4, 280]]) {
    assertEquals(h.wasi.fd_fdstat_get(fd, pointer), WASI_ERRNO.SUCCESS);
    assertEquals(h.memory.bytes[pointer], WASI_FILETYPE.DIRECTORY);
    // R6 (A-1): fd4 adds PATH_FILESTAT_SET_TIMES; fd3 does NOT (the fd4-only right).
    const expectedRights = fd === 4
      ? (rootRights | WASI_RIGHTS.PATH_FILESTAT_SET_TIMES)
      : rootRights;
    assertEquals(h.memory.u64(pointer + 8), expectedRights, `fd${fd} base rights`);
    assertEquals(h.memory.u64(pointer + 16), inheritedRights, `fd${fd} inherited rights`);
    assertEquals(h.wasi.fd_filestat_get(fd, pointer + 40), WASI_ERRNO.SUCCESS);
    assertEquals(h.memory.bytes[pointer + 56], WASI_FILETYPE.DIRECTORY);
    assertEquals(h.wasi.fd_close(fd), WASI_ERRNO.EBADF, `fd${fd} preopen cannot close`);
  }
});

Deno.test("WASI path normalization/stat: relative classes work; traversal, NUL, invalid UTF-8 and symlink flags fail", () => {
  const h = harness();
  let length = putPath(h.memory, 1000, "inputs/in.txt");
  assertEquals(
    h.wasi.path_filestat_get(3, 0, 1000, length, 1100),
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(h.memory.bytes[1116], WASI_FILETYPE.REGULAR_FILE);
  assertEquals(h.memory.u64(1132), 6n);
  assertEquals(
    h.wasi.path_filestat_get(4, 0, 1000, length, 1180),
    WASI_ERRNO.SUCCESS,
    "the /job alias reaches the exact same class-relative workspace path",
  );
  assertEquals(h.memory.bytes[1196], WASI_FILETYPE.REGULAR_FILE);
  assertEquals(h.memory.u64(1212), 6n);
  for (
    const [path, errno] of [
      ["../inputs/in.txt", WASI_ERRNO.EPERM],
      ["inputs/../in.txt", WASI_ERRNO.EPERM],
      ["/inputs/in.txt", WASI_ERRNO.EPERM],
      ["inputs\\in.txt", WASI_ERRNO.EPERM],
      ["inputs//in.txt", WASI_ERRNO.EPERM],
      ["unknown/x", WASI_ERRNO.EPERM],
      ["inputs/x\0y", WASI_ERRNO.EPERM],
    ]
  ) {
    length = h.memory.put(1000, enc.encode(path));
    assertEquals(
      h.wasi.path_filestat_get(3, 0, 1000, length, 1100),
      errno,
      path,
    );
  }
  h.memory.put(1000, new Uint8Array([0xff]));
  assertEquals(
    h.wasi.path_filestat_get(3, 0, 1000, 1, 1100),
    WASI_ERRNO.EINVAL,
  );
  length = putPath(h.memory, 1000, "inputs/in.txt");
  // R3: SYMLINK_FOLLOW is admitted — and over the no-symlink workspace it is
  // byte-identical to the adjacent flags=0 vector above (whose 64 stat bytes
  // still sit at 1100: every vector between faults BEFORE any stat write).
  const flagsZeroBytes = h.memory.bytes.slice(1100, 1164);
  assertEquals(
    h.wasi.path_filestat_get(3, 1, 1000, length, 1200),
    WASI_ERRNO.SUCCESS,
    "R3: flags=SYMLINK_FOLLOW succeeds over the no-symlink workspace",
  );
  assertEquals(
    [...h.memory.bytes.slice(1200, 1264)],
    [...flagsZeroBytes],
    "R3 equivalence: flags=1 produces byte-identical filestat to flags=0",
  );
  assertEquals(
    h.wasi.path_filestat_get(2, 0, 1000, length, 1100),
    WASI_ERRNO.EBADF,
  );
  const hostileError = new Error("adapter failure");
  Object.defineProperty(hostileError, "code", {
    get() {
      throw new Error("error-code getter invoked");
    },
  });
  const hostile = harness({
    workspace: {
      open() {
        throw hostileError;
      },
      readdir() {
        throw hostileError;
      },
      stat() {
        throw hostileError;
      },
    },
  });
  putPath(hostile.memory, 1000, "inputs/in.txt");
  assertEquals(
    hostile.wasi.path_filestat_get(3, 0, 1000, length, 1100),
    WASI_ERRNO.EIO,
  );
});

Deno.test("WASI path_open rights: inputs read-only, scratch rw, output write-only; escalation fails", () => {
  const h = harness();
  const readRights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const writeRights = WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const input = openPath(h, "inputs/in.txt", readRights);
  assertEquals(input.errno, WASI_ERRNO.SUCCESS);
  assertEquals(input.fd, 5);
  const aliasInput = openPath(h, "inputs/in.txt", readRights, {
    openedPtr: 3020,
    preopenFd: 4,
  });
  assertEquals(aliasInput.errno, WASI_ERRNO.SUCCESS, "fd4 alias accepts path_open");
  assertEquals(aliasInput.fd, 6, "dynamic allocation skips both static preopens");
  assertEquals(
    openPath(h, "inputs/in.txt", WASI_RIGHTS.FD_WRITE).errno,
    WASI_ERRNO.ENOTCAPABLE,
  );
  assertEquals(
    openPath(h, "inputs/new.txt", readRights, { oflags: WASI_OFLAGS.CREAT })
      .errno,
    WASI_ERRNO.EACCES,
  );
  const scratch = openPath(
    h,
    "scratch/work.txt",
    readRights | WASI_RIGHTS.FD_WRITE,
    { openedPtr: 3010 },
  );
  assertEquals(scratch.errno, WASI_ERRNO.SUCCESS);
  const output = openPath(h, "output/new.txt", writeRights, {
    oflags: WASI_OFLAGS.CREAT,
    openedPtr: 3020,
  });
  assertEquals(output.errno, WASI_ERRNO.SUCCESS);
  assertEquals(
    openPath(h, "output/existing.txt", WASI_RIGHTS.FD_READ, { openedPtr: 3030 })
      .errno,
    WASI_ERRNO.ENOTCAPABLE,
  );
  assertEquals(
    openPath(h, "scratch/work.txt", WASI_RIGHTS.PATH_OPEN, { openedPtr: 3040 })
      .errno,
    WASI_ERRNO.ENOTCAPABLE,
  );
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, "scratch/work.txt");
  assertEquals(
    h.wasi.path_open(
      3,
      0,
      pathPtr,
      length,
      0,
      readRights,
      WASI_RIGHTS.FD_READ,
      0,
      3050,
    ),
    WASI_ERRNO.ENOTCAPABLE,
  );
  assertEquals(
    h.wasi.path_open(3, 2, pathPtr, length, 0, readRights, 0n, 0, 3050),
    WASI_ERRNO.ENOTSUP,
    "R4 authorized edit: dirflags 1→2 — the vector's intent (an unsupported dirflags bit stays ENOTSUP) is preserved now that SYMLINK_FOLLOW is admitted",
  );
  assertEquals(
    h.wasi.path_open(
      3,
      0,
      pathPtr,
      length,
      WASI_OFLAGS.DIRECTORY,
      readRights,
      0n,
      0,
      3050,
    ),
    WASI_ERRNO.ENOTCAPABLE,
  );
  assertEquals(
    h.wasi.path_open(
      3,
      0,
      pathPtr,
      length,
      WASI_OFLAGS.EXCL,
      readRights,
      0n,
      0,
      3050,
    ),
    WASI_ERRNO.EINVAL,
  );
  assertEquals(
    h.wasi.path_open(
      3,
      0,
      pathPtr,
      length,
      WASI_OFLAGS.TRUNC,
      readRights,
      0n,
      0,
      3050,
    ),
    WASI_ERRNO.ENOTCAPABLE,
  );
});

Deno.test("WASI path_open: an unexpected result-memory failure closes and forgets the unreturned FD", () => {
  const memory = new TestMemory();
  const workspace = new MemoryWorkspace();
  const h = harness({ memory, workspace });
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  memory.failWriteAt = 3000;
  assertEquals(openPath(h, "inputs/in.txt", rights).errno, WASI_ERRNO.EIO);
  assertEquals(workspace.closed, 1);
  assertEquals(h.runtime.snapshot().counters.openDynamicFds, 0);
  memory.failWriteAt = null;
  const retry = openPath(h, "inputs/in.txt", rights);
  assertEquals(retry.errno, WASI_ERRNO.SUCCESS);
  assertEquals(retry.fd, 5);
});

Deno.test("WASI fd_read: stdin/file iovecs are little-endian, partial, EOF-safe and alias/OOB guarded", () => {
  const h = harness({ workspace: new MemoryWorkspace({ partialRead: 2 }) });
  setIovecs(h.memory, 100, [{ pointer: 500, length: 4 }, {
    pointer: 510,
    length: 4,
  }]);
  assertEquals(h.wasi.fd_read(0, 100, 2, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(200), 8);
  assertEquals(h.memory.text(500, 4), "stdi");
  assertEquals(h.memory.text(510, 4), "n-da");
  setIovecs(h.memory, 100, [{ pointer: 500, length: 8 }]);
  assertEquals(h.wasi.fd_read(0, 100, 1, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(200), 2);
  assertEquals(h.memory.text(500, 2), "ta");
  assertEquals(h.wasi.fd_read(0, 100, 1, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(200), 0);

  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const opened = openPath(h, "inputs/in.txt", rights);
  setIovecs(h.memory, 100, [{ pointer: 600, length: 5 }]);
  assertEquals(h.wasi.fd_read(opened.fd, 100, 1, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(200), 2);
  assertEquals(h.memory.text(600, 2), "ab");

  setIovecs(h.memory, 100, [{ pointer: 100, length: 4 }]);
  assertEquals(h.wasi.fd_read(0, 100, 1, 200), WASI_ERRNO.EINVAL);
  setIovecs(h.memory, 100, [{ pointer: 500, length: 8 }, {
    pointer: 504,
    length: 8,
  }]);
  assertEquals(h.wasi.fd_read(0, 100, 2, 200), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.fd_read(0, 0xfffffff0, 2, 200), WASI_ERRNO.EFAULT);
  assertEquals(h.wasi.fd_read(1, 100, 0, 200), WASI_ERRNO.EBADF);
});

Deno.test("WASI fd_write: stdio and files support bounded partial IO; input writes/output reads are denied", () => {
  const h = harness({
    workspace: new MemoryWorkspace({ partialWrite: 2 }),
    job: { quota: { stdoutBytes: 5, stderrBytes: 3, fileBytes: 3 } },
  });
  h.memory.putText(500, "abcdefgh");
  setIovecs(h.memory, 100, [{ pointer: 500, length: 8 }]);
  assertEquals(h.wasi.fd_write(1, 100, 1, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(200), 5);
  assertEquals(dec.decode(h.runtime.snapshot().stdout), "abcde");
  assertEquals(h.wasi.fd_write(1, 100, 1, 200), WASI_ERRNO.EFBIG);
  const afterFullWrite = h.runtime.snapshot();
  assertEquals(dec.decode(afterFullWrite.stdout), "abcde", "EFBIG writes zero additional stdout bytes");
  assertEquals(afterFullWrite.counters.stdoutBytes, 5, "stdout never overshoots its exact quota");
  assertEquals(h.wasi.fd_write(2, 100, 1, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(200), 3);
  assertEquals(dec.decode(h.runtime.snapshot().stderr), "abc");

  const readRights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const writeRights = WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const input = openPath(h, "inputs/in.txt", readRights);
  assertEquals(h.wasi.fd_write(input.fd, 100, 1, 200), WASI_ERRNO.ENOTCAPABLE);
  const output = openPath(h, "output/new.txt", writeRights, {
    oflags: WASI_OFLAGS.CREAT,
    openedPtr: 3010,
  });
  assertEquals(h.wasi.fd_write(output.fd, 100, 1, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(200), 2);
  setIovecs(h.memory, 100, [{ pointer: 700, length: 2 }]);
  assertEquals(h.wasi.fd_read(output.fd, 100, 1, 200), WASI_ERRNO.ENOTCAPABLE);
  setIovecs(h.memory, 100, [{ pointer: 500, length: 4 }, {
    pointer: 502,
    length: 4,
  }]);
  assertEquals(h.wasi.fd_write(1, 100, 2, 200), WASI_ERRNO.EINVAL);
});

Deno.test("WASI seek/tell/filestat/close: BigInt offsets, partial files and lowest-FD reuse are exact", () => {
  const h = harness();
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE |
    WASI_RIGHTS.FD_SEEK | WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const opened = openPath(h, "scratch/work.txt", rights);
  assertEquals(
    h.wasi.fd_seek(opened.fd, 2n, WASI_WHENCE.SET, 100),
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(h.memory.u64(100), 2n);
  assertEquals(h.wasi.fd_tell(opened.fd, 108), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u64(108), 2n);
  assertEquals(
    h.wasi.fd_seek(opened.fd, -1n, WASI_WHENCE.CUR, 116),
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(h.memory.u64(116), 1n);
  assertEquals(
    h.wasi.fd_seek(opened.fd, -1n, WASI_WHENCE.END, 124),
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(h.memory.u64(124), 4n);
  assertEquals(
    h.wasi.fd_seek(opened.fd, -6n, WASI_WHENCE.SET, 124),
    WASI_ERRNO.EINVAL,
  );
  assertEquals(
    h.wasi.fd_seek(
      opened.fd,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      WASI_WHENCE.SET,
      124,
    ),
    WASI_ERRNO.EOVERFLOW,
  );
  assertEquals(h.wasi.fd_filestat_get(opened.fd, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u64(232), 5n);
  assertEquals(h.wasi.fd_close(opened.fd), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(opened.fd), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_close(0), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(3), WASI_ERRNO.EBADF);
  const reused = openPath(h, "scratch/work.txt", rights);
  assertEquals(reused.fd, opened.fd);
  assertEquals(h.wasi.fd_tell(0, 108), WASI_ERRNO.ESPIPE);
  assertEquals(h.wasi.fd_seek(1, 0n, 0, 100), WASI_ERRNO.ESPIPE);
});

Deno.test("WASI random_get: injected entropy is exact and the 64KiB/OOB caps run before filling", () => {
  let fills = 0;
  const h = harness({
    randomFill: (bytes) => {
      fills++;
      bytes.fill(0xa5);
      return bytes;
    },
  });
  assertEquals(h.wasi.random_get(100, 16), WASI_ERRNO.SUCCESS);
  assertEquals([...h.memory.bytes.slice(100, 116)], new Array(16).fill(0xa5));
  assertEquals(fills, 1);
  assertEquals(h.wasi.random_get(100, 65_537), WASI_ERRNO.E2BIG);
  assertEquals(h.wasi.random_get(0xfffffff0, 16), WASI_ERRNO.EFAULT);
  assertEquals(fills, 1);
});

Deno.test("WASI clocks: monotonic id1 is nondecreasing; CLOCK_REALTIME id0 is explicitly ENOTSUP", () => {
  const times = [10n, 5n, 12n];
  const h = harness({ monotonicNowNs: () => times.shift() });
  assertEquals(
    h.wasi.clock_time_get(WASI_CLOCK.REALTIME, 0n, 100),
    WASI_ERRNO.ENOTSUP,
  );
  assertEquals(
    h.wasi.clock_time_get(WASI_CLOCK.MONOTONIC, 0n, 100),
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(h.memory.u64(100), 10n);
  assertEquals(
    h.wasi.clock_time_get(WASI_CLOCK.MONOTONIC, 0n, 108),
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(h.memory.u64(108), 10n);
  assertEquals(
    h.wasi.clock_time_get(WASI_CLOCK.MONOTONIC, 0n, 116),
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(h.memory.u64(116), 12n);
  assertEquals(h.wasi.clock_time_get(9, 0n, 100), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.clock_time_get(1, -1n, 100), WASI_ERRNO.EINVAL);
});

Deno.test("WASI proc_exit is the sole syscall signal; invalid/cancelled calls return errno", () => {
  const h = harness();
  const error = assertThrows(() => h.wasi.proc_exit(7), WasiProcExit);
  assertEquals(error.code, 7);
  assertEquals(error.signal, "wasi-proc-exit");
  assertEquals(h.wasi.proc_exit(0x1_0000_0000), WASI_ERRNO.EINVAL);
  const cancelled = harness({ isCancelled: () => true });
  assertEquals(cancelled.wasi.proc_exit(0), WASI_ERRNO.ECANCELED);
  for (const [name, fn] of Object.entries(h.wasi)) {
    if (name === "proc_exit") continue;
    const result = fn(-1, -1, -1, -1, -1, -1n, -1n, -1, -1);
    assertEquals(
      typeof result,
      "number",
      `${name} returned errno rather than throwing`,
    );
  }
});

Deno.test("WASI quotas/cancellation: every call is fenced; host/path/file/FD quotas fail closed", () => {
  const cancelled = harness({ isCancelled: () => true });
  assertEquals(cancelled.wasi.environ_get(0, 0), WASI_ERRNO.ECANCELED);

  const host = harness({ job: { quota: { hostCalls: 1 } } });
  assertEquals(host.wasi.environ_get(0, 0), WASI_ERRNO.SUCCESS);
  assertEquals(host.wasi.environ_get(0, 0), WASI_ERRNO.E2BIG);

  const path = harness({ job: { quota: { pathCalls: 1 } } });
  const length = putPath(path.memory, 1000, "inputs/in.txt");
  assertEquals(
    path.wasi.path_filestat_get(3, 0, 1000, length, 1100),
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(
    path.wasi.path_filestat_get(3, 0, 1000, length, 1100),
    WASI_ERRNO.E2BIG,
  );

  const fdLimit = harness({ job: { quota: { dynamicFds: 1 } } });
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  assertEquals(
    openPath(fdLimit, "inputs/in.txt", rights).errno,
    WASI_ERRNO.SUCCESS,
  );
  assertEquals(
    openPath(fdLimit, "inputs/in.txt", rights, { openedPtr: 3010 }).errno,
    WASI_ERRNO.ENOSPC,
  );

  const file = harness({ job: { quota: { fileBytes: 1 } } });
  const opened = openPath(file, "inputs/in.txt", rights);
  setIovecs(file.memory, 100, [{ pointer: 500, length: 2 }]);
  assertEquals(file.wasi.fd_read(opened.fd, 100, 1, 200), WASI_ERRNO.SUCCESS);
  assertEquals(file.memory.u32(200), 1);
  assertEquals(file.wasi.fd_read(opened.fd, 100, 1, 200), WASI_ERRNO.EFBIG);

  const size = harness({ job: { quota: { fileBytes: 10, fileSize: 2 } } });
  size.memory.putText(500, "abcd");
  setIovecs(size.memory, 100, [{ pointer: 500, length: 4 }]);
  const writable = WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const output = openPath(size, "output/new.txt", writable, {
    oflags: WASI_OFLAGS.CREAT,
  });
  assertEquals(size.wasi.fd_write(output.fd, 100, 1, 200), WASI_ERRNO.SUCCESS);
  assertEquals(size.memory.u32(200), 2);
  assertEquals(size.wasi.fd_write(output.fd, 100, 1, 200), WASI_ERRNO.EFBIG);
  assertEquals(
    size.wasi.fd_seek(output.fd, 3n, WASI_WHENCE.SET, 300),
    WASI_ERRNO.EFBIG,
  );
});

Deno.test("fd_readdir planner: byte sort, exact dirents, cookies, full-entry buffers and hostile bounds", () => {
  const entries = [
    { name: "z", type: "file" },
    { name: "a", type: "directory" },
  ];
  const full = planFdReaddir(entries, 0n, 50);
  assertEquals(full.errno, WASI_ERRNO.SUCCESS);
  assertEquals(full.bufused, 50);
  assertEquals(decodeDirents(full.packed), [
    { next: 1n, ino: 0n, type: WASI_FILETYPE.DIRECTORY, name: "a" },
    { next: 2n, ino: 0n, type: WASI_FILETYPE.REGULAR_FILE, name: "z" },
  ]);
  assertEquals(planFdReaddir(entries, 0n, 0).bufused, 0);
  assertEquals(planFdReaddir(entries, 0n, 24).bufused, 0, "a name is never truncated");
  assertEquals(
    decodeDirents(planFdReaddir(entries, 0n, 25).packed).map((row) => row.name),
    ["a"],
  );
  assertEquals(
    decodeDirents(planFdReaddir(entries, 1n, 25).packed).map((row) => row.name),
    ["z"],
  );
  assertEquals(planFdReaddir(entries, 2n, 50).bufused, 0, "cookie == count is EOF");
  assertEquals(planFdReaddir(entries, 99n, 50).errno, WASI_ERRNO.SUCCESS);
  assertEquals(planFdReaddir(entries, 99n, 50).bufused, 0, "cookie > count is EOF");
  assertEquals(planFdReaddir([], 0n, 0).bufused, 0);
  const maxName = planFdReaddir([{ name: "x".repeat(255), type: "file" }], 0n, 279);
  assertEquals(maxName.errno, WASI_ERRNO.SUCCESS);
  assertEquals(maxName.bufused, 279);
  for (const hostile of [
    [{ name: "x".repeat(256), type: "file" }],
    [{ name: "..", type: "file" }],
    [{ name: ".", type: "directory" }],
    [{ name: "a/b", type: "file" }],
    [{ name: "a\0b", type: "file" }],
    [{ name: "a", type: "symlink" }],
    [{ name: "a", type: "file", extra: true }],
    Array.from({ length: 4097 }, (_, i) => ({ name: `x${i}`, type: "file" })),
  ]) {
    assertEquals(planFdReaddir(hostile, 0n, 1000).errno, WASI_ERRNO.EIO);
  }
  for (const [cookie, bufLen] of [[-1n, 50], [0n, -1], [0n, 0x1_0000_0000]]) {
    assertEquals(planFdReaddir(entries, cookie, bufLen).errno, WASI_ERRNO.EINVAL);
  }
  assertEquals([...planFdReaddir(entries, 0n, 50).packed], [...full.packed], "deterministic bytes");
  assert(Object.isFrozen(full), "the planner result is immutable");
});

Deno.test("D-minus: exact libc tuple grants only readdir + child-stat authority and reports it honestly", () => {
  assertEquals(WASI_LIBC_OPENDIR_PROFILE, {
    dirflags: WASI_LOOKUPFLAGS.SYMLINK_FOLLOW,
    oflags: WASI_OFLAGS.DIRECTORY,
    requestedBase: 0x200026n,
    requestedInheriting: 0x600066n,
    fdflags: WASI_FDFLAGS.NONBLOCK,
    granted: 0x244026n,
  });
  const h = harness();
  h.workspace.files.set("inputs/nested/deep.txt", { type: "file", bytes: enc.encode("deep") });
  const root = openDir(h, ".", { preopenFd: 4 });
  assertEquals(root, { errno: WASI_ERRNO.SUCCESS, fd: 5 });
  assertEquals(h.wasi.fd_fdstat_get(root.fd, 100), WASI_ERRNO.SUCCESS);
  const view = new DataView(h.memory.bytes.buffer);
  assertEquals(view.getUint8(100), WASI_FILETYPE.DIRECTORY);
  assertEquals(view.getUint16(102, true), WASI_FDFLAGS.NONBLOCK);
  assertEquals(view.getBigUint64(108, true), 0x244026n);
  assertEquals(view.getBigUint64(116, true), 0x244026n);
  const forbidden = WASI_RIGHTS.PATH_OPEN | WASI_RIGHTS.FD_WRITE |
    WASI_RIGHTS.FD_FILESTAT_SET_SIZE | WASI_RIGHTS.PATH_FILESTAT_SET_SIZE |
    WASI_RIGHTS.FD_FDSTAT_SET_FLAGS | WASI_RIGHTS.PATH_CREATE_FILE |
    WASI_RIGHTS.PATH_CREATE_DIRECTORY;
  assertEquals(view.getBigUint64(108, true) & forbidden, 0n);
  assertEquals(view.getBigUint64(116, true) & forbidden, 0n);
  assertEquals(h.wasi.fd_fdstat_set_flags(root.fd, WASI_FDFLAGS.NONBLOCK), WASI_ERRNO.ENOTCAPABLE);

  assertEquals(h.wasi.fd_readdir(root.fd, 400, 1000, 0n, 300), WASI_ERRNO.SUCCESS);
  assertEquals(
    decodeDirents(h.memory.bytes.slice(400, 400 + h.memory.u32(300))).map((row) => [row.name, row.type]),
    [
      ["inputs", WASI_FILETYPE.DIRECTORY],
      ["output", WASI_FILETYPE.DIRECTORY],
      ["scratch", WASI_FILETYPE.DIRECTORY],
    ],
  );

  const childNameLength = putPath(h.memory, 2000, "inputs");
  assertEquals(h.wasi.path_filestat_get(root.fd, 0, 2000, childNameLength, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[216], WASI_FILETYPE.DIRECTORY);
  const child = openDir(h, "inputs", { preopenFd: 4, openedPtr: 3010 });
  assertEquals(child.errno, WASI_ERRNO.SUCCESS, "child opens return to preopen fd4");
  assertEquals(h.wasi.fd_readdir(child.fd, 1400, 1000, 0n, 1300), WASI_ERRNO.SUCCESS);
  assertEquals(
    decodeDirents(h.memory.bytes.slice(1400, 1400 + h.memory.u32(1300))).map((row) => [row.name, row.type]),
    [
      ["in.txt", WASI_FILETYPE.REGULAR_FILE],
      ["nested", WASI_FILETYPE.DIRECTORY],
    ],
  );
  const fileLength = putPath(h.memory, 2100, "in.txt");
  assertEquals(h.wasi.path_filestat_get(child.fd, 0, 2100, fileLength, 300), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[316], WASI_FILETYPE.REGULAR_FILE);
  const nestedLength = putPath(h.memory, 2200, "nested");
  assertEquals(h.wasi.path_filestat_get(child.fd, 0, 2200, nestedLength, 400), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[416], WASI_FILETYPE.DIRECTORY);
  const nested = openDir(h, "inputs/nested", { preopenFd: 4, openedPtr: 3020 });
  assertEquals(nested.errno, WASI_ERRNO.SUCCESS, "nested child also opens from preopen fd4");
  assertEquals(h.wasi.fd_readdir(nested.fd, 1800, 100, 0n, 1700), WASI_ERRNO.SUCCESS);
  assertEquals(decodeDirents(h.memory.bytes.slice(1800, 1800 + h.memory.u32(1700))).map((row) => row.name), ["deep.txt"]);

  const dotLength = putPath(h.memory, 2000, ".");
  assertEquals(h.wasi.path_filestat_get(child.fd, 0, 2000, dotLength, 500), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[516], WASI_FILETYPE.DIRECTORY);
  assertEquals(openDir(h, ".", { preopenFd: child.fd, openedPtr: 3030 }).errno, WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_read(child.fd, 0, 0, 0), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_write(child.fd, 0, 0, 0), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_seek(child.fd, 0n, WASI_WHENCE.SET, 0), WASI_ERRNO.ESPIPE);
  assertEquals(h.wasi.fd_tell(child.fd, 0), WASI_ERRNO.ESPIPE);

  assertEquals(h.wasi.fd_close(nested.fd), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(child.fd), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(child.fd), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_close(root.fd), WASI_ERRNO.SUCCESS);
  assertEquals(h.runtime.snapshot().counters.openDynamicFds, 0);
});

Deno.test("D-minus: exact tuple mutant lattice, fd-kind matrix, alias parity and rights-first memory order", () => {
  const mutations = [
    { dirflags: 0 },
    { dirflags: 2 },
    { oflags: WASI_OFLAGS.DIRECTORY | WASI_OFLAGS.CREAT },
    { oflags: WASI_OFLAGS.DIRECTORY | WASI_OFLAGS.EXCL },
    { oflags: WASI_OFLAGS.DIRECTORY | WASI_OFLAGS.TRUNC },
    { rightsBase: WASI_LIBC_OPENDIR_PROFILE.requestedBase - WASI_RIGHTS.FD_READ },
    { rightsBase: WASI_LIBC_OPENDIR_PROFILE.requestedBase | WASI_RIGHTS.FD_READDIR },
    { rightsBase: WASI_LIBC_OPENDIR_PROFILE.requestedBase | WASI_RIGHTS.FD_WRITE },
    { rightsInheriting: WASI_LIBC_OPENDIR_PROFILE.requestedInheriting - WASI_RIGHTS.FD_WRITE },
    { rightsInheriting: WASI_LIBC_OPENDIR_PROFILE.requestedInheriting | WASI_RIGHTS.FD_READDIR },
    { fdflags: 0 },
    { fdflags: WASI_FDFLAGS.NONBLOCK | WASI_FDFLAGS.APPEND },
  ];
  for (const [index, mutation] of mutations.entries()) {
    assertEquals(openDir(harness(), ".", mutation).errno, WASI_ERRNO.ENOTCAPABLE, `tuple mutation ${index}`);
  }
  assertEquals(openDir(harness(), ".", { oflags: 0 }).errno, WASI_ERRNO.ENOTSUP, "without DIRECTORY the unchanged file branch rejects dirflags");
  assertEquals(openDir(harness(), ".", { oflags: 0x10 }).errno, WASI_ERRNO.EINVAL, "unknown oflags are rejected first");

  const h = harness();
  const dir = openDir(h, "inputs", { preopenFd: 4 });
  assertEquals(dir.errno, WASI_ERRNO.SUCCESS);
  const readRights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const fileFd = openPath(h, "inputs/in.txt", readRights, { preopenFd: 4, openedPtr: 3040 }).fd;

  assertEquals(h.wasi.fd_filestat_get(dir.fd, 100), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[116], WASI_FILETYPE.DIRECTORY);
  assertEquals(h.wasi.fd_readdir(dir.fd, 400, 100, 0n, 300), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_readdir(fileFd, 0xfffffff0, 32, 0n, 0xfffffff0), WASI_ERRNO.ENOTCAPABLE);
  assertEquals(h.wasi.fd_readdir(0, 0xfffffff0, 32, 0n, 0xfffffff0), WASI_ERRNO.ENOTCAPABLE);
  assertEquals(h.wasi.fd_readdir(999, 0xfffffff0, 32, 0n, 0xfffffff0), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_readdir(3, 0xfffffff0, 32, 0n, 0xfffffff0), WASI_ERRNO.EFAULT);
  assertEquals(h.wasi.fd_readdir(3, 400, 20, 0n, 410), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.fd_prestat_get(dir.fd, 100), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_prestat_dir_name(dir.fd, 100, 1), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_fdstat_set_flags(dir.fd, WASI_FDFLAGS.NONBLOCK), WASI_ERRNO.ENOTCAPABLE);
  assertEquals(h.wasi.fd_read(dir.fd, 0, 0, 0), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_write(dir.fd, 0, 0, 0), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_seek(dir.fd, 0n, WASI_WHENCE.SET, 0), WASI_ERRNO.ESPIPE);
  assertEquals(h.wasi.fd_tell(dir.fd, 0), WASI_ERRNO.ESPIPE);

  const exactLength = putPath(h.memory, 2000, ".");
  assertEquals(
    h.wasi.path_open(
      dir.fd,
      WASI_LIBC_OPENDIR_PROFILE.dirflags,
      2000,
      exactLength,
      WASI_LIBC_OPENDIR_PROFILE.oflags,
      WASI_LIBC_OPENDIR_PROFILE.requestedBase,
      WASI_LIBC_OPENDIR_PROFILE.requestedInheriting,
      WASI_LIBC_OPENDIR_PROFILE.fdflags,
      3050,
    ),
    WASI_ERRNO.EBADF,
    "DIR-base path_open is permanently forbidden even for the exact tuple",
  );
  assertEquals(openDir(h, ".", { preopenFd: dir.fd, dirflags: 0, openedPtr: 3060 }).errno, WASI_ERRNO.EBADF);
  assertEquals(h.wasi.path_filestat_get(fileFd, 0, 2000, exactLength, 500), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.path_filestat_get(2, 0, 0xfffffff0, 4, 0xfffffff0), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.path_filestat_get(999, 1, 0xfffffff0, 4, 0xfffffff0), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.path_filestat_get(dir.fd, 1, 0xfffffff0, 4, 0xfffffff0), WASI_ERRNO.EFAULT, "R3: the flag plan admits flags=1 FIRST, then the poisoned path read faults (flag-plan precedes memory)");
  assertEquals(h.wasi.path_filestat_get(dir.fd, 0, 0xfffffff0, 4, 0xfffffff0), WASI_ERRNO.EFAULT);

  assertEquals(h.wasi.fd_readdir(3, 800, 100, 0n, 700), WASI_ERRNO.SUCCESS);
  const a = h.memory.bytes.slice(800, 800 + h.memory.u32(700));
  assertEquals(h.wasi.fd_readdir(4, 1200, 100, 0n, 1100), WASI_ERRNO.SUCCESS);
  const b = h.memory.bytes.slice(1200, 1200 + h.memory.u32(1100));
  assertEquals([...a], [...b], "fd3 and fd4 enumerate identical root bytes");
  assertEquals(h.wasi.fd_readdir(4, 1600, 100, 3n, 1500), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(1500), 0, "cookie == count is EOF");
  assertEquals(h.wasi.fd_readdir(4, 1600, 100, 999n, 1500), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(1500), 0, "cookie > count is EOF");
  assertEquals(h.wasi.fd_readdir(4, 1600, 0, 0n, 1500), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(1500), 0, "zero buffer is valid");

  assertEquals(h.wasi.fd_close(fileFd), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(dir.fd), WASI_ERRNO.SUCCESS);
  assertEquals(h.runtime.snapshot().counters.openDynamicFds, 0);
});

Deno.test("D-minus: DIR-base path_filestat_get joins only inside the immutable bound subtree", () => {
  const h = harness();
  h.workspace.files.set("inputs/sub/deep.txt", { type: "file", bytes: enc.encode("x") });
  const dir = openDir(h, "inputs", { preopenFd: 4 });
  assertEquals(dir.errno, WASI_ERRNO.SUCCESS);
  let pointer = 2000;
  const stat = (bytes, flags = 0, statPtr = 100) => {
    const input = typeof bytes === "string" ? enc.encode(bytes) : bytes;
    h.memory.put(pointer, input);
    const errno = h.wasi.path_filestat_get(dir.fd, flags, pointer, input.byteLength, statPtr);
    pointer += input.byteLength + 8;
    return errno;
  };
  assertEquals(stat("."), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[116], WASI_FILETYPE.DIRECTORY);
  assertEquals(stat("in.txt", 0, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[216], WASI_FILETYPE.REGULAR_FILE);
  assertEquals(stat("sub", 0, 300), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[316], WASI_FILETYPE.DIRECTORY);
  assertEquals(stat("sub/deep.txt", 0, 400), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[416], WASI_FILETYPE.REGULAR_FILE);
  assertEquals(stat("missing"), WASI_ERRNO.ENOENT);
  assertEquals(stat("output/existing.txt"), WASI_ERRNO.ENOENT, "a different class name is still joined below inputs");

  const hostiles = [
    ["", WASI_ERRNO.ENAMETOOLONG],
    ["../escape", WASI_ERRNO.EPERM],
    ["/inputs", WASI_ERRNO.EPERM],
    ["sub/../escape", WASI_ERRNO.EPERM],
    ["sub/./x", WASI_ERRNO.EPERM],
    ["sub//x", WASI_ERRNO.EPERM],
    ["sub/", WASI_ERRNO.EPERM],
    ["sub\\x", WASI_ERRNO.EPERM],
    ["sub/\0x", WASI_ERRNO.EPERM],
    ["sub/\u0001x", WASI_ERRNO.EINVAL],
    ["sub/\u007fx", WASI_ERRNO.EINVAL],
    ["x".repeat(256), WASI_ERRNO.ENAMETOOLONG],
  ];
  for (const [path, errno] of hostiles) assertEquals(stat(path), errno, JSON.stringify(path));
  assertEquals(stat(new Uint8Array([0xff])), WASI_ERRNO.EINVAL, "invalid UTF-8 fails closed");
  const valid = enc.encode("in.txt");
  h.memory.put(5000, valid);
  assertEquals(h.wasi.path_filestat_get(dir.fd, 0, 5000, valid.byteLength, 0xfffffff0), WASI_ERRNO.EFAULT);
  assertEquals(h.wasi.fd_close(dir.fd), WASI_ERRNO.SUCCESS);
  assertEquals(h.runtime.snapshot().counters.openDynamicFds, 0);
});

Deno.test("WASI source boundary: only two new pure modules exist and no product route/execution primitive reaches them", async () => {
  const types = await Deno.readTextFile(
    new URL("../extension/lib/wasm-host-types.js", import.meta.url),
  );
  const runtime = await Deno.readTextFile(
    new URL("../extension/lib/wasi-preview1-runtime.js", import.meta.url),
  );
  for (const source of [types, runtime]) {
    for (
      const forbidden of [
        "WebAssembly.instantiate",
        "WebAssembly.compile",
        "new Worker",
        "chrome.",
        "fetch(",
        "navigator.storage",
        "FileSystem",
        "createAsset",
        "OpfsToolWorkspace",
      ]
    ) {
      assert(
        !source.includes(forbidden),
        `forbidden Gate 1 surface: ${forbidden}`,
      );
    }
  }
  const productFiles = [
    "../extension/background/service-worker.js",
    "../extension/lib/provider.js",
    "../extension/lib/agent.js",
    "../extension/lib/lazy-tool-protocol.js",
    "../extension/lib/wasm-package-authority.js",
  ];
  for (const rel of productFiles) {
    const source = await Deno.readTextFile(new URL(rel, import.meta.url));
    assert(
      !source.includes("wasi-preview1-runtime") &&
        !source.includes("wasm-host-types"),
      `${rel} remains unbound`,
    );
  }
  // R11: the first22 stay byte-for-byte; the six append in the exact order.
  assertEquals(
    SUPPORTED_WASI_PREVIEW1_IMPORTS.slice(0, 22),
    ["args_get", "args_sizes_get", "clock_time_get", "environ_get", "environ_sizes_get", "fd_close", "fd_fdstat_get", "fd_fdstat_set_flags", "fd_filestat_get", "fd_filestat_set_size", "fd_prestat_dir_name", "fd_prestat_get", "fd_read", "fd_readdir", "fd_seek", "fd_tell", "fd_write", "path_filestat_get", "path_filestat_set_times", "path_open", "proc_exit", "random_get"],
  );
  assertEquals(
    SUPPORTED_WASI_PREVIEW1_IMPORTS.slice(22),
    ["fd_sync", "path_create_directory", "path_remove_directory", "path_unlink_file", "path_readlink", "poll_oneoff"],
  );
  assert(Object.isFrozen(SUPPORTED_WASI_PREVIEW1_IMPORTS));
  assert(Object.isFrozen(REBUILT_WASI_IMPORTS));
});

// ──────────────────────────────────────────────────────────────────────────
// S1 rollback hygiene: the recycleDynamicFd helper + the FILE/DIRECTORY
// cleanup refactor (no accepted-syscall-matrix change).
// ──────────────────────────────────────────────────────────────────────────
Deno.test("S1 rollback: a FILE open failure (missing path, no create) closes nothing and reuses the same fd", () => {
  const workspace = new MemoryWorkspace();
  const h = harness({ workspace });
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE;
  const first = openPath(h, "scratch/work.txt", rights);
  assertEquals(first.errno, WASI_ERRNO.SUCCESS);
  const firstFd = first.fd;
  assertEquals(h.wasi.fd_close(firstFd), WASI_ERRNO.SUCCESS);
  // a missing-path open (no create) allocates an fd, then the workspace open
  // fails -> the FILE catch recycles the fd -> the errno 44 is returned.
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, "scratch/missing.txt");
  const miss = h.wasi.path_open(3, 0, pathPtr, length, 0, rights, 0n, 0, 3000);
  assertEquals(miss, WASI_ERRNO.ENOENT, "the missing open returns ENOENT");
  assertEquals(workspace.closed, 1, "only the first close happened; no handle was acquired for the failed open");
  // the next VALID open reuses the exact same fd number.
  const second = openPath(h, "scratch/work.txt", rights);
  assertEquals(second.errno, WASI_ERRNO.SUCCESS);
  assertEquals(second.fd, firstFd, "the failed open's fd is immediately reusable");
  assertEquals(h.wasi.fd_close(second.fd), WASI_ERRNO.SUCCESS);
  assertEquals(workspace.closed, 2);
});

Deno.test("S1 rollback: an OOB opened-fd pointer returns EFAULT with no fd/free-list drift", () => {
  const workspace = new MemoryWorkspace();
  const h = harness({ workspace });
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE;
  const first = openPath(h, "scratch/work.txt", rights);
  assertEquals(first.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(first.fd), WASI_ERRNO.SUCCESS);
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, "scratch/work.txt");
  const errno = h.wasi.path_open(3, 0, pathPtr, length, 0, rights, 0n, 0, 100000);
  assertEquals(errno, WASI_ERRNO.EFAULT, "the OOB opened-fd span faults before any allocation");
  assertEquals(workspace.closed, 1, "no handle was ever acquired");
  // the free list is intact: the next open reuses the first fd.
  const second = openPath(h, "scratch/work.txt", rights);
  assertEquals(second.fd, first.fd, "no drift after the faulted open");
  assertEquals(h.wasi.fd_close(second.fd), WASI_ERRNO.SUCCESS);
});

Deno.test("S1 rollback: the DIRECTORY branch keeps identical reuse on an OOB word write", () => {
  const workspace = new MemoryWorkspace();
  const h = harness({ workspace });
  const ok = openDir(h, "scratch");
  assertEquals(ok.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(ok.fd), WASI_ERRNO.SUCCESS);
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, "scratch");
  const profile = {
    dirflags: WASI_LIBC_OPENDIR_PROFILE.dirflags,
    oflags: WASI_LIBC_OPENDIR_PROFILE.oflags,
    rightsBase: WASI_LIBC_OPENDIR_PROFILE.requestedBase,
    rightsInheriting: WASI_LIBC_OPENDIR_PROFILE.requestedInheriting,
    fdflags: WASI_LIBC_OPENDIR_PROFILE.fdflags,
    preopenFd: 4,
  };
  const errno = h.wasi.path_open(
    profile.preopenFd, profile.dirflags, pathPtr, length,
    profile.oflags, profile.rightsBase, profile.rightsInheriting,
    profile.fdflags, 100000,
  );
  assertEquals(errno, WASI_ERRNO.EFAULT, "the DIRECTORY OOB span faults");
  const again = openDir(h, "scratch");
  assertEquals(again.errno, WASI_ERRNO.SUCCESS);
  assertEquals(again.fd, ok.fd, "the directory fd is reused after the fault");
  assertEquals(h.wasi.fd_close(again.fd), WASI_ERRNO.SUCCESS);
});

Deno.test("S1 rollback: a double fd_close stays EBADF and the counters on a failed open are +1 host/+1 path", () => {
  const workspace = new MemoryWorkspace();
  const h = harness({ workspace });
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE;
  const first = openPath(h, "scratch/work.txt", rights);
  assertEquals(first.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(first.fd), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(first.fd), WASI_ERRNO.EBADF, "double close stays EBADF");
  // a failed open counts +1 host +1 path with zero file bytes and baseline fds
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, "scratch/missing.txt");
  assertEquals(h.wasi.path_open(3, 0, pathPtr, length, 0, rights, 0n, 0, 3000), WASI_ERRNO.ENOENT);
  const counters = h.runtime.snapshot().counters;
  assert(counters.pathCalls >= 2, "pathCalls incremented");
  assert(counters.hostCalls >= 2, "hostCalls incremented");
  assertEquals(counters.fileBytes, 0, "no file bytes on the failed open");
});

// ──────────────────────────────────────────────────────────────────────────
// S1 reachability reconciliation: the runtime NEVER calls createScratchFile
// directly; the intended internal missing-scratch create is reached ONLY via
// the workspace.open() path that path_open drives (createScratchFile is the
// workspace-internal machinery). This KAT proves the exact reachability: a
// runtime path_open(CREAT) on a scratch path creates the file in the REAL
// workspace through the generic open.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("S1 reachability: the runtime's path_open(CREAT) on a scratch path creates the file via the workspace.open internal path", () => {
  const workspace = new MemoryWorkspace();
  const h = harness({ workspace });
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE;
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, "scratch/gen.bin");
  const errno = h.wasi.path_open(3, 0, pathPtr, length, WASI_OFLAGS.CREAT, rights, 0n, 0, 3000);
  assertEquals(errno, WASI_ERRNO.SUCCESS, "the generic FILE open with CREAT succeeds on the scratch path");
  const fd = h.memory.u32(3000);
  // the file exists in the REAL workspace + a write round-trips
  const stat = workspace.stat("scratch/gen.bin");
  assertEquals(stat.type, "file");
  setIovecs(h.memory, 4000, [{ pointer: 5000, length: 2 }]);
  h.memory.put(5000, new Uint8Array([0x61, 0x62])); // "ab"
  assertEquals(h.wasi.fd_write(fd, 4000, 1, 4100), WASI_ERRNO.SUCCESS);
  assertEquals(workspace.stat("scratch/gen.bin").size, 2, "the write reached the real workspace");
  assertEquals(h.wasi.fd_close(fd), WASI_ERRNO.SUCCESS);
});

Deno.test("S1 rollback: three consecutive failed opens each recycle their selected fd exactly once (no free-list drift)", () => {
  const workspace = new MemoryWorkspace();
  const h = harness({ workspace });
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE;
  // three failed opens (missing path, no create) — each selects an fd that is
  // recycled exactly once; a subsequent valid open + two more failures must
  // keep the fd numbers stable (no hole-scan masking).
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, "scratch/missing.txt");
  const first = openPath(h, "scratch/work.txt", rights);
  assertEquals(first.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(first.fd), WASI_ERRNO.SUCCESS);
  for (let i = 0; i < 3; i++) {
    assertEquals(h.wasi.path_open(3, 0, pathPtr, length, 0, rights, 0n, 0, 3000), WASI_ERRNO.ENOENT);
  }
  const again = openPath(h, "scratch/work.txt", rights);
  assertEquals(again.errno, WASI_ERRNO.SUCCESS);
  assertEquals(again.fd, first.fd, "the free list stays lowest-consumed across the repeated failures");
  assertEquals(h.wasi.fd_close(again.fd), WASI_ERRNO.SUCCESS);
});

// ──────────────────────────────────────────────────────────────────────────
// R3 (CAP-FB-20260823-R3-LOOKUP-FOLLOW-01): path_filestat_get lookup flags
// {0, SYMLINK_FOLLOW}. The planner KAT, the asU32 errno pinning, the
// precedence mutants, and the no-symlink equivalence matrix (incl. the
// post-S2 explicit-directory rows). Additive — no existing vector beyond the
// two checklist-authorized edits is touched.

Deno.test("R3 planner: {0,1} admitted, every other u32 value ENOTSUP", () => {
  assertEquals(planPathFilestatLookup(0), WASI_ERRNO.SUCCESS);
  assertEquals(planPathFilestatLookup(1), WASI_ERRNO.SUCCESS, "SYMLINK_FOLLOW");
  for (const flags of [2, 3, 0x7fffffff, 0x80000000, 0xffffffff]) {
    assertEquals(planPathFilestatLookup(flags), WASI_ERRNO.ENOTSUP, `flags ${flags.toString(16)}`);
  }
});

Deno.test("R3 asU32 errno semantics: in-range negatives wrap to ENOTSUP, only out-of-range/non-integer EINVAL", () => {
  const h = harness();
  const length = putPath(h.memory, 1000, "inputs/in.txt");
  // -1 wraps via >>>0 to 0xffffffff → planner → ENOTSUP (NOT EINVAL)
  assertEquals(h.wasi.path_filestat_get(3, -1, 1000, length, 1100), WASI_ERRNO.ENOTSUP);
  // -0x80000000 wraps to 0x80000000 → ENOTSUP
  assertEquals(h.wasi.path_filestat_get(3, -0x80000000, 1000, length, 1100), WASI_ERRNO.ENOTSUP);
  // out-of-range negatives and >u32 fault EINVAL at asU32 (before the planner)
  assertEquals(h.wasi.path_filestat_get(3, -0x80000001, 1000, length, 1100), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.path_filestat_get(3, 0x100000000, 1000, length, 1100), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.path_filestat_get(3, 1.5, 1000, length, 1100), WASI_ERRNO.EINVAL, "non-integer");
});

Deno.test("R3 precedence: EBADF/ENOTCAPABLE precede the flag plan; the flag plan precedes guest memory", () => {
  const h = harness();
  const dir = openDir(h, "inputs");
  assertEquals(dir.errno, WASI_ERRNO.SUCCESS);
  const length = putPath(h.memory, 1000, "in.txt");
  // unknown fd + flags2 + poisoned ptrs → EBADF wins before everything
  assertEquals(h.wasi.path_filestat_get(999, 2, 0xfffffff0, 4, 0xfffffff0), WASI_ERRNO.EBADF);
  // stdio fd + flags1 → EBADF (kind gate before the flag plan)
  assertEquals(h.wasi.path_filestat_get(2, 1, 1000, length, 1100), WASI_ERRNO.EBADF);
  // a FILE fd + flags1 → EBADF (kind gate: PREOPEN/DIR only)
  const file = openPath(h, "inputs/in.txt", 0x200026n);
  assertEquals(file.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.path_filestat_get(file.fd, 1, 1000, length, 1100), WASI_ERRNO.EBADF);
  // DIR revoked-right + flags1 → ENOTCAPABLE before the flag plan
  const statSpyBefore = h.workspace.stats.length;
  // NOTE (checklist §6 "DIR revoked-right → ENOTCAPABLE"): a rights-revoked
  // PREOPEN/DIR record is NOT publicly constructible — preopen rootRights
  // hard-code PATH_FILESTAT_GET and every DIRECTORY open grants the opendir
  // profile (which includes the bit). The ENOTCAPABLE arm is therefore
  // defensive-only; the precedence it guards (rights BEFORE the flag plan) is
  // pinned by the source-order assertion in the boundary test below, and the
  // kind-gate precedence (EBADF before flags) is executable above.
  // valid base + flags2 → ENOTSUP (the planner after rights)
  assertEquals(h.wasi.path_filestat_get(3, 2, 1000, length, 1100), WASI_ERRNO.ENOTSUP);
  // valid base + flags1 + bad path ptr → EFAULT (plan precedes the path read)
  assertEquals(h.wasi.path_filestat_get(3, 1, 0xfffffff0, 4, 1100), WASI_ERRNO.EFAULT);
  assertEquals(h.workspace.stats.length, statSpyBefore, "no workspace.stat on faulted calls");
  // valid base + flags1 + VALID path + bad stat ptr → EFAULT before the
  // adapter (an invalid path would EPERM first — grammar precedes the stat
  // span by design, so this mutant MUST use a valid path)
  const validLength = putPath(h.memory, 1000, "inputs/in.txt");
  assertEquals(h.wasi.path_filestat_get(3, 1, 1000, validLength, 0xfffffff0), WASI_ERRNO.EFAULT);
  assertEquals(h.workspace.stats.length, statSpyBefore, "the stat span precedes the adapter call");
  // missing → ENOENT (for BOTH flags)
  const missing = putPath(h.memory, 1000, "inputs/missing.txt");
  assertEquals(h.wasi.path_filestat_get(3, 0, 1000, missing, 1100), WASI_ERRNO.ENOENT);
  assertEquals(h.wasi.path_filestat_get(3, 1, 1000, missing, 1100), WASI_ERRNO.ENOENT);
});

Deno.test("R3 equivalence matrix: flags0 ≡ flags1 across PREOPEN/DIR bases and every stat class", () => {
  const h = harness();
  // an explicit directory with NO descendants (the genuinely new S2 shape:
  // directory, size 0, exists — an implicit dir requires a descendant)
  h.workspace.dirs.add("scratch/emptydir");
  h.workspace.dirs.add("scratch/emptydir/nested");

  const rows = [
    ["inputs/in.txt", "file"],
    ["inputs", "implicit dir"],
    [".", "root"],
    ["inputs/missing.txt", "missing"],
    ["scratch/emptydir", "explicit empty dir"],
    ["scratch/emptydir/nested", "explicit nested empty dir"],
  ];
  const dir = openDir(h, "inputs");
  assertEquals(dir.errno, WASI_ERRNO.SUCCESS);

  for (const [path, label] of rows) {
    for (const baseFd of [3, 4]) {
      const length = putPath(h.memory, 1000, path);
      const before = h.runtime.snapshot().counters;
      const statCallsBefore = h.workspace.stats.length;
      const errno0 = h.wasi.path_filestat_get(baseFd, 0, 1000, length, 1100);
      const bytes0 = h.memory.bytes.slice(1100, 1164);
      const statsAfter0 = h.workspace.stats.slice(statCallsBefore);
      const errno1 = h.wasi.path_filestat_get(baseFd, 1, 1000, length, 1200);
      const bytes1 = h.memory.bytes.slice(1200, 1264);
      const statsAfter1 = h.workspace.stats.slice(statCallsBefore + statsAfter0.length);
      assertEquals(errno1, errno0, `${label} fd${baseFd}: errno flags0 ≡ flags1`);
      if (errno0 === WASI_ERRNO.SUCCESS) {
        assertEquals([...bytes1], [...bytes0], `${label} fd${baseFd}: exact 64 stat bytes identical`);
        assertEquals(statsAfter0, [path], `${label} fd${baseFd}: ONE stat call, the exact resolved path`);
        assertEquals(statsAfter1, [path], `${label} fd${baseFd}: identical stat argument for flags1`);
      } else {
        assertEquals(statsAfter0.length, statsAfter1.length, `${label} fd${baseFd}: same stat-call count on failure`);
      }
      const after = h.runtime.snapshot().counters;
      assertEquals(after.hostCalls - before.hostCalls, 2, `${label} fd${baseFd}: +1 hostCalls per admitted call`);
      assertEquals(after.pathCalls - before.pathCalls, 2, `${label} fd${baseFd}: +1 pathCalls per admitted call`);
      assertEquals(after.fileBytes - before.fileBytes, 0, `${label} fd${baseFd}: fileBytes unchanged`);
      assertEquals(after.stdoutBytes - before.stdoutBytes, 0, `${label} fd${baseFd}: stdoutBytes unchanged`);
      assertEquals(after.stderrBytes - before.stderrBytes, 0, `${label} fd${baseFd}: stderrBytes unchanged`);
    }
  }
  // DIR base equivalence (the DIR fd opened above, path relative to its dir)
  const length = putPath(h.memory, 1000, "in.txt");
  const errno0 = h.wasi.path_filestat_get(dir.fd, 0, 1000, length, 1100);
  const errno1 = h.wasi.path_filestat_get(dir.fd, 1, 1000, length, 1200);
  assertEquals(errno0, WASI_ERRNO.SUCCESS);
  assertEquals(errno1, WASI_ERRNO.SUCCESS, "DIR base admits flags=1");
  assertEquals(
    [...h.memory.bytes.slice(1200, 1264)],
    [...h.memory.bytes.slice(1100, 1164)],
    "DIR base: flags0 ≡ flags1 byte-identical",
  );
});

Deno.test("R3 source boundary: the planner is referenced ONLY by the syscall (no provider/page/permission/route import)", async () => {
  const source = await Deno.readTextFile(new URL("../extension/lib/wasi-preview1-runtime.js", import.meta.url));
  const references = source.split("planPathFilestatLookup").length - 1;
  // The definition + the R3 syscall call site + the R6 planner's flags gate.
  assertEquals(references, 3, "planner referenced at its definition + the R3 syscall + the R6 planner flags gate");
  // the rights gate PRECEDES the flag normalisation in the syscall body (the
  // precedence the unreachable ENOTCAPABLE arm guards)
  const bodyStart = source.indexOf("path_filestat_get: (fdValue");
  const body = source.slice(bodyStart, bodyStart + 1200);
  const rightsIdx = body.indexOf("requireRight(base, WASI_RIGHTS.PATH_FILESTAT_GET)");
  const flagsIdx = body.indexOf("asU32(flagsValue)");
  const planIdx = body.indexOf("planPathFilestatLookup(flags)");
  const pathIdx = body.indexOf("resolveDirBasePath(base, pathPtr, pathLength)");
  assert(rightsIdx > 0 && flagsIdx > rightsIdx && planIdx > flagsIdx && pathIdx > planIdx,
    "order: requireRight → asU32 → planner → path/memory (byte-preserved)");
  for (const other of ["extension/background/service-worker.js", "extension/lib/provider.js", "extension/lib/capabilities.js"]) {
    const text = await Deno.readTextFile(new URL(`../${other}`, import.meta.url)).catch(() => "");
    assertEquals(text.includes("planPathFilestatLookup"), false, `${other} must not import the planner`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// R4 (CAP-FB-20260823-R4-FILE-FOLLOW-01): FILE-branch path_open dirflags
// {0, SYMLINK_FOLLOW}. Planner KAT, asU32 pinning, precedence mutants, the
// no-symlink open-equivalence matrix, and the P-1 source pin. Additive only.

Deno.test("R4 planner: {0,1} admitted, every other u32 value ENOTSUP (the P-1 two-value form)", () => {
  assertEquals(planFileOpenDirflags(0), WASI_ERRNO.SUCCESS);
  assertEquals(planFileOpenDirflags(1), WASI_ERRNO.SUCCESS, "SYMLINK_FOLLOW");
  for (const dirflags of [2, 3, 0x7fffffff, 0xffffffff]) {
    assertEquals(planFileOpenDirflags(dirflags), WASI_ERRNO.ENOTSUP, `dirflags ${dirflags.toString(16)}`);
  }
});

Deno.test("R4 asU32 pinning: non-integer/negative-out-of-range/>u32 EINVAL at the syscall", () => {
  const h = harness();
  const rights = WASI_RIGHTS.FD_READ;
  const length = putPath(h.memory, 2000, "inputs/in.txt");
  assertEquals(h.wasi.path_open(3, -1, 2000, length, 0, rights, 0n, 0, 3000), WASI_ERRNO.ENOTSUP, "-1 wraps to 0xffffffff → planner → ENOTSUP");
  assertEquals(h.wasi.path_open(3, -0x80000001, 2000, length, 0, rights, 0n, 0, 3000), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.path_open(3, 0x100000000, 2000, length, 0, rights, 0n, 0, 3000), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.path_open(3, 1.5, 2000, length, 0, rights, 0n, 0, 3000), WASI_ERRNO.EINVAL, "non-integer");
});

Deno.test("R4 dirflags at the syscall: 0/1 open identically; 2 stays ENOTSUP; precedence holds", () => {
  const h = harness();
  const rights = WASI_RIGHTS.FD_READ;
  const length = putPath(h.memory, 2000, "inputs/in.txt");
  // the P-1 executable mutant: dirflags=2 must NOT be silently accepted
  assertEquals(h.wasi.path_open(3, 2, 2000, length, 0, rights, 0n, 0, 3000), WASI_ERRNO.ENOTSUP, "dirflags=2 stays ENOTSUP");
  // precedence: unknown fd + dirflags2 + poisoned ptrs → EBADF first
  assertEquals(h.wasi.path_open(999, 2, 0xfffffff0, 4, 0, rights, 0n, 0, 0xfffffff0), WASI_ERRNO.EBADF);
  // stdio base + dirflags1 → EBADF (kind gate)
  assertEquals(h.wasi.path_open(2, 1, 2000, length, 0, rights, 0n, 0, 3000), WASI_ERRNO.EBADF);
  // valid base + dirflags1 + traversal path → EPERM before the adapter
  const bad = putPath(h.memory, 2000, "../escape.txt");
  assertEquals(h.wasi.path_open(3, 1, 2000, bad, 0, rights, 0n, 0, 3000), WASI_ERRNO.EPERM);
  // valid base + dirflags1 + VALID path + poisoned openedFdPtr → EFAULT before
  // the adapter (re-put the valid path — the traversal write above clobbered ptr 2000)
  const validLength = putPath(h.memory, 2000, "inputs/in.txt");
  const openedBefore = h.workspace.opened.length;
  assertEquals(h.wasi.path_open(3, 1, 2000, validLength, 0, rights, 0n, 0, 0xfffffff0), WASI_ERRNO.EFAULT);
  assertEquals(h.workspace.opened.length, openedBefore, "no workspace.open on the faulted call");
});

Deno.test("R4 equivalence: dirflags0 ≡ dirflags1 — the same workspace.open call and the same fd record", () => {
  const h = harness();
  const rights = WASI_RIGHTS.FD_READ;
  const length = putPath(h.memory, 2000, "inputs/in.txt");
  const before = h.runtime.snapshot().counters;
  const openedBefore = h.workspace.opened.length;
  const errno0 = h.wasi.path_open(3, 0, 2000, length, 0, rights, 0n, 0, 3000);
  const fd0 = h.memory.u32(3000);
  const errno1 = h.wasi.path_open(4, 1, 2000, length, 0, rights, 0n, 0, 3010);
  const fd1 = h.memory.u32(3010);
  assertEquals(errno0, WASI_ERRNO.SUCCESS);
  assertEquals(errno1, WASI_ERRNO.SUCCESS, "dirflags=SYMLINK_FOLLOW opens");
  // ONE workspace.open each, with the SAME resolved path + SAME options
  const calls = h.workspace.opened.slice(openedBefore);
  assertEquals(calls.length, 2, "one workspace.open per admitted call");
  assertEquals(calls[0].path, calls[1].path, "identical resolved path");
  assertEquals(JSON.stringify(calls[0].options), JSON.stringify(calls[1].options), "identical open options");
  // the fd records are equivalent (rights/fdflags/offset/handle shape)
  assertEquals(fd0 > 0 && fd1 > 0 && fd0 !== fd1, true, "two distinct FILE fds");
  const snap = h.runtime.snapshot().counters;
  assertEquals(snap.hostCalls - before.hostCalls, 2, "+1 hostCalls per admitted call");
  assertEquals(snap.pathCalls - before.pathCalls, 2, "+1 pathCalls per admitted call");
  assertEquals(h.wasi.fd_close(fd0), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(fd1), WASI_ERRNO.SUCCESS);
  assertEquals(h.runtime.snapshot().counters.openDynamicFds, 0, "fds returned to the free list");
});

Deno.test("R4 source pins: the subsumed ||-form is ABSENT; the planner is referenced only by the FILE branch", async () => {
  const source = await Deno.readTextFile(new URL("../extension/lib/wasi-preview1-runtime.js", import.meta.url));
  assertEquals(
    source.includes("dirflags !== 0 || (dirflags & WASI_LOOKUPFLAGS.SYMLINK_FOLLOW)"),
    false,
    "the P-1 subsumed ||-form must NOT be present in the FILE branch",
  );
  const references = source.split("planFileOpenDirflags").length - 1;
  assertEquals(references, 2, "planner referenced only at its definition + the FILE-branch call site");
  // order: the dirflags plan precedes fdflags/oflags/rights/memory/adapter
  const bodyStart = source.indexOf("// Existing FILE-open branch below stays byte-for-byte equivalent.");
  // R7 added the touch-CREAT recognizer branch inside the FILE branch, so the
  // window extends past it to reach the generic workspace.open.
  const body = source.slice(bodyStart, bodyStart + 6000);
  const planIdx = body.indexOf("planFileOpenDirflags(dirflags)");
  const fdflagsIdx = body.indexOf("WASI_FDFLAGS.APPEND");
  const pathIdx = body.indexOf("decodePath(pathPtr, pathLength)");
  const openIdx = body.indexOf("workspace.open(");
  assert(planIdx > 0 && fdflagsIdx > planIdx && pathIdx > fdflagsIdx && openIdx > pathIdx,
    "order: dirflags plan → fdflags → oflags/rights → decodePath → workspace.open (byte-preserved)");
});

// ──────────────────────────────────────────────────────────────────────────
// R5 (CAP-FB-20260823-R5-FILESTAT-SET-SIZE-01): fd_filestat_set_size bounded
// resize — scratch-only, the r2 aggregate-projected 10 MiB ceiling, all-or-
// nothing bytes. Additive KATs; the census pin lives in gzip-preview.test.ts.

Deno.test("R5 planner: every arm in the C-1/C-2 order; no-partial on failure", () => {
  const base = {
    kind: FD_KIND.FILE,
    path: "scratch/work.txt",
    rights: WASI_RIGHTS.FD_FILESTAT_SET_SIZE,
    sizeValue: 8n,
    currentFileBytes: 5,
    currentScratchBytes: 5,
    maxAggregateBytes: 10 * 1024 * 1024,
  };
  assertEquals(planFdFilestatSetSize(base), { errno: WASI_ERRNO.SUCCESS, size: 8n });
  assertEquals(planFdFilestatSetSize({ ...base, kind: FD_KIND.DIR }).errno, WASI_ERRNO.EISDIR, "DIR → EISDIR");
  assertEquals(planFdFilestatSetSize({ ...base, kind: FD_KIND.STDOUT }).errno, WASI_ERRNO.EBADF, "stdio → EBADF");
  assertEquals(planFdFilestatSetSize({ ...base, kind: FD_KIND.PREOPEN }).errno, WASI_ERRNO.EBADF, "PREOPEN → EBADF");
  assertEquals(planFdFilestatSetSize({ ...base, sizeValue: -1n }).errno, WASI_ERRNO.EINVAL, "negative → EINVAL");
  assertEquals(planFdFilestatSetSize({ ...base, sizeValue: 5 }).errno, WASI_ERRNO.EINVAL, "non-BigInt → EINVAL");
  assertEquals(planFdFilestatSetSize({ ...base, sizeValue: 0x10000000000000000n }).errno, WASI_ERRNO.EINVAL, ">U64_MAX → EINVAL");
  assertEquals(planFdFilestatSetSize({ ...base, rights: 0n }).errno, WASI_ERRNO.ENOTCAPABLE, "right missing");
  assertEquals(planFdFilestatSetSize({ ...base, path: "output/new.txt" }).errno, WASI_ERRNO.ENOTCAPABLE, "C-2: output class re-checked");
  assertEquals(planFdFilestatSetSize({ ...base, path: "inputs/in.txt" }).errno, WASI_ERRNO.ENOTCAPABLE, "inputs class");
  // aggregate projection: 10 MiB aggregate with two files — the second grow
  // past the shared bound faults EFBIG even though the per-file size is ≤ 10 MiB
  assertEquals(
    planFdFilestatSetSize({ ...base, sizeValue: 10n * 1024n * 1024n, currentFileBytes: 0, currentScratchBytes: 6n * 1024n * 1024n }).errno,
    WASI_ERRNO.EFBIG,
    "second-file grow past the shared aggregate",
  );
  assertEquals(
    planFdFilestatSetSize({ ...base, sizeValue: 10n * 1024n * 1024n + 1n, currentFileBytes: 0, currentScratchBytes: 0 }).errno,
    WASI_ERRNO.EFBIG,
    "the off-by-one ceiling arm",
  );
  assertEquals(
    planFdFilestatSetSize({ ...base, sizeValue: 10n * 1024n * 1024n, currentFileBytes: 0, currentScratchBytes: 0 }).errno,
    WASI_ERRNO.SUCCESS,
    "exactly at the ceiling succeeds",
  );
});

Deno.test("R5 syscall: grow/shrink/equal exact bytes; readback via fd_filestat_get; fileBytes NOT incremented", () => {
  const h = harness();
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_FILESTAT_GET | WASI_RIGHTS.FD_FILESTAT_SET_SIZE;
  const file = openPath(h, "scratch/work.txt", rights); // seeded 5 bytes "12345"
  assertEquals(file.errno, WASI_ERRNO.SUCCESS);
  const before = h.runtime.snapshot().counters;
  // grow to 8: prefix preserved, zero-filled tail
  assertEquals(h.wasi.fd_filestat_set_size(file.fd, 8n), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_seek(file.fd, 0n, 0, 2300), WASI_ERRNO.SUCCESS);
  // readback the bytes through fd_read
  h.memory.setU32(2000, 1200); h.memory.setU32(2004, 8); // iovec {ptr:1200,len:8}
  assertEquals(h.wasi.fd_read(file.fd, 2000, 1, 2100), WASI_ERRNO.SUCCESS);
  assertEquals(String.fromCharCode(...h.memory.bytes.slice(1200, 1208)), "12345\0\0\0", "grow: prefix + zero tail");
  // fd_filestat_get readback reports the new size
  assertEquals(h.wasi.fd_filestat_get(file.fd, 2200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u64(2200 + 32), 8n, "readback size 8");
  // shrink to 2
  assertEquals(h.wasi.fd_filestat_set_size(file.fd, 2n), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_seek(file.fd, 0n, 0, 2300), WASI_ERRNO.SUCCESS);
  h.memory.setU32(2000, 1200); h.memory.setU32(2004, 8);
  assertEquals(h.wasi.fd_read(file.fd, 2000, 1, 2100), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u32(2100), 2, "shrink reads back exactly 2 bytes");
  // equal → no-op success
  assertEquals(h.wasi.fd_filestat_set_size(file.fd, 2n), WASI_ERRNO.SUCCESS);
  // counters: +1 hostCalls per admitted resize; pathCalls/fileBytes unchanged (P-3)
  const after = h.runtime.snapshot().counters;
  assertEquals(after.pathCalls - before.pathCalls, 0, "the resize + seeks + reads add ZERO path calls (an fd syscall, not a path call)");
  assertEquals(after.fileBytes - before.fileBytes, 2 + 8, "only the two fd_reads count file bytes — the resize adds ZERO");
  assertEquals(h.wasi.fd_close(file.fd), WASI_ERRNO.SUCCESS);
});

Deno.test("R5 syscall mutants: kind/right/class/ceiling; rollback leaves bytes+aggregate untouched", () => {
  const h = harness();
  const rights = WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_FILESTAT_SET_SIZE;
  const file = openPath(h, "scratch/work.txt", rights);
  assertEquals(file.errno, WASI_ERRNO.SUCCESS);
  // (this test never reads/seeks — the short rights set suffices)
  const bytesBefore = [...h.workspace.files.get("scratch/work.txt").bytes];
  const aggBefore = h.workspace.scratchTotalBytes();
  // unknown fd → EBADF
  assertEquals(h.wasi.fd_filestat_set_size(999, 1n), WASI_ERRNO.EBADF);
  // stdio → EBADF, DIR → EISDIR
  assertEquals(h.wasi.fd_filestat_set_size(1, 1n), WASI_ERRNO.EBADF);
  const dir = openDir(h, "scratch");
  assertEquals(dir.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_filestat_set_size(dir.fd, 1n), WASI_ERRNO.EISDIR);
  // inputs FILE fd lacks the right → ENOTCAPABLE
  const input = openPath(h, "inputs/in.txt", WASI_RIGHTS.FD_READ);
  assertEquals(input.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_filestat_set_size(input.fd, 1n), WASI_ERRNO.ENOTCAPABLE, "no FD_FILESTAT_SET_SIZE right");
  // output FILE fd HOLDS the right but the class gate re-checks (C-2) → ENOTCAPABLE
  const output = openPath(h, "output/existing.txt", WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_FILESTAT_SET_SIZE);
  assertEquals(output.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_filestat_set_size(output.fd, 1n), WASI_ERRNO.ENOTCAPABLE, "output class stays resize-denied");
  // EINVAL: negative / non-BigInt / >U64_MAX
  assertEquals(h.wasi.fd_filestat_set_size(file.fd, -1n), WASI_ERRNO.EINVAL);
  assertEquals(h.wasi.fd_filestat_set_size(file.fd, 5), WASI_ERRNO.EINVAL);
  // EFBIG: over the aggregate (the double's ceiling is the planner's 10 MiB)
  assertEquals(h.wasi.fd_filestat_set_size(file.fd, 11n * 1024n * 1024n), WASI_ERRNO.EFBIG);
  // rollback: every failure left BOTH the bytes AND the aggregate untouched
  assertEquals([...h.workspace.files.get("scratch/work.txt").bytes], bytesBefore, "bytes untouched");
  assertEquals(h.workspace.scratchTotalBytes(), aggBefore, "aggregate untouched");
  for (const fd of [file.fd, dir.fd, input.fd, output.fd]) {
    assertEquals(h.wasi.fd_close(fd), WASI_ERRNO.SUCCESS);
  }
});

Deno.test("R5 census + boundary: SUPPORTED is exactly +1 (fd_filestat_set_size); planner referenced only by the syscall", async () => {
  assertEquals(SUPPORTED_WASI_PREVIEW1_IMPORTS.includes("fd_filestat_set_size"), true);
  // R6 added path_filestat_set_times (21→22); R11 added the six sqlite imports
  // (22→28). This test was the R5 pin (21) — updated to the R11 census.
  assertEquals(SUPPORTED_WASI_PREVIEW1_IMPORTS.length, 28, "the R11 census 22→28, deliberate");
  const source = await Deno.readTextFile(new URL("../extension/lib/wasi-preview1-runtime.js", import.meta.url));
  const references = source.split("planFdFilestatSetSize").length - 1;
  assertEquals(references, 2, "planner referenced only at its definition + the syscall call site");
});

// ── R6 path_filestat_set_times (CAP-FB-20260823-R6-SET-TIMES-01) ──────────
Deno.test("R6 planner: every arm — fd4/right/flags/fstflags/timestamps/class/existence", () => {
  const base = { fd: 4, kind: FD_KIND.PREOPEN, rights: WASI_RIGHTS.PATH_FILESTAT_SET_TIMES, flagsValue: 1, fstflagsValue: 5, atimValue: 100000000000n, mtimValue: 200000000000n, path: "scratch/work.txt", exists: true, isDirectory: false };
  // success
  assertEquals(planPathFilestatSetTimes(base), { errno: WASI_ERRNO.SUCCESS, atimNs: 100000000000n, mtimNs: 200000000000n });
  // fd !== 4 → ENOTCAPABLE (the fd4-only right)
  assertEquals(planPathFilestatSetTimes({ ...base, fd: 3 }).errno, WASI_ERRNO.ENOTCAPABLE);
  // kind !== PREOPEN → EBADF
  assertEquals(planPathFilestatSetTimes({ ...base, kind: FD_KIND.FILE }).errno, WASI_ERRNO.EBADF);
  // right missing → ENOTCAPABLE
  assertEquals(planPathFilestatSetTimes({ ...base, rights: WASI_RIGHTS.PATH_FILESTAT_GET }).errno, WASI_ERRNO.ENOTCAPABLE);
  // flags 2 → ENOTSUP
  assertEquals(planPathFilestatSetTimes({ ...base, flagsValue: 2 }).errno, WASI_ERRNO.ENOTSUP);
  // NOW fstflags {2,8,10} → ENOTSUP (no realtime)
  for (const now of [2, 8, 10]) {
    assertEquals(planPathFilestatSetTimes({ ...base, fstflagsValue: now }).errno, WASI_ERRNO.ENOTSUP, `NOW ${now} → ENOTSUP`);
  }
  // conflict {3,12} / unknown / out-of-range → EINVAL
  for (const bad of [3, 12, 0, 6, 7, 16]) {
    assertEquals(planPathFilestatSetTimes({ ...base, fstflagsValue: bad }).errno, WASI_ERRNO.EINVAL, `fstflags ${bad} → EINVAL`);
  }
  // unselected operand nonzero → EINVAL (fstflags 4 = MTIM only; atim must be 0)
  assertEquals(planPathFilestatSetTimes({ ...base, fstflagsValue: 4, atimValue: 1n }).errno, WASI_ERRNO.EINVAL);
  // selected out-of-range → EINVAL
  assertEquals(planPathFilestatSetTimes({ ...base, atimValue: 4102444800000000001n }).errno, WASI_ERRNO.EINVAL);
  // non-scratch path → ENOTCAPABLE
  assertEquals(planPathFilestatSetTimes({ ...base, path: "inputs/in.txt" }).errno, WASI_ERRNO.ENOTCAPABLE);
  // missing → ENOENT; dir → EISDIR
  assertEquals(planPathFilestatSetTimes({ ...base, exists: false }).errno, WASI_ERRNO.ENOENT);
  assertEquals(planPathFilestatSetTimes({ ...base, isDirectory: true }).errno, WASI_ERRNO.EISDIR);
});

Deno.test("R6 syscall: set-times + fd_filestat_get readback; unselected side preserved", () => {
  const h = harness();
  const pathPtr = 2000;
  const len = putPath(h.memory, pathPtr, "scratch/work.txt");
  // MTIM only (fstflags 4): atim unselected (0), mtim = 5s.
  assertEquals(h.wasi.path_filestat_set_times(4, 1, pathPtr, len, 0n, 5000000000n, 4), WASI_ERRNO.SUCCESS);
  // readback via path_filestat_get
  assertEquals(h.wasi.path_filestat_get(4, 1, pathPtr, len, 3000), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u64(3000 + 40), 0n, "atim preserved (unselected)");
  assertEquals(h.memory.u64(3000 + 48), 5000000000n, "mtim written");
  // the workspace row records it (the source-of-truth readback)
  assertEquals(h.workspace.files.get("scratch/work.txt").mtimNs, 5000000000n);
  assertEquals(h.workspace.files.get("scratch/work.txt").atimNs ?? 0n, 0n, "atim untouched");
});

Deno.test("R6 syscall mutants: fd3/right/flags/NOW/missing/dir fail closed, no mutation", () => {
  const h = harness();
  const pathPtr = 2000;
  const len = putPath(h.memory, pathPtr, "scratch/work.txt");
  // fd3 (the `.` preopen) → ENOTCAPABLE (the fd4-only right)
  assertEquals(h.wasi.path_filestat_set_times(3, 1, pathPtr, len, 0n, 1n, 4), WASI_ERRNO.ENOTCAPABLE);
  // flags 2 → ENOTSUP
  assertEquals(h.wasi.path_filestat_set_times(4, 2, pathPtr, len, 0n, 1n, 4), WASI_ERRNO.ENOTSUP);
  // NOW fstflags 2 → ENOTSUP
  assertEquals(h.wasi.path_filestat_set_times(4, 1, pathPtr, len, 0n, 1n, 2), WASI_ERRNO.ENOTSUP);
  // missing path → ENOENT
  const mp = 2000; const ml = putPath(h.memory, mp, "scratch/nope.txt");
  assertEquals(h.wasi.path_filestat_set_times(4, 1, mp, ml, 0n, 1n, 4), WASI_ERRNO.ENOENT);
  // a directory → EISDIR
  h.workspace.dirs.add("scratch/sub");
  const dp = 2000; const dl = putPath(h.memory, dp, "scratch/sub");
  assertEquals(h.wasi.path_filestat_set_times(4, 1, dp, dl, 0n, 1n, 4), WASI_ERRNO.EISDIR);
  // no mutation after the failures
  assertEquals(h.workspace.files.get("scratch/work.txt").mtimNs ?? 0n, 0n, "the file's mtimNs unchanged");
});

Deno.test("R6 census + boundary: SUPPORTED +1 (path_filestat_set_times); planner referenced only by the syscall", async () => {
  assertEquals(SUPPORTED_WASI_PREVIEW1_IMPORTS.includes("path_filestat_set_times"), true);
  assertEquals(SUPPORTED_WASI_PREVIEW1_IMPORTS.length, 28, "the R11 census 22→28, deliberate");
  const source = await Deno.readTextFile(new URL("../extension/lib/wasi-preview1-runtime.js", import.meta.url));
  const references = source.split("planPathFilestatSetTimes").length - 1;
  assertEquals(references, 2, "planner referenced only at its definition + the syscall call site");
});

// ── R7 touch-CREAT profile (CAP-FB-20260823-R7-TOUCH-CREATE-01) ──────────
Deno.test("R7 recognizer: exact whole-tuple true; every one-field near-miss false", () => {
  const t = RETAINED_TOUCH_CREATE_PROFILE;
  assert(isExactRetainedTouchCreateTuple(4, 1, 1, 0x0fffbffdn, 0x0fffffffn, 1), "the exact tuple matches");
  // one-field near-misses
  assert(!isExactRetainedTouchCreateTuple(3, 1, 1, t.requestedBase, t.requestedInheriting, 1), "fd3");
  assert(!isExactRetainedTouchCreateTuple(4, 0, 1, t.requestedBase, t.requestedInheriting, 1), "dirflags0");
  assert(!isExactRetainedTouchCreateTuple(4, 1, 0, t.requestedBase, t.requestedInheriting, 1), "oflags0");
  assert(!isExactRetainedTouchCreateTuple(4, 1, 9, t.requestedBase, t.requestedInheriting, 1), "CREAT|TRUNC");
  assert(!isExactRetainedTouchCreateTuple(4, 1, 5, t.requestedBase, t.requestedInheriting, 1), "CREAT|EXCL");
  assert(!isExactRetainedTouchCreateTuple(4, 1, 1, 0n, t.requestedInheriting, 1), "base0");
  assert(!isExactRetainedTouchCreateTuple(4, 1, 1, t.requestedBase, 0n, 1), "inheriting0");
  assert(!isExactRetainedTouchCreateTuple(4, 1, 1, t.requestedBase, t.requestedInheriting, 0), "fdflags0");
});

Deno.test("R7 syscall: the exact touch-CREAT profile projects FD_WRITE/APPEND/inherit0 and creates the scratch file", () => {
  const h = harness();
  const pathPtr = 2000;
  const len = putPath(h.memory, pathPtr, "scratch/touched");
  const openedPtr = 3000;
  const errno = h.wasi.path_open(4, 1, pathPtr, len, WASI_OFLAGS.CREAT, RETAINED_TOUCH_CREATE_PROFILE.requestedBase, RETAINED_TOUCH_CREATE_PROFILE.requestedInheriting, WASI_FDFLAGS.APPEND, openedPtr);
  assertEquals(errno, WASI_ERRNO.SUCCESS);
  const fd = h.memory.u32(openedPtr);
  assert(fd >= 5, "a dynamic fd");
  // the descriptor projection (fd_fdstat_get)
  assertEquals(h.wasi.fd_fdstat_get(fd, 3200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[3200], WASI_FILETYPE.REGULAR_FILE);
  assertEquals(h.memory.u32(3200 + 2) & 0xffff, WASI_FDFLAGS.APPEND, "flags APPEND");
  assertEquals(h.memory.u64(3200 + 8), WASI_RIGHTS.FD_WRITE, "FD_WRITE only");
  assertEquals(h.memory.u64(3200 + 16), 0n, "inheriting 0");
  // the file exists (size 0), but the FD_WRITE-only projection denies the
  // FD_FILESTAT_GET right — the guest must not stat a touch-CREAT fd.
  assertEquals(h.wasi.fd_filestat_get(fd, 3264), WASI_ERRNO.ENOTCAPABLE);
  assertEquals(h.workspace.files.has("scratch/touched"), true, "the scratch file was created");
  assertEquals(h.workspace.files.get("scratch/touched").bytes.byteLength, 0, "size 0");
  assertEquals(h.wasi.fd_close(fd), WASI_ERRNO.SUCCESS);
});

Deno.test("R7 near-miss: fd3 / TRUNC / EXCL fall through to the generic FILE branch (no create)", () => {
  const h = harness();
  const pathPtr = 2000;
  const len = putPath(h.memory, pathPtr, "scratch/touched");
  const openedPtr = 3000;
  // fd3 (the `.` preopen) — not the profile → the generic branch (no create)
  assertEquals(h.wasi.path_open(3, 1, pathPtr, len, WASI_OFLAGS.CREAT, RETAINED_TOUCH_CREATE_PROFILE.requestedBase, RETAINED_TOUCH_CREATE_PROFILE.requestedInheriting, WASI_FDFLAGS.APPEND, openedPtr), WASI_ERRNO.ENOTCAPABLE);
  // CREAT|TRUNC (oflags 9) — a near-miss → the generic branch
  assertEquals(h.wasi.path_open(4, 1, pathPtr, len, WASI_OFLAGS.CREAT | WASI_OFLAGS.TRUNC, RETAINED_TOUCH_CREATE_PROFILE.requestedBase, RETAINED_TOUCH_CREATE_PROFILE.requestedInheriting, WASI_FDFLAGS.APPEND, openedPtr), WASI_ERRNO.ENOTCAPABLE);
  // CREAT|EXCL (oflags 5) — a near-miss → the generic branch
  assertEquals(h.wasi.path_open(4, 1, pathPtr, len, WASI_OFLAGS.CREAT | WASI_OFLAGS.EXCL, RETAINED_TOUCH_CREATE_PROFILE.requestedBase, RETAINED_TOUCH_CREATE_PROFILE.requestedInheriting, WASI_FDFLAGS.APPEND, openedPtr), WASI_ERRNO.ENOTCAPABLE);
  assertEquals(h.workspace.files.has("scratch/touched"), false, "no scratch file was created by the near-misses");
});

// ── R10 sqlite DB-open profiles (CAP-FB-20260823-R10-SQLITE-ALIAS-PROFILE-01) ─
Deno.test("R10 recognizers: exact read/write tuples true; every one-field near-miss false", () => {
  const P = SQLITE_DB_OPEN_PROFILE;
  assert(isExactSqliteDbReadOpenTuple(3, 0, 0, P.readBase, P.inheriting, 0), "read tuple matches");
  assert(isExactSqliteDbWriteOpenTuple(3, 0, WASI_OFLAGS.CREAT, P.writeBase, P.inheriting, 0), "write tuple matches");
  // one-field near-misses (read)
  assert(!isExactSqliteDbReadOpenTuple(4, 0, 0, P.readBase, P.inheriting, 0), "fd4");
  assert(!isExactSqliteDbReadOpenTuple(3, 1, 0, P.readBase, P.inheriting, 0), "dirflags1");
  assert(!isExactSqliteDbReadOpenTuple(3, 0, WASI_OFLAGS.CREAT, P.readBase, P.inheriting, 0), "read+CREAT");
  assert(!isExactSqliteDbReadOpenTuple(3, 0, 0, P.writeBase, P.inheriting, 0), "base=write");
  assert(!isExactSqliteDbReadOpenTuple(3, 0, 0, P.readBase, 0n, 0), "inh0");
  assert(!isExactSqliteDbReadOpenTuple(3, 0, 0, P.readBase, P.inheriting, WASI_FDFLAGS.APPEND), "fdflags APPEND");
  // one-field near-misses (write)
  assert(!isExactSqliteDbWriteOpenTuple(3, 0, 0, P.writeBase, P.inheriting, 0), "write+oflags0");
  assert(!isExactSqliteDbWriteOpenTuple(3, 0, WASI_OFLAGS.CREAT, P.readBase, P.inheriting, 0), "write+readBase");
});

Deno.test("R10 syscall: read/write projections are masked scratch rights with inheriting 0 and the workspace→scratch alias", () => {
  const h = harness();
  h.workspace.files.set("scratch/test.db", { type: "file", bytes: enc.encode("sqlite") });
  // read open: workspace/test.db → scratch/test.db, projected 0x200026.
  const rp = 2000;
  const rlen = putPath(h.memory, rp, "workspace/test.db");
  const rErrno = h.wasi.path_open(3, 0, rp, rlen, 0, SQLITE_DB_OPEN_PROFILE.readBase, SQLITE_DB_OPEN_PROFILE.inheriting, 0, 3000);
  assertEquals(rErrno, WASI_ERRNO.SUCCESS);
  const rfd = h.memory.u32(3000);
  assertEquals(h.wasi.fd_fdstat_get(rfd, 3200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u64(3200 + 8), SQLITE_DB_OPEN_PROFILE.readProjection, "read projection 0x200026");
  assertEquals(h.memory.u64(3200 + 16), 0n, "read inheriting 0");
  assertEquals(h.wasi.fd_close(rfd), WASI_ERRNO.SUCCESS);
  // write open: a FRESH harness so the fresh.db establishes its own binding
  // (the R11 one-DB rule would deny a second basename on the read harness).
  const h2 = harness();
  const wp = 2100;
  const wlen = putPath(h2.memory, wp, "workspace/fresh.db");
  const wErrno = h2.wasi.path_open(3, 0, wp, wlen, WASI_OFLAGS.CREAT, SQLITE_DB_OPEN_PROFILE.writeBase, SQLITE_DB_OPEN_PROFILE.inheriting, 0, 3100);
  assertEquals(wErrno, WASI_ERRNO.SUCCESS);
  const wfd = h2.memory.u32(3100);
  assertEquals(h2.wasi.fd_fdstat_get(wfd, 3264), WASI_ERRNO.SUCCESS);
  assertEquals(h2.memory.u64(3264 + 8), SQLITE_DB_OPEN_PROFILE.writeProjection | WASI_RIGHTS.FD_SYNC, "write projection 0x600076");
  assertEquals(h2.memory.u64(3264 + 16), 0n, "write inheriting 0");
  assertEquals(h2.workspace.files.has("scratch/fresh.db"), true, "the aliased scratch DB was created");
  assertEquals(h2.wasi.fd_close(wfd), WASI_ERRNO.SUCCESS);
});

Deno.test("R10 near-miss: fd4/non-workspace path/oflags±bit fall through to the generic branch; no alias applies", () => {
  const h = harness();
  h.workspace.files.set("scratch/test.db", { type: "file", bytes: enc.encode("sqlite") });
  const openedPtr = 3000;
  // fd4 (the /job preopen) — not the fd3 `.` tuple → the generic branch
  const p1 = 2000; const l1 = putPath(h.memory, p1, "workspace/test.db");
  assertEquals(h.wasi.path_open(4, 0, p1, l1, 0, SQLITE_DB_OPEN_PROFILE.readBase, SQLITE_DB_OPEN_PROFILE.inheriting, 0, openedPtr), WASI_ERRNO.ENOTCAPABLE);
  // non-workspace path (a scalar match but the path is not workspace/…) → EPERM
  const p2 = 2000; const l2 = putPath(h.memory, p2, "inputs/test.db");
  assertEquals(h.wasi.path_open(3, 0, p2, l2, 0, SQLITE_DB_OPEN_PROFILE.readBase, SQLITE_DB_OPEN_PROFILE.inheriting, 0, openedPtr), WASI_ERRNO.EPERM);
  // the dir-sync "workspace" open (no slash) → EPERM (tolerated-nonfatal)
  const p3 = 2000; const l3 = putPath(h.memory, p3, "workspace");
  assertEquals(h.wasi.path_open(3, 0, p3, l3, 0, SQLITE_DB_OPEN_PROFILE.readBase, SQLITE_DB_OPEN_PROFILE.inheriting, 0, openedPtr), WASI_ERRNO.EPERM);
  assertEquals(h.workspace.files.has("scratch/test.db"), true, "the existing scratch DB is untouched");
});

// ── R11 sqlite six-import completion (CAP-FB-20260823-R11-SQLITE-SIX-IMPORTS-01) ─
function bindSqlite(h, basename = "test.db") {
  const p = 2000;
  const len = putPath(h.memory, p, `workspace/${basename}`);
  const errno = h.wasi.path_open(3, 0, p, len, WASI_OFLAGS.CREAT, SQLITE_DB_OPEN_PROFILE.writeBase, SQLITE_DB_OPEN_PROFILE.inheriting, 0, 3000);
  assertEquals(errno, WASI_ERRNO.SUCCESS);
  return h.memory.u32(3000);
}

Deno.test("R11 errno + rights surface: EBUSY10/ENOTEMPTY55; fd3 0x6046600 / fd4 0x6146600 / inheriting 0x600066", () => {
  assertEquals(WASI_ERRNO.EBUSY, 10);
  assertEquals(WASI_ERRNO.ENOTEMPTY, 55);
  const h = harness();
  assertEquals(h.wasi.fd_fdstat_get(3, 2000), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u64(2000 + 8), 0x6046600n, "fd3 base rights");
  assertEquals(h.memory.u64(2000 + 16), 0x600066n, "fd3 inheriting");
  assertEquals(h.wasi.fd_fdstat_get(4, 2064), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u64(2064 + 8), 0x6146600n, "fd4 base rights");
  assertEquals(h.memory.u64(2064 + 16), 0x600066n, "fd4 inheriting");
});

Deno.test("R11 fd_sync: exact FILE+FD_SYNC only; read/generic denied; no-op counters", () => {
  const h = harness();
  const dbfd = bindSqlite(h);
  assertEquals(h.wasi.fd_sync(dbfd), WASI_ERRNO.SUCCESS, "the DB write fd has FD_SYNC");
  assertEquals(h.wasi.fd_sync(0), WASI_ERRNO.EBADF, "stdin not FILE");
  assertEquals(h.wasi.fd_sync(3), WASI_ERRNO.EBADF, "preopen not FILE");
  assertEquals(h.wasi.fd_sync(999), WASI_ERRNO.EBADF, "unopened EBADF");
  // a generic scratch FILE (no FD_SYNC) → ENOTCAPABLE.
  const g = openPath(h, "scratch/work.txt", WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE);
  assertEquals(g.errno, WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_sync(g.fd), WASI_ERRNO.ENOTCAPABLE, "generic FILE lacks FD_SYNC");
  assertEquals(h.wasi.fd_close(dbfd), WASI_ERRNO.SUCCESS);
});

Deno.test("R11 lock pair: exact bound lock create/remove; binding gate + alias + errno lattice", () => {
  const h = harness();
  // before binding → ENOTCAPABLE before path memory.
  const p0 = 2000; const l0 = putPath(h.memory, p0, "workspace/test.db.lock");
  assertEquals(h.wasi.path_create_directory(3, p0, l0), WASI_ERRNO.ENOTCAPABLE);
  const dbfd = bindSqlite(h);
  // create the exact lock (fd3 workspace alias + fd4 scratch spelling converge).
  const p1 = 2100; const l1 = putPath(h.memory, p1, "workspace/test.db.lock");
  assertEquals(h.wasi.path_create_directory(3, p1, l1), WASI_ERRNO.SUCCESS);
  // the create again → EEXIST.
  assertEquals(h.wasi.path_create_directory(3, p1, l1), WASI_ERRNO.EEXIST);
  // wrong scratch lock (different basename) → ENOTCAPABLE.
  const p2 = 2200; const l2 = putPath(h.memory, p2, "workspace/other.db.lock");
  assertEquals(h.wasi.path_create_directory(3, p2, l2), WASI_ERRNO.ENOTCAPABLE);
  // inputs → EACCES before existence.
  const p3 = 2300; const l3 = putPath(h.memory, p3, "inputs/x.lock");
  assertEquals(h.wasi.path_create_directory(3, p3, l3), WASI_ERRNO.EACCES);
  // remove the exact lock.
  assertEquals(h.wasi.path_remove_directory(3, p1, l1), WASI_ERRNO.SUCCESS);
  // remove again → ENOTDIR (the missing explicit dir).
  assertEquals(h.wasi.path_remove_directory(3, p1, l1), WASI_ERRNO.ENOTDIR);
  // ENOTEMPTY55: a child under the lock blocks the removal.
  assertEquals(h.wasi.path_create_directory(3, p1, l1), WASI_ERRNO.SUCCESS);
  h.workspace.files.set("scratch/test.db.lock/child", { type: "file", bytes: enc.encode("x") });
  assertEquals(h.wasi.path_remove_directory(3, p1, l1), WASI_ERRNO.ENOTEMPTY);
  assertEquals(h.wasi.fd_close(dbfd), WASI_ERRNO.SUCCESS);
});

Deno.test("R11 unlink: exact bound journal only; DB/lock/foreign denied before existence", () => {
  const h = harness();
  const dbfd = bindSqlite(h);
  h.workspace.files.set("scratch/test.db-journal", { type: "file", bytes: enc.encode("jx") });
  // the DB path → ENOTCAPABLE (not the journal).
  const p0 = 2000; const l0 = putPath(h.memory, p0, "workspace/test.db");
  assertEquals(h.wasi.path_unlink_file(3, p0, l0), WASI_ERRNO.ENOTCAPABLE);
  // the lock path → ENOTCAPABLE.
  const p1 = 2000; const l1 = putPath(h.memory, p1, "workspace/test.db.lock");
  assertEquals(h.wasi.path_unlink_file(3, p1, l1), WASI_ERRNO.ENOTCAPABLE);
  // the exact journal → SUCCESS (the name released).
  const p2 = 2000; const l2 = putPath(h.memory, p2, "workspace/test.db-journal");
  assertEquals(h.wasi.path_unlink_file(3, p2, l2), WASI_ERRNO.SUCCESS);
  assertEquals(h.workspace.files.has("scratch/test.db-journal"), false, "the journal was unlinked");
  // the missing journal → ENOENT.
  assertEquals(h.wasi.path_unlink_file(3, p2, l2), WASI_ERRNO.ENOENT);
  assertEquals(h.wasi.fd_close(dbfd), WASI_ERRNO.SUCCESS);
});

Deno.test("R11 journal auxiliary: the derived write-profile open after binding → 0x600076/0", () => {
  const h = harness();
  const dbfd = bindSqlite(h);
  const p = 2000; const len = putPath(h.memory, p, "workspace/test.db-journal");
  const errno = h.wasi.path_open(3, 0, p, len, WASI_OFLAGS.CREAT, SQLITE_DB_OPEN_PROFILE.writeBase, SQLITE_DB_OPEN_PROFILE.inheriting, 0, 3200);
  assertEquals(errno, WASI_ERRNO.SUCCESS);
  const jfd = h.memory.u32(3200);
  assertEquals(h.wasi.fd_fdstat_get(jfd, 3264), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.u64(3264 + 8), 0x600076n, "journal write projection (FD_SYNC included)");
  assertEquals(h.memory.u64(3264 + 16), 0n, "journal inheriting 0");
  // a second DB basename → ENOTCAPABLE (no binding rotation).
  const p2 = 2000; const len2 = putPath(h.memory, p2, "workspace/other.db");
  assertEquals(h.wasi.path_open(3, 0, p2, len2, WASI_OFLAGS.CREAT, SQLITE_DB_OPEN_PROFILE.writeBase, SQLITE_DB_OPEN_PROFILE.inheriting, 0, 3300), WASI_ERRNO.ENOTCAPABLE);
  assertEquals(h.wasi.fd_close(jfd), WASI_ERRNO.SUCCESS);
  assertEquals(h.wasi.fd_close(dbfd), WASI_ERRNO.SUCCESS);
});

Deno.test("R11 stubs: path_readlink ENOTCAPABLE (no PATH_READLINK grant) with zero accessors; poll_oneoff ENOTSUP", () => {
  const h = harness();
  assertEquals(h.wasi.path_readlink(3, 0, 0, 0, 0, 0), WASI_ERRNO.ENOTCAPABLE);
  assertEquals(h.wasi.path_readlink(0, 0, 0, 0, 0, 0), WASI_ERRNO.EBADF, "stdio not PREOPEN/DIR");
  assertEquals(h.wasi.path_readlink(999, 0, 0, 0, 0, 0), WASI_ERRNO.EBADF, "unopened");
  assertEquals(h.wasi.poll_oneoff(0, 0, 0, 0), WASI_ERRNO.ENOTSUP);
  assertEquals(h.wasi.poll_oneoff(1.5, 0, 0, 0), WASI_ERRNO.EINVAL, "non-integer scalar");
});
