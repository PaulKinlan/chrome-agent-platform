// Credential-free Chrome Web Store package boundary.
//
// This module does not transform package bytes and grants no Wasm/package
// execution authority. It validates the existing exact package inventory before
// the unchanged package SHA/atomic-publish path runs. AST/HTML scans are
// defense-in-depth heuristics; exact CSP and exact package hashes are primary.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { scanBundledWasmFiles, scanShippedJs } from "./scan-shipped.mjs";
// The admitted Pyodide runtime lane (CAP-FB-20260823-PYODIDE-PYTHON-01): the
// runtime ships as one byte-verified blob set (dist/wasm-tools/python/) whose
// exact sha256 pins ARE the admission record (PYTHON_RUNTIME_PIN mirrors
// wasm-tools/python/MANIFEST.json; tests/python-runtime.test.ts asserts disk ==
// pins == manifest). It is NOT authored shipped source and NOT a WASI
// tool-bundle: the vendored glue is verified byte-exact here instead of
// AST-scanned, and its wasm is admitted by its pins instead of the bundled
// executable map.
import { PYTHON_RUNTIME_PIN, PYTHON_RUNTIME_DIR } from "../extension/lib/python-runtime.js";

export const PYTHON_RUNTIME_ARCHIVE_PREFIX = PYTHON_RUNTIME_DIR; // "dist/wasm-tools/python/"

export const STORE_TARGET = "store";
export const STORE_EXTENSION_CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-src 'self' about: blob: data:";
export const STORE_WASM_LANE = "bundled-reviewed-only";
export const STORE_ALLOWED_WORKER_LITERALS = Object.freeze([]);

const MAX_POLICY_FILES = 2_048;
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const REMOTE_SCRIPT_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;
const SCRIPT_SRC_RE =
  /<script\b[^>]*\bsrc\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/giu;

function policyError(message) {
  return new Error(`store target validation failed: ${message}`);
}

function plainExact(value, keys) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

export function parsePackageArguments(args) {
  if (!Array.isArray(args) || args.length > 4) {
    throw policyError("invalid argument shape");
  }
  let target = null;
  let validateOnly = false;
  const positional = [];
  for (const argument of args) {
    if (typeof argument !== "string" || argument.length === 0) {
      throw policyError("invalid argument shape");
    }
    if (argument.startsWith("--target=")) {
      if (target !== null) throw policyError("duplicate target flag");
      target = argument.slice("--target=".length);
      if (target === "developer") {
        throw policyError("target_developer_not_enabled");
      }
      if (target === "enterprise") {
        throw policyError("target_enterprise_not_enabled");
      }
      if (target !== STORE_TARGET) {
        throw policyError(`unsupported target: ${target || "<empty>"}`);
      }
    } else if (argument === "--validate-only") {
      if (validateOnly) throw policyError("duplicate validate-only flag");
      validateOnly = true;
    } else if (argument.startsWith("-")) {
      throw policyError(`unknown flag: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length > 1) throw policyError("too many archive paths");
  if (validateOnly && positional.length !== 1) {
    throw policyError("validate-only requires exactly one archive path");
  }
  if (target === null) throw policyError("explicit --target=store required");
  return Object.freeze({
    target,
    validateOnly,
    archivePath: positional[0] ?? null,
  });
}

function assertExactStoreCsp(manifest) {
  if (!plainExact(manifest?.content_security_policy, ["extension_pages"])) {
    throw policyError("content_security_policy object is not exact");
  }
  if (
    manifest.content_security_policy.extension_pages !== STORE_EXTENSION_CSP
  ) throw policyError("extension_pages CSP is not exact");
}

function remoteHtmlScriptViolations(text, archivePath) {
  const violations = [];
  SCRIPT_SRC_RE.lastIndex = 0;
  for (let match; (match = SCRIPT_SRC_RE.exec(text));) {
    const value = (match[2] ?? match[3] ?? "").trim();
    if (REMOTE_SCRIPT_URL_RE.test(value)) {
      violations.push(
        `${archivePath}: remote script src is forbidden: ${value}`,
      );
    }
  }
  return violations;
}

async function boundedReadText(entry) {
  const bytes = await readFile(entry.sourcePath);
  if (bytes.length > MAX_TEXT_FILE_BYTES) {
    throw policyError(`text input exceeds bound: ${entry.archivePath}`);
  }
  return bytes.toString("utf8");
}

export async function assertStoreTargetBoundary({
  target,
  inventory,
  bundledWasmManifestByArchivePath = new Map(),
}) {
  if (target !== STORE_TARGET) {
    throw policyError("explicit --target=store required");
  }
  if (
    !Array.isArray(inventory) || inventory.length === 0 ||
    inventory.length > MAX_POLICY_FILES
  ) {
    throw policyError("package inventory is outside bounds");
  }
  if (!(bundledWasmManifestByArchivePath instanceof Map)) {
    throw policyError("bundled Wasm manifest authority must be a Map");
  }
  const byPath = new Map();
  for (const entry of inventory) {
    if (
      !entry || typeof entry.archivePath !== "string" ||
      typeof entry.sourcePath !== "string" || byPath.has(entry.archivePath)
    ) throw policyError("package inventory identity is invalid");
    byPath.set(entry.archivePath, entry);
  }

  // Python-runtime lane: byte-exact admission against the shipped pins. Every
  // file under the runtime dir must be pinned and hash-match; extras and
  // drifted bytes fail closed. These entries are then EXCLUDED from the
  // authored-source scans (they are vendored runtime bytes, admitted by hash
  // like CAS binaries, not authored extension source).
  const pythonRuntimeEntries = inventory.filter((entry) =>
    entry.archivePath.startsWith(PYTHON_RUNTIME_ARCHIVE_PREFIX)
  );
  const pythonRuntimeViolations = [];
  for (const entry of pythonRuntimeEntries) {
    const file = entry.archivePath.slice(PYTHON_RUNTIME_ARCHIVE_PREFIX.length);
    const pin = PYTHON_RUNTIME_PIN.files[file];
    if (!pin) {
      pythonRuntimeViolations.push(`${entry.archivePath}: unmanifested python-runtime file`);
      continue;
    }
    const bytes = await readFile(entry.sourcePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== pin.sha256) {
      pythonRuntimeViolations.push(`${entry.archivePath}: python-runtime byte drift (${digest} != ${pin.sha256})`);
    }
  }
  const nonRuntimeEntries = inventory.filter((entry) =>
    !entry.archivePath.startsWith(PYTHON_RUNTIME_ARCHIVE_PREFIX)
  );

  const manifestEntry = byPath.get("manifest.json");
  if (!manifestEntry) throw policyError("manifest.json is missing");
  let manifest;
  try {
    manifest = JSON.parse(await boundedReadText(manifestEntry));
  } catch (error) {
    if (String(error?.message).startsWith("store target validation failed:")) {
      throw error;
    }
    throw policyError("manifest.json is invalid");
  }
  if (manifest?.manifest_version !== 3) {
    throw policyError("manifest_version must be exactly 3");
  }
  assertExactStoreCsp(manifest);

  const jsEntries = nonRuntimeEntries.filter((entry) =>
    /\.(?:m?js)$/iu.test(entry.archivePath)
  );
  const generatedBundles = new Set(
    jsEntries.filter((entry) => entry.archivePath.startsWith("dist/"))
      .map((entry) => entry.sourcePath),
  );
  const allowedDynamicEvaluatorFiles = new Set(
    jsEntries.filter((entry) =>
      entry.archivePath === "sandbox/script-sandbox.js"
    ).map((entry) => entry.sourcePath),
  );
  const jsViolations = await scanShippedJs(
    jsEntries.map((entry) => entry.sourcePath),
    {
      generatedBundles,
      allowedWorkerLiterals: new Set(STORE_ALLOWED_WORKER_LITERALS),
      allowedDynamicEvaluatorFiles,
      readText: async (file) => {
        const entry = jsEntries.find((candidate) =>
          candidate.sourcePath === file
        );
        if (!entry) throw policyError("scanner requested an unknown JS input");
        return await boundedReadText(entry);
      },
    },
  );

  const htmlEntries = nonRuntimeEntries.filter((candidate) =>
    /\.html$/iu.test(candidate.archivePath)
  );
  const htmlViolations = [];
  for (const entry of htmlEntries) {
    htmlViolations.push(
      ...remoteHtmlScriptViolations(
        await boundedReadText(entry),
        entry.archivePath,
      ),
    );
  }

  const wasmEntries = nonRuntimeEntries.filter((entry) =>
    /\.wasm$/iu.test(entry.archivePath)
  );
  for (const archivePath of bundledWasmManifestByArchivePath.keys()) {
    if (!wasmEntries.some((entry) => entry.archivePath === archivePath)) {
      throw policyError(
        `bundled Wasm manifest has no package byte: ${archivePath}`,
      );
    }
  }
  const manifestByFile = new Map();
  for (const entry of wasmEntries) {
    const executable = bundledWasmManifestByArchivePath.get(entry.archivePath);
    if (executable) manifestByFile.set(entry.sourcePath, executable);
  }
  const wasmViolations = await scanBundledWasmFiles(
    wasmEntries.map((entry) => entry.sourcePath),
    {
      readBytes: (file) => readFile(file),
      manifestByFile,
    },
  );

  const violations = [...jsViolations, ...htmlViolations, ...wasmViolations, ...pythonRuntimeViolations];
  if (violations.length > 0) {
    throw policyError(
      `static boundary violations (${violations.length}):\n${
        violations.join("\n")
      }`,
    );
  }
  if (bundledWasmManifestByArchivePath.size !== wasmEntries.length) {
    throw policyError("bundled Wasm manifest inventory is not exact");
  }
  return Object.freeze({
    target: STORE_TARGET,
    csp: STORE_EXTENSION_CSP,
    wasmLane: STORE_WASM_LANE,
    canLoadOwnerPackages: false,
    canLoadNetworkPackages: false,
    allowedWorkerLiterals: STORE_ALLOWED_WORKER_LITERALS,
    filesScanned: inventory.length,
    jsScanned: jsEntries.length,
    htmlScanned: htmlEntries.length,
    wasmScanned: wasmEntries.length,
  });
}
