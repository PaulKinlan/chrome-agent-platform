// External reconciliation, not oracle testimony. Receipt references (path/hash)
// must come from the trusted capturer, never be discovered in an evidence tree.
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, isAbsolute, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capture, validateTerminal, nativePatch } from './capture.mjs';
import { isRamBacked } from '../lib/durable-root.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Reflect.ownKeys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const jobKey = job => JSON.stringify([job.mode, job.checkId, job.recipeId, job.mutantSha256]);

async function authorityObjects(authority) {
  if (!exact(authority, ['design', 'oracle', 'candidate', 'manifest'])) fail('AUTHORITY');
  const pins = {}, buffers = {};
  for (const key of Object.keys(authority)) {
    const object = authority[key];
    if (!exact(object, ['path', 'sha256']) || !isAbsolute(object.path) || !HEX.test(object.sha256)) fail('AUTHORITY');
    pins[key] = object.sha256;
    buffers[key] = await readFile(object.path);
    if (hash(buffers[key]) !== pins[key]) fail('AUTHORITY_HASH');
  }
  const api = await import('data:text/javascript;base64,' + buffers.oracle.toString('base64'));
  const manifest = await api.authenticateCandidate(new Uint8Array(buffers.candidate), new Uint8Array(buffers.manifest), pins);
  for (const recipe of manifest.recipes) nativePatch(buffers.candidate, recipe);
  return { pins, buffers, api, manifest };
}

// Pure structural reconciliation seam for DEVELOPMENT terminal vectors. No
// filesystem authentication here; only reconcile() can admit retained captures.
export function reconcileJobRecords(jobs, records) {
  const wanted = new Set(jobs.map(jobKey));
  if (wanted.size !== jobs.length || !Array.isArray(records) || records.length !== wanted.size * 2) fail('JOB_SET');
  const seen = new Set(), runs = new Set(), versions = new Map(), baseline = [], mutants = new Set(), edges = [];
  let hashes;
  for (const record of records) {
    if (!record || !['node', 'deno'].includes(record.runtime?.name)) fail('RUNTIME');
    const t = validateTerminal(record.stdout, record.expected);
    if (!same(t.runtime, record.runtime) || record.exitCode !== 0 || record.signal !== null || record.failure !== null || record.truncated !== false) fail('PROCESS_FAILURE');
    if (runs.has(t.runId) || (hashes && !same(hashes, t.observedHashes))) fail('IDENTITY_CHANGED');
    runs.add(t.runId); hashes = t.observedHashes;
    const identity = jobKey({ mode: t.mode, ...t.job }), key = t.runtime.name + '/' + identity;
    if (!wanted.has(identity) || seen.has(key)) fail('JOB_SET');
    seen.add(key);
    if (versions.has(t.runtime.name) && !same(versions.get(t.runtime.name), t.runtime)) fail('RUNTIME_CHANGED');
    versions.set(t.runtime.name, t.runtime);
    if (t.mode === 'baseline' && t.outcome === 'BASELINE_PASS') baseline.push({ runtime: t.runtime.name, checkId: t.job.checkId });
    else if (t.mode === 'mutation' && t.outcome === 'CAUGHT_NAMED_RED') {
      mutants.add(t.job.mutantSha256); edges.push({ runtime: t.runtime.name, ...t.job });
    } else fail('UNACCEPTED_OUTCOME');
  }
  for (const runtime of ['node', 'deno']) for (const key of wanted) if (!seen.has(runtime + '/' + key)) fail('JOB_SET');
  return { baselineObservations: baseline, uniqueMutantHashes: [...mutants], caughtObservations: edges };
}

export async function reconcile(authority, receipts) {
  const { pins, buffers, api, manifest } = await authorityObjects(authority);
  if (!Array.isArray(receipts) || Reflect.ownKeys(receipts).length !== receipts.length + 1) fail('RECEIPTS');
  const records = [], runs = new Set();
  for (const reference of receipts) {
    if (!exact(reference, ['path', 'sha256']) || !isAbsolute(reference.path) || !HEX.test(reference.sha256) || basename(reference.path) !== 'host-envelope.json') fail('RECEIPT_REFERENCE');
    const bytes = await readFile(reference.path); // Once, hash before JSON.
    if (hash(bytes) !== reference.sha256) fail('ENVELOPE_HASH');
    const host = api.parseManifestJSON(bytes); // Same duplicate-key refusal.
    if (!exact(host, ['schemaVersion', 'kind', 'mode', 'runId', 'expected', 'runtime', 'authentication', 'oracleAuthenticated',
      'probe', 'interpreter', 'terminal', 'validTerminal', 'status', 'failure', 'retained']) ||
      host.schemaVersion !== 1 || host.kind !== 'registry-oracle-host' || !UUID.test(host.runId) || runs.has(host.runId) ||
      host.authentication !== 'external-entry-bytes' || host.oracleAuthenticated !== true || host.validTerminal !== true ||
      host.retained !== true || host.failure !== null || !['BASELINE_PASS', 'CAUGHT_NAMED_RED'].includes(host.status) ||
      !exact(host.expected, ['design', 'oracle', 'candidate', 'manifest', 'job']) ||
      Object.keys(pins).some(key => host.expected[key] !== pins[key])) fail('HOST_ENVELOPE');
    runs.add(host.runId);
    const root = await realpath(dirname(reference.path));
    if (isRamBacked(root) || basename(root) !== host.runId) fail('RUN_DIRECTORY');
    for (const [key, file] of [['design', 'design.md'], ['oracle', 'oracle.mjs'], ['candidate', 'candidate.mjs'], ['manifest', 'manifest.json']]) {
      const retained = await readFile(join(root, pins[key], file));
      if (!retained.equals(buffers[key])) fail('CAPSULE_CHANGED');
    }
    const captures = {};
    for (const [key, stem] of [['probe', 'runtime-probe'], ['interpreter', 'interpreter']]) {
      const p = host[key];
      if (!exact(p, ['executable', 'args', 'exitCode', 'signal', 'failure', 'truncated', 'stdoutSha256', 'stderrSha256', 'stdoutBytes', 'stderrBytes']) ||
          !isAbsolute(p.executable) || !Array.isArray(p.args) || p.exitCode !== 0 || p.signal !== null || p.failure !== null || p.truncated !== false) fail('PROCESS_FAILURE');
      for (const stream of ['stdout', 'stderr']) {
        const raw = await readFile(join(root, `${stem}.${stream}`));
        if (hash(raw) !== p[stream + 'Sha256'] || raw.length !== p[stream + 'Bytes']) fail('CAPTURE_HASH');
        if (stream === 'stdout') captures[key] = raw;
      }
    }
    if (!same(api.parseManifestJSON(captures.probe), host.runtime) || host.probe.executable !== host.interpreter.executable) fail('RUNTIME_PROBE');
    const prefix = host.runtime.name === 'node' ? ['--input-type=module', '-'] :
      ['run', '--no-prompt', '--no-config', '--no-lock', '--cached-only', '--ext=js', '-'];
    if (!same(host.probe.args, prefix)) fail('LAUNCH_ARGUMENTS');
    const native = host.runtime.name === 'deno' ? [...prefix.slice(0, -1), '--allow-read=' +
      [join(root, pins.candidate, 'candidate.mjs'), join(root, pins.manifest, 'manifest.json')].join(','), '-'] : prefix;
    const wantedArgs = [...native, '--mode', host.mode, '--run-id', host.runId, '--oracle-sha256', pins.oracle,
      '--design-sha256', pins.design, '--candidate', join(root, pins.candidate, 'candidate.mjs'), '--candidate-sha256', pins.candidate,
      '--manifest', join(root, pins.manifest, 'manifest.json'), '--manifest-sha256', pins.manifest,
      '--check-id', host.expected.job.checkId, ...(host.mode === 'mutation' ? ['--recipe-id', host.expected.job.recipeId] : [])];
    if (!same(host.interpreter.args, wantedArgs)) fail('LAUNCH_ARGUMENTS');
    const expected = { runId: host.runId, ...host.expected, runtime: host.runtime, mode: host.mode,
      leafMode: api.CATALOGUE.find(leaf => leaf.checkId === host.expected.job.checkId)?.mode };
    const terminal = validateTerminal(captures.interpreter, expected);
    if (!same(terminal, host.terminal) || terminal.outcome !== host.status) fail('HOST_TERMINAL');
    records.push({ ...host.interpreter, stdout: captures.interpreter, expected, runtime: host.runtime });
  }
  const result = reconcileJobRecords(api.expectedJobs(manifest), records);
  const caughtEdges = [];
  for (const observation of result.caughtObservations) {
    const recipe = manifest.recipes.find(recipe => recipe.recipeId === observation.recipeId);
    for (const edge of recipe.edges.filter(edge => edge.checkId === observation.checkId)) caughtEdges.push({ ...edge,
      runtime: observation.runtime, recipeId: recipe.recipeId, mutantSha256: recipe.mutantSha256 });
  }
  for (const runtime of ['node', 'deno']) api.validateRequiredEdges(caughtEdges.filter(edge => edge.runtime === runtime)
    .map(({ faultId, checkId }) => ({ faultId, checkId })));
  return { status: 'ACCEPTED', observedHashes: pins, ...result, caughtEdges };
}

// One process per job, sequential by construction. This controller is generic;
// calling it requires independently admitted C/M, not locally computed pins.
export async function runMatrix(authority, runtimes, evidenceParent) {
  if (!exact(runtimes, ['node', 'deno']) || Object.entries(runtimes).some(([name, path]) => !isAbsolute(path) || basename(path) !== name)) fail('RUNTIMES');
  const parent = await realpath(evidenceParent);
  if (isRamBacked(parent)) fail('EVIDENCE_PARENT');
  const { api, manifest } = await authorityObjects(authority);
  const references = [], failures = [];
  for (const runtime of ['node', 'deno']) {
    const common = ['--runtime', runtimes[runtime], '--oracle', authority.oracle.path, '--oracle-sha256', authority.oracle.sha256, '--evidence-parent', parent];
    const mechanics = await capture(['--mode', 'mechanics', ...common]);
    if (mechanics.status !== 'MECHANICS_PASS' || !mechanics.retained) fail('MECHANICS_PREREQUISITE');
    for (const job of api.expectedJobs(manifest)) {
      const args = ['--mode', job.mode, ...common];
      for (const key of ['design', 'candidate', 'manifest']) args.push('--' + key, authority[key].path, '--' + key + '-sha256', authority[key].sha256);
      args.push('--check-id', job.checkId);
      if (job.recipeId !== null) args.push('--recipe-id', job.recipeId);
      const result = await capture(args);
      if (result.retained) references.push({ path: join(result.runDir, 'host-envelope.json'), sha256: result.envelopeSha256 });
      if (!result.retained || !['BASELINE_PASS', 'CAUGHT_NAMED_RED'].includes(result.status)) failures.push({ runId: result.runId, failure: result.failure });
    }
  }
  let result;
  try { result = failures.length ? { status: 'REJECTED', failures } : await reconcile(authority, references); }
  catch (error) { result = { status: 'REJECTED', failure: 'RECONCILIATION_FAILURE' }; }
  const root = join(parent, randomUUID());
  await mkdir(root, { mode: 0o700 });
  const bytes = JSON.stringify({ ...result, receipts: references }) + '\n';
  const path = join(root, 'reconciliation.json');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) fail('EVIDENCE_WRITE');
  return { ...result, path, sha256: hash(bytes) };
}
