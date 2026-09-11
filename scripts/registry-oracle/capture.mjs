// Externally trusted S1 host, not an oracle and not a Node sandbox.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { isRamBacked } from '../lib/durable-root.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMIT = 65536;
const TIMEOUT = 10000;
const flags = ['fixtureReady', 'subjectEntered', 'subjectCompleted', 'assertionEntered', 'assertionFailed', 'calibrationPassed'];
const counters = ['parserCalls', 'parserReturns', 'urlConstructs', 'encoderConstructs', 'wholeEncodeViolations', 'encodeIntoViolations'];
const fail = code => { throw new Error(code); };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

export function parseArgs(args) {
  const result = {};
  const names = ['--mode', '--runtime', '--oracle', '--oracle-sha256', '--evidence-parent'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!names.includes(key) || Object.hasOwn(result, key) || !args[i + 1] || args[i + 1].startsWith('--')) fail('ARGUMENTS');
    result[key] = args[i + 1];
  }
  if (names.some(key => !Object.hasOwn(result, key)) || result['--mode'] !== 'mechanics' ||
      !HEX.test(result['--oracle-sha256']) ||
      ['--runtime', '--oracle', '--evidence-parent'].some(key => !isAbsolute(result[key])) ||
      !['node', 'deno'].includes(basename(result['--runtime']))) fail('ARGUMENTS');
  return result;
}

function runtimeShape(runtime) {
  return exact(runtime, ['name', 'version', 'v8', 'typescript']) &&
    ['node', 'deno'].includes(runtime.name) && text(runtime.version) && text(runtime.v8) &&
    (runtime.name === 'node' ? runtime.typescript === null : text(runtime.typescript));
}

// JSON.parse validates syntax; this extra scan rejects duplicate member names,
// including escaped spellings. No last-line selection or duplicate-key collapse.
function terminalJSON(bytes) {
  let source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (source.endsWith('\n')) source = source.slice(0, -1);
  if (!source.startsWith('{') || !source.endsWith('}')) fail('STDOUT_PROTOCOL');
  const value = JSON.parse(source);
  const stack = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') stack.push(new Set());
    else if (source[i] === '}') stack.pop();
    else if (source[i] === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') i++;
        i++;
      }
      const key = JSON.parse(source.slice(start, i + 1));
      let next = i + 1;
      while (/\s/.test(source[next] ?? '') && next < source.length) next++;
      if (source[next] === ':') {
        if (stack.at(-1)?.has(key)) fail('STDOUT_PROTOCOL');
        stack.at(-1)?.add(key);
      }
    }
  }
  return value;
}

export function validateTerminal(bytes, expected) {
  const t = terminalJSON(bytes);
  if (!exact(t, ['schemaVersion', 'mode', 'runId', 'runtime', 'observedHashes', 'job', 'outcome', 'observations', 'error']) ||
      t.schemaVersion !== 1 || t.mode !== 'mechanics' || !UUID.test(t.runId) || t.runId !== expected.runId ||
      !runtimeShape(t.runtime) || !exact(expected.runtime, ['name', 'version', 'v8', 'typescript']) ||
      Object.keys(t.runtime).some(key => t.runtime[key] !== expected.runtime[key]) ||
      !exact(t.observedHashes, ['oracle']) || !HEX.test(t.observedHashes.oracle) || t.observedHashes.oracle !== expected.oracle ||
      !exact(t.job, ['checkId', 'recipeId', 'mutantSha256']) || Object.values(t.job).some(v => v !== null) ||
      !['MECHANICS_PASS', 'MECHANICS_FAIL'].includes(t.outcome) ||
      !exact(t.observations, [...flags, 'assertionId', ...counters])) fail('STDOUT_PROTOCOL');
  const o = t.observations;
  if (flags.some(key => typeof o[key] !== 'boolean') ||
      counters.some(key => !Number.isSafeInteger(o[key]) || o[key] < 0) ||
      !(o.assertionId === null || text(o.assertionId)) ||
      o.parserReturns > o.parserCalls || o.urlConstructs > o.parserCalls ||
      (o.subjectCompleted && !o.subjectEntered) || (o.subjectEntered && !o.fixtureReady) ||
      (o.assertionFailed && !o.assertionEntered) || (o.assertionEntered !== (o.assertionId !== null)) ||
      !(t.error === null || (exact(t.error, ['stage', 'code']) &&
        [t.error.stage, t.error.code].every(v => text(v) && /^[A-Za-z0-9_.-]+$/.test(v))))) fail('STDOUT_PROTOCOL');
  if (t.outcome === 'MECHANICS_PASS' && (t.error !== null || flags.some(key => !o[key]) ||
      o.assertionId !== 'MECH-PRIVATE-ASSERTION' || o.urlConstructs < 1 || o.parserCalls <= o.parserReturns ||
      o.encoderConstructs < 1 || o.wholeEncodeViolations < 1 || o.encodeIntoViolations < 1)) fail('STDOUT_PROTOCOL');
  if (t.outcome === 'MECHANICS_FAIL' && t.error === null) fail('STDOUT_PROTOCOL');
  return t;
}

function launch(executable, args, input) {
  return new Promise(resolve => {
    const streams = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    let child;
    let timer;
    const finish = (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ executable, args, exitCode, signal, failure,
        stdout: Buffer.concat(streams.stdout), stderr: Buffer.concat(streams.stderr),
        truncated: sizes.stdout > LIMIT || sizes.stderr > LIMIT });
    };
    try {
      // No inherited NODE_OPTIONS/DENO_* hooks, credentials, or permission settings.
      child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    } catch { failure = 'LAUNCH_FAILURE'; finish(null, null); return; }
    child.on('error', () => { failure ??= 'LAUNCH_FAILURE'; });
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', bytes => {
        const room = Math.max(0, LIMIT - sizes[name]);
        streams[name].push(bytes.subarray(0, room));
        sizes[name] += bytes.length;
        if (sizes[name] > LIMIT) { failure ??= 'OUTPUT_LIMIT'; child.kill('SIGKILL'); }
      });
      child[name].on('error', () => { failure ??= 'CAPTURE_FAILURE'; child.kill('SIGKILL'); });
    }
    child.stdin.on('error', () => { failure ??= 'STDIN_FAILURE'; });
    child.once('close', finish);
    timer = setTimeout(() => { failure ??= 'TIMEOUT'; child.kill('SIGKILL'); }, TIMEOUT);
    child.stdin.end(input);
  });
}

const runtimeProbe = `console.log(JSON.stringify(typeof Deno === 'object' ?
  {name:'deno',version:Deno.version.deno,v8:Deno.version.v8,typescript:Deno.version.typescript} :
  {name:'node',version:process.versions.node,v8:process.versions.v8,typescript:null}));`;

async function store(path, bytes) {
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) fail('EVIDENCE_WRITE');
  } catch { fail('EVIDENCE_WRITE'); }
}

export async function capture(args) {
  let runDir = null;
  const envelope = { schemaVersion: 1, kind: 'registry-oracle-host', mode: 'mechanics',
    runId: null, expected: null, runtime: null, authentication: 'external-entry-bytes',
    oracleAuthenticated: false, probe: null, interpreter: null, terminal: null,
    validTerminal: false, status: 'HOST_FAILURE', failure: null, retained: false };
  try {
    const options = parseArgs(args);
    const parent = await realpath(options['--evidence-parent']);
    if (isRamBacked(parent)) fail('EVIDENCE_PARENT');
    envelope.runId = randomUUID();
    const allocated = join(parent, envelope.runId);
    await mkdir(allocated, { mode: 0o700 }); // Full UUID, exclusive, never reuse a run.
    runDir = allocated; // A failed allocation must NEVER write into an existing run.
    const O = options['--oracle-sha256'];
    envelope.expected = { oracle: O, job: { checkId: null, recipeId: null, mutantSha256: null } };
    const bytes = await readFile(options['--oracle']); // The ONLY oracle-path read.
    if (hash(bytes) !== O) fail('ORACLE_HASH_MISMATCH');
    envelope.oracleAuthenticated = true;
    try { await mkdir(join(runDir, O)); } catch { fail('EVIDENCE_WRITE'); }
    await store(join(runDir, O, 'oracle.mjs'), bytes);
    const executable = await realpath(options['--runtime']);
    const name = basename(options['--runtime']);
    const interpreterArgs = name === 'node' ? ['--input-type=module', '-'] :
      ['run', '--no-prompt', '--no-config', '--no-lock', '--cached-only', '--ext=js', '-'];
    const saveProcess = async (label, result) => {
      const { stdout, stderr, ...metadata } = result;
      const record = { ...metadata, stdoutSha256: hash(stdout), stderrSha256: hash(stderr),
        stdoutBytes: stdout.length, stderrBytes: stderr.length };
      envelope[label === 'runtime-probe' ? 'probe' : 'interpreter'] = record;
      await store(join(runDir, `${label}.stdout`), stdout);
      await store(join(runDir, `${label}.stderr`), stderr);
    };
    const probe = await launch(executable, interpreterArgs, Buffer.from(runtimeProbe));
    await saveProcess('runtime-probe', probe);
    if (probe.failure || probe.exitCode !== 0 || probe.signal) fail('RUNTIME_PROBE');
    const runtime = terminalJSON(probe.stdout);
    if (!runtimeShape(runtime) || runtime.name !== name) fail('RUNTIME_IDENTITY');
    envelope.runtime = runtime;
    const launchedArgs = [...interpreterArgs, '--mode', 'mechanics', '--run-id', envelope.runId, '--oracle-sha256', O];
    const result = await launch(executable, launchedArgs, bytes); // The authenticated buffer, NOT a reopened path.
    await saveProcess('interpreter', result);
    try {
      envelope.terminal = validateTerminal(result.stdout, { runId: envelope.runId, oracle: O, runtime });
      envelope.validTerminal = true;
    } catch { envelope.failure = 'STDOUT_PROTOCOL'; }
    if (result.failure) envelope.failure = result.failure;
    else if (result.signal || result.exitCode !== 0) envelope.failure = 'INTERPRETER_EXIT';
    else if (envelope.validTerminal && envelope.terminal.outcome !== 'MECHANICS_PASS') envelope.failure = 'ORACLE_FAILURE';
    if (!envelope.failure) envelope.status = 'MECHANICS_PASS';
  } catch (error) {
    // Only our bounded identifiers are exposed. Never forward a path-bearing fs
    // error, subject payload, exception message, or stack from the interpreter.
    const known = ['ARGUMENTS', 'EVIDENCE_PARENT', 'EVIDENCE_WRITE', 'ORACLE_HASH_MISMATCH', 'RUNTIME_PROBE', 'RUNTIME_IDENTITY'];
    envelope.failure = known.includes(error?.message) ? error.message : 'CAPTURE_FAILURE';
    envelope.status = 'HOST_FAILURE';
  }
  if (!runDir) return { ...envelope, runDir };
  try {
    // Announce retention only AFTER the exclusive file write and byte readback.
    const retained = { ...envelope, retained: envelope.failure !== 'EVIDENCE_WRITE' };
    await store(join(runDir, 'host-envelope.json'), JSON.stringify(retained) + '\n');
    return { ...retained, runDir };
  } catch {
    return { ...envelope, status: 'HOST_FAILURE', failure: 'EVIDENCE_WRITE', retained: false, runDir };
  }
}

if (import.meta.main) {
  const result = await capture(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.status === 'MECHANICS_PASS' && result.retained ? 0 : 1;
}
