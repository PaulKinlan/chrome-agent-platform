import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { WASI } from 'node:wasi';
import { makeBoundedFdWrite } from './quota-sink.mjs';

let stdinFd;
let stdoutFd;
let stderrFd;
try {
  stdinFd = fs.openSync(workerData.stdinPath, 'r');
  stdoutFd = fs.openSync(workerData.stdoutPath, 'w');
  stderrFd = fs.openSync(workerData.stderrPath, 'w');
  const preopens = workerData.workspaceDir ? { '/workspace': workerData.workspaceDir } : {};
  const wasi = new WASI({
    version: 'preview1',
    args: ['sqlite3_query_bounded'],
    env: {},
    preopens,
    stdin: stdinFd,
    stdout: stdoutFd,
    stderr: stderrFd,
    returnOnExit: true,
  });
  const imports = wasi.getImportObject();
  const wasiImports = imports.wasi_snapshot_preview1;
  let instance;
  const bounded = makeBoundedFdWrite(
    wasiImports.fd_write.bind(wasiImports),
    () => instance?.exports?.memory,
    { stdoutLimit: workerData.outputLimit, stderrLimit: workerData.stderrLimit },
  );
  wasiImports.fd_write = bounded.fdWrite;
  const bytes = fs.readFileSync(workerData.wasmPath);
  const result = await WebAssembly.instantiate(bytes, imports);
  instance = result.instance;
  const status = wasi.start(instance);
  fs.fsyncSync(stdoutFd);
  fs.fsyncSync(stderrFd);
  parentPort.postMessage({
    status,
    stdoutWritten: bounded.totals.get(1),
    stderrWritten: bounded.totals.get(2),
  });
} catch (error) {
  parentPort.postMessage({
    workerError: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown worker error',
  });
} finally {
  for (const fd of [stdinFd, stdoutFd, stderrFd]) {
    if (Number.isInteger(fd)) {
      try { fs.closeSync(fd); } catch { /* parent treats missing receipt as failure */ }
    }
  }
}
