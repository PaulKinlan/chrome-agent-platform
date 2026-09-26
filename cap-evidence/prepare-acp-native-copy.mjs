// Test-time activation only. Never edit/re-pin the shipped manifest.
// CAP_DURABLE_ROOT=<evidence root> node cap-evidence/prepare-acp-native-copy.mjs
// Record receipt.json before loading the copy; discard its extension/ after use.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { durableRoot } from '../scripts/lib/durable-root.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function inventory(dir, prefix = '', materialized = false) {
  return readdirSync(join(dir, prefix)).sort().flatMap((name) => {
    const path = join(prefix, name);
    const file = join(dir, path);
    // A hash walk alone follows links and cannot prove a self-contained copy.
    if (materialized) assert(!lstatSync(file).isSymbolicLink(), `copy contains symlink: ${path}`);
    if (statSync(file).isDirectory()) return inventory(dir, path, materialized);
    const bytes = readFileSync(file);
    return [{ path, bytes: bytes.length, sha256: sha(bytes) }];
  });
}
const protectedPaths = [
  'extension/manifest.json',
  'packages/bundled/evidence/emscripten-abi/loaded-probe/snapshot.json',
  'scripts/emscripten-abi-loaded.ts',
  'tests/emscripten-abi-loaded-harness.test.ts',
];
const protectedBefore = Object.fromEntries(protectedPaths.map((p) => [p, sha(readFileSync(join(root, p)))]));
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
assert(!manifest.key, 'path-derived extension identity requires no manifest key');
assert(!manifest.permissions.includes('nativeMessaging'), 'activation delta already present');
const source = inventory(join(root, 'extension'));
const evidenceRoot = durableRoot();
mkdirSync(evidenceRoot, { recursive: true });
const run = mkdtempSync(join(evidenceRoot, 'acp-native-copy-'));
const extension = join(run, 'extension');
execFileSync('cp', ['--archive', '--dereference', '--reflink=auto', join(root, 'extension'), extension]);
assert.deepEqual(inventory(extension, '', true), source, 'initial copy must match all current built bytes');
manifest.permissions.push('nativeMessaging');
writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const copied = inventory(extension, '', true);
assert.deepEqual(copied.filter((p) => p.path !== 'manifest.json'), source.filter((p) => p.path !== 'manifest.json'));
assert.deepEqual(inventory(join(root, 'extension')), source, 'source changed during preparation');
const protectedAfter = Object.fromEntries(protectedPaths.map((p) => [p, sha(readFileSync(join(root, p)))]));
assert.deepEqual(protectedAfter, protectedBefore);
const extensionId = sha(realpathSync(extension)).slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
const receipt = {
  testOnly: true, createdAt: new Date().toISOString(), root, extension, extensionId,
  gitHead: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  gitStatus: execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
  activationDelta: [{ op: 'add', path: '/permissions/-', value: 'nativeMessaging' }],
  sourceManifestSha256: protectedBefore['extension/manifest.json'],
  generatedManifestSha256: sha(readFileSync(join(extension, 'manifest.json'))),
  sourceTreeSha256: sha(JSON.stringify(source)), generatedTreeSha256: sha(JSON.stringify(copied)),
  protectedBefore, protectedAfter, sourceInventory: source, generatedInventory: copied,
};
writeFileSync(join(run, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ run, extension, extensionId, manifest: receipt.generatedManifestSha256, tree: receipt.generatedTreeSha256 }));
