// @ts-nocheck — exercise the actual esbuild plugin, not source-name pins.
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1';
import { build, stop } from 'npm:esbuild@0.25.12';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { durableDir } from '../scripts/lib/durable-root.mjs';
import { browserDependencies, browserProcessEnvOptions, EMPTY_PROCESS_ENV_DEFINE_NAME, projectAgentDoBrowser } from '../scripts/browser-dependencies.mjs';

const require = createRequire(import.meta.url);
const agentRoot = dirname(require.resolve('agent-do'));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const options = {
  bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent',
  metafile: true, plugins: [browserDependencies],
  define: browserProcessEnvOptions.define, banner: browserProcessEnvOptions.banner,
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

// ── chrome-agent-platform-3337: the process.env shim is one un-splittable value ──────────────────
// Removing the define-module (the object literal) is what makes the worker bundle reproducible; the
// define must then be an IDENTIFIER and the banner must DECLARE that exact identifier, or the bundle
// references an undeclared global and dies at module init with a ReferenceError — a failure no byte
// comparison can see. These three tests are the pair's guard (shape + every consumer), its executed
// value, and the REAL worker entry executed under the protocol fakes.
const PROCESS_ENV_DEFINER = 'scripts/browser-dependencies.mjs';
/** Every file under scripts/ and tests/ plus build.mjs, so a NEW consumer cannot escape the guard by
 *  not being in a hand-maintained list (review P2-1, chrome-agent-platform-3337). */
async function processEnvCandidates() {
  const exts = ['.mjs', '.js', '.ts'];
  const out = ['build.mjs'];
  for (const dir of ['scripts', 'tests']) {
    const walk = async (d) => {
      for await (const e of Deno.readDir(d)) {
        const p = join(d, e.name);
        if (e.isDirectory) await walk(p);
        else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
      }
    };
    await walk(join(ROOT, dir));
  }
  return out.map((p) => p.startsWith(ROOT) ? p.slice(ROOT.length).replace(/^\/+/, '') : p);
}

Deno.test('browser dependencies (3337): the process.env define is an identifier and its banner declares it, and NO consumer can split the pair', async () => {
  assertEquals(Object.keys(browserProcessEnvOptions).sort(), ['banner', 'define']);
  const defineName = browserProcessEnvOptions.define['process.env'];
  // A regression to the object literal ('{}') would reintroduce the shared define module and the
  // ~314 injected init calls this bead is about, so the VALUE must stay a bare identifier.
  assert(
    typeof defineName === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(defineName),
    `the process.env define must be a bare identifier, got ${JSON.stringify(defineName)}`,
  );
  assertEquals(defineName, EMPTY_PROCESS_ENV_DEFINE_NAME, 'the exported define name must be the one the define uses');
  assertStringIncludes(
    browserProcessEnvOptions.banner.js,
    `const ${defineName} = {};`,
    'the banner must DECLARE exactly the identifier the define substitutes',
  );
  // Consumer scan over EVERY scripts/ and tests/ file (review P2-1): a config that spreads the define
  // without the banner is the unsafe split, wherever it lives; and DESTRUCTURING the export is rejected
  // outright, because destructuring ONLY the define out of it drops the banner while still looking like a
  // use of the export. (The pattern is built from pieces so this comment cannot trip its own check.)
  let scanned = 0;
  const destructure = new RegExp('\\{[^}]*\\}\\s*=\\s*browserProcessEnvOptions');
  for (const rel of await processEnvCandidates()) {
    if (rel === PROCESS_ENV_DEFINER) continue; // the module that DEFINES the pair
    const text = await Deno.readTextFile(join(ROOT, rel));
    if (!text.includes('browserProcessEnvOptions')) continue;
    scanned += 1;
    assert(
      !destructure.test(text),
      `${rel} destructures browserProcessEnvOptions — spread .define AND set .banner instead (chrome-agent-platform-3337)`,
    );
    if (!text.includes('browserProcessEnvOptions.define')) continue;
    assert(
      text.includes('browserProcessEnvOptions.banner'),
      `${rel} takes the process.env define without its banner (chrome-agent-platform-3337)`,
    );
  }
  assert(scanned >= 3, `the consumer scan must actually find consumers, found ${scanned}`);
  // …and the two build targets that need it must still be consumers, so deleting the coupling is red.
  for (const rel of ['build.mjs', 'scripts/build-test-extension.mjs']) {
    const text = await Deno.readTextFile(join(ROOT, rel));
    assert(
      text.includes('browserProcessEnvOptions.define') && text.includes('browserProcessEnvOptions.banner'),
      `${rel} must use the coupled browserProcessEnvOptions (define + banner)`,
    );
  }
});

Deno.test('browser dependencies (3337): the coupled shim still EVALUATES to one empty {} and manufactures no Node global', async () => {
  const src = `
    globalThis.__envProbe = {
      isObject: typeof process.env === 'object' && process.env !== null,
      keyCount: Object.keys(process.env).length,
      propUndefined: process.env.SOME_KEY === undefined,
    };
    export const env = process.env;
  `;
  const cjs = await build({ ...options, format: 'cjs', stdin: { contents: src, resolveDir: Deno.cwd(), sourcefile: 'env-probe.js' } });
  const text = cjs.outputFiles[0].text;
  assert(!/<define:/.test(text), 'no shared define module may be emitted');
  assertEquals((text.match(/\bprocess\.env/g) || []).length, 0, 'every process.env reference must be substituted');
  const { runInNewContext } = await import('node:vm');
  const context = { module: { exports: {} }, console };
  runInNewContext(text, context);
  assertEquals(context.process, undefined, 'no process global may be manufactured (SDK detection must see a browser)');
  assertEquals(
    JSON.stringify(context.__envProbe),
    JSON.stringify({ isObject: true, keyCount: 0, propUndefined: true }),
    'the shim must still be one empty object',
  );
});

Deno.test('browser dependencies (3337): EVERY bundle build.mjs emits carries the banner, substitutes every process.env and has no define module', async () => {
  // The per-bundle STATIC leg (coord's addition): the worker entry is EXECUTED in the test below, but the
  // other shipped bundles' init paths need a browser to run, so their substitution is checked on the
  // emitted artifact instead — banner declared, no reference left to process.env, no define module. The
  // entry list mirrors build.mjs (the six surfaces are its SURFACE_BUNDLES plus the named bundles).
  const entries = [
    'background/service-worker.js',
    'options/options.js',
    'ntp/ntp.js',
    'sidepanel/sidepanel.js',
    'shared/diff-core.js',
    'artifacts/index.js',
    'artifact/artifact.js',
    'directory/directory.js',
    'privacy/privacy.js',
    'offscreen/offscreen.js',
    'lib/user-wasm-store-client.js',
    'workers/agent-worker.js',
  ];
  const result = await build({
    ...options,
    outdir: join(ROOT, '.build', 'process-env-shim-static'),
    entryPoints: entries.map((e) => join(ROOT, 'extension', e)),
  });
  assertEquals(result.outputFiles.length, entries.length, 'every entry must produce exactly one bundle');
  for (const out of result.outputFiles) {
    const label = relative(ROOT, out.path);
    assertStringIncludes(
      out.text,
      `const ${EMPTY_PROCESS_ENV_DEFINE_NAME} = {};`,
      `${label} must carry the banner that declares the defined identifier`,
    );
    assertEquals((out.text.match(/\bprocess\.env/g) || []).length, 0, `${label} must substitute every process.env`);
    assert(!/<define:/.test(out.text), `${label} must not carry esbuild's shared define module`);
  }
});

Deno.test('browser dependencies (3337): the REAL agent-worker entry builds with the coupled shim and EXECUTES without a ReferenceError', async () => {
  const result = await build({
    ...options,
    entryPoints: [join(ROOT, 'extension/workers/agent-worker.js')],
    define: { ...browserProcessEnvOptions.define, __CAP_BUILD_LOG_DEFAULT__: JSON.stringify('off') },
    banner: browserProcessEnvOptions.banner,
  });
  const text = result.outputFiles[0].text;
  assert(!/<define:/.test(text), 'the worker bundle must carry no define module');
  assertEquals((text.match(/\bprocess\.env/g) || []).length, 0, 'the worker bundle must substitute every process.env');
  // Execute the REAL built worker under the same fakes tests/agent-worker-protocol.test.ts uses. A
  // missing banner (undeclared identifier) throws here — the one failure a byte compare cannot see.
  // durableDir, not makeTempDir: the always-on durable-root guard (and the fleet's own rule) requires a
  // NEW file to put scratch in the durable evidence root, with its own teardown (merger block on 3337).
  const dir = durableDir(`3337-worker-exec-${Deno.pid}`);
  try {
    const file = join(dir, 'agent-worker.mjs');
    await Deno.writeTextFile(file, text);
    const connectHandlers = [];
    Object.defineProperty(globalThis, 'self', {
      value: {
        name: 'agent-protocol',
        addEventListener(type, fn) { if (type === 'connect') connectHandlers.push(fn); },
        close() {},
      },
      configurable: true,
      writable: true,
    });
    globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true }) } };
    await import(pathToFileURL(file).href + `?kj9s=${Date.now()}`);
    assertEquals(connectHandlers.length, 1, 'the built worker must register exactly one connect handler');
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
