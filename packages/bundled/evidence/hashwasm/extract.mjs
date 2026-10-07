#!/usr/bin/env node
// Extract Wasm binaries from the PINNED hash-wasm npm tarball.
// The tarball embeds each module as a base64 blob inside dist/<name>.umd.min.js.
// Deterministic: pinned tarball sha512 + the largest >=500-char base64 blob
// (the only blob in that file) decoded. Two runs are byte-identical.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARBALL = join(HERE, "hash-wasm-4.12.0.tgz");
const TARBALL_SHA512_B64 = "+/2B2rYLb48I/evdOIhP+K/DD2ca2fgBjp6O+GBEnCDk2e4rpeXIK8GvIyRPjTezgmWn9gmKwkQjjx6BtqDHVQ==";

if (!existsSync(TARBALL)) {
  execSync(`curl -sL https://registry.npmjs.org/hash-wasm/-/hash-wasm-4.12.0.tgz -o ${TARBALL}`);
}
const tarball = readFileSync(TARBALL);
const actual = createHash("sha512").update(tarball).digest("base64");
if (actual !== TARBALL_SHA512_B64) throw new Error(`tarball sha512 mismatch: ${actual}`);

// Verify license text matches package/LICENSE in the tarball
const upstreamLicense = execSync(`tar -xOzf ${TARBALL} package/LICENSE`).toString("utf8");
const vendoredLicense = readFileSync(join(HERE, "LICENSES/hash-wasm-MIT.txt"), "utf8");
if (upstreamLicense !== vendoredLicense) throw new Error("license text mismatch between tarball and vendored copy");

const MODULES = [
  "md4", "sha1", "sha256", "sha512", "ripemd160", "sm3", "whirlpool",
  "blake2b", "blake2s", "adler32", "crc32", "xxhash32", "sha3", "blake3",
];

for (const name of MODULES) {
  const tmpFile = join(HERE, `${name}.umd.min.js`);
  execSync(`tar xzf ${TARBALL} -C ${HERE} --strip-components=2 package/dist/${name}.umd.min.js`);
  const src = readFileSync(tmpFile, "utf8");
  const blobs = src.match(/[A-Za-z0-9+/=]{500,}/g);
  if (!blobs || blobs.length !== 1) throw new Error(`expected exactly one embedded blob in ${name}`);
  const wasm = Buffer.from(blobs[0], "base64");
  const sha = createHash("sha256").update(wasm).digest("hex");
  writeFileSync(join(HERE, `binaries/${name}.wasm`), wasm);
  unlinkSync(tmpFile);
  console.log(`extracted ${name}.wasm`, wasm.length, "sha256", sha);
}
