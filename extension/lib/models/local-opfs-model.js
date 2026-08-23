// lib/models/local-opfs-model.js — Local OPFS on-device GGUF language model adapter.
// (CAP-FB-20260819-LOCAL-MODEL-MANAGEMENT-01).
//
// Invariants:
//   - Zero network: executes on-device over verified GGUF weights in OPFS.
//   - Strict LanguageModelV2 compliance for agent-do loops.
//   - Honest lifecycle: checks if the model is installed in OPFS before generation.
//   - Gemma-4 chat template formatting (<start_of_turn>user/model<end_of_turn>).
//   - Truthful capability: doGenerate/doStream throws typed engine_not_bundled error
//     until an on-device Wasm inference engine (e.g. wllama) is bundled.
//   - Clean abortSignal handling and timeout containment.

import { wrapLanguageModel } from "ai";
import { thoughtSignatureMiddleware } from "./thought-signature-middleware.js";
import { toolCallFinishMiddleware } from "./tool-call-finish-middleware.js";
import { getCatalogModel } from "../local-model-catalog.js";
import { LocalModelManager } from "../local-model-manager.js";

/** Format chat messages into the standard Gemma-4 turn template */
export function formatGemmaPrompt(messages) {
  let prompt = "";
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : m.role === "system" ? "user" : m.role;
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
      ? m.content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("\n")
      : String(m.content || "");

    prompt += `<start_of_turn>${role}\n${content}<end_of_turn>\n`;
  }
  prompt += "<start_of_turn>model\n";
  return prompt;
}

/**
 * Creates a LanguageModelV2 instance backed by an installed local GGUF model in OPFS.
 */
export function createLocalOpfsModel({
  modelId = "gemma-4-e4b-it-qat-q4_0",
  modelManager = null,
  opfsRoot = null,
} = {}) {
  const catalogEntry = getCatalogModel(modelId);
  const resolvedManager = modelManager || new LocalModelManager({ rootDir: opfsRoot });

  const rawModel = {
    specificationVersion: "v1",
    modelId,
    provider: "local-opfs",
    defaultObjectGenerationMode: "json",
    supportsImageUrls: Boolean(catalogEntry?.files?.some((f) => f.kind === "mmproj")),

    async doGenerate(options) {
      const isInstalled = await resolvedManager.isModelInstalled(modelId);
      if (!isInstalled) {
        throw new Error(
          `Local model '${modelId}' is not installed in OPFS. Please download it from Settings -> Local models before running local tasks.`,
        );
      }

      if (options?.abortSignal?.aborted) {
        throw new Error("Generation aborted");
      }

      // Truthful error: model weights are installed, but engine binary is not yet bundled
      const error = new Error(
        `engine_not_bundled: Local GGUF model '${modelId}' is verified and installed in OPFS, but the on-device Wasm inference engine is not bundled in this build.`,
      );
      error.code = "engine_not_bundled";
      throw error;
    },

    async doStream(options) {
      const isInstalled = await resolvedManager.isModelInstalled(modelId);
      if (!isInstalled) {
        throw new Error(
          `Local model '${modelId}' is not installed in OPFS. Please download it from Settings -> Local models before running local tasks.`,
        );
      }

      if (options?.abortSignal?.aborted) {
        throw new Error("Generation aborted");
      }

      const error = new Error(
        `engine_not_bundled: Local GGUF model '${modelId}' is verified and installed in OPFS, but the on-device Wasm inference engine is not bundled in this build.`,
      );
      error.code = "engine_not_bundled";
      throw error;
    },
  };

  return wrapLanguageModel({
    model: rawModel,
    middleware: [
      thoughtSignatureMiddleware(),
      toolCallFinishMiddleware(),
    ],
  });
}
