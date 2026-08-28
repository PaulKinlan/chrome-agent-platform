// run-log-wal-memory.js — an in-memory run-log handle factory.
//
// The durable-run registry takes `logHandleFor` for the same reason it takes
// `store`: a caller that supplies its own storage must be able to supply all of
// it, or the registry reaches past its injected dependencies to real OPFS.
// This is the in-memory implementation of that seam.
//
// It lives in lib/ rather than a test file because three suites already need it
// and copying a storage double is how the 20 OPFS fakes drifted into all
// silently corrupting byte writes. It models FileSystemWritableFileStream
// faithfully — including `seek`, whose absence in an earlier hand-rolled double
// made every append double the file.
export function createMemoryRunLogHandles({ failWriteFor = null } = {}) {
  const files = new Map();
  // `failWriteFor(executionId)` lets a test inject a log-write failure. Storage
  // faults used to be injected on the key-value store; the registry's own rows
  // are written to the LOG now, so the fault has to be injectable where the
  // write actually happens.
  return (executionId, { create = false } = {}) => {
    const id = String(executionId ?? "");
    let node = files.get(id);
    if (!node) {
      if (!create) return Promise.resolve(null);
      node = { content: "" };
      files.set(id, node);
    }
    return Promise.resolve({
      async getFile() {
        const bytes = new TextEncoder().encode(node.content);
        return {
          size: bytes.length,
          async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); },
          slice(a, b) {
            const sub = bytes.subarray(a, b);
            return { async arrayBuffer() { return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.length); } };
          },
          async text() { return node.content; },
        };
      },
      async createWritable({ keepExistingData = false } = {}) {
        let buf = keepExistingData ? node.content : "";
        let pos = 0;
        return {
          async seek(p) { pos = p; },
          async write(chunk) {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            buf = buf.slice(0, pos) + text + buf.slice(pos + text.length);
            pos += text.length;
          },
          async close() {
            if (typeof failWriteFor === "function" && failWriteFor(id)) throw new Error("quota exceeded");
            node.content = buf;
          },
        };
      },
    });
  };
}
