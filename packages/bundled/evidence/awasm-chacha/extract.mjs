#!/usr/bin/env node
// Extract binaries/chacha_poly1305.wasm from the PINNED @awasm/noble npm tarball.
// The tarball embeds the module as a base64 blob inside targets/wasm/chacha_poly1305.js.
// Deterministic: pinned tarball sha512 + base64 blob decoded.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARBALL = join(HERE, "awasm-noble-0.1.4.tgz");
const TARBALL_SHA512_B64 = "LFkAq7VnGc8Hum4x12yxBsyoQYq9mWDf02j1lltzXaeZ14qcXwEYnOl5ByJ49xiBk1L7h6m3vkKkInvtDUIvOg==";

const tarball = readFileSync(TARBALL);
const actual = createHash("sha512").update(tarball).digest("base64");
if (actual !== TARBALL_SHA512_B64) throw new Error(`tarball sha512 mismatch: ${actual}`);

execSync(`tar xzf ${TARBALL} -C ${HERE} --strip-components=3 package/targets/wasm/chacha_poly1305.js`);
const src = readFileSync(join(HERE, "chacha_poly1305.js"), "utf8");
const match = src.match(/atob\((['"])([A-Za-z0-9+/=]+)\1\)/);
if (!match) throw new Error("expected embedded base64 blob in targets/wasm/chacha_poly1305.js");

const wasm = Buffer.from(match[2], "base64");
writeFileSync(join(HERE, "binaries/chacha_poly1305.wasm"), wasm);
console.log("extracted chacha_poly1305.wasm", wasm.length, "sha256", createHash("sha256").update(wasm).digest("hex"));
