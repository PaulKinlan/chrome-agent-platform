// tests/local-model-inference.test.ts — Verification of on-device OPFS local model
// inference lifecycle, Gemma-4 prompt formatting, and provider resolution
// (CAP-FB-20260819-LOCAL-MODEL-MANAGEMENT-01).
// @ts-nocheck

import {
  createLocalOpfsModel,
  formatGemmaPrompt,
} from "../extension/lib/models/local-opfs-model.js";
import { LocalModelManager } from "../extension/lib/local-model-manager.js";
import { resolveModelFromConfig, PROVIDER_CHOICES } from "../extension/lib/provider.js";
import { MODEL_PRICING } from "../extension/lib/model-prices.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// In-memory mock OPFS implementation for lifecycle testing
class MemoryFileHandle {
  constructor(name, data = new Uint8Array(0)) {
    this.name = name;
    this.kind = "file";
    this._data = data;
  }
  async getFile() {
    return {
      size: this._data.byteLength,
      text: async () => new TextDecoder().decode(this._data),
      stream: () => new ReadableStream({
        start(controller) {
          controller.enqueue(this._data);
          controller.close();
        },
      }),
    };
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (chunk) => {
        chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk));
      },
      close: async () => {
        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        this._data = merged;
      },
    };
  }
}

class MemoryDirectoryHandle {
  constructor(name = "") {
    this.name = name;
    this.kind = "directory";
    this._entries = new Map();
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this._entries.has(name)) {
      if (!create) {
        const err = new Error(`Directory ${name} not found`);
        err.name = "NotFoundError";
        throw err;
      }
      this._entries.set(name, new MemoryDirectoryHandle(name));
    }
    return this._entries.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this._entries.has(name)) {
      if (!create) {
        const err = new Error(`File ${name} not found`);
        err.name = "NotFoundError";
        throw err;
      }
      this._entries.set(name, new MemoryFileHandle(name));
    }
    return this._entries.get(name);
  }
  async removeEntry(name, { recursive = false } = {}) {
    if (!this._entries.has(name)) {
      const err = new Error(`Entry ${name} not found`);
      err.name = "NotFoundError";
      throw err;
    }
    this._entries.delete(name);
  }
}

Deno.test("formatGemmaPrompt: correctly templates multi-turn messages into Gemma-4 turns", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is 2+2?" },
    { role: "assistant", content: "2+2 is 4." },
    { role: "user", content: "And 4+4?" },
  ];

  const formatted = formatGemmaPrompt(messages);
  assert(formatted.includes("<start_of_turn>user\nYou are a helpful assistant.<end_of_turn>"), "system role maps to user turn");
  assert(formatted.includes("<start_of_turn>user\nWhat is 2+2?<end_of_turn>"), "user turn formatted");
  assert(formatted.includes("<start_of_turn>model\n2+2 is 4.<end_of_turn>"), "assistant maps to model turn");
  assert(formatted.endsWith("<start_of_turn>model\n"), "prompt ends with model turn header");
});

Deno.test("LocalOpfsModel: throws actionable install error when model is not installed in OPFS", async () => {
  const rootDir = new MemoryDirectoryHandle();
  const mgr = new LocalModelManager({ rootDir });

  const model = createLocalOpfsModel({
    modelId: "gemma-4-e4b-it-qat-q4_0",
    modelManager: mgr,
  });

  let threw = false;
  try {
    await model.doGenerate({
      prompt: [{ role: "user", content: "Hello" }],
    });
  } catch (err) {
    threw = true;
    assert(err.message.includes("is not installed in OPFS"), "error must explain model is not installed");
    assert(err.message.includes("Settings -> Local models"), "error must direct user to Settings");
  }
  assert(threw, "doGenerate must throw when model is absent");
});

Deno.test("LocalOpfsModel: throws typed engine_not_bundled error when model is installed but Wasm engine is absent", async () => {
  const modelsDir = new MemoryDirectoryHandle("models");
  const gemmaDir = await modelsDir.getDirectoryHandle("gemma-4-e4b-it-qat-q4_0", { create: true });
  
  // Install mock manifest
  const manifestHandle = await gemmaDir.getFileHandle("manifest.json", { create: true });
  const writer = await manifestHandle.createWritable();
  await writer.write(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    modelId: "gemma-4-e4b-it-qat-q4_0",
    installedAt: new Date().toISOString(),
    files: [{ name: "gemma-4-E4B_q4_0-it.gguf", bytes: 100 }],
  })));
  await writer.close();

  const mgr = new LocalModelManager({ rootDir: modelsDir });
  const isInstalled = await mgr.isModelInstalled("gemma-4-e4b-it-qat-q4_0");
  assertEquals(isInstalled, true, "model must be recognized as installed");

  const model = createLocalOpfsModel({
    modelId: "gemma-4-e4b-it-qat-q4_0",
    modelManager: mgr,
  });

  // Test doGenerate throws engine_not_bundled
  let genThrew = false;
  try {
    await model.doGenerate({
      prompt: [{ role: "user", content: "Run analysis" }],
    });
  } catch (err) {
    genThrew = true;
    assert(err.message.includes("engine_not_bundled"), "must throw engine_not_bundled");
    assert(err.message.includes("not bundled in this build"), "must explain engine is not yet bundled");
  }
  assertEquals(genThrew, true, "doGenerate must throw engine_not_bundled");

  // Test doStream throws engine_not_bundled
  let streamThrew = false;
  try {
    await model.doStream({
      prompt: [{ role: "user", content: "Stream output" }],
    });
  } catch (err) {
    streamThrew = true;
    assert(err.message.includes("engine_not_bundled"), "must throw engine_not_bundled");
  }
  assertEquals(streamThrew, true, "doStream must throw engine_not_bundled");
});

Deno.test("LocalModelManager facade: downloadModel forwards injected fetchFn/fetchImpl properly", async () => {
  let fetchCalled = false;
  const mockFetch = async (url, opts) => {
    fetchCalled = true;
    return {
      ok: true,
      status: 200,
      url: "https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/gemma-4-E4B_q4_0-it.gguf?download=true",
      body: {
        getReader() {
          let read = false;
          return {
            read: async () => {
              if (read) return { done: true, value: undefined };
              read = true;
              return { done: false, value: new Uint8Array(65536) };
            },
          };
        },
      },
    };
  };

  const modelsDir = new MemoryDirectoryHandle("models");
  const mgr = new LocalModelManager({ rootDir: modelsDir });

  // Test that downloadModel passes fetchFn
  try {
    await mgr.downloadModel({
      modelId: "gemma-4-e4b-it-qat-q4_0",
      fetchFn: mockFetch,
    });
  } catch {
    // Hash check may fail on fake bytes, but fetch was called
  }
  assertEquals(fetchCalled, true, "injected fetchFn must be called by facade");
});

Deno.test("Provider layer: resolves local-opfs provider config and zero-cost pricing", async () => {
  // Provider choice registered
  const localChoice = PROVIDER_CHOICES.find((p) => p.id === "local-opfs");
  assert(localChoice, "local-opfs choice must exist in PROVIDER_CHOICES");
  assertEquals(localChoice.needsKey, false, "local-opfs needs no API key");

  // Resolution
  const resolved = await resolveModelFromConfig({
    provider: "local-opfs",
    model: "gemma-4-e4b-it-qat-q4_0",
  });

  assertEquals(resolved.providerName, "local-opfs");
  assertEquals(resolved.modelId, "gemma-4-e4b-it-qat-q4_0");
  assert(resolved.model, "resolved model instance must exist");

  // Pricing
  const price = MODEL_PRICING["gemma-4-e4b-it-qat-q4_0"];
  assert(price, "gemma-4-e4b-it-qat-q4_0 pricing exists");
  assertEquals(price.input, 0, "on-device input price is 0");
  assertEquals(price.output, 0, "on-device output price is 0");
});
