#!/usr/bin/env node
// Extract binaries/blake3.wasm from the PINNED hash-wasm npm tarball.
// The tarball embeds the module as a base64 blob inside dist/blake3.umd.min.js.
// Deterministic: pinned tarball sha512 + the largest >=500-char base64 blob
// (the only blob in that file) decoded. Two runs are byte-identical.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARBALL = join(HERE, "hash-wasm-4.12.0.tgz");
const TARBALL_SHA512_B64 = "+/2B2rYLb48I/evdOIhP+K/DD2ca2fgBjp6O+GBEnCDk2e4rpeXIK8GvIyRPjTezgmWn9gmKwkQjjx6BtqDHVQ==";
if (!readFileSync(TARBALL, null)) {
  execSync(`curl -sL https://registry.npmjs.org/hash-wasm/-/hash-wasm-4.12.0.tgz -o ${TARBALL}`);
}
const tarball = readFileSync(TARBALL);
const actual = createHash("sha512").update(tarball).digest("base64");
if (actual !== TARBALL_SHA512_B64) throw new Error(`tarball sha512 mismatch: ${actual}`);
execSync(`tar xzf ${TARBALL} -C ${HERE} --strip-components=2 package/dist/blake3.umd.min.js`);
const src = readFileSync(join(HERE, "blake3.umd.min.js"), "utf8");
const blobs = src.match(/[A-Za-z0-9+/=]{500,}/g);
if (!blobs || blobs.length !== 1) throw new Error("expected exactly one embedded blob");
const wasm = Buffer.from(blobs[0], "base64");
writeFileSync(join(HERE, "binaries/blake3.wasm"), wasm);
console.log("extracted blake3.wasm", wasm.length, "sha256", createHash("sha256").update(wasm).digest("hex"));
