// Candidate-free DEVELOPMENT tests. Mock entries below test host protocol only;
// even a mock MECHANICS_PASS is never registry or official oracle evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { capture, parseArgs, validateTerminal } from './capture.mjs';
import { CHUNK, encodeBase64, decodeBase64, sha256, verifiedDataURL, createObservers, calibrateAssertionOrigin, runMechanics, entryArgs } from './oracle.mjs';
import { isRamBacked } from '../lib/durable-root.mjs';

const parent = await realpath(process.env.ORACLE_S1_EVIDENCE_PARENT ?? '');
assert.ok(process.env.ORACLE_S1_EVIDENCE_PARENT, 'Explicit ORACLE_S1_EVIDENCE_PARENT required');
assert.ok(!isRamBacked(parent));
assert.ok(process.env.ORACLE_S1_DENO?.startsWith('/'), 'Explicit native ORACLE_S1_DENO required');
const root = join(parent, randomUUID());
await mkdir(root, { mode: 0o700 });
console.log(`# DEVELOPMENT evidence: ${root}`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const oraclePath = resolve('scripts/registry-oracle/oracle.mjs');
const oracleBytes = await readFile(oraclePath);
const O = digest(oracleBytes);
const args = (path = oraclePath, hash = O, runtime = process.execPath) => [
  '--mode', 'mechanics', '--runtime', runtime, '--oracle', path,
  '--oracle-sha256', hash, '--evidence-parent', root,
];
const expected = { runId: randomUUID(), oracle: O,
  runtime: { name: 'node', version: process.versions.node, v8: process.versions.v8, typescript: null } };
const terminal = () => ({ schemaVersion: 1, mode: 'mechanics', runId: expected.runId, runtime: { ...expected.runtime },
  observedHashes: { oracle: O }, job: { checkId: null, recipeId: null, mutantSha256: null }, outcome: 'MECHANICS_PASS',
  observations: { fixtureReady: true, subjectEntered: true, subjectCompleted: true, assertionEntered: true,
    assertionFailed: true, calibrationPassed: true, assertionId: 'MECH-PRIVATE-ASSERTION',
    parserCalls: 4, parserReturns: 3, urlConstructs: 2, encoderConstructs: 1, wholeEncodeViolations: 1, encodeIntoViolations: 1 }, error: null });
const validate = value => validateTerminal(new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)), expected);

// A tiny, explicitly fake terminal producer, with no product imports or fixtures.
const mockPrelude = `// HOST PROTOCOL ADVERSARY, NOT AN ORACLE OR REGISTRY\nconst t = ${JSON.stringify(terminal())};
const a = process.argv.slice(2); t.runId = a[a.indexOf('--run-id')+1];
t.observedHashes.oracle = a[a.indexOf('--oracle-sha256')+1];\n`;
async function mock(label, body) {
  const directory = join(root, randomUUID());
  await mkdir(directory);
  const path = join(directory, label + '.mock.mjs');
  const bytes = mockPrelude + body;
  await writeFile(path, bytes, { flag: 'wx' });
  return { path, hash: digest(bytes) };
}
async function evidence(label, result) {
  await writeFile(join(root, label + '.result.json'), JSON.stringify(result) + '\n', { flag: 'wx' });
  if (result.retained) {
    const retained = JSON.parse(await readFile(join(result.runDir, 'host-envelope.json'), 'utf8'));
    assert.equal(retained.status, result.status);
    for (const [key, stem] of [['probe', 'runtime-probe'], ['interpreter', 'interpreter']]) {
      if (retained[key]) {
        for (const stream of ['stdout', 'stderr']) {
          const bytes = await readFile(join(result.runDir, `${stem}.${stream}`));
          assert.equal(digest(bytes), retained[key][`${stream}Sha256`]);
        }
      }
    }
  }
}

test('arguments are explicit, unique, known, and mechanics-only', () => {
  assert.equal(parseArgs(args())['--mode'], 'mechanics');
  for (let i = 0; i < args().length; i += 2) {
    assert.throws(() => parseArgs(args().filter((_, index) => index !== i && index !== i + 1)));
    assert.throws(() => parseArgs([...args(), ...args().slice(i, i + 2)]));
  }
  for (const flag of ['--candidate', '--manifest', '--design', '--baseline', '--mutation', '--recipe-id', '--check-id', '--unknown']) {
    assert.throws(() => parseArgs([...args(), flag, 'x']));
  }
  for (const mode of ['baseline', 'mutation', 'self-test', '']) {
    const bad = args(); bad[1] = mode; assert.throws(() => parseArgs(bad));
  }
  const entry = ['--mode', 'mechanics', '--run-id', expected.runId, '--oracle-sha256', O];
  assert.equal(entryArgs(entry)['--run-id'], expected.runId);
  for (let i = 0; i < entry.length; i += 2) {
    assert.throws(() => entryArgs(entry.filter((_, index) => index !== i && index !== i + 1)));
    assert.throws(() => entryArgs([...entry, ...entry.slice(i, i + 2)]));
  }
  for (const mode of ['baseline', 'mutation']) assert.throws(() => entryArgs(['--mode', mode, ...entry.slice(2)]));
  for (const flag of ['--candidate', '--manifest', '--design', '--unknown']) assert.throws(() => entryArgs([...entry, flag, 'x']));
  assert.throws(() => parseArgs([...args(), '--mode']));
  const relative = args(); relative[3] = 'node'; assert.throws(() => parseArgs(relative));
});

test('strict complete terminal shape, identity, counters, flags, and duplicate JSON keys', () => {
  assert.equal(validate(terminal()).outcome, 'MECHANICS_PASS');
  const source = JSON.stringify(terminal());
  for (const raw of ['', 'null', '{}', '[]', source + '\n' + source, 'banner\n' + source, source + '\n\n',
    source.slice(0, -1), '{"schemaVersion":0,' + source.slice(1), '{"schema\\u0056ersion":0,' + source.slice(1)]) {
    assert.throws(() => validate(raw));
  }
  assert.throws(() => validateTerminal(new Uint8Array([0xff]), expected));
  const collapsedJob = terminal();
  collapsedJob.job = { 'checkId,mutantSha256,recipeId': null };
  assert.throws(() => validate(collapsedJob));
  for (const section of [null, 'runtime', 'observedHashes', 'job', 'observations']) {
    const object = section ? terminal()[section] : terminal();
    for (const key of Object.keys(object)) {
      const missing = terminal(); delete (section ? missing[section] : missing)[key]; assert.throws(() => validate(missing));
      const wrong = terminal(); (section ? wrong[section] : wrong)[key] = []; assert.throws(() => validate(wrong));
    }
    const extra = terminal(); (section ? extra[section] : extra).extra = true; assert.throws(() => validate(extra));
  }
  for (const change of [t => t.runId = randomUUID(), t => t.runtime.version = 'wrong', t => t.runtime.v8 = 'wrong',
    t => t.runtime.name = 'deno', t => t.observedHashes.oracle = 'a'.repeat(64), t => t.job.checkId = 'REG-BASE-01',
    t => t.outcome = 'BASELINE_PASS', t => t.observations.parserCalls = -1, t => t.observations.encoderConstructs = 0.5,
    t => t.observations.parserReturns = Number.MAX_SAFE_INTEGER + 1, t => t.observations.calibrationPassed = false,
    t => t.observations.assertionFailed = false, t => t.observations.assertionId = 'forged',
    t => t.error = { stage: 'x', code: 'x', payload: 'forbidden' }, t => t.error = { stage: 'x', code: 'x'.repeat(129) }]) {
    const bad = terminal(); change(bad); assert.throws(() => validate(bad));
  }
  const failed = terminal(); failed.outcome = 'MECHANICS_FAIL'; failed.error = { stage: 'calibration', code: 'MECHANICS_CHECK' };
  assert.equal(validate(failed).outcome, 'MECHANICS_FAIL');
});

test('portable bytes reject tampering and preserve BOM/non-ASCII/CRLF at chunk boundaries', async () => {
  assert.equal(await sha256(new Uint8Array()), digest(new Uint8Array()));
  assert.equal(await sha256(new TextEncoder().encode('abc')), digest('abc'));
  for (const n of [0, 1, 2, 256, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK + 2, 2 * CHUNK + 1, 2 * CHUNK + 2]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => i % 256);
    const encoded = encodeBase64(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString('base64')); // Independent Node reference, NOT used by oracle.
    assert.deepEqual(decodeBase64(encoded), bytes);
  }
  for (const bad of ['A', 'AB==', 'AAB=', 'AA==AA==', ' AA==', 'AA==\n', '_A==']) assert.throws(() => decodeBase64(bad));
  const bytes = new TextEncoder().encode('\uFEFF// é 日本語\r\nexport const value = "🦉";\r\n');
  const url = await verifiedDataURL(bytes, digest(bytes));
  assert.deepEqual(decodeBase64(url.split(',')[1]), bytes);
  assert.equal((await import(url)).value, '🦉');
  await assert.rejects(verifiedDataURL(bytes, '0'.repeat(64)));
  await assert.rejects(verifiedDataURL(bytes, digest(bytes), encodeBase64(bytes.subarray(1))));
});

test('native brands, extracted methods, parser attempts, bounds, private assertion identity, and restoration', async () => {
  const targets = [[globalThis, 'URL'], [globalThis, 'TextEncoder'], [URL, 'parse'], [URL, 'canParse'],
    [TextEncoder.prototype, 'encode'], [TextEncoder.prototype, 'encodeInto']];
  const before = targets.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key));
  const result = await runMechanics();
  assert.equal(result.outcome, 'MECHANICS_PASS');
  assert.ok(result.observations.parserCalls > result.observations.parserReturns);
  assert.equal(result.observations.wholeEncodeViolations, 1);
  assert.equal(result.observations.encodeIntoViolations, 1);
  const forged = new TypeError('oracle assertion'); forged.name = 'OracleAssertion';
  assert.equal(calibrateAssertionOrigin(forged).assertionId, 'MECH-PRIVATE-ASSERTION');
  const observer = createObservers();
  try {
    observer.install();
    targets.forEach(([object, key], i) => {
      const native = before[i]?.value;
      if (typeof native === 'function') {
        assert.equal(object[key].name, native.name);
        assert.equal(object[key].length, native.length);
        assert.equal(object[key].prototype, native.prototype);
      }
    });
    assert.throws(() => observer.observe(() => { throw forged; }), error => error === forged);
    const receiver = new TextEncoder(); const encode = receiver.encode;
    assert.deepEqual(encode.call(receiver, 'é'), new Uint8Array([195, 169]));
    assert.throws(() => encode.call({}), TypeError);
  } finally { observer.restore(); }
  targets.forEach(([object, key], i) => assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), before[i]));
});

test('native constructor accessor descriptors install and restore without a substitute encoder', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
  let native = TextEncoder;
  const accessor = { configurable: true, enumerable: false, get: () => native, set: value => { native = value; } };
  Object.defineProperty(globalThis, 'TextEncoder', accessor);
  const observer = createObservers();
  try {
    observer.install();
    const bytes = observer.observe(() => new TextEncoder().encode('é'));
    assert.deepEqual(bytes, new Uint8Array([195, 169]));
    assert.equal(observer.snapshot().counters.encoderConstructs, 1);
    observer.restore();
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder'), accessor);
    assert.equal(TextEncoder, original.value);
  } finally { observer.restore(); Object.defineProperty(globalThis, 'TextEncoder', original); }
});

test('wrong external O prevents code from executing and retains host failure', async () => {
  const marker = join(root, 'MUST-NOT-EXIST');
  const entry = await mock('wrong-O', `await (await import('node:fs/promises')).writeFile(${JSON.stringify(marker)}, 'executed', {flag:'wx'});`);
  const result = await capture(args(entry.path, '0'.repeat(64)));
  await evidence('wrong-O', result);
  assert.equal(result.failure, 'ORACLE_HASH_MISMATCH');
  assert.equal(result.oracleAuthenticated, false);
  assert.equal(result.interpreter, null); assert.equal(result.probe, null);
  assert.equal(result.retained, true);
  assert.ok(!(await readdir(root)).includes('MUST-NOT-EXIST'));
});

test('host protocol adversaries retain failure, never pass from output text alone', async t => {
  const cases = {
    absent: '', duplicate: 'console.log(JSON.stringify(t)); console.log(JSON.stringify(t));',
    malformed: 'console.log("{");', extra: 'console.log("banner"); console.log(JSON.stringify(t));',
    shape: 't.extra=true; console.log(JSON.stringify(t));', identity: 't.runtime.version="wrong"; console.log(JSON.stringify(t));',
    nonzero: 'console.log(JSON.stringify(t)); process.exitCode=7;',
    crash: 'throw new TypeError("candidate-free mock crash");',
    signal: 'process.kill(process.pid,"SIGKILL");',
    timeout: 'setInterval(()=>{},1000);',
    flood: 'process.stdout.write("x".repeat(70000));',
    // Error name/message cannot earn product RED, even with an otherwise valid terminal.
    forged: 't.outcome="CAUGHT_NAMED_RED"; console.log(JSON.stringify(t));',
    oracleFail: 't.outcome="MECHANICS_FAIL"; t.error={stage:"calibration",code:"MECHANICS_CHECK"}; console.log(JSON.stringify(t)); process.exitCode=1;',
  };
  for (const [label, body] of Object.entries(cases)) await t.test(label, async () => {
    const entry = await mock(label, body);
    const result = await capture(args(entry.path, entry.hash));
    await evidence(label, result);
    assert.equal(result.status, 'HOST_FAILURE'); assert.equal(result.retained, true);
    assert.ok(result.failure); assert.ok(result.interpreter);
    if (label === 'nonzero') assert.equal(result.interpreter.exitCode, 7);
    if (label === 'signal') assert.equal(result.interpreter.signal, 'SIGKILL');
    if (label === 'timeout') assert.equal(result.failure, 'TIMEOUT');
    if (label === 'flood') assert.equal(result.interpreter.truncated, true);
  });
});

test('launch prerequisite and evidence-write failures cannot claim green retention', async () => {
  const missing = await capture(args(oraclePath, O, join(root, 'missing', 'node')));
  await evidence('missing-runtime', missing);
  assert.equal(missing.status, 'HOST_FAILURE'); assert.equal(missing.retained, true);
  const noExecDir = join(root, randomUUID()); await mkdir(noExecDir);
  const noExec = join(noExecDir, 'node'); await writeFile(noExec, '// not executable', { flag: 'wx', mode: 0o600 });
  const launchFailure = await capture(args(oraclePath, O, noExec));
  await evidence('launch-failure', launchFailure);
  assert.equal(launchFailure.status, 'HOST_FAILURE'); assert.equal(launchFailure.probe.failure, 'LAUNCH_FAILURE');
  for (const [label, bad] of [['missing', []], ['duplicate', [...args(), '--mode', 'mechanics']],
    ['unknown', [...args(), '--candidate', 'not-authorized']]]) {
    const refused = await capture(bad);
    await evidence('arguments-' + label, refused);
    assert.equal(refused.failure, 'ARGUMENTS'); assert.equal(refused.retained, false); assert.equal(refused.interpreter, null);
  }
  const absentParent = args(); absentParent[9] = join(root, 'absent-parent');
  const absent = await capture(absentParent);
  await evidence('absent-parent', absent);
  assert.equal(absent.retained, false); assert.equal(absent.status, 'HOST_FAILURE');
  // Deliberate mock collision in its OWN newly allocated evidence run. Node is
  // not confined. The host must not overwrite or bless this fake file.
  const collision = await mock('write-collision', `
await (await import('node:fs/promises')).writeFile(${JSON.stringify(root)}+'/'+t.runId+'/host-envelope.json','MOCK COLLISION',{flag:'wx'});
console.log(JSON.stringify(t));`);
  const result = await capture(args(collision.path, collision.hash));
  await evidence('write-collision', result);
  assert.equal(result.failure, 'EVIDENCE_WRITE'); assert.equal(result.retained, false); assert.equal(result.status, 'HOST_FAILURE');
  const rawCollision = await mock('raw-write-collision', `
await (await import('node:fs/promises')).mkdir(${JSON.stringify(root)}+'/'+t.runId+'/interpreter.stdout');
console.log(JSON.stringify(t));`);
  const raw = await capture(args(rawCollision.path, rawCollision.hash));
  await evidence('raw-write-collision', raw);
  assert.equal(raw.failure, 'EVIDENCE_WRITE'); assert.equal(raw.retained, false); assert.equal(raw.status, 'HOST_FAILURE');
  const failureEnvelope = JSON.parse(await readFile(join(raw.runDir, 'host-envelope.json'), 'utf8'));
  assert.equal(failureEnvelope.retained, false); assert.equal(failureEnvelope.status, 'HOST_FAILURE');
});

test('authenticated native Node and Deno mechanics captures, zero product credit', async t => {
  for (const [name, runtime] of [['node', process.execPath], ['deno', process.env.ORACLE_S1_DENO]]) await t.test(name, async () => {
    const result = await capture(args(oraclePath, O, runtime));
    await evidence('native-' + name, result);
    assert.equal(result.status, 'MECHANICS_PASS'); assert.equal(result.retained, true);
    assert.equal(result.runtime.name, name);
    assert.deepEqual(result.terminal.observedHashes, { oracle: O });
    assert.deepEqual(result.terminal.job, { checkId: null, recipeId: null, mutantSha256: null });
    assert.equal(result.interpreter.exitCode, 0); assert.equal(result.interpreter.signal, null);
    assert.deepEqual(await readFile(join(result.runDir, O, 'oracle.mjs')), oracleBytes);
    if (name === 'deno') assert.ok(!result.interpreter.args.some(arg => arg.startsWith('--allow-')));
  });
});
