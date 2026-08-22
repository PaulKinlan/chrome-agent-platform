import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export const INPUT_LIMIT = 1024 * 1024;
export const OUTPUT_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;
const STDERR_LIMIT = 64 * 1024;
const DEFAULT_WASM = fileURLToPath(new URL('../dist/sqlite3-query-bounded.wasm', import.meta.url));

function failure(message, extra = {}) {
  return {
    status: 1,
    output: Buffer.alloc(0),
    stderr: Buffer.from(`sqlite3: ${message}\n`),
    terminated: false,
    terminationReason: null,
    ...extra,
  };
}

function inputBytes(input) {
  if (Buffer.isBuffer(input)) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input);
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return Buffer.from(JSON.stringify(input));
  }
  throw new TypeError('input must be a Buffer, string, or request object');
}

function inspectRequest(bytes) {
  const text = bytes.toString('utf8').trimStart();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function safeDatabaseName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/u.test(value);
}

async function workerRun(workerData, timeoutMs) {
  return await new Promise((resolve) => {
    const worker = new Worker(new URL('./wasi-worker.mjs', import.meta.url), { workerData });
    let receipt = null;
    let timedOut = false;
    let workerError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      void worker.terminate();
    }, timeoutMs);
    worker.on('message', (message) => { receipt = message; });
    worker.on('error', (error) => { workerError = error; });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ receipt, timedOut, workerError, exitCode: code });
    });
  });
}

async function execute(input, {
  wasmPath = DEFAULT_WASM,
  workspaceDir = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  mode,
} = {}) {
  let bytes;
  try {
    bytes = inputBytes(input);
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'invalid input');
  }
  if (bytes.length > INPUT_LIMIT) return failure('input exceeds 1048576 bytes');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    return failure('invalid timeout');
  }
  const request = inspectRequest(bytes);
  if (request && Object.hasOwn(request, 'database') && !safeDatabaseName(request.database)) {
    return failure('database path traversal denied');
  }
  if (mode === 'memory' && request && Object.hasOwn(request, 'database')) {
    return failure('database is unavailable in the in-memory tranche');
  }
  if (mode === 'workspace') {
    if (!request || !Object.hasOwn(request, 'database')) {
      return failure('workspace tranche requires a database name');
    }
    if (!safeDatabaseName(request.database)) return failure('database path traversal denied');
    try {
      const metadata = fs.statSync(workspaceDir, { throwIfNoEntry: true });
      if (!metadata.isDirectory()) return failure('workspace is not a directory');
      workspaceDir = fs.realpathSync(workspaceDir);
    } catch {
      return failure('workspace is unavailable');
    }
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-sqlite3-query-'));
  fs.chmodSync(stage, 0o700);
  const stdinPath = path.join(stage, 'stdin');
  const stdoutPath = path.join(stage, 'stdout');
  const stderrPath = path.join(stage, 'stderr');
  let result;
  try {
    fs.writeFileSync(stdinPath, bytes, { mode: 0o600 });
    fs.writeFileSync(stdoutPath, Buffer.alloc(0), { mode: 0o600 });
    fs.writeFileSync(stderrPath, Buffer.alloc(0), { mode: 0o600 });
    const workerResult = await workerRun({
      wasmPath: path.resolve(wasmPath),
      workspaceDir: mode === 'workspace' ? workspaceDir : null,
      stdinPath,
      stdoutPath,
      stderrPath,
      outputLimit: OUTPUT_LIMIT,
      stderrLimit: STDERR_LIMIT,
    }, timeoutMs);
    if (workerResult.timedOut) {
      result = failure('execution timed out', { terminated: true, terminationReason: 'timeout' });
    } else if (workerResult.workerError) {
      result = failure('worker failed');
    } else if (!workerResult.receipt || workerResult.receipt.workerError ||
               !Number.isInteger(workerResult.receipt.status)) {
      result = failure('invalid worker receipt');
    } else {
      const stdout = fs.readFileSync(stdoutPath);
      const stderr = fs.readFileSync(stderrPath);
      if (stdout.length > OUTPUT_LIMIT || workerResult.receipt.stdoutWritten > OUTPUT_LIMIT) {
        result = failure('output exceeds 2097152 bytes');
      } else if (stderr.length > STDERR_LIMIT || workerResult.receipt.stderrWritten > STDERR_LIMIT) {
        result = failure('stderr exceeds 65536 bytes');
      } else if (workerResult.receipt.status !== 0) {
        result = {
          status: workerResult.receipt.status,
          output: Buffer.alloc(0),
          stderr,
          terminated: false,
          terminationReason: null,
        };
      } else {
        result = {
          status: 0,
          output: stdout,
          stderr,
          terminated: false,
          terminationReason: null,
        };
      }
    }
  } catch {
    result = failure('stage failure');
  }
  try {
    fs.rmSync(stage, { recursive: true, force: false });
  } catch {
    return failure('stage cleanup failed');
  }
  return result;
}

export async function runMemoryQuery(input, options = {}) {
  return execute(input, { ...options, mode: 'memory' });
}

export async function runWorkspaceQuery(input, { workspaceDir, ...options } = {}) {
  return execute(input, { ...options, workspaceDir, mode: 'workspace' });
}
