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
  WASI_FILETYPE,
  WASI_HOST_DEFAULT_QUOTA,
  WASI_HOST_HARD_LIMITS,
  WASI_OFLAGS,
  WASI_RIGHTS,
  WASI_WHENCE,
  WasiProcExit,
} from "../extension/lib/wasm-host-types.js";
import {
  createWasiPreview1Runtime,
  REBUILT_TOOL_COUNT,
  REBUILT_WASI_IMPORTS,
  revalidateAuditedMemory,
  SUPPORTED_WASI_PREVIEW1_IMPORTS,
  validateWasiImportSet,
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
  constructor({ partialRead = Infinity, partialWrite = Infinity } = {}) {
    this.files = new Map([
      ["inputs/in.txt", { type: "file", bytes: enc.encode("abcdef") }],
      ["scratch/work.txt", { type: "file", bytes: enc.encode("12345") }],
      ["output/existing.txt", { type: "file", bytes: enc.encode("hidden") }],
    ]);
    this.partialRead = partialRead;
    this.partialWrite = partialWrite;
    this.opened = [];
    this.closed = 0;
  }
  stat(path) {
    const row = this.files.get(path);
    if (!row) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { type: row.type, size: row.bytes.byteLength };
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
  { oflags = 0, fdflags = 0, openedPtr = 3000 } = {},
) {
  const pathPtr = 2000;
  const length = putPath(h.memory, pathPtr, path);
  const errno = h.wasi.path_open(
    3,
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
  assertThrows(
    () =>
      createWasiJob({
        ...rawJob(),
        stdin: new Uint8Array(WASI_HOST_HARD_LIMITS.MAX_STDIN_BYTES + 1),
      }),
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

Deno.test("WASI preopen/fd stat KAT: fd3 is exact dot root and stdio/file types are bounded", () => {
  const h = harness();
  assertEquals(h.wasi.fd_prestat_get(3, 100), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[100], 0);
  assertEquals(h.memory.u32(104), 1);
  assertEquals(h.wasi.fd_prestat_dir_name(3, 120, 1), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.text(120, 1), ".");
  assertEquals(h.wasi.fd_prestat_get(2, 100), WASI_ERRNO.EBADF);
  assertEquals(h.wasi.fd_prestat_dir_name(3, 120, 0), WASI_ERRNO.ENAMETOOLONG);
  assertEquals(h.wasi.fd_fdstat_get(0, 200), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[200], WASI_FILETYPE.CHARACTER_DEVICE);
  assertEquals(h.wasi.fd_fdstat_get(3, 240), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[240], WASI_FILETYPE.DIRECTORY);
  assertEquals(h.wasi.fd_filestat_get(3, 300), WASI_ERRNO.SUCCESS);
  assertEquals(h.memory.bytes[316], WASI_FILETYPE.DIRECTORY);
  assertEquals(h.memory.u64(332), 0n);
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
  assertEquals(
    h.wasi.path_filestat_get(3, 1, 1000, length, 1100),
    WASI_ERRNO.ENOTSUP,
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
  assertEquals(input.fd, 4);
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
    h.wasi.path_open(3, 1, pathPtr, length, 0, readRights, 0n, 0, 3050),
    WASI_ERRNO.ENOTSUP,
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
    WASI_ERRNO.ENOTSUP,
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
  assertEquals(retry.fd, 4);
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
  assertEquals(
    SUPPORTED_WASI_PREVIEW1_IMPORTS,
    [...SUPPORTED_WASI_PREVIEW1_IMPORTS].sort(),
  );
  assert(Object.isFrozen(SUPPORTED_WASI_PREVIEW1_IMPORTS));
  assert(Object.isFrozen(REBUILT_WASI_IMPORTS));
});
