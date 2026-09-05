// OPFS authority and byte-window helpers for large bundled-tool jobs.
// Content is never carried as one Chrome message: callers append finite chunks,
// seal an opaque capability reference, and execution opens that file in a
// dedicated Worker. The only fixed limits here are identifier/path grammar.

import { decodeCanonicalBase64, encodeCanonicalBase64 } from "./wasm-base64.js";

const STREAMS_DIR = "wasm-tool-streams-v1";
const ID_RE = /^[0-9a-f]{32}$/u;
const FILES = Object.freeze({ input: "stdin.bin", stdout: "stdout.bin", stderr: "stderr.bin" });
const appendLocks = new Map();
const encoder = new TextEncoder();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function plain(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

export function newWasmStreamId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function validateWasmStreamRef(value, { kinds = ["input", "stdout"] } = {}) {
  if (!plain(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["id", "kind", "version"]) ||
      value.version !== 1 || !ID_RE.test(value.id) || !kinds.includes(value.kind)) {
    fail("wasm_stream_ref");
  }
  return Object.freeze({ version: 1, id: value.id, kind: value.kind });
}

function validateOwner(owner) {
  if (typeof owner !== "string" || owner.length === 0 || encoder.encode(owner).byteLength > 1024) {
    fail("wasm_stream_owner");
  }
  return owner;
}

async function streamsRoot(storage = navigator.storage) {
  if (!storage?.getDirectory) fail("wasm_stream_opfs_unavailable");
  const root = await storage.getDirectory();
  return await root.getDirectoryHandle(STREAMS_DIR, { create: true });
}

async function streamDirectory(id, { create = false, storage } = {}) {
  if (!ID_RE.test(id)) fail("wasm_stream_id");
  return await (await streamsRoot(storage)).getDirectoryHandle(id, { create });
}

async function writeJson(directory, name, value) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  await writer.write(JSON.stringify(value));
  await writer.close();
}

async function readJson(directory, name) {
  try {
    const handle = await directory.getFileHandle(name);
    return JSON.parse(await (await handle.getFile()).text());
  } catch {
    fail("wasm_stream_metadata");
  }
}

function metadataShape(value) {
  if (!plain(value) || value.version !== 1 || !ID_RE.test(value.id) ||
      !["input", "output"].includes(value.type) || typeof value.owner !== "string" ||
      typeof value.sealed !== "boolean" || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    fail("wasm_stream_metadata");
  }
  return value;
}

export async function createWasmStreamInput({ owner, storage } = {}) {
  const id = newWasmStreamId();
  const directory = await streamDirectory(id, { create: true, storage });
  await directory.getFileHandle(FILES.input, { create: true });
  await writeJson(directory, "authority.json", {
    version: 1,
    id,
    type: "input",
    owner: validateOwner(owner),
    sealed: false,
    bytes: 0,
    createdAt: Date.now(),
  });
  return Object.freeze({ version: 1, id, kind: "input" });
}

async function withAppendLock(id, operation) {
  const previous = appendLocks.get(id) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  appendLocks.set(id, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (appendLocks.get(id) === queued) appendLocks.delete(id);
  }
}

export async function appendWasmStreamInput({ ref, owner, bytes, storage } = {}) {
  const input = validateWasmStreamRef(ref, { kinds: ["input"] });
  if (!(bytes instanceof Uint8Array)) fail("wasm_stream_bytes");
  return await withAppendLock(input.id, async () => {
    const directory = await streamDirectory(input.id, { storage });
    const meta = metadataShape(await readJson(directory, "authority.json"));
    if (meta.type !== "input" || meta.owner !== validateOwner(owner) || meta.sealed) {
      fail("wasm_stream_authority");
    }
    const handle = await directory.getFileHandle(FILES.input);
    const file = await handle.getFile();
    if (file.size !== meta.bytes) fail("wasm_stream_size_drift");
    const writer = await handle.createWritable({ keepExistingData: true });
    try {
      await writer.seek(file.size);
      await writer.write(bytes);
      await writer.close();
    } catch (error) {
      await writer.abort?.().catch(() => {});
      throw error;
    }
    const nextBytes = file.size + bytes.byteLength;
    await writeJson(directory, "authority.json", { ...meta, bytes: nextBytes });
    return Object.freeze({ ok: true, bytes: nextBytes });
  });
}

export async function appendWasmStreamInputBase64({ ref, owner, base64, storage } = {}) {
  if (typeof base64 !== "string") fail("wasm_stream_base64");
  let bytes;
  try { bytes = decodeCanonicalBase64(base64); }
  catch { fail("wasm_stream_base64"); }
  return await appendWasmStreamInput({ ref, owner, bytes, storage });
}

export async function sealWasmStreamInput({ ref, owner, storage } = {}) {
  const input = validateWasmStreamRef(ref, { kinds: ["input"] });
  return await withAppendLock(input.id, async () => {
    const directory = await streamDirectory(input.id, { storage });
    const meta = metadataShape(await readJson(directory, "authority.json"));
    if (meta.type !== "input" || meta.owner !== validateOwner(owner)) fail("wasm_stream_authority");
    const file = await (await directory.getFileHandle(FILES.input)).getFile();
    if (file.size !== meta.bytes) fail("wasm_stream_size_drift");
    const sealed = { ...meta, sealed: true, bytes: file.size };
    await writeJson(directory, "authority.json", sealed);
    return Object.freeze({ ok: true, ref: input, bytes: file.size });
  });
}

export async function validateSealedWasmStream({ ref, owner, storage } = {}) {
  const stream = validateWasmStreamRef(ref);
  const directory = await streamDirectory(stream.id, { storage });
  const meta = metadataShape(await readJson(directory, "authority.json"));
  const expectedType = stream.kind === "input" ? "input" : "output";
  if (meta.type !== expectedType || meta.owner !== validateOwner(owner) || !meta.sealed) {
    fail("wasm_stream_authority");
  }
  const fileName = FILES[stream.kind];
  const file = await (await directory.getFileHandle(fileName)).getFile();
  if (file.size !== meta.bytes) fail("wasm_stream_size_drift");
  return Object.freeze({ ref: stream, bytes: file.size, directory, fileName });
}

export async function openWasmStreamHandles({ ref, owner, allowUnsealedOutput = false, storage } = {}) {
  const stream = validateWasmStreamRef(ref);
  const directory = await streamDirectory(stream.id, { storage });
  const meta = metadataShape(await readJson(directory, "authority.json"));
  const expectedType = stream.kind === "input" ? "input" : "output";
  if (meta.type !== expectedType || meta.owner !== validateOwner(owner) ||
      (!meta.sealed && !(allowUnsealedOutput && expectedType === "output"))) {
    fail("wasm_stream_authority");
  }
  const dataName = FILES[stream.kind];
  const dataHandle = await directory.getFileHandle(dataName);
  const file = await dataHandle.getFile();
  if (file.size !== meta.bytes) fail("wasm_stream_size_drift");
  return Object.freeze({
    meta,
    directory,
    inputFile: dataHandle,
    stdoutFile: expectedType === "output" ? dataHandle : null,
    stderrFile: expectedType === "output" ? await directory.getFileHandle(FILES.stderr) : null,
  });
}

export async function createWasmStreamOutput({ owner, storage } = {}) {
  const id = newWasmStreamId();
  const directory = await streamDirectory(id, { create: true, storage });
  await directory.getFileHandle(FILES.stdout, { create: true });
  await directory.getFileHandle(FILES.stderr, { create: true });
  await directory.getDirectoryHandle("scratch", { create: true });
  await writeJson(directory, "authority.json", {
    version: 1,
    id,
    type: "output",
    owner: validateOwner(owner),
    sealed: false,
    bytes: 0,
    createdAt: Date.now(),
  });
  return Object.freeze({ version: 1, id, kind: "stdout" });
}

export async function sealWasmStreamOutput({ ref, owner, bytes, receipt, storage } = {}) {
  const output = validateWasmStreamRef(ref, { kinds: ["stdout"] });
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !plain(receipt)) fail("wasm_stream_receipt");
  const directory = await streamDirectory(output.id, { storage });
  const meta = metadataShape(await readJson(directory, "authority.json"));
  if (meta.type !== "output" || meta.owner !== validateOwner(owner) || meta.sealed) {
    fail("wasm_stream_authority");
  }
  const file = await (await directory.getFileHandle(FILES.stdout)).getFile();
  if (file.size !== bytes) fail("wasm_stream_size_drift");
  await writeJson(directory, "receipt.json", receipt);
  await writeJson(directory, "authority.json", { ...meta, sealed: true, bytes });
  return Object.freeze({ ok: true, ref: output, bytes });
}

export async function readWasmStreamWindow({ ref, owner, offset = 0, length, storage } = {}) {
  const validated = await validateSealedWasmStream({ ref, owner, storage });
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0) fail("wasm_stream_window");
  const file = await (await validated.directory.getFileHandle(validated.fileName)).getFile();
  const end = Math.min(file.size, offset + length);
  const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
  return Object.freeze({
    ok: true,
    base64: encodeCanonicalBase64(bytes),
    offset,
    end,
    size: file.size,
    eof: end >= file.size,
  });
}

export async function readWasmStreamReceipt({ ref, owner, storage } = {}) {
  const validated = await validateSealedWasmStream({ ref, owner, storage });
  const receipt = await readJson(validated.directory, "receipt.json");
  return Object.freeze({ ok: true, ref: validated.ref, receipt });
}

export async function removeWasmStream({ ref, owner, storage } = {}) {
  const stream = validateWasmStreamRef(ref);
  const validated = await validateSealedWasmStream({ ref: stream, owner, storage });
  const meta = metadataShape(await readJson(validated.directory, "authority.json"));
  if (meta.promoted === true) {
    fail("wasm_stream_promoted", "cannot remove promoted artifact stream");
  }
  const root = await streamsRoot(storage);
  await root.removeEntry(stream.id, { recursive: true });
  return Object.freeze({ ok: true });
}

/** Trusted-host cleanup for partial output after spawn/timeout/failure. */
export async function discardWasmStream({ ref, owner, storage } = {}) {
  const stream = validateWasmStreamRef(ref);
  const directory = await streamDirectory(stream.id, { storage });
  const meta = metadataShape(await readJson(directory, "authority.json"));
  if (meta.owner !== validateOwner(owner)) fail("wasm_stream_authority");
  if (meta.promoted === true) {
    fail("wasm_stream_promoted", "cannot discard promoted artifact stream");
  }
  const root = await streamsRoot(storage);
  await root.removeEntry(stream.id, { recursive: true });
  return Object.freeze({ ok: true });
}

export async function listWasmStreamEntries({ storage } = {}) {
  const root = await streamsRoot(storage);
  const out = [];
  try {
    for await (const [name, handle] of root.entries()) {
      if (ID_RE.test(name) && handle.kind === "directory") {
        try {
          const meta = await readJson(handle, "authority.json");
          out.push({ id: name, meta });
        } catch {
          out.push({ id: name, meta: null });
        }
      }
    }
  } catch { /* empty or non-iterable */ }
  return out;
}

export const WASM_STREAM_FILE_NAMES = FILES;
export const WASM_STREAM_ROOT_NAME = STREAMS_DIR;
