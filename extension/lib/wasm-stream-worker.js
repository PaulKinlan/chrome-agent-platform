import { createIncrementalSha256 } from "./incremental-sha256.js";
import { createWasiPreview1Runtime } from "./wasi-preview1-runtime.js";
import { openWasmStreamHandles, validateWasmStreamRef } from "./wasm-stream-files.js";
import { createSyncWorkspace } from "./wasm-sync-workspace.js";
import { WasiProcExit } from "./wasm-host-types.js";
import { runExternalSort } from "./wasm-external-sort.js";

const WORKER_INSTANCE_ID = crypto.randomUUID();

function fail(message) { throw new Error(message); }

async function makeStreamAdapters(handles) {
  if (typeof handles.inputFile.createSyncAccessHandle !== "function") fail("opfs_sync_access_unavailable");
  const inputAccess = await handles.inputFile.createSyncAccessHandle();
  const stdoutAccess = await handles.stdoutFile.createSyncAccessHandle();
  const stderrAccess = await handles.stderrFile.createSyncAccessHandle();
  stdoutAccess.truncate(0);
  stderrAccess.truncate(0);
  let inputOffset = 0, stdoutOffset = 0, stderrOffset = 0;
  const inputHash = createIncrementalSha256();
  const stdoutHash = createIncrementalSha256();
  const stderrHash = createIncrementalSha256();

  return {
    stdin: {
      read(maxBytes) {
        const target = new Uint8Array(maxBytes);
        const read = inputAccess.read(target, { at: inputOffset });
        if (read <= 0) return new Uint8Array();
        const chunk = target.subarray(0, read);
        inputOffset += read;
        inputHash.update(chunk);
        return chunk;
      },
    },
    stdout: {
      write(chunk) {
        let written = 0;
        while (written < chunk.byteLength) {
          const count = stdoutAccess.write(chunk.subarray(written), { at: stdoutOffset + written });
          if (count <= 0) fail("opfs_stdout_write_failed");
          written += count;
        }
        stdoutOffset += written;
        stdoutHash.update(chunk);
        return written;
      },
    },
    stderr: {
      write(chunk) {
        let written = 0;
        while (written < chunk.byteLength) {
          const count = stderrAccess.write(chunk.subarray(written), { at: stderrOffset + written });
          if (count <= 0) fail("opfs_stderr_write_failed");
          written += count;
        }
        stderrOffset += written;
        stderrHash.update(chunk);
        return written;
      },
    },
    access: Object.freeze({ input: inputAccess, stdout: stdoutAccess, stderr: stderrAccess }),
    finish() {
      inputAccess.close();
      stdoutAccess.flush();
      stdoutAccess.close();
      stderrAccess.flush();
      stderrAccess.close();
      return Object.freeze({
        stdinBytes: inputOffset,
        stdinSha256: inputHash.hex(),
        stdoutBytes: stdoutOffset,
        stdoutSha256: stdoutHash.hex(),
        stderrBytes: stderrOffset,
        stderrSha256: stderrHash.hex(),
      });
    },
    abort() {
      try { inputAccess.close(); } catch {}
      try { stdoutAccess.close(); } catch {}
      try { stderrAccess.close(); } catch {}
    },
  };
}

function startWasiInstance(instance) {
  const fn = typeof instance?.exports?._start === "function"
    ? instance.exports._start
    : typeof instance?.exports?.run === "function" ? instance.exports.run : null;
  if (!fn) fail("wasm_stream_export_missing");
  try { fn(); return 0; }
  catch (error) {
    if (error instanceof WasiProcExit) return error.code;
    throw error;
  }
}

async function instantiateWasi(wasmBytes, runtime) {
  const result = await WebAssembly.instantiate(wasmBytes, runtime.imports);
  return result.instance ?? result;
}

function runtimeMemory(getInstance) {
  return {
    size: () => getInstance()?.exports?.memory?.buffer?.byteLength ?? 0,
    read: (pointer, length) => {
      const buffer = getInstance()?.exports?.memory?.buffer;
      if (!buffer || pointer + length > buffer.byteLength) return new Uint8Array();
      return new Uint8Array(buffer, pointer, length);
    },
    write: (pointer, bytes) => {
      const buffer = getInstance()?.exports?.memory?.buffer;
      if (!buffer || pointer + bytes.byteLength > buffer.byteLength) fail("wasm_stream_memory");
      new Uint8Array(buffer, pointer, bytes.byteLength).set(bytes);
    },
  };
}

async function execute(message) {
  if (!(message.wasmBytes instanceof Uint8Array) || !message.job || typeof message.owner !== "string") {
    fail("wasm_stream_job");
  }
  const inputRef = validateWasmStreamRef(message.inputRef);
  const outputRef = validateWasmStreamRef(message.outputRef, { kinds: ["stdout"] });
  const inputHandles = await openWasmStreamHandles({ ref: inputRef, owner: message.owner });
  const outputHandles = await openWasmStreamHandles({ ref: outputRef, owner: message.owner, allowUnsealedOutput: true });
  const adapters = await makeStreamAdapters({
    inputFile: inputHandles.inputFile,
    stdoutFile: outputHandles.stdoutFile,
    stderrFile: outputHandles.stderrFile,
  });
  const job = { ...message.job, stdin: new Uint8Array() };
  const startedAt = performance.now();
  try {
    let exitCode;
    if (message.toolId === "sort") {
      exitCode = await runExternalSort({
        wasmBytes: message.wasmBytes,
        args: job.args.slice(1),
        job,
        inputAccess: adapters.access.input,
        stdin: adapters.stdin,
        stdout: adapters.stdout,
        stderr: adapters.stderr,
        scratchDirectory: await outputHandles.directory.getDirectoryHandle("scratch"),
        instantiateWasi,
      });
    } else {
      let instance = null;
      const runtime = createWasiPreview1Runtime({
        job,
        memory: runtimeMemory(() => instance),
        workspace: createSyncWorkspace({ root: job.context.workspaceRoot, seed: job.workspaceSeed }),
        stdio: {
          readStdin(_offset, maxBytes) { return adapters.stdin.read(maxBytes); },
          writeStdout(_offset, bytes) { return adapters.stdout.write(bytes); },
          writeStderr(_offset, bytes) { return adapters.stderr.write(bytes); },
        },
      });
      instance = await instantiateWasi(message.wasmBytes, runtime);
      exitCode = startWasiInstance(instance);
    }
    const receipt = adapters.finish();
    const accepted = job.acceptedExitCodes.includes(exitCode);
    return Object.freeze({
      ok: accepted,
      phase: accepted ? "completed" : "failed",
      outputRef: accepted ? outputRef : null,
      exitCode,
      receipt,
      error: accepted ? null : `unaccepted_exit_code:${exitCode}`,
      elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    });
  } catch (error) {
    adapters.abort();
    throw error;
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || message.type !== "wasm.stream.job") return;
  try {
    const result = await execute(message);
    self.postMessage({
      type: "wasm.stream.result",
      sessionId: message.sessionId,
      toolId: message.toolId,
      workerInstanceId: WORKER_INSTANCE_ID,
      ...result,
      receipt: result.receipt ? {
        ...result.receipt,
        elapsedMs: result.elapsedMs,
        workerInstanceId: WORKER_INSTANCE_ID,
      } : null,
    });
  } catch (error) {
    self.postMessage({
      type: "wasm.stream.result",
      sessionId: message.sessionId,
      toolId: message.toolId,
      ok: false,
      phase: "failed",
      outputRef: null,
      receipt: null,
      error: String(error?.message ?? error).slice(0, 1024),
      exitCode: null,
      workerInstanceId: WORKER_INSTANCE_ID,
    });
  }
});
