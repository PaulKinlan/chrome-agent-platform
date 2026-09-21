// @ts-nocheck — exercise the actual esbuild plugin, not source-name pins.
import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1';
import { build, stop } from 'npm:esbuild@0.25.12';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { browserDependencies, browserDefines, projectAgentDoBrowser } from '../scripts/browser-dependencies.mjs';

const require = createRequire(import.meta.url);
const agentRoot = dirname(require.resolve('agent-do'));
const options = {
  bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent',
  metafile: true, plugins: [browserDependencies], define: browserDefines,
};

Deno.test('browser dependencies: new bare, prefixed and subpath builtins refuse by name and importer', async () => {
  try {
    for (const builtin of ['fs', 'node:child_process', 'fs/promises', 'node:sqlite']) {
      const error = await assertRejects(() => build({ ...options,
        stdin: { contents: `import '${builtin}';`, sourcefile: 'new-dependency.js', resolveDir: Deno.cwd() },
      }));
      assert(error.message.includes(`Node builtin "${builtin}" forbidden`), error.message);
      assert(error.message.includes('new-dependency.js'), error.message);
    }
  } finally { stop(); }
});

Deno.test('browser dependencies: each pinned source refuses changed upstream bytes', async () => {
  for (const file of ['index.js', 'mcp.js', 'routines.js', 'scheduled-tasks.js']) {
    const source = await Deno.readTextFile(join(agentRoot, file));
    assert(projectAgentDoBrowser(file, source).length > 0);
    assertThrows(() => projectAgentDoBrowser(file, source + '\n'), Error, 'changed; review browser projection');
  }
});

Deno.test('browser dependencies: real agent-do bundles without Node modules or invented globals', async () => {
  try {
    const result = await build({ ...options, stdin: {
      contents: `export { createAgent } from 'agent-do';`, resolveDir: Deno.cwd(),
    } });
    const inputs = Object.keys(result.metafile.inputs);
    for (const name of ['browser-shim-node', 'browser-shim-process', 'cross-spawn', 'shebang-command', 'shebang-regex', 'path-key', '/client/stdio.js']) {
      assert(!inputs.some(p => p.includes(name)), `unexpected input ${name}`);
    }
    // A browser-like VM has no Node process/global; evaluate the actual bundle.
    const { runInNewContext } = await import('node:vm');
    const cjs = await build({ ...options, format: 'cjs', stdin: {
      contents: `export { createAgent } from 'agent-do';`, resolveDir: Deno.cwd(),
    } });
    const context = { module: { exports: {} }, console, Event, EventTarget, MessageEvent, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, ReadableStream, TransformStream, crypto, setTimeout, clearTimeout };
    runInNewContext(cjs.outputFiles[0].text, context);
    assertEquals(context.process, undefined);
    assertEquals(context.global, undefined);
    const createAgent = context.module.exports.createAgent;
    const agent = createAgent({ id: 'browser-test', name: 'Browser', model: {}, scheduledTasks: [{ id: 'daily', cron: '0 9 * * *', payload: 'hello' }] });
    assertEquals(agent.id, 'browser-test');
    assertThrows(() => createAgent({ scheduledTasks: [{ id: 'bad', cron: 'invalid', payload: 'x' }] }));
  } finally { stop(); }
});
