import fs from 'node:fs';
import { parse } from '../build-tools/node_modules/acorn/dist/acorn.mjs';

function memberName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') {
    const property = node.computed
      ? (node.property?.type === 'Literal' ? String(node.property.value) : '*')
      : memberName(node.property);
    return `${memberName(node.object)}.${property}`;
  }
  if (node.type === 'ChainExpression') return memberName(node.expression);
  return node.type;
}

const forbiddenCalls = new Set(['eval', 'Function', 'fetch', 'importScripts']);
const forbiddenConstructors = new Set(['Function', 'XMLHttpRequest', 'WebSocket', 'EventSource']);
const forbiddenMembers = new Set([
  'WebAssembly.instantiate', 'WebAssembly.instantiateStreaming',
  'globalThis.fetch', 'self.fetch', 'window.fetch', 'navigator.sendBeacon'
]);
const results = [];
let failed = false;
for (const file of process.argv.slice(2)) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
  const findings = [];
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'ImportExpression') findings.push({ rule: 'dynamic-import', offset: node.start });
    if (node.type === 'CallExpression') {
      const name = memberName(node.callee);
      if (forbiddenCalls.has(name) || forbiddenMembers.has(name) || name.endsWith('.fetch')) {
        findings.push({ rule: `call:${name}`, offset: node.start });
      }
    }
    if (node.type === 'NewExpression') {
      const name = memberName(node.callee);
      if (forbiddenConstructors.has(name) || name.endsWith('.XMLHttpRequest') || name.endsWith('.WebSocket')) {
        findings.push({ rule: `construct:${name}`, offset: node.start });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object') stack.push(child);
      } else if (value && typeof value === 'object' && value.type) {
        stack.push(value);
      }
    }
  }
  for (const [rule, text] of [
    ['source-map-directive', 'sourceMappingURL'],
    ['node-source-map-support', 'source-map-support'],
    ['jridgewell-source-map', '@jridgewell/source-map']
  ]) {
    if (source.includes(text)) findings.push({ rule, offset: source.indexOf(text) });
  }
  if (findings.length) failed = true;
  results.push({ file, bytes: Buffer.byteLength(source), findings });
}
console.log(JSON.stringify({ schemaVersion: 1, passed: !failed, files: results }, null, 2));
if (failed) process.exit(1);
