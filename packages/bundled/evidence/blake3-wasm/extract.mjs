#!/usr/bin/env node
// Extract binaries/blake3.wasm and glue/blake3.mjs from the PINNED blake3-wasm npm tarball.
// Deterministic: pinned tarball sha512 + exact member extraction.
// Upstream: connor4312/blake3 (blake3-wasm@3.0.0, MIT).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARBALL = join(HERE, "blake3-wasm-3.0.0.tgz");
const TARBALL_SHA512_B64 = "X410nN2AIX6k8gHQmXruQ9YV3U8fe7ZrfLMp88qBcGx5oEIGzz305HvquXoSTPdaR74EA99KHBTb8El9q0vjqQ==";

export function extractTarball() {
  const tarball = readFileSync(TARBALL);
  const actual = createHash("sha512").update(tarball).digest("base64");
  if (actual !== TARBALL_SHA512_B64) throw new Error(`tarball sha512 mismatch: ${actual}`);

  execSync(`tar xzf ${TARBALL} -C ${HERE}/binaries --strip-components=3 package/esm/wasm/blake3.wasm`);
  execSync(`tar xzf ${TARBALL} -C ${HERE}/glue --strip-components=3 package/esm/wasm/blake3.mjs`);

  mkdirSync(join(HERE, "build-a"), { recursive: true });
  mkdirSync(join(HERE, "build-b"), { recursive: true });
  execSync(`tar xzf ${TARBALL} -C ${HERE}/build-a --strip-components=3 package/esm/wasm/blake3.wasm package/esm/wasm/blake3.mjs`);
  execSync(`tar xzf ${TARBALL} -C ${HERE}/build-b --strip-components=3 package/esm/wasm/blake3.wasm package/esm/wasm/blake3.mjs`);

  const wasm = readFileSync(join(HERE, "binaries/blake3.wasm"));
  const wasmSha256 = createHash("sha256").update(wasm).digest("hex");
  if (wasmSha256 !== "7bc38ed8b469117059b43ab04c70b2a5506ab313a9ae2926dd338f072dbd310d" || wasm.length !== 43943) {
    throw new Error(`blake3.wasm hash/length mismatch: ${wasmSha256} (${wasm.length} bytes)`);
  }

  const glue = readFileSync(join(HERE, "glue/blake3.mjs"));
  const glueSha256 = createHash("sha256").update(glue).digest("hex");
  if (glueSha256 !== "7d03777d994e39a8a619a8c9fe20c1bcb11710b114fc2f280022a2a103052878" || glue.length !== 17819) {
    throw new Error(`blake3.mjs hash/length mismatch: ${glueSha256} (${glue.length} bytes)`);
  }

  console.log("extracted blake3.wasm", wasm.length, "sha256", wasmSha256);
  console.log("extracted blake3.mjs", glue.length, "sha256", glueSha256);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  extractTarball();
}
