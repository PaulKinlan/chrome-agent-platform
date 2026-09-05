// File-backed external merge sort for the bundled WASI sort kernel.
// Runs are line-complete and bounded by bytes/record count; a line larger than
// one run becomes a zero-copy singleton run, so no content-size ceiling leaks
// into Wasm linear memory. Pairwise merges compare OPFS ranges incrementally.

import { createWasiPreview1Runtime } from "./wasi-preview1-runtime.js";
import { createSyncWorkspace } from "./wasm-sync-workspace.js";
import { WasiProcExit } from "./wasm-host-types.js";

const RUN_BYTES = 4 * 1024 * 1024;
const RUN_LINES = 32768;
const IO_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function fail(message) { throw new Error(message); }

function startWasiInstance(instance) {
  const fn = typeof instance?.exports?._start === "function"
    ? instance.exports._start
    : typeof instance?.exports?.run === "function" ? instance.exports.run : null;
  if (!fn) fail("sort_kernel_export_missing");
  try { fn(); return 0; }
  catch (error) {
    if (error instanceof WasiProcExit) return error.code;
    throw error;
  }
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
      if (!buffer || pointer + bytes.byteLength > buffer.byteLength) fail("sort_kernel_memory");
      new Uint8Array(buffer, pointer, bytes.byteLength).set(bytes);
    },
  };
}

function writeAll(access, bytes, offset) {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = access.write(bytes.subarray(written), { at: offset + written });
    if (count <= 0) fail("sort_scratch_write_failed");
    written += count;
  }
  return offset + written;
}

function readAt(access, offset, length) {
  const bytes = new Uint8Array(length);
  const count = access.read(bytes, { at: offset });
  return count === length ? bytes : bytes.subarray(0, Math.max(0, count));
}

function copyRange(source, start, end, sink) {
  for (let offset = start; offset < end;) {
    const bytes = readAt(source, offset, Math.min(IO_BYTES, end - offset));
    if (bytes.byteLength === 0) fail("sort_scratch_read_failed");
    sink(bytes);
    offset += bytes.byteLength;
  }
}

function parseSortArgs(args) {
  let numeric = false, reverse = false, unique = false;
  if (!Array.isArray(args)) fail("sort_arguments");
  for (const arg of args) {
    if (typeof arg !== "string" || arg[0] !== "-" || arg.length < 2) fail("sort_arguments");
    for (const option of arg.slice(1)) {
      if (option === "n") numeric = true;
      else if (option === "r") reverse = true;
      else if (option === "u") unique = true;
      else fail(`sort_unsupported_option:${option}`);
    }
  }
  return Object.freeze({ numeric, reverse, unique });
}

class LineCursor {
  constructor(access) {
    this.access = access;
    this.offset = 0;
    this.size = access.getSize();
  }

  next() {
    if (this.offset >= this.size) return null;
    const start = this.offset;
    for (let position = start; position < this.size;) {
      const bytes = readAt(this.access, position, Math.min(IO_BYTES, this.size - position));
      if (bytes.byteLength === 0) fail("sort_run_read_failed");
      const newline = bytes.indexOf(10);
      if (newline >= 0) {
        const end = position + newline;
        this.offset = end + 1;
        return Object.freeze({ access: this.access, start, end });
      }
      position += bytes.byteLength;
    }
    this.offset = this.size;
    return Object.freeze({ access: this.access, start, end: this.size });
  }
}

function compareSpan(a, aStart, aLength, b, bStart, bLength, padWithZero = false) {
  const length = padWithZero ? Math.max(aLength, bLength) : Math.min(aLength, bLength);
  for (let offset = 0; offset < length; offset += IO_BYTES) {
    const count = Math.min(IO_BYTES, length - offset);
    const left = offset < aLength
      ? readAt(a, aStart + offset, Math.min(count, aLength - offset))
      : new Uint8Array();
    const right = offset < bLength
      ? readAt(b, bStart + offset, Math.min(count, bLength - offset))
      : new Uint8Array();
    for (let index = 0; index < count; index++) {
      const av = index < left.byteLength ? left[index] : 48;
      const bv = index < right.byteLength ? right[index] : 48;
      if (av !== bv) return av < bv ? -1 : 1;
    }
  }
  if (!padWithZero && aLength !== bLength) return aLength < bLength ? -1 : 1;
  return 0;
}

function compareLexical(a, b) {
  return compareSpan(a.access, a.start, a.end - a.start, b.access, b.start, b.end - b.start);
}

function numericKey(ref) {
  let position = ref.start;
  let chunk = new Uint8Array();
  let chunkStart = position;
  const nextByte = () => {
    if (position >= ref.end) return -1;
    if (position < chunkStart || position >= chunkStart + chunk.byteLength) {
      chunkStart = position;
      chunk = readAt(ref.access, position, Math.min(IO_BYTES, ref.end - position));
      if (chunk.byteLength === 0) fail("sort_numeric_read_failed");
    }
    return chunk[position++ - chunkStart];
  };
  let byte = nextByte();
  while ([9, 11, 12, 13, 32].includes(byte)) byte = nextByte();
  let negative = false;
  if (byte === 43 || byte === 45) { negative = byte === 45; byte = nextByte(); }
  let integerFirst = -1, integerLength = 0, sawDigit = false;
  while (byte >= 48 && byte <= 57) {
    sawDigit = true;
    if (byte !== 48 || integerFirst >= 0) {
      if (integerFirst < 0) integerFirst = position - 1;
      integerLength++;
    }
    byte = nextByte();
  }
  let fractionStart = position;
  let fractionSignificantLength = 0;
  if (byte === 46) {
    fractionStart = position;
    let fractionLength = 0;
    byte = nextByte();
    while (byte >= 48 && byte <= 57) {
      sawDigit = true;
      fractionLength++;
      if (byte !== 48) fractionSignificantLength = fractionLength;
      byte = nextByte();
    }
  }
  const nonzero = integerLength > 0 || fractionSignificantLength > 0;
  return Object.freeze({
    negative: nonzero && negative,
    integerFirst: integerFirst < 0 ? position : integerFirst,
    integerLength,
    fractionStart,
    fractionLength: fractionSignificantLength,
    sawDigit,
  });
}

function compareNumeric(a, b) {
  const ak = numericKey(a), bk = numericKey(b);
  if (ak.negative !== bk.negative) return ak.negative ? -1 : 1;
  let absolute;
  if (ak.integerLength !== bk.integerLength) absolute = ak.integerLength < bk.integerLength ? -1 : 1;
  else {
    absolute = compareSpan(a.access, ak.integerFirst, ak.integerLength,
      b.access, bk.integerFirst, bk.integerLength);
    if (absolute === 0) {
      absolute = compareSpan(a.access, ak.fractionStart, ak.fractionLength,
        b.access, bk.fractionStart, bk.fractionLength, true);
    }
  }
  return ak.negative ? -absolute : absolute;
}

function compareLines(a, b, options) {
  let order = options.numeric ? compareNumeric(a, b) : compareLexical(a, b);
  if (order === 0 && options.numeric) order = compareLexical(a, b);
  return options.reverse ? -order : order;
}

async function createRun(scratchDirectory, name) {
  const handle = await scratchDirectory.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  return { name, handle, access };
}

async function sortRange({ source, start, end, singleton, scratchDirectory, name, wasmBytes, job, stderr, instantiateWasi }) {
  const run = await createRun(scratchDirectory, name);
  try {
    if (singleton) {
      let offset = 0;
      copyRange(source, start, end, (bytes) => { offset = writeAll(run.access, bytes, offset); });
      if (offset === 0 || readAt(run.access, offset - 1, 1)[0] !== 10) {
        offset = writeAll(run.access, new Uint8Array([10]), offset);
      }
    } else {
      let inputOffset = start, outputOffset = 0;
      let instance = null;
      const runtime = createWasiPreview1Runtime({
        job: { ...job, stdin: new Uint8Array() },
        memory: runtimeMemory(() => instance),
        workspace: createSyncWorkspace({ root: job.context.workspaceRoot, seed: job.workspaceSeed }),
        stdio: {
          readStdin(_offset, maxBytes) {
            if (inputOffset >= end) return new Uint8Array();
            const bytes = readAt(source, inputOffset, Math.min(maxBytes, end - inputOffset));
            inputOffset += bytes.byteLength;
            return bytes;
          },
          writeStdout(_offset, bytes) {
            outputOffset = writeAll(run.access, bytes, outputOffset);
            return bytes.byteLength;
          },
          writeStderr(_offset, bytes) { return stderr.write(bytes); },
        },
      });
      instance = await instantiateWasi(wasmBytes, runtime);
      const exitCode = startWasiInstance(instance);
      if (exitCode !== 0) fail(`sort_kernel_exit:${exitCode}`);
    }
    run.access.flush();
    run.access.close();
    return Object.freeze({ name, handle: run.handle });
  } catch (error) {
    try { run.access.close(); } catch {}
    throw error;
  }
}

async function mergePair({ left, right, scratchDirectory, name, options }) {
  const leftAccess = await left.handle.createSyncAccessHandle();
  const rightAccess = await right.handle.createSyncAccessHandle();
  const merged = await createRun(scratchDirectory, name);
  let outputOffset = 0;
  try {
    const leftCursor = new LineCursor(leftAccess), rightCursor = new LineCursor(rightAccess);
    let a = leftCursor.next(), b = rightCursor.next();
    const emit = (line) => {
      copyRange(line.access, line.start, line.end, (bytes) => {
        outputOffset = writeAll(merged.access, bytes, outputOffset);
      });
      outputOffset = writeAll(merged.access, new Uint8Array([10]), outputOffset);
    };
    while (a && b) {
      const lexical = compareLexical(a, b);
      if (options.unique && lexical === 0) { emit(a); a = leftCursor.next(); b = rightCursor.next(); continue; }
      if (compareLines(a, b, options) <= 0) { emit(a); a = leftCursor.next(); }
      else { emit(b); b = rightCursor.next(); }
    }
    while (a) { emit(a); a = leftCursor.next(); }
    while (b) { emit(b); b = rightCursor.next(); }
    merged.access.flush();
    merged.access.close();
    leftAccess.close();
    rightAccess.close();
    return Object.freeze({ name, handle: merged.handle });
  } catch (error) {
    try { merged.access.close(); } catch {}
    try { leftAccess.close(); } catch {}
    try { rightAccess.close(); } catch {}
    throw error;
  }
}

export async function runExternalSort({ wasmBytes, args, job, inputAccess, stdin, stdout, stderr, scratchDirectory, instantiateWasi }) {
  const options = parseSortArgs(args);
  if (typeof instantiateWasi !== "function") fail("sort_kernel_host");
  const runs = [];
  let runNumber = 0;
  let absolute = 0, batchStart = 0, lineStart = 0, lineCount = 0;
  const flushRange = async (start, end, singleton = false) => {
    if (end <= start) return;
    runs.push(await sortRange({
      source: inputAccess, start, end, singleton, scratchDirectory,
      name: `run-${runNumber++}.bin`, wasmBytes, job, stderr, instantiateWasi,
    }));
  };

  for (;;) {
    const bytes = stdin.read(256 * 1024);
    if (bytes.byteLength === 0) break;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (bytes[index] !== 10) continue;
      const lineEnd = absolute + index + 1;
      const lineLength = lineEnd - lineStart;
      if (lineLength > RUN_BYTES) {
        await flushRange(batchStart, lineStart);
        await flushRange(lineStart, lineEnd, true);
        batchStart = lineEnd;
        lineCount = 0;
      } else {
        lineCount++;
        if (lineEnd - batchStart >= RUN_BYTES || lineCount >= RUN_LINES) {
          await flushRange(batchStart, lineEnd);
          batchStart = lineEnd;
          lineCount = 0;
        }
      }
      lineStart = lineEnd;
    }
    absolute += bytes.byteLength;
  }
  if (lineStart < absolute && absolute - lineStart > RUN_BYTES) {
    await flushRange(batchStart, lineStart);
    await flushRange(lineStart, absolute, true);
    batchStart = absolute;
  }
  await flushRange(batchStart, absolute);

  let round = 0;
  try {
    let active = runs;
    while (active.length > 1) {
      const next = [];
      for (let index = 0; index < active.length; index += 2) {
        if (index + 1 >= active.length) { next.push(active[index]); continue; }
        const merged = await mergePair({
          left: active[index], right: active[index + 1], scratchDirectory,
          name: `merge-${round}-${index >> 1}.bin`, options,
        });
        await scratchDirectory.removeEntry(active[index].name);
        await scratchDirectory.removeEntry(active[index + 1].name);
        next.push(merged);
      }
      active = next;
      round++;
    }
    if (active.length === 1) {
      const finalAccess = await active[0].handle.createSyncAccessHandle();
      try { copyRange(finalAccess, 0, finalAccess.getSize(), (bytes) => stdout.write(bytes)); }
      finally { finalAccess.close(); }
      await scratchDirectory.removeEntry(active[0].name);
    }
    return 0;
  } catch (error) {
    try { stderr.write(encoder.encode(`sort: ${String(error?.message ?? error)}\n`)); } catch {}
    throw error;
  }
}

export const EXTERNAL_SORT_PROFILE = Object.freeze({ runBytes: RUN_BYTES, runLines: RUN_LINES, ioBytes: IO_BYTES });
