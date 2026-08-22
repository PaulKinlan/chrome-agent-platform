// lib/wasm-host-types.js — pure, bounded types for the unreachable WASI host.
//
// SOURCE AUTHORITY ONLY. This module defines data contracts and constants. It
// does not create a Worker, OPFS handle, route, provider, network request,
// WebAssembly instance, or executable package path.

import { WASM_PACKAGE_LIMITS } from "./wasm-package-authority.js";

export const WASI_ERRNO = Object.freeze({
  SUCCESS: 0,
  E2BIG: 1,
  EACCES: 2,
  EBADF: 8,
  ECANCELED: 11,
  EEXIST: 20,
  EFAULT: 21,
  EFBIG: 22,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ENAMETOOLONG: 37,
  ENOENT: 44,
  ENOSPC: 51,
  ENOTDIR: 54,
  ENOTSUP: 58,
  EOVERFLOW: 61,
  EPERM: 63,
  ESPIPE: 70,
  ENOTCAPABLE: 76,
});

export const WASI_FILETYPE = Object.freeze({
  UNKNOWN: 0,
  BLOCK_DEVICE: 1,
  CHARACTER_DEVICE: 2,
  DIRECTORY: 3,
  REGULAR_FILE: 4,
  SOCKET_DGRAM: 5,
  SOCKET_STREAM: 6,
  SYMBOLIC_LINK: 7,
});

export const WASI_WHENCE = Object.freeze({ SET: 0, CUR: 1, END: 2 });
export const WASI_CLOCK = Object.freeze({ REALTIME: 0, MONOTONIC: 1 });
export const WASI_OFLAGS = Object.freeze({
  CREAT: 1,
  DIRECTORY: 2,
  EXCL: 4,
  TRUNC: 8,
});
export const WASI_FDFLAGS = Object.freeze({
  APPEND: 1,
  DSYNC: 2,
  NONBLOCK: 4,
  RSYNC: 8,
  SYNC: 16,
});
export const WASI_LOOKUPFLAGS = Object.freeze({ SYMLINK_FOLLOW: 1 });

export const WASI_RIGHTS = Object.freeze({
  FD_DATASYNC: 1n << 0n,
  FD_READ: 1n << 1n,
  FD_SEEK: 1n << 2n,
  FD_FDSTAT_SET_FLAGS: 1n << 3n,
  FD_SYNC: 1n << 4n,
  FD_TELL: 1n << 5n,
  FD_WRITE: 1n << 6n,
  FD_ADVISE: 1n << 7n,
  FD_ALLOCATE: 1n << 8n,
  PATH_CREATE_DIRECTORY: 1n << 9n,
  PATH_CREATE_FILE: 1n << 10n,
  PATH_LINK_SOURCE: 1n << 11n,
  PATH_LINK_TARGET: 1n << 12n,
  PATH_OPEN: 1n << 13n,
  FD_READDIR: 1n << 14n,
  PATH_READLINK: 1n << 15n,
  PATH_RENAME_SOURCE: 1n << 16n,
  PATH_RENAME_TARGET: 1n << 17n,
  PATH_FILESTAT_GET: 1n << 18n,
  PATH_FILESTAT_SET_SIZE: 1n << 19n,
  PATH_FILESTAT_SET_TIMES: 1n << 20n,
  FD_FILESTAT_GET: 1n << 21n,
  FD_FILESTAT_SET_SIZE: 1n << 22n,
  FD_FILESTAT_SET_TIMES: 1n << 23n,
  POLL_FD_READWRITE: 1n << 26n,
});

export const WASI_HOST_HARD_LIMITS = Object.freeze({
  MAX_ARGS: 64,
  MAX_ARG_BYTES: 4096,
  MAX_STDIN_BYTES: 1024 * 1024,
  MAX_STDOUT_BYTES: 1024 * 1024,
  MAX_STDERR_BYTES: 256 * 1024,
  MAX_HOST_CALLS: 50_000,
  MAX_PATH_CALLS: 4096,
  MAX_PATH_BYTES: 1024,
  MAX_PATH_SEGMENT_BYTES: 255,
  MAX_IOVECS: 1024,
  MAX_IO_BYTES_PER_CALL: 1024 * 1024,
  MAX_FILE_BYTES: 10 * 1024 * 1024,
  MAX_FILE_IO_BYTES: 10 * 1024 * 1024,
  MAX_RANDOM_BYTES_PER_CALL: 65_536,
  MAX_DYNAMIC_FDS: 256,
});

export const WASI_HOST_DEFAULT_QUOTA = Object.freeze({
  hostCalls: WASI_HOST_HARD_LIMITS.MAX_HOST_CALLS,
  pathCalls: WASI_HOST_HARD_LIMITS.MAX_PATH_CALLS,
  stdinBytes: WASI_HOST_HARD_LIMITS.MAX_STDIN_BYTES,
  stdoutBytes: WASI_HOST_HARD_LIMITS.MAX_STDOUT_BYTES,
  stderrBytes: WASI_HOST_HARD_LIMITS.MAX_STDERR_BYTES,
  fileBytes: WASI_HOST_HARD_LIMITS.MAX_FILE_IO_BYTES,
  fileSize: WASI_HOST_HARD_LIMITS.MAX_FILE_BYTES,
  dynamicFds: WASI_HOST_HARD_LIMITS.MAX_DYNAMIC_FDS,
});

export const FD_KIND = Object.freeze({
  STDIN: "stdin",
  STDOUT: "stdout",
  STDERR: "stderr",
  PREOPEN: "preopen",
  FILE: "file",
});

export const PATH_CLASS_RIGHTS = Object.freeze({
  inputs: Object.freeze({
    readable: true,
    writable: false,
    rights: WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_SEEK |
      WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET,
  }),
  scratch: Object.freeze({
    readable: true,
    writable: true,
    rights: WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_WRITE |
      WASI_RIGHTS.FD_SEEK | WASI_RIGHTS.FD_TELL |
      WASI_RIGHTS.FD_FILESTAT_GET | WASI_RIGHTS.FD_FILESTAT_SET_SIZE,
  }),
  output: Object.freeze({
    readable: false,
    writable: true,
    rights: WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_SEEK |
      WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET |
      WASI_RIGHTS.FD_FILESTAT_SET_SIZE,
  }),
});

const encoder = new TextEncoder();
const JOB_KEYS = Object.freeze(["args", "context", "quota", "stdin", "tier"]);
const CONTEXT_KEYS = Object.freeze([
  "callId",
  "executionId",
  "origin",
  "workspaceRoot",
]);
const QUOTA_KEYS = Object.freeze(Object.keys(WASI_HOST_DEFAULT_QUOTA).sort());
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function fail(code) {
  throw new TypeError(code);
}

function ownRecord(value, keys, code) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail(code);
  }
  return value;
}

function boundedId(value, code) {
  if (typeof value !== "string" || !ID_RE.test(value)) fail(code);
  return value;
}

function isWellFormedText(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function boundedOrigin(value) {
  if (typeof value !== "string" || value.length > 256) fail("context_origin");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("context_origin");
  }
  if (
    !new Set(["http:", "https:"]).has(url.protocol) || url.username ||
    url.password || url.pathname !== "/" || url.search || url.hash ||
    url.origin !== value
  ) fail("context_origin");
  return value;
}

export function createWasiContext(value) {
  const input = ownRecord(value, CONTEXT_KEYS, "context_shape");
  const executionId = boundedId(input.executionId, "context_execution_id");
  const callId = boundedId(input.callId, "context_call_id");
  const expectedRoot = `tool-jobs/${executionId}/${callId}/`;
  if (input.workspaceRoot !== expectedRoot) fail("context_workspace_root");
  return Object.freeze({
    executionId,
    callId,
    origin: boundedOrigin(input.origin),
    workspaceRoot: expectedRoot,
  });
}

export function createWasiQuota(value = WASI_HOST_DEFAULT_QUOTA) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) fail("quota_shape");
  for (const key of Object.keys(value)) {
    if (!QUOTA_KEYS.includes(key)) fail("quota_shape");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail("quota_shape");
  }
  const quota = {};
  for (const key of QUOTA_KEYS) {
    const candidate = Object.hasOwn(value, key)
      ? Object.getOwnPropertyDescriptor(value, key).value
      : WASI_HOST_DEFAULT_QUOTA[key];
    const hard = WASI_HOST_DEFAULT_QUOTA[key];
    if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > hard) {
      fail(`quota_${key}`);
    }
    quota[key] = candidate;
  }
  return Object.freeze(quota);
}

export function createWasiJob(value) {
  const input = ownRecord(value, JOB_KEYS, "job_shape");
  if (
    !new Set(["tiny", "default"]).has(input.tier) ||
    WASM_PACKAGE_LIMITS.TIERS[input.tier]?.admission !== "allowed"
  ) fail("job_tier");
  const quota = createWasiQuota(input.quota);
  if (
    !Array.isArray(input.args) ||
    input.args.length > WASI_HOST_HARD_LIMITS.MAX_ARGS
  ) fail("job_args");
  let argBytes = 0;
  const args = input.args.map((arg) => {
    if (
      typeof arg !== "string" || arg.includes("\0") || !isWellFormedText(arg)
    ) fail("job_args");
    const bytes = encoder.encode(arg);
    if (bytes.length > 1024) fail("job_args");
    argBytes += bytes.length + 1;
    return arg;
  });
  if (argBytes > WASI_HOST_HARD_LIMITS.MAX_ARG_BYTES) fail("job_args");
  if (
    !(input.stdin instanceof Uint8Array) ||
    input.stdin.byteLength > quota.stdinBytes
  ) fail("job_stdin");
  return Object.freeze({
    context: createWasiContext(input.context),
    args: Object.freeze(args),
    stdin: Object.freeze([...input.stdin]),
    quota,
    tier: input.tier,
  });
}

export function createFdRecord(value) {
  const required = [
    "fd",
    "filetype",
    "flags",
    "handle",
    "kind",
    "offset",
    "path",
    "rights",
  ];
  const input = ownRecord(value, required, "fd_shape");
  if (
    !Number.isSafeInteger(input.fd) || input.fd < 0 || input.fd > 0xffff_ffff
  ) fail("fd_number");
  if (!Object.values(FD_KIND).includes(input.kind)) fail("fd_kind");
  if (!Object.values(WASI_FILETYPE).includes(input.filetype)) {
    fail("fd_filetype");
  }
  if (
    typeof input.rights !== "bigint" || input.rights < 0n ||
    input.rights > 0xffff_ffff_ffff_ffffn
  ) fail("fd_rights");
  if (
    typeof input.offset !== "bigint" || input.offset < 0n ||
    input.offset > 0xffff_ffff_ffff_ffffn
  ) fail("fd_offset");
  if (
    !Number.isSafeInteger(input.flags) || input.flags < 0 ||
    input.flags > 0xffff
  ) fail("fd_flags");
  if (
    typeof input.path !== "string" ||
    input.path.length > WASI_HOST_HARD_LIMITS.MAX_PATH_BYTES
  ) fail("fd_path");
  if (
    input.kind === FD_KIND.FILE &&
    (!input.handle || typeof input.handle !== "object")
  ) fail("fd_handle");
  if (input.kind !== FD_KIND.FILE && input.handle !== null) fail("fd_handle");
  return Object.freeze({ ...input });
}

export class WasiProcExit extends Error {
  constructor(code) {
    if (!Number.isInteger(code) || code < 0 || code > 0xffff_ffff) {
      fail("proc_exit_code");
    }
    super(`WASI proc_exit(${code})`);
    this.name = "WasiProcExit";
    this.code = code >>> 0;
    this.signal = "wasi-proc-exit";
    Object.freeze(this);
  }
}
