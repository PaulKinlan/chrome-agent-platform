// Candidate-free DEVELOPMENT mechanisms. Structural comment patches are NOT
// proposed registry recipes, semantic fault mappings, or product observations.
import { strict as assert } from 'node:assert';
import { BASELINE_LEAF_IDS, REQUIRED_EDGES, buildFixture, rawEqual, observationPolicy, createObservers,
  observeLeaf, encodeBase64, sha256, applyRecipe, authenticateCandidate, validateManifest, parseManifestJSON, expectedJobs,
  entryArgs, runCandidate } from './oracle.mjs';
const utf8 = s => new TextEncoder().encode(s);
const source = utf8('\uFEFF// STRUCTURAL-ONLY é\r\nexport {};\r\n');
const patched = utf8('\uFEFF// STRUCTURAL-ONLY 日本語\r\nexport {};\r\n');
const pins = { design: 'd'.repeat(64), oracle: 'e'.repeat(64), candidate: await sha256(source), manifest: 'f'.repeat(64) };
const recipe = { recipeId: 'STRUCTURAL-NOT-A-FAULT', needleBase64: encodeBase64(utf8('é')), replacementBase64: encodeBase64(utf8('日本語')),
  expectedOccurrences: 1, mutantSha256: await sha256(patched), edges: REQUIRED_EDGES.map(e => ({ ...e })),
  rationale: 'DEVELOPMENT SHAPE VECTOR ONLY: changed comment is NOT an admissible semantic fault.' };
const manifest = { schemaVersion: 1, designSha256: pins.design, oracleSha256: pins.oracle, candidateSha256: pins.candidate,
  baselineLeafIds: [...BASELINE_LEAF_IDS], recipes: [recipe] };
const bytes = utf8(JSON.stringify(manifest)); pins.manifest = await sha256(bytes);
assert.equal((await authenticateCandidate(source, bytes, pins)).recipes.length, 1);
const result = await applyRecipe(source, recipe);
assert.deepEqual(result.bytes, patched);
assert.equal(result.offset, 22); // Full original-byte offset includes BOM and CRLF is preserved.
assert.deepEqual(source, utf8('\uFEFF// STRUCTURAL-ONLY é\r\nexport {};\r\n'));
assert.deepEqual((await applyRecipe(source, recipe)).bytes, patched); // No accumulated mutation.
await assert.rejects(applyRecipe(patched, recipe));
for (const change of [r => r.needleBase64 = '', r => r.needleBase64 = 'AB==', r => r.needleBase64 = encodeBase64(new Uint8Array([0xff])),
  r => r.replacementBase64 = r.needleBase64, r => r.expectedOccurrences = 2, r => r.mutantSha256 = pins.candidate,
  r => r.needleBase64 = encodeBase64(utf8('ABSENT')), r => r.needleBase64 = encodeBase64(utf8(' '))]) {
  const r = structuredClone(recipe); change(r); await assert.rejects(applyRecipe(source, r));
}
const deletion = { ...recipe, replacementBase64: '', mutantSha256: await sha256(utf8('\uFEFF// STRUCTURAL-ONLY \r\nexport {};\r\n')) };
assert.deepEqual((await applyRecipe(source, deletion)).bytes, utf8('\uFEFF// STRUCTURAL-ONLY \r\nexport {};\r\n'));
for (const change of [m => m.extra = 1, m => delete m.schemaVersion, m => m.designSha256 = pins.oracle,
  m => m.oracleSha256 = pins.design, m => m.candidateSha256 = pins.design,
  m => m.baselineLeafIds.pop(), m => m.baselineLeafIds[0] = m.baselineLeafIds[1], m => delete m.baselineLeafIds[0],
  m => m.baselineLeafIds[0] = 'REG-UNKNOWN', m => m.baselineLeafIds.extra = true,
  m => m.recipes = [], m => delete m.recipes[0], m => m.recipes.push(m.recipes[0]), m => m.recipes[0].recipeId = '',
  m => m.recipes[0].rationale = ' ', m => m.recipes[0].expectedObservation = 'EQUIVALENT_PASS',
  m => m.recipes[0].edges.pop(), m => m.recipes[0].edges.push(m.recipes[0].edges[0]), m => delete m.recipes[0].edges[0],
  m => m.recipes[0].edges[0].checkId = 'REG-BASE-07', m => m.recipes[0].edges[0].faultId = 'UNKNOWN',
  m => m.recipes[0].edges[0].extra = true, m => m.recipes[0].mutantSha256 = pins.candidate]) {
  const m = structuredClone(manifest); change(m); await assert.rejects(validateManifest(m, source, pins));
}
for (const key of ['candidate', 'manifest']) await assert.rejects(authenticateCandidate(source, bytes, { ...pins, [key]: '0'.repeat(64) }));
await assert.rejects(authenticateCandidate(source, utf8('not JSON'), pins), /CAPSULE_HASH/);
for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}']) assert.throws(() => parseManifestJSON(utf8(text)));
assert.equal(parseManifestJSON(utf8('{"a":"{x}","b":{"a":2}}')).b.a, 2);
assert.equal(expectedJobs(manifest).length, BASELINE_LEAF_IDS.length + new Set(REQUIRED_EDGES.map(e => e.checkId)).size);

const complete = buildFixture('REG-BASE-42').expectation.value;
assert.equal(rawEqual(complete, structuredClone(complete)), true);
const nullRecords = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(nullRecords) :
  Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([k, v]) => [k, nullRecords(v)]))) : value;
assert.equal(rawEqual(nullRecords(complete), complete), true);
for (const damage of [x => x.writer.mcpServers.reverse(), x => x.writer.instanceId = 'wrong', x => x.writer.extra = true,
  x => delete x.writer.name, x => x.writer.mcpServers.push(null), x => delete x.writer.mcpServers[0],
  x => Object.setPrototypeOf(x.writer, { evil: true }), x => x.writer.mcpServers.extra = true,
  x => Object.defineProperty(x.writer, 'name', { get() { throw new Error('GETTER_MUST_NOT_RUN'); }, enumerable: true }),
  x => x.writer[Symbol('extra')] = true, x => Object.defineProperty(x.writer, 'hidden', { value: 1 })]) {
  const damaged = structuredClone(complete); damage(damaged); assert.equal(rawEqual(damaged, complete), false);
}
assert.equal(rawEqual({}, { a: undefined }), false);
assert.equal(rawEqual({ a: undefined }, {}), false);
assert.equal(rawEqual({ b: 2, a: 1 }, { a: 1, b: 2 }), true);
const own = v => Object.defineProperty({}, '__proto__', { value: v, enumerable: true });
assert.equal(rawEqual(own({ benign: 1 }), own({ benign: 1 })), true);
assert.equal(rawEqual(Object.create({ benign: 1 }), own({ benign: 1 })), false);

function observe(id, action, mode = 'mutation') {
  const fixture = buildFixture(id), observers = createObservers(observationPolicy(fixture));
  const namespace = Object.create(null);
  if (action !== undefined) namespace[fixture.helper] = action;
  observers.install();
  try { return observeLeaf(namespace, fixture, observers, mode); }
  finally { observers.restore(); }
}
// Deliberately nonconforming single-call vectors, never candidate modules.
assert.equal(observe('REG-BASE-01', () => ({ cls: 'wrong' })).outcome, 'CAUGHT_NAMED_RED');
assert.equal(observe('REG-BASE-01', () => ({ cls: 'portable-deny-union' })).outcome, 'MUTANT_SURVIVED');
assert.equal(observe('REG-BASE-01', () => ({ cls: 'portable-deny-union' }), 'baseline').outcome, 'BASELINE_PASS');
assert.equal(observe('REG-BASE-03', () => ({ cls: 'portable-deny-union' })).outcome, 'CAUGHT_NAMED_RED');
assert.equal(observe('REG-BASE-03', () => ({})).outcome, 'CAUGHT_NAMED_RED');
assert.equal(observe('REG-BASE-60', () => { throw new TypeError('overreject'); }).outcome, 'CAUGHT_NAMED_RED');
const renamedTypeError = new TypeError('oracle assertion'); renamedTypeError.name = 'OracleAssertion';
assert.equal(observe('REG-BASE-60', () => { throw renamedTypeError; }).outcome, 'CAUGHT_NAMED_RED');
assert.equal(observe('REG-BASE-64.null', () => { throw renamedTypeError; }, 'baseline').outcome, 'BASELINE_PASS');
const forgedError = new Error('oracle assertion'); forgedError.name = 'OracleAssertion';
assert.equal(observe('REG-BASE-60', () => { throw forgedError; }).outcome, 'SUBJECT_CRASH');
assert.equal(observe('REG-BASE-60', () => new Proxy({}, { getPrototypeOf() { throw forgedError; } })).outcome, 'WRONG_ASSERTION');
assert.equal(observe('REG-BASE-60', () => { throw new Error('ordinary'); }).outcome, 'SUBJECT_CRASH');
assert.equal(observe('REG-BASE-60', () => { throw { name: 'OracleAssertion', message: 'oracle assertion' }; }).outcome, 'SUBJECT_CRASH');
assert.equal(observe('REG-BASE-64.null', () => { throw Object.create(TypeError.prototype); }).outcome, 'SUBJECT_CRASH');
assert.equal(observe('REG-BASE-64.null', () => { throw new TypeError(); }, 'baseline').outcome, 'BASELINE_PASS');
assert.equal(observe('REG-BASE-64.null', () => null).outcome, 'CAUGHT_NAMED_RED');
const api = observe('REG-BASE-58', undefined);
assert.equal(api.outcome, 'CAUGHT_NAMED_RED'); assert.equal(api.observations.subjectEntered, false);
assert.equal(observe('REG-BASE-58', () => { throw new Error('MUST_NOT_CALL'); }).outcome, 'MUTANT_SURVIVED');
assert.equal(observe('REG-BASE-60', undefined).outcome, 'SETUP_BLOCKED');
assert.equal(observe('REG-BASE-11', input => ({ provider: input.provider, baseURL: input.baseURL, model: input.model })).outcome, 'CAUGHT_NAMED_RED'); // V must really construct URL.
assert.equal(observe('REG-BASE-22', () => { throw new TypeError(); }, 'baseline').outcome, 'BASELINE_PASS');
for (const endpoint of [input => { new URL(input.url); }, input => URL.parse(input.url), input => URL.canParse(input.url),
  input => new TextEncoder().encode(input.url), input => new TextEncoder().encodeInto(input.url, new Uint8Array(65537))]) {
  const result = observe('REG-BASE-22', input => { endpoint(input); throw new TypeError(); });
  assert.equal(result.outcome, 'CAUGHT_NAMED_RED');
}
assert.equal(observe('REG-BASE-23', input => { new TextEncoder().encode(input.url); throw new TypeError(); }).observations.wholeEncodeViolations, 1);
assert.equal(observe('REG-BASE-22', input => {
  const encoder = new TextEncoder(); encoder.encode(input.url.slice(0, 40000)); encoder.encodeInto(input.url, new Uint8Array(65536)); throw new TypeError();
}, 'baseline').outcome, 'BASELINE_PASS'); // No invented universal chunk ceiling.
for (const id of ['REG-BASE-27', 'REG-BASE-28', 'REG-MCP-URL-TYPE.null', 'REG-MCP-URL-TYPE.undefined', 'REG-MCP-URL-TYPE.number', 'REG-MCP-URL-TYPE.boolean']) {
  for (const conversion of [v => v, v => String(v), v => JSON.stringify(v)]) {
    const result = observe(id, input => { new TextEncoder().encode(conversion(input.url)); throw new TypeError(); });
    assert.equal(result.outcome, 'CAUGHT_NAMED_RED'); assert.ok(result.observations.wholeEncodeViolations > 0);
  }
}
assert.equal(observe('REG-BASE-64.null', () => {
  const original = Array.prototype.push;
  try {
    Array.prototype.push = () => { throw new TypeError('DEVELOPMENT observer instrumentation failure'); };
    new TextEncoder().encode('bounded');
  } finally { Array.prototype.push = original; }
}).outcome, 'SETUP_BLOCKED');
// 1x7e: internal metadata failure taints the whole observation, even when the
// thrown value is primitive or the subject catches it and later returns/throws.
function failMetadata(value, endpoint, swallow) {
  const original = Array.prototype.push;
  try {
    Array.prototype.push = () => { throw value; };
    try { endpoint(); } catch (error) { if (!swallow) throw error; }
  } finally { Array.prototype.push = original; }
}
const observerFailures = [];
for (const [kind, value] of [['string', 'DEVELOPMENT_METADATA'], ['null', null], ['object', new TypeError('DEVELOPMENT_METADATA')]]) {
  for (const [entry, endpoint] of [['encode', () => new TextEncoder().encode('bounded')],
    ['encodeInto', () => new TextEncoder().encodeInto('bounded', new Uint8Array(8))]]) {
    for (const behavior of ['escape', 'throw', 'return', 'wrong-return']) for (const mode of ['baseline', 'mutation']) {
      const id = `${entry}-${kind}-${behavior}-${mode}`;
      const leaf = behavior.includes('return') ? 'REG-BASE-60' : 'REG-BASE-64.null';
      const result = observe(leaf, () => {
        failMetadata(value, endpoint, behavior !== 'escape');
        if (behavior === 'throw') throw new TypeError('ordinary subject validation');
        return behavior === 'return' ? { name: 'Site Bot' } : {};
      }, mode);
      try {
        assert.equal(result.outcome, 'SETUP_BLOCKED', id);
        assert.equal(result.observations.assertionEntered, false, id);
        assert.equal(result.observations.assertionFailed, false, id);
        assert.equal(result.observations.assertionId, null, id);
      } catch { observerFailures.push({ id, outcome: result.outcome, assertionEntered: result.observations.assertionEntered }); }
    }
  }
}
// Real native API errors are not instrumentation failures. Delegation remains
// outside the metadata catch, including native argument coercion and brands.
for (const endpoint of [() => new URL('not a URL'), () => URL.parse({ toString() { throw new TypeError(); } }),
  () => URL.canParse({ toString() { throw new TypeError(); } }),
  () => TextEncoder.prototype.encode.call({}, 'bounded'),
  () => new TextEncoder().encode({ toString() { throw new TypeError(); } }),
  () => new TextEncoder().encodeInto('bounded', null)]) {
  assert.equal(observe('REG-BASE-64.null', endpoint, 'baseline').outcome, 'BASELINE_PASS');
}
const localObserver = createObservers();
localObserver.install();
try {
  // Direct mechanics callers must also refuse a swallowed metadata failure.
  try {
    assert.throws(() => localObserver.observe(() => failMetadata(null, () => new TextEncoder().encode('bounded'), true)),
      error => error.message === 'OBSERVER_INSTRUMENTATION');
  } catch { observerFailures.push({ id: 'direct-observe-swallowed-failure' }); }
  // The taint belongs to one observation, not the next use of the observer.
  assert.deepEqual(localObserver.observe(() => new TextEncoder().encode('ok')), new Uint8Array([111, 107]));
} finally { localObserver.restore(); }
console.log(JSON.stringify({ developmentOnly: true, observerFailureControls: 49, failures: observerFailures, productObservations: 0 }));
assert.deepEqual(observerFailures, [], '1x7e internal observer failures must block before any named assertion');
const pollution = Object.getOwnPropertyDescriptor(Object.prototype, 'evil');
try {
  Object.defineProperty(Object.prototype, 'evil', { value: 1, configurable: true });
  assert.equal(observe('REG-BASE-62', () => ({ name: 'Site Bot', model: 'kept-model', note: 'kept-note' })).outcome, 'CAUGHT_NAMED_RED');
} finally { if (pollution) Object.defineProperty(Object.prototype, 'evil', pollution); else delete Object.prototype.evil; }
const entry = ['--mode', 'baseline', '--run-id', '12345678-1234-4123-8123-123456789abc', '--oracle-sha256', pins.oracle,
  '--design-sha256', pins.design, '--candidate', '/explicit/candidate', '--candidate-sha256', pins.candidate,
  '--manifest', '/explicit/manifest', '--manifest-sha256', pins.manifest, '--check-id', 'REG-BASE-01'];
assert.equal(entryArgs(entry)['--mode'], 'baseline');
for (let i = 0; i < entry.length; i += 2) {
  assert.throws(() => entryArgs(entry.filter((_, j) => j !== i && j !== i + 1)));
  assert.throws(() => entryArgs([...entry, ...entry.slice(i, i + 2)]));
}
assert.throws(() => entryArgs([...entry, '--recipe-id', recipe.recipeId]));
// 0yo9: source-order conformance only, NOT runtime product proof. Do not invoke
// runCandidate here: C/mutant execution requires separate independent approval.
const setupSource = runCandidate.toString();
const setupSteps = ['const policy = {};', 'observers = createObservers(policy);', 'observers.install();',
  'calibrateNative();', 'const namespace = await import(await verifiedDataURL(bytes, job.mutantSha256 ?? pins.candidate));',
  'const fixture = buildFixture(job.checkId);', 'validateFixture(fixture);',
  'Object.assign(policy, observationPolicy(fixture));',
  "observeLeaf(namespace, fixture, observers, options['--mode'])"];
let previousStep = -1;
for (const step of setupSteps) {
  const position = setupSource.indexOf(step);
  assert.ok(position > previousStep, '0yo9 inactive observer/import/fresh fixture/policy/call source order: ' + step);
  previousStep = position;
}
assert.equal((setupSource.match(/\bbuildFixture\s*\(/g) ?? []).length, 1, '0yo9 no preliminary duplicate fixture');
assert.equal((setupSource.match(/\bobserveLeaf\s*\(/g) ?? []).length, 1, '0yo9 sole actual observation');
console.log(JSON.stringify({ developmentOnly: true, sourceOrderGuard: 'PASS', productObservations: 0 }));
// 4uon: named512 is UTF-16 units; encodeInto destinations use provider10MiB bytes.
// Single-call native controls only, not a registry implementation or new r5 leaf.
const providerBytes = 10 * 1024 * 1024, namedBoundChecks = [];
for (const id of ['REG-BASE-54', 'REG-BASE-79.over']) {
  for (const destinationBytes of [1024, providerBytes, providerBytes + 1]) {
    const destination = new Uint8Array(destinationBytes);
    let encoded;
    const result = observe(id, input => {
      encoded = new TextEncoder().encodeInto(input.writer.provider.baseURL, destination);
      throw new TypeError('named code-unit refusal');
    }, 'baseline');
    namedBoundChecks.push({ id, destinationBytes,
      pass: encoded.read === 513 && encoded.written === 513 && destination[512] === 97 &&
        result.outcome === (destinationBytes > providerBytes ? 'BASELINE_FAIL' : 'BASELINE_PASS') &&
        result.observations.encodeIntoViolations === Number(destinationBytes > providerBytes) &&
        result.observations.wholeEncodeViolations === 0 && result.observations.parserCalls === 0 });
  }
  const whole = observe(id, input => {
    new TextEncoder().encode(input.writer.provider.baseURL); throw new TypeError();
  }, 'baseline');
  namedBoundChecks.push({ id, operation: 'whole-encode',
    pass: whole.outcome === 'BASELINE_FAIL' && whole.observations.wholeEncodeViolations === 1 });
}
for (const units of [512, 513]) {
  const fixture = buildFixture('REG-BASE-79.over');
  const scalar = 'https://api.example.test/' + 'é'.repeat(units - 25);
  fixture.input.writer.provider.baseURL = scalar; // Policy-only unit/byte discriminator, not a new leaf.
  const policy = observationPolicy(fixture);
  namedBoundChecks.push({ units, rawBytes: utf8(scalar).length,
    pass: scalar.length === units && utf8(scalar).length > 512 &&
      policy.wholeInput === (units > 512 ? scalar : null) &&
      policy.byteLimit === (units > 512 ? providerBytes : Infinity) });
}
console.log(JSON.stringify({ developmentOnly: true, namedBoundChecks, productObservations: 0 }));
assert.deepEqual(namedBoundChecks.filter(check => !check.pass), [], '4uon named units and provider raw-byte destination bound');
console.log(JSON.stringify({ developmentOnly: true, result: 'EXECUTION_MECHANISMS_PASS', productObservations: 0,
  runtime: typeof Deno === 'object' ? Deno.version : process.versions.node }));
