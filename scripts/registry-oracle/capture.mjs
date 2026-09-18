// Externally trusted capture/reconciliation host, not a Node sandbox.
// Explicit D/O/C/M pins are supplied ONLY by independent exact-object approval.
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
  const common = ['--mode', '--runtime', '--oracle', '--oracle-sha256', '--evidence-parent'];
  const candidate = ['--design', '--design-sha256', '--candidate', '--candidate-sha256', '--manifest', '--manifest-sha256', '--check-id'];
  const names = [...common, ...candidate, '--recipe-id'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!names.includes(key) || Object.hasOwn(result, key) || !args[i + 1] || args[i + 1].startsWith('--')) fail('ARGUMENTS');
    result[key] = args[i + 1];
  }
  const mode = result['--mode'];
  const required = mode === 'mechanics' ? common : [...common, ...candidate, ...(mode === 'mutation' ? ['--recipe-id'] : [])];
  if (!['mechanics', 'baseline', 'mutation'].includes(mode) || !exact(result, required) ||
      !HEX.test(result['--oracle-sha256']) ||
      ['--runtime', '--oracle', '--evidence-parent'].some(key => !isAbsolute(result[key])) ||
      !['node', 'deno'].includes(basename(result['--runtime'])) || (mode !== 'mechanics' && (
        ['--design', '--candidate', '--manifest'].some(key => !isAbsolute(result[key])) ||
        ['--design-sha256', '--candidate-sha256', '--manifest-sha256'].some(key => !HEX.test(result[key])) ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(result['--check-id']) ||
        (mode === 'mutation' && !(typeof result['--recipe-id'] === 'string' && result['--recipe-id'].length > 0))))) fail('ARGUMENTS');
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
  const mode = expected.mode ?? 'mechanics';
  const mechanics = mode === 'mechanics';
  const hashKeys = mechanics ? ['oracle'] : ['design', 'oracle', 'candidate', 'manifest'];
  const job = expected.job ?? { checkId: null, recipeId: null, mutantSha256: null };
  const outcomes = mechanics ? ['MECHANICS_PASS', 'MECHANICS_FAIL'] :
    [mode === 'baseline' ? 'BASELINE_PASS' : 'CAUGHT_NAMED_RED', mode === 'baseline' ? 'BASELINE_FAIL' : 'MUTANT_SURVIVED',
      'WRONG_ASSERTION', 'SUBJECT_CRASH', 'SETUP_BLOCKED', 'CUSTODY_FAILURE', 'PROTOCOL_FAILURE'];
  if (!exact(t, ['schemaVersion', 'mode', 'runId', 'runtime', 'observedHashes', 'job', 'outcome', 'observations', 'error']) ||
      t.schemaVersion !== 1 || !['mechanics', 'baseline', 'mutation'].includes(mode) || t.mode !== mode || !UUID.test(t.runId) || t.runId !== expected.runId ||
      !runtimeShape(t.runtime) || !exact(expected.runtime, ['name', 'version', 'v8', 'typescript']) ||
      Object.keys(t.runtime).some(key => t.runtime[key] !== expected.runtime[key]) ||
      !exact(t.observedHashes, hashKeys) || hashKeys.some(key => !HEX.test(t.observedHashes[key]) || t.observedHashes[key] !== expected[key]) ||
      !exact(t.job, ['checkId', 'recipeId', 'mutantSha256']) || Object.keys(t.job).some(key => t.job[key] !== job[key]) ||
      !outcomes.includes(t.outcome) ||
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
  if (!mechanics) {
    const success = ['BASELINE_PASS', 'CAUGHT_NAMED_RED'].includes(t.outcome);
    const api = t.job.checkId === 'REG-BASE-58';
    if (!['S', 'V', 'P', 'API'].includes(expected.leafMode) || (expected.leafMode === 'API') !== api) fail('STDOUT_PROTOCOL');
    if (['BASELINE_PASS', 'MUTANT_SURVIVED'].includes(t.outcome) &&
        ((expected.leafMode === 'V' && o.urlConstructs === 0) || (expected.leafMode === 'P' &&
          (o.parserCalls !== 0 || o.wholeEncodeViolations !== 0 || o.encodeIntoViolations !== 0)))) fail('STDOUT_PROTOCOL');
    if (!text(job.checkId) || (mode === 'baseline' ? job.recipeId !== null || job.mutantSha256 !== null : typeof job.recipeId !== 'string' || job.recipeId.length === 0 || !HEX.test(job.mutantSha256))) fail('STDOUT_PROTOCOL');
    if (success || t.outcome === 'MUTANT_SURVIVED' || t.outcome === 'BASELINE_FAIL') {
      if (!o.fixtureReady || !o.calibrationPassed || !o.assertionEntered || o.assertionId !== job.checkId ||
          o.subjectEntered !== !api || o.subjectCompleted !== !api ||
          o.assertionFailed !== ['CAUGHT_NAMED_RED', 'BASELINE_FAIL'].includes(t.outcome)) fail('STDOUT_PROTOCOL');
    }
    if (success ? t.error !== null : t.error === null) fail('STDOUT_PROTOCOL');
    if (api && (o.subjectEntered || o.subjectCompleted || counters.some(key => o[key] !== 0))) fail('STDOUT_PROTOCOL');
  }
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

// Read each caller path once; every later operation uses these authenticated
// buffers or their exclusive content-addressed capsules. No source token scan is
// mistaken for the independent pure-module / semantic-patch review prerequisite.
// Host-side reconstruction uses native Buffer search/concat and node:crypto,
// independently of the stdin oracle's Uint8Array patch loop and subtle digest.
export function nativePatch(original, recipe) {
  const needle = Buffer.from(recipe.needleBase64, 'base64'), replacement = Buffer.from(recipe.replacementBase64, 'base64');
  if (!needle.length || needle.toString('base64') !== recipe.needleBase64 || replacement.toString('base64') !== recipe.replacementBase64 ||
      recipe.expectedOccurrences !== 1 || needle.equals(replacement)) fail('PATCH_SHAPE');
  const source = Buffer.from(original), offset = source.indexOf(needle);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  decoder.decode(source); decoder.decode(needle); decoder.decode(replacement);
  if (offset < 0 || source.indexOf(needle, offset + 1) !== -1) fail('PATCH_OCCURRENCES');
  const bytes = Buffer.concat([source.subarray(0, offset), replacement, source.subarray(offset + needle.length)]);
  if (hash(bytes) !== recipe.mutantSha256) fail('PATCH_HASH');
  return { bytes, offset };
}
async function admitObjects(options, oracleBytes, runDir = null) {
  const pins = Object.fromEntries(['design', 'oracle', 'candidate', 'manifest'].map(key => [key, options[`--${key}-sha256`]]));
  if (Object.values(pins).some(value => typeof value !== 'string' || !HEX.test(value)) || hash(oracleBytes) !== pins.oracle) fail('ADMISSION_FAILURE');
  const buffers = { oracle: oracleBytes };
  for (const key of ['design', 'candidate', 'manifest']) {
    buffers[key] = await readFile(options[`--${key}`]);
    if (hash(buffers[key]) !== pins[key]) fail('CAPSULE_HASH');
  }
  if (runDir) for (const [key, name] of [['design', 'design.md'], ['candidate', 'candidate.mjs'], ['manifest', 'manifest.json']]) {
    await mkdir(join(runDir, pins[key]), { recursive: true, mode: 0o700 });
    await store(join(runDir, pins[key], name), buffers[key]);
  }
  // This is O, already authenticated above, not C. O is self-contained and its
  // library import runs no subject. Candidate bytes are NEVER imported by host.
  const api = await import('data:text/javascript;base64,' + oracleBytes.toString('base64'));
  let manifest;
  try {
    manifest = await api.authenticateCandidate(new Uint8Array(buffers.candidate), new Uint8Array(buffers.manifest), pins);
    for (const recipe of manifest.recipes) nativePatch(buffers.candidate, recipe);
  }
  catch { fail('ADMISSION_FAILURE'); }
  return { pins, buffers, api, manifest };
}

export async function capture(args) {
  let runDir = null;
  const envelope = { schemaVersion: 1, kind: 'registry-oracle-host', mode: 'mechanics',
    runId: null, expected: null, runtime: null, authentication: 'external-entry-bytes',
    oracleAuthenticated: false, probe: null, interpreter: null, terminal: null,
    validTerminal: false, status: 'HOST_FAILURE', failure: null, retained: false };
  try {
    const options = parseArgs(args);
    envelope.mode = options['--mode'];
    const mechanics = envelope.mode === 'mechanics';
    const parent = await realpath(options['--evidence-parent']);
    // Deno's permission list is comma-separated. Refuse ambiguous capsule paths
    // rather than accidentally granting a second, broader path.
    if (isRamBacked(parent) || (!mechanics && parent.includes(','))) fail('EVIDENCE_PARENT');
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
    let admitted = null;
    if (!mechanics) {
      admitted = await admitObjects(options, bytes, runDir);
      const selected = admitted.api.expectedJobs(admitted.manifest).find(job => job.mode === envelope.mode &&
        job.checkId === options['--check-id'] && job.recipeId === (options['--recipe-id'] ?? null));
      if (!selected) fail('JOB_ID');
      const { mode: _, ...job } = selected;
      envelope.expected = { ...admitted.pins, job };
    }
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
    const candidateArgs = mechanics ? [] : ['--design-sha256', admitted.pins.design,
      '--candidate', join(runDir, admitted.pins.candidate, 'candidate.mjs'), '--candidate-sha256', admitted.pins.candidate,
      '--manifest', join(runDir, admitted.pins.manifest, 'manifest.json'), '--manifest-sha256', admitted.pins.manifest,
      '--check-id', envelope.expected.job.checkId, ...(envelope.mode === 'mutation' ? ['--recipe-id', envelope.expected.job.recipeId] : [])];
    const nativeArgs = !mechanics && name === 'deno' ? [...interpreterArgs.slice(0, -1),
      '--allow-read=' + [join(runDir, admitted.pins.candidate, 'candidate.mjs'), join(runDir, admitted.pins.manifest, 'manifest.json')].join(','), '-'] : interpreterArgs;
    const launchedArgs = [...nativeArgs, '--mode', envelope.mode, '--run-id', envelope.runId, '--oracle-sha256', O, ...candidateArgs];
    const result = await launch(executable, launchedArgs, bytes); // The authenticated buffer, NOT a reopened path.
    await saveProcess('interpreter', result);
    try {
      envelope.terminal = validateTerminal(result.stdout, { runId: envelope.runId, ...envelope.expected, runtime, mode: envelope.mode,
        leafMode: admitted?.api.CATALOGUE.find(leaf => leaf.checkId === envelope.expected.job.checkId)?.mode });
      envelope.validTerminal = true;
    } catch { envelope.failure = 'STDOUT_PROTOCOL'; }
    if (result.failure) envelope.failure = result.failure;
    else if (result.signal || result.exitCode !== 0) envelope.failure = 'INTERPRETER_EXIT';
    else if (envelope.validTerminal && !['MECHANICS_PASS', 'BASELINE_PASS', 'CAUGHT_NAMED_RED'].includes(envelope.terminal.outcome)) envelope.failure = 'ORACLE_FAILURE';
    if (!envelope.failure) envelope.status = envelope.terminal.outcome;
  } catch (error) {
    // Only our bounded identifiers are exposed. Never forward a path-bearing fs
    // error, subject payload, exception message, or stack from the interpreter.
    const known = ['ARGUMENTS', 'EVIDENCE_PARENT', 'EVIDENCE_WRITE', 'ORACLE_HASH_MISMATCH', 'RUNTIME_PROBE', 'RUNTIME_IDENTITY', 'ADMISSION_FAILURE', 'CAPSULE_HASH', 'JOB_ID'];
    envelope.failure = known.includes(error?.message) ? error.message : 'CAPTURE_FAILURE';
    envelope.status = 'HOST_FAILURE';
  }
  if (!runDir) return { ...envelope, runDir };
  try {
    // Announce retention only AFTER the exclusive file write and byte readback.
    const retained = { ...envelope, retained: envelope.failure !== 'EVIDENCE_WRITE' };
    const envelopeBytes = JSON.stringify(retained) + '\n';
    await store(join(runDir, 'host-envelope.json'), envelopeBytes);
    return { ...retained, runDir, envelopeSha256: hash(envelopeBytes) };
  } catch {
    return { ...envelope, status: 'HOST_FAILURE', failure: 'EVIDENCE_WRITE', retained: false, runDir };
  }
}

if (import.meta.main) {
  const result = await capture(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = ['MECHANICS_PASS', 'BASELINE_PASS', 'CAUGHT_NAMED_RED'].includes(result.status) && result.retained ? 0 : 1;
}
