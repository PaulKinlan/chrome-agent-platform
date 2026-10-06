// Temporary browser projection of agent-do 0.7.0 pending upstream #139.
// Retains library implementations; removes only Node-only exports/imports.
// Full-file hashes make an upstream change a build refusal, not a guessed patch.
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';

const hashes = {
  'index.js': 'feb404af0fe2131df616c2841cc1df8e3d13a1a27b6d20cf0af68c7cf7fb4de2',
  'mcp.js': '59d4c962efec76a101387632d6d252b1068e6e857a0afde0950633e7b2b07229',
  'routines.js': '764e6c0c6ce159ae1a20252369b000b46481ca7607d4ec5f78d8bfceda921590',
  'scheduled-tasks.js': 'cd4c344539bfa366938eb7cc259b2094cadc8c67a67c6fef01bb1c3a225ae86a',
};

export function projectAgentDoBrowser(file, source) {
  if (createHash('sha256').update(source).digest('hex') !== hashes[file]) {
    throw new Error(`cap-browser-dependencies: agent-do 0.7.0 ${file} changed; review browser projection (upstream #139)`);
  }
  if (file === 'index.js') return "export { createAgent } from './agent.js';\n";
  const nodes = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body;
  const edits = [];
  for (const node of nodes) {
    const declaration = node.declaration ?? node;
    const name = declaration.id?.name;
    if (node.type === 'ImportDeclaration' && (
      node.source.value.startsWith('node:') ||
      node.source.value.endsWith('/client/stdio.js') ||
      node.source.value === './stores/file-lock.js'
    )) edits.push([node.start, node.end, '']);
    if (file === 'routines.js' && name === 'FilesystemRoutineStore' ||
        file === 'scheduled-tasks.js' && ['readStatus', 'writeStatus', 'recordRun', 'runScheduledTask'].includes(name)) {
      edits.push([node.start, node.end, '']);
    }
    if (file === 'mcp.js' && declaration.declarations?.[0]?.id.name === 'LIB_VERSION') {
      // The old browser createRequire shim always threw, selecting this fallback.
      edits.push([node.start, node.end, "const LIB_VERSION = '0.0.0';"]);
    }
    if (file === 'mcp.js' && name === 'createTransport') {
      const branch = declaration.body.body[0].cases.find(c => c.test?.value === 'stdio');
      edits.push([branch.start, branch.end, "case 'stdio': throw new Error('child_process not available in extension');"]);
    }
  }
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    source = source.slice(0, start) + replacement + source.slice(end);
  }
  return source;
}

export const browserDependencies = {
  name: 'cap-browser-dependencies',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (isBuiltin(args.path) || args.path.startsWith('node:')) {
        return { errors: [{ text: `Node builtin "${args.path}" forbidden in browser bundle (importer: ${args.importer || '<entry>'})` }] };
      }
    });
    build.onLoad({ filter: /\/agent-do\/dist\/src\/(index|mcp|routines|scheduled-tasks)\.js$/ }, async args => ({
      contents: projectAgentDoBrowser(path.basename(args.path), await readFile(args.path, 'utf8')),
      loader: 'js',
    }));
    build.onEnd(result => {
      for (const input of Object.keys(result.metafile?.inputs ?? {})) {
        if (/(?:browser-shim-(?:node|process)\.js|node_modules\/(?:cross-spawn|shebang-command|shebang-regex|path-key)\/)/.test(input)) {
          return { errors: [{ text: `Node-only dependency survived browser projection: ${input}` }] };
        }
      }
    });
  },
};

// Explicit provider keys are supplied by CAP. Do not manufacture a Node global
// (SDK runtime detection must see a browser); only environment defaults are empty.
//
// chrome-agent-platform-3337: the browser `process.env` shim is ONE esbuild option fragment carrying
// BOTH the define and the banner that declares it (browserProcessEnvOptions below), so no build target
// can acquire the define without the banner — a bare identifier define with no declaration references
// an undeclared global and dies at module init with a ReferenceError, which no byte comparison can see.
const EMPTY_PROCESS_ENV_IDENTIFIER = "__CAP_EMPTY_PROCESS_ENV__";

/**
 * The browser `process.env` shim, as one esbuild option fragment: `define` + the `banner` that
 * declares it. Spread BOTH keys into the build config (`...browserProcessEnvOptions.define` plus
 * `banner: browserProcessEnvOptions.banner`); never one without the other.
 *
 * WHY NOT THE OBVIOUS OBJECT LITERAL: `define: { 'process.env': '{}' }` makes esbuild synthesise a
 * shared `<define:process.env>` virtual module and inject an init call into every file that reads
 * process.env — 314 of the 317 files in the agent-worker graph. Those injected init calls are
 * borderline side-effect parts, and esbuild 0.25.12's tree-shaking includes/excludes one of them
 * nondeterministically, which moved `workers/agent-worker.js` by exactly 4 bytes (`A(),`) between two
 * builds of the same commit (the 846613 vs 846617 drift this fix removes). An IDENTIFIER define is
 * substituted as TEXT: esbuild creates no virtual module and injects no init calls, so that class of
 * byte-visible nondeterminism cannot arise. MEASURED in one process, 10 worker builds per shape:
 * object literal 7x/3x across two output states (307 vs 308 inputs, 305 vs 306 init calls);
 * identifier 10/10 byte-identical sha with 0 init calls and 0 define module.
 *
 * VALUE IS PRESERVED: the substituted text is the banner-declared const, so `process.env` still
 * evaluates to one shared empty object. Measured by executing both shapes: value
 * `{isObject:true, propIsUndefined:true, keyCount:0}` in BOTH. No `process` global is manufactured,
 * so SDK runtime detection still sees a browser.
 */
export const browserProcessEnvOptions = Object.freeze({
  define: Object.freeze({ "process.env": EMPTY_PROCESS_ENV_IDENTIFIER }),
  banner: Object.freeze({ js: `const ${EMPTY_PROCESS_ENV_IDENTIFIER} = {};` }),
});

/** Exported so the guard test can prove the banner declares exactly the identifier the define names. */
export const EMPTY_PROCESS_ENV_DEFINE_NAME = EMPTY_PROCESS_ENV_IDENTIFIER;
