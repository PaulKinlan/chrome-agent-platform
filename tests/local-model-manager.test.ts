// tests/local-model-manager.test.ts — Rigorous unit and contract tests for
// local model streaming download, Range resume, chunked SHA-256 verification,
// O(1) memory promotion, and user deletion (CAP-FB-20260819-LOCAL-MODEL-MANAGEMENT-01).
// @ts-nocheck

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  getCatalogModel,
  getModelsOpfsRoot,
  downloadLocalModel,
  deleteLocalModel,
  listInstalledModels,
  verifyModelIntegrity,
  StreamingSha256,
} from "../extension/lib/local-model-manager.js";
import { LOCAL_MODEL_CATALOG } from "../extension/lib/local-model-catalog.js";

// ---- In-Memory OPFS Mock Directory & File Handles ----
class MemoryFileHandle {
  constructor(name, initialBytes = new Uint8Array(0)) {
    this.name = name;
    this.kind = "file";
    this._bytes = new Uint8Array(initialBytes);
  }

  async getFile() {
    const bytes = this._bytes;
    return {
      name: this.name,
      size: bytes.byteLength,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      slice: (start, end) => ({
        stream: () => new Blob([bytes.subarray(start, end ?? bytes.byteLength)]).stream(),
      }),
      stream: () => new Blob([bytes]).stream(),
    };
  }

  async createWritable({ keepExistingData = false } = {}) {
    let buffer = keepExistingData ? new Uint8Array(this._bytes) : new Uint8Array(0);
    let position = 0;
    const self = this;

    return {
      async seek(pos) {
        position = pos;
      },
      async write(chunk) {
        const chunkBytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        const needed = position + chunkBytes.byteLength;
        if (needed > buffer.byteLength) {
          const next = new Uint8Array(needed);
          next.set(buffer, 0);
          buffer = next;
        }
        buffer.set(chunkBytes, position);
        position += chunkBytes.byteLength;
      },
      async close() {
        self._bytes = buffer;
      },
      async abort() {},
    };
  }
}

class MemoryDirectoryHandle {
  constructor(name = "root") {
    this.name = name;
    this.kind = "directory";
    this._entries = new Map();
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    if (this._entries.has(name)) {
      const e = this._entries.get(name);
      if (e.kind === "directory") return e;
      throw new Error(`Entry "${name}" is not a directory`);
    }
    if (!create) {
      const err = new Error(`Directory "${name}" not found`);
      err.name = "NotFoundError";
      err.code = "ENOENT";
      throw err;
    }
    const dir = new MemoryDirectoryHandle(name);
    this._entries.set(name, dir);
    return dir;
  }

  async getFileHandle(name, { create = false } = {}) {
    if (this._entries.has(name)) {
      const e = this._entries.get(name);
      if (e.kind === "file") return e;
      throw new Error(`Entry "${name}" is not a file`);
    }
    if (!create) {
      const err = new Error(`File "${name}" not found`);
      err.name = "NotFoundError";
      err.code = "ENOENT";
      throw err;
    }
    const file = new MemoryFileHandle(name);
    this._entries.set(name, file);
    return file;
  }

  async removeEntry(name, { recursive = false } = {}) {
    if (!this._entries.has(name)) {
      const err = new Error(`Entry "${name}" not found`);
      err.name = "NotFoundError";
      err.code = "ENOENT";
      throw err;
    }
    this._entries.delete(name);
  }

  async *entries() {
    for (const [k, v] of this._entries) {
      yield [k, v];
    }
  }
}

const makeMockResponse = (body, opts = {}, url = "https://huggingface.co/google/gemma-4-test-128k/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/model.gguf") => {
  const resp = new Response(body, opts);
  Object.defineProperty(resp, "url", { value: url, configurable: true });
  return resp;
};

function computeOneShotSha256(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then((d) =>
    [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")
  );
}

Deno.test("StreamingSha256: streaming hash matches one-shot across small and multi-chunk payloads", async () => {
  const payloads = [
    new Uint8Array(0),
    new TextEncoder().encode("Hello world\n"),
    new Uint8Array(64).fill(0x42), // exactly 1 block
    new Uint8Array(65).fill(0x43), // 1 block + 1 byte
    new Uint8Array(1000).fill(0xaa),
    new Uint8Array(128 * 1024).map((_, i) => i % 256), // 128 KiB multi-chunk
  ];

  for (const p of payloads) {
    const expected = await computeOneShotSha256(p);
    const hasher = new StreamingSha256();
    // Feed in small arbitrary chunk sizes (e.g. 17 bytes)
    for (let i = 0; i < p.length; i += 17) {
      hasher.update(p.subarray(i, Math.min(p.length, i + 17)));
    }
    const actual = hasher.digestHex();
    assertEquals(actual, expected, `Hash mismatch for payload length ${p.length}`);
  }
});

Deno.test("getCatalogModel: retrieves catalog models and rejects unknown IDs", () => {
  const gemma = getCatalogModel("gemma-4-e4b-it-qat-q4_0");
  assert(gemma !== null);
  assertEquals(gemma.publisher, "Google");

  const unknown = getCatalogModel("nonexistent-model-xyz");
  assertEquals(unknown, null);
});

Deno.test("downloadLocalModel: multi-chunk streaming download, integrity verification, manifest creation, and delete", async () => {
  const opfsRoot = new MemoryDirectoryHandle("opfs-root");
  const testBytes = new Uint8Array(128 * 1024).map((_, i) => i % 256); // 128 KiB
  const testSha256 = await computeOneShotSha256(testBytes);

  const modelFixture = {
    id: "gemma-4-test-128k",
    name: "Gemma 4 Test 128K Model",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-test-128k",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    installedBytes: 128 * 1024,
    installedGiB: "128 KiB",
    files: [
      {
        role: "model",
        name: "model.gguf",
        bytes: 128 * 1024,
        sha256: testSha256,
        url: "https://huggingface.co/google/gemma-4-test-128k/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/model.gguf",
      },
    ],
  };

  const catalog = [modelFixture];
  const progressList = [];

  const mockFetch = async (url) => {
    return makeMockResponse(new Blob([testBytes]).stream(), {
      status: 200,
      headers: { "Content-Length": String(testBytes.byteLength) },
    }, url);
  };

  const res = await downloadLocalModel({
    modelId: "gemma-4-test-128k",
    opfsRoot,
    catalog,
    fetchImpl: mockFetch,
    onProgress: (p) => progressList.push(p),
  });

  assert(res.ok);
  assertEquals(res.manifest.status, "installed");
  assertEquals(res.manifest.integrityVerified, true);
  assert(progressList.length >= 2);

  // Assert listInstalledModels finds the installed model
  const list = await listInstalledModels({ opfsRoot, catalog });
  assertEquals(list.length, 1);
  assertEquals(list[0].id, "gemma-4-test-128k");

  // Assert verifyModelIntegrity passes
  const integrity = await verifyModelIntegrity({ modelId: "gemma-4-test-128k", opfsRoot, catalog });
  assert(integrity.ok);
  assertEquals(integrity.integrityVerified, true);

  // Assert user-controlled deletion cleans the directory
  const delRes = await deleteLocalModel({ modelId: "gemma-4-test-128k", opfsRoot });
  assert(delRes.ok);
  assertEquals(delRes.deleted, true);

  const emptyList = await listInstalledModels({ opfsRoot, catalog });
  assertEquals(emptyList.length, 0);
});

Deno.test("downloadLocalModel: Range resume with partial .part file and prefix hash continuity", async () => {
  const opfsRoot = new MemoryDirectoryHandle("opfs-root");
  const fullBytes = new Uint8Array(64 * 1024).map((_, i) => (i + 1) % 256); // 64 KiB
  const fullSha = await computeOneShotSha256(fullBytes);

  const modelFixture = {
    id: "gemma-4-resume-model",
    name: "Gemma 4 Resume Test",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-resume-model",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    installedBytes: 64 * 1024,
    installedGiB: "64 KiB",
    files: [
      {
        role: "model",
        name: "resumable.gguf",
        bytes: 64 * 1024,
        sha256: fullSha,
        url: "https://huggingface.co/google/gemma-4-resume-model/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/resumable.gguf",
      },
    ],
  };

  const catalog = [modelFixture];

  // Pre-seed a partial .part file with first 16 KiB
  const modelDir = await opfsRoot.getDirectoryHandle("gemma-4-resume-model", { create: true });
  const partHandle = await modelDir.getFileHandle("resumable.gguf.part", { create: true });
  const writable = await partHandle.createWritable();
  await writable.write(fullBytes.subarray(0, 16 * 1024));
  await writable.close();

  let receivedRangeHeader = null;
  const mockResumeFetch = async (url, opts = {}) => {
    receivedRangeHeader = opts.headers?.Range;
    const slice = fullBytes.subarray(16 * 1024);
    return makeMockResponse(new Blob([slice]).stream(), {
      status: 206,
      headers: {
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes 16384-65535/65536`,
      },
    }, url);
  };

  const res = await downloadLocalModel({
    modelId: "gemma-4-resume-model",
    opfsRoot,
    catalog,
    fetchImpl: mockResumeFetch,
  });

  assert(res.ok);
  assertEquals(receivedRangeHeader, "bytes=16384-65535");
  assertEquals(res.manifest.status, "installed");
  assertEquals(res.manifest.integrityVerified, true);
});

Deno.test("downloadLocalModel: HTTP 200 fallback restarts download from byte 0 when 206 is not supported", async () => {
  const opfsRoot = new MemoryDirectoryHandle("opfs-root");
  const fullBytes = new TextEncoder().encode("restart from beginning\n");
  const fullSha = await computeOneShotSha256(fullBytes);

  const modelFixture = {
    id: "gemma-4-restart-model",
    name: "Gemma 4 Restart Test",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-restart-model",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    installedBytes: fullBytes.byteLength,
    installedGiB: "24 B",
    files: [
      {
        role: "model",
        name: "restart.gguf",
        bytes: fullBytes.byteLength,
        sha256: fullSha,
        url: "https://huggingface.co/google/gemma-4-restart-model/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/restart.gguf",
      },
    ],
  };

  const catalog = [modelFixture];

  // Seed stale part file
  const modelDir = await opfsRoot.getDirectoryHandle("gemma-4-restart-model", { create: true });
  const partHandle = await modelDir.getFileHandle("restart.gguf.part", { create: true });
  const writable = await partHandle.createWritable();
  await writable.write(new TextEncoder().encode("stale bytes"));
  await writable.close();

  // Server replies with HTTP 200 (restarting from 0)
  const mockRestartFetch = async (url) => {
    return makeMockResponse(new Blob([fullBytes]).stream(), {
      status: 200,
      headers: { "Content-Length": String(fullBytes.byteLength) },
    }, url);
  };

  const res = await downloadLocalModel({
    modelId: "gemma-4-restart-model",
    opfsRoot,
    catalog,
    fetchImpl: mockRestartFetch,
  });

  assert(res.ok);
  assertEquals(res.manifest.status, "installed");
});

Deno.test("downloadLocalModel: aborts mid-stream when signal is triggered", async () => {
  const opfsRoot = new MemoryDirectoryHandle("opfs-root");
  const modelFixture = {
    id: "gemma-4-abort-model",
    name: "Gemma 4 Abort Test",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-abort-model",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    installedBytes: 1000,
    installedGiB: "1000 B",
    files: [
      {
        role: "model",
        name: "abort.gguf",
        bytes: 1000,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        url: "https://huggingface.co/google/gemma-4-abort-model/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/abort.gguf",
      },
    ],
  };

  const catalog = [modelFixture];
  const controller = new AbortController();

  const mockInfiniteFetch = async (url) => {
    let sent = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (sent >= 500) {
          controller.abort("User cancelled");
        }
        sent += 100;
        c.enqueue(new Uint8Array(100));
      },
    });
    return makeMockResponse(stream, { status: 200 }, url);
  };

  await assertRejects(
    async () => {
      await downloadLocalModel({
        modelId: "gemma-4-abort-model",
        opfsRoot,
        catalog,
        signal: controller.signal,
        fetchImpl: mockInfiniteFetch,
      });
    },
    Error,
    "download_aborted",
  );
});

Deno.test("downloadLocalModel: fails closed on size mismatch or SHA-256 corruption", async () => {
  const opfsRoot = new MemoryDirectoryHandle("opfs-root");
  const modelFixture = {
    id: "gemma-4-corrupt-model",
    name: "Gemma 4 Corrupt Test",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-corrupt-model",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    installedBytes: 10,
    installedGiB: "10 B",
    files: [
      {
        role: "model",
        name: "corrupt.gguf",
        bytes: 10,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        url: "https://huggingface.co/google/gemma-4-corrupt-model/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/corrupt.gguf",
      },
    ],
  };

  const catalog = [modelFixture];

  // 1. Size mismatch (fewer bytes)
  const shortFetch = async (url) => makeMockResponse(new Uint8Array(5), { status: 200 }, url);
  await assertRejects(
    async () => {
      await downloadLocalModel({
        modelId: "gemma-4-corrupt-model",
        opfsRoot,
        catalog,
        fetchImpl: shortFetch,
      });
    },
    Error,
    "size_mismatch",
  );

  const corruptFetch = async (url) => makeMockResponse(new Uint8Array(10).fill(0xff), { status: 200 }, url);
  await assertRejects(
    async () => {
      await downloadLocalModel({
        modelId: "gemma-4-corrupt-model",
        opfsRoot,
        catalog,
        fetchImpl: corruptFetch,
      });
    },
    Error,
    "integrity_mismatch",
  );

  // Corrupt model must not have manifest in OPFS
  const list = await listInstalledModels({ opfsRoot, catalog });
  assertEquals(list.length, 0);
});

Deno.test("downloadLocalModel: verified-existing skips re-downloading existing verified files", async () => {
  const opfsRoot = new MemoryDirectoryHandle("opfs-root");
  const bytes = new TextEncoder().encode("already downloaded\n");
  const sha = await computeOneShotSha256(bytes);

  const modelFixture = {
    id: "gemma-4-existing-model",
    name: "Gemma 4 Existing Test",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-existing-model",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    installedBytes: bytes.byteLength,
    installedGiB: "20 B",
    files: [
      {
        role: "model",
        name: "existing.gguf",
        bytes: bytes.byteLength,
        sha256: sha,
        url: "https://huggingface.co/google/gemma-4-existing-model/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/existing.gguf",
      },
    ],
  };

  const catalog = [modelFixture];

  // Pre-seed final verified file
  const modelDir = await opfsRoot.getDirectoryHandle("gemma-4-existing-model", { create: true });
  const fileHandle = await modelDir.getFileHandle("existing.gguf", { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();

  let fetchCalled = false;
  const mockFetch = async () => {
    fetchCalled = true;
    return new Response("error", { status: 500 });
  };

  const progress = [];
  const res = await downloadLocalModel({
    modelId: "gemma-4-existing-model",
    opfsRoot,
    catalog,
    fetchImpl: mockFetch,
    onProgress: (p) => progress.push(p),
  });

  assert(res.ok);
  assertEquals(fetchCalled, false, "fetch must not be called when file is verified existing");
  assert(progress.some((p) => p.phase === "verified-existing"));
});

Deno.test("downloadLocalModel: multi-file progress math calculates cumulative overall percentage", async () => {
  const opfsRoot = new MemoryDirectoryHandle("opfs-root");
  const file1 = new Uint8Array(1000).fill(1);
  const file2 = new Uint8Array(3000).fill(2);
  const sha1 = await computeOneShotSha256(file1);
  const sha2 = await computeOneShotSha256(file2);

  const modelFixture = {
    id: "gemma-4-multi-file",
    name: "Gemma 4 Multi File Test",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-multi-file",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    installedBytes: 4000,
    installedGiB: "4000 B",
    files: [
      {
        role: "model",
        name: "part1.gguf",
        bytes: 1000,
        sha256: sha1,
        url: "https://huggingface.co/google/gemma-4-multi-file/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/part1.gguf",
      },
      {
        role: "multimodal projector",
        name: "part2.gguf",
        bytes: 3000,
        sha256: sha2,
        url: "https://huggingface.co/google/gemma-4-multi-file/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/part2.gguf",
      },
    ],
  };

  const catalog = [modelFixture];
  const progressList = [];

  const mockMultiFetch = async (url) => {
    const data = url.includes("part1") ? file1 : file2;
    return makeMockResponse(new Blob([data]).stream(), { status: 200 }, url);
  };

  const res = await downloadLocalModel({
    modelId: "gemma-4-multi-file",
    opfsRoot,
    catalog,
    fetchImpl: mockMultiFetch,
    onProgress: (p) => progressList.push(p),
  });

  assert(res.ok);
  assertEquals(res.manifest.files.length, 2);
  const lastProgress = progressList.at(-1);
  assertEquals(lastProgress.percent, 100);
  assertEquals(lastProgress.loadedBytes, 4000);
  assertEquals(lastProgress.totalBytes, 4000);
});

Deno.test("downloadLocalModel: rejects untrusted delivery URLs and non-publisher URLs", async () => {
  const opfsRoot = new MemoryDirectoryHandle("opfs-root");
  const modelFixture = {
    id: "gemma-4-untrusted",
    name: "Gemma 4 Untrusted Test",
    publisher: "Google",
    license: "Apache-2.0",
    repo: "google/gemma-4-untrusted",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    installedBytes: 10,
    installedGiB: "10 B",
    files: [
      {
        role: "model",
        name: "model.gguf",
        bytes: 10,
        sha256: "0000",
        url: "https://huggingface.co/google/gemma-4-untrusted/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/model.gguf",
      },
    ],
  };

  const catalog = [modelFixture];

  // Mock response redirected to untrusted domain
  const untrustedRedirectFetch = async () => {
    return new Response(new Uint8Array(10), {
      status: 200,
      url: "https://attacker-cdn.com/stolen-model.gguf",
    });
  };

  await assertRejects(
    async () => {
      await downloadLocalModel({
        modelId: "gemma-4-untrusted",
        opfsRoot,
        catalog,
        fetchImpl: untrustedRedirectFetch,
      });
    },
    Error,
    "untrusted_delivery_url",
  );
});
