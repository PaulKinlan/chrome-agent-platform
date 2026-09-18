// DEVELOPMENT ONLY: synthetic terminals exercise set/protocol reconciliation;
// they are NOT observations of any product or approved candidate/manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { capture, parseArgs, validateTerminal, nativePatch } from './capture.mjs';
import { reconcileJobRecords, reconcile } from './reconcile.mjs';
import { BASELINE_LEAF_IDS, REQUIRED_EDGES, expectedJobs, CATALOGUE } from './oracle.mjs';
import { isRamBacked } from '../lib/durable-root.mjs';
assert.ok(process.env.ORACLE_S1_EVIDENCE_PARENT?.startsWith('/'));
const parent = await realpath(process.env.ORACLE_S1_EVIDENCE_PARENT);
assert.ok(!isRamBacked(parent));
const root = join(parent, randomUUID()); await mkdir(root);
console.log('# DEVELOPMENT reconciliation evidence: ' + root);
const digest = b => createHash('sha256').update(b).digest('hex');
const oraclePath = resolve('scripts/registry-oracle/oracle.mjs'), oracleBytes = await readFile(oraclePath);
const pins = { design: 'a'.repeat(64), oracle: digest(oracleBytes), candidate: 'c'.repeat(64), manifest: 'd'.repeat(64) };
// Structural grouping only: not an actual mutation recipe or semantic rationale.
const jobs = expectedJobs({ baselineLeafIds: [...BASELINE_LEAF_IDS], recipes: [{ recipeId: 'SYNTHETIC-TERMINAL-GROUP',
  mutantSha256: 'f'.repeat(64), edges: REQUIRED_EDGES }] });
function records() {
  return ['node', 'deno'].flatMap(name => jobs.map(({ mode, ...job }) => {
    const runtime = { name, version: 'synthetic', v8: 'synthetic', typescript: name === 'node' ? null : 'synthetic' };
    const runId = randomUUID(), api = job.checkId === 'REG-BASE-58', mutation = mode === 'mutation';
    const leafMode = CATALOGUE.find(leaf => leaf.checkId === job.checkId).mode;
    const constructs = leafMode === 'V' ? 1 : 0;
    const terminal = { schemaVersion: 1, mode, runId, runtime, observedHashes: { ...pins }, job,
      outcome: mutation ? 'CAUGHT_NAMED_RED' : 'BASELINE_PASS', observations: {
        fixtureReady: true, subjectEntered: !api, subjectCompleted: !api, assertionEntered: true,
        assertionFailed: mutation, calibrationPassed: true, assertionId: job.checkId,
        parserCalls: constructs, parserReturns: constructs, urlConstructs: constructs, encoderConstructs: 0, wholeEncodeViolations: 0, encodeIntoViolations: 0 }, error: null };
    return { expected: { runId, runtime, mode, leafMode, ...pins, job }, runtime, stdout: Buffer.from(JSON.stringify(terminal) + '\n'),
      exitCode: 0, signal: null, failure: null, truncated: false };
  }));
}
function mutateTerminal(record, mutate) {
  const terminal = JSON.parse(record.stdout.toString()); mutate(terminal);
  record.stdout = Buffer.from(JSON.stringify(terminal) + '\n');
}
async function retain(label, data) { await writeFile(join(root, label + '.json'), JSON.stringify(data) + '\n', { flag: 'wx' }); }

test('exact full Node+Deno job sets, not counts or a favorable terminal', async () => {
  const complete = records(), summary = reconcileJobRecords(jobs, complete);
  assert.equal(summary.baselineObservations.length, BASELINE_LEAF_IDS.length * 2);
  assert.equal(summary.uniqueMutantHashes.length, 1);
  assert.equal(summary.caughtObservations.length, new Set(REQUIRED_EDGES.map(e => e.checkId)).size * 2);
  const cases = {
    missing: r => r.pop(), duplicate: r => r[1] = r[0], nodeOnly: r => r.splice(r.length / 2),
    nonzero: r => r[0].exitCode = 7, signal: r => r[0].signal = 'SIGKILL', hostFailure: r => r[0].failure = 'TIMEOUT',
    truncated: r => r[0].truncated = true, malformed: r => r[0].stdout = Buffer.from('{'),
    duplicateOutput: r => r[0].stdout = Buffer.concat([r[0].stdout, r[0].stdout]),
    changedHash: r => mutateTerminal(r[0], t => t.observedHashes.candidate = '0'.repeat(64)),
    crossedExpectedHash: r => { r[0].expected.candidate = '0'.repeat(64); mutateTerminal(r[0], t => t.observedHashes.candidate = '0'.repeat(64)); },
    wrongAssertion: r => mutateTerminal(r[jobs.findIndex(j => j.mode === 'mutation')], t => t.observations.assertionId = 'REG-BASE-99'),
    survived: r => mutateTerminal(r[jobs.findIndex(j => j.mode === 'mutation')], t => { t.outcome = 'MUTANT_SURVIVED'; t.observations.assertionFailed = false; t.error = { stage: 'assertion', code: 'MUTANT_SURVIVED' }; }),
    genericThrow: r => mutateTerminal(r[0], t => { t.outcome = 'SUBJECT_CRASH'; t.error = { stage: 'subject', code: 'SUBJECT_CRASH' }; }),
    changedJob: r => mutateTerminal(r[0], t => t.job.checkId = 'REG-BASE-99'),
    noSubject: r => mutateTerminal(r[0], t => { t.observations.subjectEntered = false; t.observations.subjectCompleted = false; }),
    missingValidParser: r => mutateTerminal(r[jobs.findIndex(j => j.checkId === 'REG-BASE-11')], t => t.observations.urlConstructs = 0),
    forbiddenParsePass: r => mutateTerminal(r[jobs.findIndex(j => j.checkId === 'REG-BASE-22')], t => t.observations.parserCalls = 1),
    apiInvocation: r => mutateTerminal(r[jobs.findIndex(j => j.checkId === 'REG-BASE-58')], t => { t.observations.subjectEntered = true; t.observations.subjectCompleted = true; }),
    changedRuntime: r => { r[0].expected.runtime = { ...r[0].runtime, version: 'changed' }; r[0].runtime = r[0].expected.runtime; mutateTerminal(r[0], t => t.runtime = r[0].runtime); },
    reusedRunId: r => { r[1].expected.runId = r[0].expected.runId; mutateTerminal(r[1], t => t.runId = r[0].expected.runId); },
  };
  for (const [label, damage] of Object.entries(cases)) {
    const values = records(); damage(values);
    let failure;
    try { reconcileJobRecords(jobs, values); } catch (error) { failure = error.message; }
    assert.ok(failure, label);
    await retain(label, { developmentOnly: true, failure, damagedRecord: values[0], productObservations: 0 });
  }
  await retain('synthetic-set-green', { developmentOnly: true, baselineRecords: summary.baselineObservations.length,
    caughtRecords: summary.caughtObservations.length, productObservations: 0 });
});

test('candidate terminal closed keys and crossed identities fail', () => {
  const record = records()[0];
  const valid = JSON.parse(record.stdout);
  for (const section of [null, 'observedHashes', 'job', 'observations']) {
    for (const key of Object.keys(section ? valid[section] : valid)) {
      const bad = structuredClone(valid); delete (section ? bad[section] : bad)[key];
      assert.throws(() => validateTerminal(Buffer.from(JSON.stringify(bad)), record.expected));
    }
    const extra = structuredClone(valid); (section ? extra[section] : extra).extra = 1;
    assert.throws(() => validateTerminal(Buffer.from(JSON.stringify(extra)), record.expected));
  }
});

test('complete authority arguments required; malformed real capsule capture refuses before any child', async () => {
  const directory = join(root, randomUUID()); await mkdir(directory);
  const files = { design: 'DEVELOPMENT DESIGN BYTES, NOT APPROVAL', candidate: '// DEVELOPMENT NEGATIVE: must not import\nthrow new Error("MUST_NOT_IMPORT");', manifest: '{}' };
  const authority = { oracle: { path: oraclePath, sha256: pins.oracle } };
  for (const [key, value] of Object.entries(files)) {
    const path = join(directory, key); await writeFile(path, value, { flag: 'wx' });
    authority[key] = { path, sha256: digest(value) };
  }
  const args = ['--mode', 'baseline', '--runtime', process.execPath, '--oracle', oraclePath, '--oracle-sha256', pins.oracle, '--evidence-parent', root];
  for (const key of ['design', 'candidate', 'manifest']) args.push('--' + key, authority[key].path, '--' + key + '-sha256', authority[key].sha256);
  args.push('--check-id', 'REG-BASE-01');
  assert.equal(parseArgs(args)['--mode'], 'baseline');
  for (let i = 0; i < args.length; i += 2) {
    assert.throws(() => parseArgs(args.filter((_, index) => index !== i && index !== i + 1)));
    assert.throws(() => parseArgs([...args, ...args.slice(i, i + 2)]));
  }
  assert.throws(() => parseArgs([...args, '--recipe-id', 'undeclared']));
  const result = await capture(args);
  assert.equal(result.failure, 'ADMISSION_FAILURE'); assert.equal(result.retained, true);
  assert.equal(result.interpreter, null); assert.equal(result.probe, null);
  assert.equal(digest(await readFile(join(result.runDir, 'host-envelope.json'))), result.envelopeSha256);
  await retain('invalid-manifest-native-capture', result);
  for (const key of ['design', 'candidate', 'manifest']) {
    const bad = [...args]; bad[bad.indexOf('--' + key + '-sha256') + 1] = '0'.repeat(64);
    const result = await capture(bad);
    assert.equal(result.failure, 'CAPSULE_HASH'); assert.equal(result.interpreter, null);
    await retain('wrong-' + key + '-capture', result);
  }
  await assert.rejects(reconcile(authority, [])); // Missing semantic/structural M never becomes overall acceptance.
});

test('retained-capture tampering fails before incomplete synthetic job set can reconcile', async () => {
  const directory = join(root, randomUUID()); await mkdir(directory);
  const original = Buffer.from('\uFEFF// STRUCTURAL alpha é\r\n'), patched = Buffer.from('\uFEFF// STRUCTURAL beta é\r\n');
  const localPins = { design: digest('STRUCTURAL design, NOT approval'), oracle: pins.oracle, candidate: digest(original), manifest: null };
  const recipe = { recipeId: 'STRUCTURAL-COMMENT-NOT-A-FAULT', needleBase64: Buffer.from('alpha').toString('base64'),
    replacementBase64: Buffer.from('beta').toString('base64'), expectedOccurrences: 1, mutantSha256: digest(patched),
    edges: REQUIRED_EDGES, rationale: 'DEVELOPMENT invalid semantic recipe: comment-only patch, no product.' };
  assert.deepEqual(nativePatch(original, recipe).bytes, patched);
  assert.throws(() => nativePatch(original, { ...recipe, mutantSha256: '0'.repeat(64) }));
  assert.throws(() => nativePatch(original, { ...recipe, replacementBase64: '/w==' }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, designSha256: localPins.design, oracleSha256: localPins.oracle,
    candidateSha256: localPins.candidate, baselineLeafIds: BASELINE_LEAF_IDS, recipes: [recipe] }));
  localPins.manifest = digest(manifest);
  const buffers = { design: Buffer.from('STRUCTURAL design, NOT approval'), oracle: oracleBytes, candidate: original, manifest };
  const authority = {};
  for (const key of Object.keys(buffers)) {
    const path = join(directory, key); await writeFile(path, buffers[key], { flag: 'wx' });
    authority[key] = { path, sha256: localPins[key] };
  }
  const variants = {
    missingJobs: () => {}, changedEnvelope: async (dir) => writeFile(join(dir, 'host-envelope.json'), '{}'),
    corruptStdout: async dir => writeFile(join(dir, 'interpreter.stdout'), '{}'),
    corruptStderr: async dir => writeFile(join(dir, 'interpreter.stderr'), 'changed'),
    corruptProbe: async dir => writeFile(join(dir, 'runtime-probe.stdout'), '{}'),
    changedCapsule: async dir => writeFile(join(dir, localPins.candidate, 'candidate.mjs'), 'changed'),
    nonzero: async (_, host) => host.interpreter.exitCode = 7,
    truncation: async (_, host) => host.interpreter.truncated = true,
    crossedJob: async (_, host) => host.expected.job.checkId = 'REG-BASE-02',
    crossedHash: async (_, host) => host.expected.manifest = '0'.repeat(64),
    alteredLaunch: async (_, host) => host.interpreter.args.push('--allow-all'),
    forgedHostTerminal: async (_, host) => host.terminal.outcome = 'CAUGHT_NAMED_RED',
  };
  for (const [label, damage] of Object.entries(variants)) {
    const runId = randomUUID(), dir = join(directory, runId); await mkdir(dir);
    for (const [key, file] of [['design', 'design.md'], ['oracle', 'oracle.mjs'], ['candidate', 'candidate.mjs'], ['manifest', 'manifest.json']]) {
      await mkdir(join(dir, localPins[key])); await writeFile(join(dir, localPins[key], file), buffers[key], { flag: 'wx' });
    }
    const runtime = { name: 'node', version: 'SYNTHETIC', v8: 'SYNTHETIC', typescript: null };
    const job = { checkId: 'REG-BASE-01', recipeId: null, mutantSha256: null };
    const terminal = { schemaVersion: 1, mode: 'baseline', runId, runtime, observedHashes: { ...localPins }, job: { ...job },
      outcome: 'BASELINE_PASS', observations: { fixtureReady: true, subjectEntered: true, subjectCompleted: true, assertionEntered: true,
        assertionFailed: false, calibrationPassed: true, assertionId: job.checkId, parserCalls: 0, parserReturns: 0, urlConstructs: 0,
        encoderConstructs: 0, wholeEncodeViolations: 0, encodeIntoViolations: 0 }, error: null };
    const prefix = ['--input-type=module', '-'];
    const args = [...prefix, '--mode', 'baseline', '--run-id', runId, '--oracle-sha256', localPins.oracle,
      '--design-sha256', localPins.design, '--candidate', join(dir, localPins.candidate, 'candidate.mjs'), '--candidate-sha256', localPins.candidate,
      '--manifest', join(dir, localPins.manifest, 'manifest.json'), '--manifest-sha256', localPins.manifest, '--check-id', job.checkId];
    const host = { schemaVersion: 1, kind: 'registry-oracle-host', mode: 'baseline', runId, expected: { ...localPins, job }, runtime,
      authentication: 'external-entry-bytes', oracleAuthenticated: true, probe: null, interpreter: null, terminal,
      validTerminal: true, status: 'BASELINE_PASS', failure: null, retained: true };
    for (const [key, stem, value, argv] of [['probe', 'runtime-probe', runtime, prefix], ['interpreter', 'interpreter', terminal, args]]) {
      const stdout = Buffer.from(JSON.stringify(value) + '\n'), stderr = Buffer.alloc(0);
      host[key] = { executable: process.execPath, args: argv, exitCode: 0, signal: null, failure: null, truncated: false,
        stdoutSha256: digest(stdout), stderrSha256: digest(stderr), stdoutBytes: stdout.length, stderrBytes: 0 };
      await writeFile(join(dir, stem + '.stdout'), stdout, { flag: 'wx' }); await writeFile(join(dir, stem + '.stderr'), stderr, { flag: 'wx' });
    }
    const path = join(dir, 'host-envelope.json');
    if (label === 'changedEnvelope') {
      const bytes = JSON.stringify(host) + '\n'; await writeFile(path, bytes, { flag: 'wx' });
      await damage(dir, host);
      await assert.rejects(reconcile(authority, [{ path, sha256: digest(bytes) }]), /ENVELOPE_HASH/);
    } else {
      await damage(dir, host);
      const bytes = JSON.stringify(host) + '\n'; await writeFile(path, bytes, { flag: 'wx' });
      let failure;
      try { await reconcile(authority, [{ path, sha256: digest(bytes) }]); } catch (error) { failure = error.message; }
      assert.ok(failure, label);
      if (label === 'missingJobs') assert.equal(failure, 'JOB_SET');
      else assert.notEqual(failure, 'JOB_SET', label + ' must fail at custody boundary, not missing count');
      await retain('retained-' + label, { developmentOnly: true, failure, path, productObservations: 0 });
    }
  }
});
