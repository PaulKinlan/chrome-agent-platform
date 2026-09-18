// Self-contained stdin ES module. S1 mechanics + S2 frozen data + S3 execution.
// Candidate execution requires externally reviewed exact D/O/C/M pins.
const NativeURL = globalThis.URL;
const NativeEncoder = globalThis.TextEncoder;
const ordinaryPrototype = Object.prototype;
const encoder = new NativeEncoder();
const encodeNative = NativeEncoder.prototype.encode;
const utf8 = text => Reflect.apply(encodeNative, encoder, [text]);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const requireMechanics = (condition, code = 'MECHANICS_CHECK') => { if (!condition) throw new Error(code); };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const CHUNK = 8190; // Nonfinal chunks must be divisible by three.

export async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeBase64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    let binary = '';
    for (const byte of bytes.subarray(offset, offset + CHUNK)) binary += String.fromCharCode(byte);
    result += btoa(binary);
  }
  return result;
}

export function decodeBase64(text) {
  if (typeof text !== 'string' || text.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('BASE64');
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (encodeBase64(bytes) !== text) throw new Error('BASE64'); // Reject nonzero pad bits too.
  return bytes;
}

export async function verifiedDataURL(bytes, expectedHash, payload = encodeBase64(bytes)) {
  const decoded = decodeBase64(payload);
  if (!HASH.test(expectedHash) || !sameBytes(decoded, bytes) || await sha256(decoded) !== expectedHash) throw new Error('IMPORT_BYTES');
  return 'data:text/javascript;base64,' + payload;
}

export async function calibrateBytes() {
  requireMechanics(await sha256(new Uint8Array()) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  requireMechanics(await sha256(utf8('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const length of [0, 1, 2, 256, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK + 2, 2 * CHUNK + 1, 2 * CHUNK + 2]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
    requireMechanics(sameBytes(decodeBase64(encodeBase64(bytes)), bytes));
  }
  for (const bad of ['A', 'AA=', 'AA===', 'AA==AA==', 'AB==', 'AAB=', ' AA==', 'AA==\n', '-A==']) {
    let refused = false;
    try { decodeBase64(bad); } catch { refused = true; }
    requireMechanics(refused);
  }
  const source = utf8('\uFEFF// mechanics non-ASCII: 日本語\r\nexport const text = "é🦉";\r\n');
  const digest = await sha256(source);
  const payload = encodeBase64(source);
  let refused = false;
  try { await verifiedDataURL(source, digest, 'AAAA' + payload.slice(4)); } catch { refused = true; }
  requireMechanics(refused);
  // Whole-buffer verification retains the BOM and CRLF bytes before import.
  const fixture = await import(await verifiedDataURL(source, digest));
  requireMechanics(fixture.text === 'é🦉');
}

const counterNames = ['parserCalls', 'parserReturns', 'urlConstructs', 'encoderConstructs', 'wholeEncodeViolations', 'encodeIntoViolations'];
const freshCounters = () => Object.fromEntries(counterNames.map(key => [key, 0]));
const descriptorEqual = (a, b) => ['value', 'get', 'set', 'enumerable', 'configurable', 'writable'].every(key => a?.[key] === b?.[key]);

export function createObservers(policy = null) {
  // Captured before any fixture import. Genuine native instances and receivers
  // are used throughout; constructor proxies do not proxy the instances.
  const saved = [[globalThis, 'URL'], [globalThis, 'TextEncoder'],
    ...['parse', 'canParse'].filter(key => typeof NativeURL[key] === 'function').map(key => [NativeURL, key]),
    ...['encode', 'encodeInto'].map(key => [NativeEncoder.prototype, key])]
    .map(([object, key]) => [object, key, Object.getOwnPropertyDescriptor(object, key)]);
  let active = false;
  let installed = false;
  let counters = freshCounters();
  let lengths = [];
  // Calibration ceiling only, in UTF-16 code units. NOT a registry byte budget.
  const ceiling = 32;
  let instrumentationFailed = false; // Observation-local; thrown identity or swallowing cannot clear it.
  const count = key => { if (active) counters[key]++; };
  const replace = (object, key, value) => {
    const descriptor = saved.find(([o, k]) => o === object && k === key)?.[2];
    requireMechanics(descriptor && typeof Reflect.get(object, key) === 'function', 'OBSERVER_DESCRIPTOR_' + key);
    // Deno exposes TextEncoder through a configurable getter/setter; Node uses
    // a writable data property. Install the same genuine constructor observer
    // for either representation, then restore the EXACT original descriptor.
    const replacement = Object.hasOwn(descriptor, 'value') ? { ...descriptor, value } :
      { configurable: descriptor.configurable, enumerable: descriptor.enumerable, writable: typeof descriptor.set === 'function', value };
    Object.defineProperty(object, key, replacement);
  };
  return {
    install() {
      requireMechanics(!installed);
      installed = true; // Partial installation must still be restored in finally.
      replace(globalThis, 'URL', new Proxy(NativeURL, {
        construct(target, args, newTarget) {
          count('parserCalls'); count('urlConstructs');
          const result = Reflect.construct(target, args, newTarget);
          count('parserReturns');
          return result;
        },
      }));
      for (const [object, key, descriptor] of saved.filter(([object]) => object === NativeURL)) {
        replace(object, key, new Proxy(descriptor.value, {
          apply(target, receiver, args) {
            count('parserCalls');
            const result = Reflect.apply(target, receiver, args);
            // Normal native return, including parse(null)/canParse(false), not a validity claim.
            count('parserReturns');
            return result;
          },
        }));
      }
      replace(globalThis, 'TextEncoder', new Proxy(NativeEncoder, {
        construct(target, args, newTarget) {
          count('encoderConstructs');
          return Reflect.construct(target, args, newTarget);
        },
      }));
      for (const key of ['encode', 'encodeInto']) {
        const native = saved.find(([o, k]) => o === NativeEncoder.prototype && k === key)[2].value;
        replace(NativeEncoder.prototype, key, new Proxy(native, {
          apply(target, receiver, args) {
            try {
              if (active) {
                const inputLength = typeof args[0] === 'string' ? args[0].length : null;
                const destinationLength = args[1] instanceof Uint8Array ? args[1].length : null;
                lengths.push({ kind: key, inputLength, destinationLength });
                const malformed = policy?.malformed.some(value => Object.is(args[0], value));
                const whole = policy ? policy.wholeInput !== null && inputLength >= policy.wholeInput.length : inputLength > ceiling;
                if (key === 'encode' && (malformed || whole)) count('wholeEncodeViolations');
                if (key === 'encodeInto' && (malformed || destinationLength > (policy?.byteLimit ?? ceiling))) count('encodeIntoViolations');
              }
            } catch (error) { instrumentationFailed = true; throw error; }
            return Reflect.apply(target, receiver, args);
          },
        }));
      }
    },
    observe(subject) {
      requireMechanics(installed && !active);
      counters = freshCounters(); lengths = []; instrumentationFailed = false;
      active = true;
      try { return subject(); } finally {
        active = false;
        requireMechanics(!instrumentationFailed, 'OBSERVER_INSTRUMENTATION');
      }
    },
    snapshot() { return { counters: { ...counters }, lengths: lengths.map(item => ({ ...item })) }; },
    hasFailure() { return instrumentationFailed; },
    restore() {
      active = false;
      for (const [object, key, descriptor] of saved) Object.defineProperty(object, key, descriptor);
      installed = false;
      requireMechanics(saved.every(([object, key, descriptor]) => descriptorEqual(Object.getOwnPropertyDescriptor(object, key), descriptor)));
      requireMechanics(Object.prototype === ordinaryPrototype);
    },
  };
}

function calibrateNative() {
  requireMechanics(new URL('HTTPS://EXAMPLE.TEST:443/a/../é').href === 'https://example.test/%C3%A9');
  requireMechanics(URL.prototype === NativeURL.prototype && TextEncoder.prototype === NativeEncoder.prototype);
  requireMechanics(new URL('https://example.test') instanceof NativeURL);
  if (typeof URL.parse === 'function') requireMechanics(URL.parse('HTTPS://EXAMPLE.TEST:443').href === 'https://example.test/');
  if (typeof URL.canParse === 'function') requireMechanics(URL.canParse('https://example.test') && !URL.canParse('not a URL'));
  const receiver = new TextEncoder();
  requireMechanics(receiver instanceof NativeEncoder && receiver.encoding === 'utf-8');
  const { encode, encodeInto } = receiver;
  requireMechanics(sameBytes(encode.call(receiver, 'é!'), new Uint8Array([195, 169, 33])));
  const destination = new Uint8Array(3);
  const result = encodeInto.call(receiver, 'é🦉', destination);
  requireMechanics(result.read === 1 && result.written === 2 && sameBytes(destination, new Uint8Array([195, 169, 0])));
  class SubEncoder extends TextEncoder {}
  class SubURL extends URL {}
  requireMechanics(new SubEncoder() instanceof SubEncoder && new SubURL('https://example.test') instanceof SubURL);
  let brandRejected = false;
  try { encode.call({}); } catch (error) { brandRejected = error instanceof TypeError; }
  requireMechanics(brandRejected, 'ENCODE_INVALID_RECEIVER');
}

// A private WeakMap is never exported or passed to the fixture. Names/messages
// cannot supply this identity. Even the captured subject error is not marked.
const assertionOrigins = new WeakMap();
const isOracleAssertion = (error, id) => assertionOrigins.get(error) === id;
function oracleAssert(condition, id) {
  if (!condition) {
    const error = new Error('oracle assertion');
    error.name = 'OracleAssertion';
    assertionOrigins.set(error, id);
    throw error;
  }
}
export function calibrateAssertionOrigin(subjectError) {
  const id = 'MECH-PRIVATE-ASSERTION';
  const forged = new TypeError('oracle assertion');
  forged.name = 'OracleAssertion';
  requireMechanics(!isOracleAssertion(forged, id) && !isOracleAssertion(subjectError, id));
  let genuine = false;
  try { oracleAssert(false, id); } catch (error) { genuine = isOracleAssertion(error, id); }
  requireMechanics(genuine);
  return { assertionEntered: true, assertionFailed: true, assertionId: id };
}

// This fixture exercises native mechanics ONLY. It is not a registry or a
// replacement implementation, and knows nothing about the oracle's assertions.
const tinySource = '\uFEFF// candidate-free mechanics 日本語\r\n' + `
const Encoder = TextEncoder, Parser = URL;
const receiver = new Encoder();
const {encode, encodeInto} = receiver;
export function control(large, chunk, smallDestination, largeDestination) {
  const encoder = new Encoder();
  const canonical = new Parser('HTTPS://EXAMPLE.TEST:443/a/../é').href;
  let error;
  try { new Parser('not a URL'); } catch (caught) { error = caught; }
  if (Parser.parse) Parser.parse('https://example.test');
  if (Parser.canParse) Parser.canParse('https://example.test');
  const whole = encode.call(receiver, large);
  const bounded = encode.call(receiver, chunk);
  const small = encodeInto.call(encoder, large, smallDestination);
  const big = encodeInto.call(receiver, large, largeDestination);
  return {canonical, error, whole, bounded, small, big};
}
export function bounded(chunk, destination) {
  encode.call(receiver, chunk);
  return encodeInto.call(receiver, chunk, destination);
}
export function forged() { const error = new TypeError('oracle assertion'); error.name = 'OracleAssertion'; throw error; }
`;

export async function runMechanics() {
  const observations = { fixtureReady: false, subjectEntered: false, subjectCompleted: false,
    assertionEntered: false, assertionFailed: false, calibrationPassed: false, assertionId: null, ...freshCounters() };
  let stage = 'native-before';
  const observers = createObservers();
  try {
    calibrateNative();
    stage = 'observer-install';
    observers.install();
    stage = 'native-installed';
    calibrateNative();
    stage = 'bytes';
    await calibrateBytes();
    stage = 'fixture-import';
    const bytes = utf8(tinySource);
    const fixture = await import(await verifiedDataURL(bytes, await sha256(bytes)));
    // All fixture allocation/reference work is inactive. Only exports run active.
    const large = 'a'.repeat(65), chunk = 'a'.repeat(16);
    const smallDestination = new Uint8Array(16), largeDestination = new Uint8Array(65);
    observations.fixtureReady = true;
    stage = 'subject';
    observations.subjectEntered = true;
    const result = observers.observe(() => fixture.control(large, chunk, smallDestination, largeDestination));
    observations.subjectCompleted = true;
    const observed = observers.snapshot();
    Object.assign(observations, observed.counters);
    stage = 'calibration';
    requireMechanics(result.canonical === 'https://example.test/%C3%A9' && result.error instanceof TypeError);
    requireMechanics(sameBytes(result.whole, utf8(large)) && sameBytes(result.bounded, utf8(chunk)));
    requireMechanics(result.small.read === 16 && result.small.written === 16 && sameBytes(smallDestination, utf8(chunk)));
    requireMechanics(result.big.read === 65 && result.big.written === 65 && sameBytes(largeDestination, utf8(large)));
    const statics = Number(typeof NativeURL.parse === 'function') + Number(typeof NativeURL.canParse === 'function');
    // Deno's genuine URL.parse also delegates through global new URL. Count
    // nested native calls honestly, rather than imposing Node's exact totals.
    requireMechanics(observations.parserCalls >= 2 + statics && observations.parserReturns === observations.parserCalls - 1 &&
      observations.urlConstructs >= 2 && observations.encoderConstructs === 1 &&
      observations.wholeEncodeViolations === 1 && observations.encodeIntoViolations === 1);
    requireMechanics(JSON.stringify(observed.lengths) === JSON.stringify([
      { kind: 'encode', inputLength: 65, destinationLength: null },
      { kind: 'encode', inputLength: 16, destinationLength: null },
      { kind: 'encodeInto', inputLength: 65, destinationLength: 16 },
      { kind: 'encodeInto', inputLength: 65, destinationLength: 65 },
    ]));
    const boundedDestination = new Uint8Array(16);
    observers.observe(() => fixture.bounded(chunk, boundedDestination));
    requireMechanics(Object.values(observers.snapshot().counters).every(v => v === 0));
    requireMechanics(sameBytes(boundedDestination, utf8(chunk)));
    let forged;
    try { observers.observe(() => fixture.forged()); } catch (error) { forged = error; }
    requireMechanics(forged instanceof TypeError && !isOracleAssertion(forged, 'MECH-PRIVATE-ASSERTION'));
    Object.assign(observations, calibrateAssertionOrigin(result.error));
    observations.calibrationPassed = true;
    return { outcome: 'MECHANICS_PASS', observations, error: null };
  } catch (error) {
    const codes = ['ENCODE_INVALID_RECEIVER', 'OBSERVER_DESCRIPTOR_URL', 'OBSERVER_DESCRIPTOR_TextEncoder',
      'OBSERVER_DESCRIPTOR_parse', 'OBSERVER_DESCRIPTOR_canParse', 'OBSERVER_DESCRIPTOR_encode', 'OBSERVER_DESCRIPTOR_encodeInto'];
    const code = codes.includes(error?.message) ? error.message : 'MECHANICS_CHECK';
    return { outcome: 'MECHANICS_FAIL', observations, error: { stage, code } };
  } finally {
    // A restoration exception supersedes PASS and reaches the terminal setup catch.
    observers.restore();
    calibrateNative();
  }
}

// S2 test-data catalogue, r5 §§4–6. These are literal constructions, NOT
// sanitizer logic. Large scalar expressions are evaluated only for one leaf.
export const GROUNDING = Object.freeze({
  commit: '776118f85c83dee6b70e9b86bf89e4d7b61bb6cc',
  path: 'extension/lib/archive-target-registry.js',
  sha256: '1ce244933686d562df369e08415b18ae6d9d70aa30a2ed3aadfefc48f74ccd85',
});
function freezeData(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeData(value[key]);
    Object.freeze(value);
  }
  return value;
}
export const BASE_RECORDS = freezeData({
  P: { provider: 'openai', baseURL: 'https://api.example.test/v1', model: 'model-1' },
  S: { id: 'alpha', name: 'Alpha', transport: 'http', url: 'https://mcp.example.test/mcp', enabled: true },
  T: { id: 'beta', name: 'Beta', transport: 'http', url: 'https://mcp.example.test/beta', enabled: false },
  A: { writer: { id: 'writer', name: 'Writer', instanceId: 'd631d758-7304-4a5d-bf15-4f0c2436f91a', role: 'Draft', skills: [], canDelegateTo: [], mcpServers: [] } },
  B: { reader: { id: 'reader', name: 'Reader', instanceId: '263503a1-4966-48cc-9185-f770aa31ea08', role: 'Read', skills: [], canDelegateTo: [], mcpServers: [] } },
  C: { name: 'Site Bot', model: 'kept-model', note: 'kept-note' },
  L: { activeProvider: 'legacy', providers: [{ id: 'legacy', baseURL: 'https://api.example.test/v1', model: 'model-1' }] },
  AUTH: { headerName: 'Authorization', token: 'fixture-mcp-secret' },
});
export const URL_DATA = freezeData({
  MP: 'https://mcp.example.test/', PP: 'https://api.example.test/',
  mcpOverUtf8: { prefix: 'MP', middle: '', character: 'é', count: 32756, codeUnits: 32781, bytes: 65537 },
  mcpShrink: { prefix: 'MP', middle: 'mcp?x=', character: 'a', count: 65507, codeUnits: 65538, bytes: 65538 },
  providerOverUtf8: { prefix: 'PP', middle: '', character: 'é', count: 5242868, codeUnits: 5242893, bytes: 10485761 },
  providerShrink: { prefix: 'PP', middle: 'v1?x=', character: 'a', count: 10485732, codeUnits: 10485762, bytes: 10485762 },
  mcpUnicode: 'https://mcp.example.test/api/日本語',
  providerUnicode: 'https://api.example.test/é',
});
const fixtureRequire = (condition, code) => { if (!condition) throw new Error('FIXTURE_' + code); };
const dataProperty = (object, key, value) => Object.defineProperty(object, key,
  { value, enumerable: true, writable: true, configurable: true });
const base = (name, ...edits) => ({ $base: name, edits });
const set = (path, value) => ['set', path, value];
const omit = path => ['omit', path];
const proto = (path, value) => ['proto', path, value];
const inherit = (path, key) => ['inherit', path, key];
const ascii = (prefix, length) => ({ $ascii: prefix, length });
const urlData = name => ({ $url: name });
const provider = value => base('P', set(['baseURL'], value));
const server = value => base('S', set(['url'], value));
const namedProvider = value => base('A', set(['writer', 'provider'], value));
const namedServers = value => base('A', set(['writer', 'mcpServers'], value));
const credentialValues = freezeData({ apiKey: 'fixture-api-key', authToken: 'fixture-auth-token', clientSecret: 'fixture-client-secret' });
const mcpCanonical = 'https://mcp.example.test/api/%E6%97%A5%E6%9C%AC%E8%AA%9E';
const providerCanonical = 'https://api.example.test/%C3%A9';
const dirtyMcpURL = 'https://u:p@mcp.example.test/mcp?tenant=a#frag';
const hostileTransport = { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'fixture-header-secret' } };
const helperNames = freezeData({ O: 'classifyOpfsPath', K: 'classifyKvKey', P: 'sanitizeProviderConfig', M: 'sanitizeMcpServer', N: 'sanitizeNamedAgents', G: 'sanitizeAgentConfig' });
const rawShape = freezeData({ records: 'ordinary-or-null-prototype', ownEnumerableDataOnly: true,
  completeKeys: true, exactScalars: true, exactArrayLengthAndOrder: true, noAttackerInheritanceOrGetters: true });
const definitions = [];
const leaf = (id, helper, mode, input, kind, value, basis = 'r5 §5; D6') => {
  definitions.push({ checkId: id.startsWith('REG-') ? id : 'REG-BASE-' + id,
    helper: helperNames[helper], mode, input,
    expectation: kind === 'EQ' ? { kind, value, shape: rawShape } :
      kind === 'TE' ? { kind, error: 'TypeError', genuineSubjectError: true } :
      kind === 'API' ? { kind, exportName: 'sanitizeAgentConfig', own: true, type: 'function', subjectCall: false } : { kind, value, property: 'cls' },
    basis });
};
const eq = (id, h, mode, input, expected) => leaf(id, h, mode, input, 'EQ', expected);
const te = (id, h, mode, input) => leaf(id, h, mode, input, 'TE');
const cls = (id, path, value, basis) => leaf(id, 'O', 'S', path, 'CLS', value, basis);
const originBoard = 'memory/origins/https%3A%2F%2Fexample.com/cap:board-deny-rules.json';
cls('01', 'memory/master/cap:board-deny-rules.json', 'portable-deny-union', 'D6 §7.1 correction, not F parity');
leaf('02', 'K', 'S', 'cap:board-deny-rules', 'CLS', 'unclassified', 'D6 §7.1 correction to F129–131');
leaf('03', 'O', 'S', originBoard, 'not-CLS', 'portable-deny-union', 'F104–112,200–206');
cls('04', originBoard, 'portable-user-data', 'F104–112,200–206');
cls('05', 'memory/master/cap:board-deny-rules', 'unclassified', 'F40,175–184');
for (const [id, tail, value] of [
  ['06', '\uD800', 'unclassified'], ['07', '\uDFFF', 'unclassified'], ['08', '\uD83D\uDE00\uD800', 'unclassified'],
  ['09', '\uD83D\uDE00', 'portable-user-data'], ['10', '\uFFFD', 'portable-user-data'],
]) cls(id, 'agent-workspaces/named-a/' + tail, value, 'D6 §3 global guard; F49,318–325 positive grammar');
for (const [i, key] of Object.keys(credentialValues).entries()) eq(String(11 + i), 'P', 'V', base('P', set([key], credentialValues[key])), base('P'));
eq('14', 'P', 'V', base('P', proto([], { injected: true })), base('P'));
eq('15', 'P', 'V', base('P', set(['nested'], { benign: 2 }), proto(['nested'], { evil: 1 })), base('P', set(['nested'], { benign: 2 })));
for (const [id, key] of [['16', 'constructor'], ['17', 'prototype']]) eq(id, 'P', 'V', base('P', set([key], 'benign')), base('P', set([key], 'benign')));
const benign = [set(['tokenLimit'], 4096), set(['apiKeyPrefix'], 'sk-'), set(['note'], 'fixture-api-key')];
eq('18', 'P', 'V', base('P', ...benign, set(['apiKey'], 'fixture-api-key')), base('P', ...benign));
eq('19', 'M', 'V', base('S', set(['auth'], base('AUTH'))), base('S'));
eq('20', 'M', 'V', base('S', set(['url'], dirtyMcpURL), set(['auth'], base('AUTH'))), base('S'));
eq('21', 'M', 'V', server(ascii('MP', 65536)), server(ascii('MP', 65536)));
for (const [id, value] of [['22', ascii('MP', 65537)], ['23', urlData('mcpOverUtf8')], ['24', urlData('mcpShrink')]]) te(id, 'M', 'P', server(value));
for (const [id, value] of [['25', 'not a URL'], ['26', 'file:///path']]) eq(id, 'M', 'S', server(value), null);
for (const [id, value] of [['27', [dirtyMcpURL]], ['28', { href: 'https://mcp.example.test/mcp' }]]) te(id, 'M', 'P', server(value));
for (const [id, value] of [['29', hostileTransport], ['30', ['http']], ['31.number', 17], ['31.boolean', true]]) te(id, 'M', 'P', base('S', set(['transport'], value)));
for (const [id, key] of [['32', 'url'], ['33', 'transport']]) eq(id, 'M', 'S', base('S', omit([key])), null);
for (const subtype of ['stdio', 'pipe']) eq('34.' + subtype, 'M', 'S', base('S', set(['transport'], subtype)), null);
eq('35', 'M', 'V', base('S', proto([], { benign: 1 }), set(['auth'], base('AUTH'))), base('S', proto([], { benign: 1 })));
const rest = [set(['description'], 'Docs'), set(['icon'], 'icon.png'), set(['customField'], { kept: true })];
eq('36', 'M', 'V', base('S', ...rest, set(['auth'], base('AUTH'))), base('S', ...rest));
eq('REG-MCP-UNICODE', 'M', 'V', server(urlData('mcpUnicode')), server(mcpCanonical));
eq('REG-MCP-IDENTITY', 'M', 'V', base('T', set(['auth'], base('AUTH'))), base('T'));
for (const key of ['url', 'transport']) eq('REG-MCP-OWN-' + key.toUpperCase(), 'M', 'S', base('S', inherit([], key)), null);
for (const [key, value] of [['null', null], ['undefined', undefined], ['number', 17], ['boolean', true]]) te('REG-MCP-URL-TYPE.' + key, 'M', 'P', server(value));
for (const [key, marker] of Object.entries(credentialValues)) {
  eq('37.' + key, 'N', 'S', base('A', set(['writer', key], marker)), base('A'));
  eq('38.' + key, 'N', 'V', namedProvider(base('P', set([key], marker))), namedProvider(base('P')));
  eq('39.' + key, 'N', 'S', base('A', set(['writer', 'tools'], { lookup: { tokenLimit: 12, [key]: marker } })), base('A', set(['writer', 'tools'], { lookup: { tokenLimit: 12 } })));
}
eq('40', 'N', 'V', namedServers([base('S', set(['auth'], base('AUTH')))]), namedServers([base('S')]));
eq('41', 'N', 'V', namedServers([base('S', set(['url'], dirtyMcpURL), set(['auth'], base('AUTH')))]), namedServers([base('S')]));
eq('42', 'N', 'V', namedServers([base('S'), base('T')]), namedServers([base('S'), base('T')]));
eq('43', 'N', 'S', namedServers([base('S'), base('T', set(['url'], 'not a URL')), base('T')]), namedServers([base('S'), base('T')]));
te('44', 'N', 'P', namedServers([server(ascii('MP', 65537))]));
te('45', 'N', 'P', namedServers([server([dirtyMcpURL])]));
te('46', 'N', 'P', namedServers([base('S', set(['transport'], hostileTransport))]));
for (const [key, value] of [['null', null], ['array', []], ['string', 'bad'], ['number', 17]]) te('47.' + key, 'N', 'S', base('A', set(['writer'], value)));
for (const [id, value] of [['48', 'not-an-array'], ['49', null], ['50', undefined]]) te(id, 'N', 'S', namedServers(value));
eq('51', 'N', 'S', base('A', omit(['writer', 'mcpServers'])), base('A', omit(['writer', 'mcpServers'])));
eq('52.absent', 'N', 'S', base('A'), base('A'));
eq('52.null', 'N', 'S', namedProvider(null), namedProvider(null));
eq('53', 'N', 'V', namedProvider(provider(ascii('PP', 512))), namedProvider(provider(ascii('PP', 512))));
te('54', 'N', 'P', namedProvider(provider(ascii('PP', 513))));
// r5's concrete .map construction explicitly uses B.reader, not {evil:1}.
eq('55.map', 'N', 'S', base('A', proto([], BASE_RECORDS.B.reader)), base('A'));
eq('55.agent', 'N', 'S', base('A', proto(['writer'], { evil: 1 })), base('A'));
eq('55.tools', 'N', 'S', base('A', set(['writer', 'tools'], { tokenLimit: 12 }), proto(['writer', 'tools'], { evil: 1 })), base('A', set(['writer', 'tools'], { tokenLimit: 12 })));
eq('55.provider', 'N', 'S', namedProvider(base('P', proto([], { evil: 1 }))), namedProvider(base('P')));
eq('55.mcp', 'N', 'S', namedServers([base('S', proto([], { evil: 1 }))]), namedServers([base('S')]));
for (const [key, value] of [['string', 'openai'], ['number', 17], ['boolean', true], ['array', []]]) te('56.' + key, 'N', 'S', namedProvider(value));
const malformedIdentity = {
  missing: base('P', omit(['provider'])), inherited: base('P', inherit([], 'provider')),
  array: base('P', set(['provider'], ['openai'])), number: base('P', set(['provider'], 17)),
};
for (const [key, value] of Object.entries(malformedIdentity)) te('57.' + key, 'N', 'S', namedProvider(value));
eq('REG-NAMED-IDENTITY', 'N', 'S', base('A', set(['reader'], BASE_RECORDS.B.reader)), base('A', set(['reader'], BASE_RECORDS.B.reader)));
eq('REG-NAMED-EMPTY', 'N', 'S', {}, {});
eq('REG-NAMED-UNICODE', 'N', 'V', namedServers([server(urlData('mcpUnicode'))]), namedServers([server(mcpCanonical)]));
te('REG-NAMED-MCP-TRANSPORT-ARRAY', 'N', 'P', namedServers([base('S', set(['transport'], ['http']))]));
leaf('58', 'G', 'API', null, 'API');
for (const [key, marker] of Object.entries(credentialValues)) eq('59.' + key, 'G', 'V', base('C', set(['provider'], base('P', set([key], marker)))), base('C', set(['provider'], base('P'))));
eq('60', 'G', 'S', { name: 'Site Bot' }, { name: 'Site Bot' });
eq('61', 'G', 'S', base('C'), base('C'));
eq('62', 'G', 'S', base('C', proto([], { evil: 1 })), base('C'));
eq('63', 'G', 'S', base('C', set(['constructor'], 'benign'), set(['prototype'], 'benign')), base('C', set(['constructor'], 'benign'), set(['prototype'], 'benign')));
for (const [key, value] of [['null', null], ['array', []], ['string', 'bad'], ['number', 17]]) te('64.' + key, 'G', 'S', value);
for (const [key, value] of [['null', null], ['string', 'openai'], ['array', []], ['missing', malformedIdentity.missing], ['inherited', malformedIdentity.inherited], ['nonprimitive', malformedIdentity.array]]) te('65.' + key, 'G', 'S', base('C', set(['provider'], value)));
eq('66', 'P', 'V', provider('HTTPS://API.EXAMPLE.TEST:443/a/../v1'), base('P'));
eq('67', 'P', 'S', provider(''), provider(''));
for (const key of ['missing', 'inherited']) te('68.' + key, 'P', 'S', malformedIdentity[key]);
for (const [key, value] of [['array', ['openai']], ['object', {}], ['number', 17], ['boolean', true]]) te('69.' + key, 'P', 'S', base('P', set(['provider'], value)));
const badProviderURLs = { array: ['https://api.example.test/v1'], object: { href: 'https://api.example.test/v1' }, number: 17, boolean: true };
for (const [key, value] of Object.entries(badProviderURLs)) te('70.' + key, 'P', 'P', provider(value));
const components = { username: 'https://u@api.example.test/v1', password: 'https://:p@api.example.test/v1', query: 'https://api.example.test/v1?tenant=a', fragment: 'https://api.example.test/v1#frag' };
for (const [key, value] of Object.entries(components)) te((['username', 'password'].includes(key) ? '71.' : '72.') + key, 'P', 'S', provider(value));
for (const [id, value] of [['73', 'ftp://api.example.test/v1'], ['74', 'file:///path'], ['75', 'http:///']]) te(id, 'P', 'S', provider(value));
eq('76', 'P', 'V', provider(ascii('PP', 10485760)), provider(ascii('PP', 10485760)));
te('77', 'P', 'P', provider(ascii('PP', 10485761)));
eq('REG-PROVIDER-UNICODE', 'P', 'V', provider(urlData('providerUnicode')), provider(providerCanonical));
te('REG-PROVIDER-UTF8-OVER', 'P', 'P', provider(urlData('providerOverUtf8')));
te('REG-PROVIDER-SHRINK', 'P', 'P', provider(urlData('providerShrink')));
eq('REG-AGENTCONFIG-EMPTY', 'G', 'S', {}, {});
const context = (name, value, extra = []) => name === 'legacy' ? base('L', set(['providers', 0, 'baseURL'], value), ...extra) :
  name === 'named' ? namedProvider(base('P', set(['baseURL'], value), ...extra)) : base('C', set(['provider'], base('P', set(['baseURL'], value), ...extra)));
for (const [id, name, helper, bound] of [['78', 'legacy', 'P', 10485760], ['79', 'named', 'N', 512], ['80', 'origin', 'G', 10485760]]) {
  for (const [key, value, expected, mode] of [
    ['valid', 'https://api.example.test/v1', 'https://api.example.test/v1', 'V'], ['empty', '', '', 'S'],
    ['canonical', 'HTTPS://API.EXAMPLE.TEST:443/a/../v1', 'https://api.example.test/v1', 'V'],
    ['unicode', urlData('providerUnicode'), providerCanonical, 'V'],
    ['bound', ascii('PP', bound), ascii('PP', bound), 'V'],
  ]) eq(id + '.' + key, helper, mode, context(name, value), context(name, expected));
  for (const [key, value] of Object.entries({ ...components, scheme: 'ftp://api.example.test/v1', hostless: 'file:///path', malformed: 'http:///' })) te(id + '.' + key, helper, 'S', context(name, value));
  for (const [key, value] of Object.entries(badProviderURLs)) te(id + '.url-' + key, helper, 'P', context(name, value));
  te(id + '.over', helper, 'P', context(name, ascii('PP', bound + 1)));
  if (id !== '79') {
    te(id + '.over-utf8', helper, 'P', context(name, urlData('providerOverUtf8')));
    te(id + '.shrink', helper, 'P', context(name, urlData('providerShrink')));
  }
  for (const [key, marker] of Object.entries(credentialValues)) {
    const edits = [set(name === 'legacy' ? ['providers', 0, key] : [key], marker)];
    eq('REG-CTX-' + name + '-' + key, helper, 'V', context(name, 'https://api.example.test/v1', edits), context(name, 'https://api.example.test/v1'));
  }
}
eq('81', 'P', 'V', base('L'), base('L'));
eq('82', 'P', 'V', base('L', set(['providers', 0, 'id'], ' '), set(['activeProvider'], ' ')), base('L', set(['providers', 0, 'id'], ' '), set(['activeProvider'], ' ')));
te('83', 'P', 'S', base('L', inherit(['providers', 0], 'id')));
te('84', 'P', 'S', base('L', omit(['providers', 0, 'id']), set(['providers', 0, 'provider'], 'openai')));
te('85', 'P', 'S', base('L', set(['providers', 0, 'provider'], 'openai')));
te('86', 'P', 'S', base('L', set(['providers', 0, 'id'], '')));
for (const [key, value] of [['array', ['legacy']], ['number', 17], ['object', {}], ['boolean', true]]) te('87.' + key, 'P', 'S', base('L', set(['providers', 0, 'id'], value)));
for (const [key, value] of [['object', {}], ['null', null], ['string', 'bad']]) te('88.' + key, 'P', 'S', base('L', set(['providers'], value)));
te('89', 'P', 'S', base('L', omit(['providers', 0, 'id'])));
te('90', 'P', 'S', base('L', set(['provider'], 'openai')));
for (const [key, value] of [['number', 17], ['object', {}], ['array', []], ['boolean', true]]) te('91.' + key, 'P', 'S', base('L', set(['activeProvider'], value)));
eq('92', 'P', 'V', base('L', omit(['activeProvider'])), base('L', omit(['activeProvider'])));
for (const [id, file, value, lines] of [
  ['93.threads', 'threads.json', 'portable-terminal-validated', '53–57,89–94,175–184'],
  ['93.assets', 'assets.json', 'portable-terminal-validated', '53–57,89–94,175–184'],
  ['93.run-registry', 'run-registry.json', 'portable-terminal-validated', '53–57,89–94,175–184'],
  ['94.scripts', 'scripts.json', 'portable-revalidate', '58,93,175–184'],
  ['94.board-wakes', 'cap:board-wakes.json', 'portable-revalidate', '58,93,175–184'],
  ['95.enrolled', 'enrolled.json', 'authority', '59,90,175–184'],
  ['95.origins', 'origins.json', 'authority', '59,90,175–184'],
  ['95.wasmPkg', 'wasmPkg.json', 'authority', '59,90,175–184'],
  ['96.wasm-repair', 'wasmPkgRepair.json', 'transaction-private', '60,91,175–184'],
  ['96.asset-repair', 'assetRepair.json', 'transaction-private', '60,91,175–184'],
]) cls(id, 'memory/master/' + file, value, 'F' + lines);
for (const [id, path, value] of [
  ['97.private-root', 'chrome-agent-platform-private', 'internal-secret'],
  ['97.transaction-root', 'archive-transactions-v1', 'transaction-private'],
  ['97.unqualified-hmac', 'owner-approval-hmac-v1', 'unclassified'],
]) cls(id, path, value, 'F18–29,296–305; grammar only, not writer population');
for (const [id, file, value] of [
  ['wasm', 'a'.repeat(64) + '.wasm', 'portable-user-data'], ['metadata', 'a'.repeat(64) + '.json', 'portable-user-data'],
  ['delete', 'delete-' + 'a'.repeat(64) + '.json', 'transaction-private'],
  ['upload', 'upload-d631d758-7304-4a5d-bf15-4f0c2436f91a.wasm', 'transaction-private'],
  ['nested-negative', 'sub/' + 'a'.repeat(64) + '.wasm', 'unclassified'],
]) cls('98.' + id, 'cap-user-wasm-v1/' + file, value, 'F76–77,311–316; flat grammar');
cls('REG-PATH-MEMORY-HIGH', 'memory/master/note-\uD800.json', 'unclassified', 'F40,101,175–184 plus D6 global guard');
cls('REG-PATH-MEMORY-PAIR', 'memory/master/note-\uD83D\uDE00.json', 'portable-user-data', 'F40,101,175–184 plus D6 global guard');
for (const item of definitions) {
  if (item.checkId === 'REG-BASE-14') item.expectation.absentInheritedKeys = ['injected'];
  if (item.checkId === 'REG-BASE-35') item.expectation.absentInheritedKeys = ['benign'];
  if (item.checkId === 'REG-BASE-15' || item.checkId === 'REG-BASE-62' || item.checkId.startsWith('REG-BASE-55.')) item.expectation.absentInheritedKeys = ['evil'];
  if (item.checkId === 'REG-BASE-15') item.expectation.absentOrdinaryPrototypeKeys = ['evil'];
}
export const CATALOGUE = freezeData(definitions);
export const BASELINE_LEAF_IDS = Object.freeze(CATALOGUE.map(item => item.checkId));

const fullId = id => id.startsWith('REG-') ? id : 'REG-BASE-' + id;
const edges = [];
const edge = (faultId, ...ids) => {
  for (const id of ids.flat()) edges.push({ faultId, checkId: fullId(id) });
};
const all = prefix => BASELINE_LEAF_IDS.filter(id => id.startsWith(fullId(prefix) + '.'));
edge('path-high', '06'); edge('path-low', '07'); edge('path-shortcircuit', '08');
edge('path-workspace-only', 'REG-PATH-MEMORY-HIGH');
edge('path-validpair-overreject', '09', 'REG-PATH-MEMORY-PAIR'); edge('path-fffd-overreject', '10');
edge('board-portable', '01'); edge('phantom-kv-admit', '02');
for (const [index, key] of Object.keys(credentialValues).entries()) {
  edge('provider-drop-' + key, String(11 + index));
  edge('recursive-' + key + '-leak', ...['37', '38', '39', '59'].map(id => id + '.' + key),
    ...['legacy', 'named', 'origin'].map(context => 'REG-CTX-' + context + '-' + key));
}
edge('proto-own-leak', '14'); edge('proto-inheritance-leak', '15');
edge('proto-named-leak', all('55')); edge('proto-origin-leak', '62');
edge('benign-constructor-drop', '16', '63'); edge('benign-prototype-drop', '17', '63'); edge('benign-substring-drop', '18');
edge('mcp-auth-leak', '19', '40'); edge('mcp-url-leak', '20', '41');
edge('mcp-bound-omit', '22'); edge('mcp-codeunits', '23'); edge('mcp-normalize-first', '24');
edge('mcp-parse-first', '22', '23', '24'); edge('mcp-encode-first', '22', '23', '24');
edge('mcp-url-coercion', '27', '28', all('REG-MCP-URL-TYPE'), '45');
edge('mcp-transport-admit', '29', '30', '31.number', '31.boolean', '46', 'REG-NAMED-MCP-TRANSPORT-ARRAY');
edge('mcp-malformed-fatal', '25', '43'); edge('mcp-own-field-coercion', 'REG-MCP-OWN-URL', 'REG-MCP-OWN-TRANSPORT');
edge('mcp-rest-overredact', '35', '36'); edge('mcp-identity-change', 'REG-MCP-IDENTITY', '42');
edge('named-bad-record', all('47')); edge('named-bad-servers', '48', '49', '50'); edge('named-null-placeholder', '43');
edge('named-empty-or-identity-change', 'REG-NAMED-IDENTITY', '42');
edge('named-optional-overreject', '51', '52.absent', '52.null', 'REG-NAMED-EMPTY');
edge('named-provider-container-admit', all('56'), all('57'));
edge('agentconfig-api-loss', '58'); edge('agentconfig-body-leak', all('59'));
edge('agentconfig-name-overreject', '60', '61', 'REG-AGENTCONFIG-EMPTY'); edge('agentconfig-container-admit', all('65'));
edge('flat-provider-identity-admit', all('68'), all('69'));
const twins = (...suffixes) => ['78', '79', '80'].flatMap(id => suffixes.map(suffix => id + '.' + suffix));
edge('provider-url-type-admit', all('70'), twins('url-array', 'url-object', 'url-number', 'url-boolean'));
edge('provider-component-admit', '71.username', '71.password', '72.query', '72.fragment', twins('username', 'password', 'query', 'fragment'));
edge('provider-scheme-admit', '73', twins('scheme')); edge('provider-invalid-admit', '74', '75', twins('hostless', 'malformed'));
edge('provider-empty-overreject', '67', twins('empty')); edge('provider-unicode-overreject', 'REG-PROVIDER-UNICODE', twins('unicode'));
const providerOver = ['77', 'REG-PROVIDER-UTF8-OVER', 'REG-PROVIDER-SHRINK', '78.over', '78.over-utf8', '78.shrink', '80.over', '80.over-utf8', '80.shrink'];
for (const fault of ['provider-bound-bypass', 'provider-parse-first', 'provider-encode-first']) edge(fault, providerOver);
edge('named-512-bypass', '54', '79.over');
edge('legacy-identity-admit', '83', '84', '85', '86', all('87'), '89');
edge('legacy-layout-admit', all('88'), '90', all('91')); edge('legacy-default-or-trim', '82', '92');
edge('frozen-classification-drift', ...['93', '94', '95', '96', '97', '98'].map(all));
export const REQUIRED_EDGES = freezeData(edges);
export const FAULT_IDS = Object.freeze([...new Set(REQUIRED_EDGES.map(item => item.faultId))]);

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function exactIdSet(actual, expected, code) {
  fixtureRequire(Array.isArray(actual) && actual.length === expected.length &&
    Array.from(actual).every((id, index) => Object.hasOwn(actual, index) && typeof id === 'string' && expected.includes(id)) && new Set(actual).size === actual.length, code);
}
export function validateLeafIds(ids) { exactIdSet(ids, BASELINE_LEAF_IDS, 'LEAF_SET'); return true; }
export function validateRequiredEdges(actual) {
  fixtureRequire(Array.isArray(actual), 'EDGE_LIST');
  const keys = [];
  for (const item of actual) {
    fixtureRequire(exactKeys(item, ['faultId', 'checkId']) && typeof item.faultId === 'string' && typeof item.checkId === 'string' &&
      FAULT_IDS.includes(item.faultId) && BASELINE_LEAF_IDS.includes(item.checkId), 'EDGE_ID');
    fixtureRequire(REQUIRED_EDGES.some(edge => edge.faultId === item.faultId && edge.checkId === item.checkId), 'EDGE_RELATIONSHIP');
    keys.push(item.faultId + '\n' + item.checkId);
  }
  exactIdSet(keys, REQUIRED_EDGES.map(item => item.faultId + '\n' + item.checkId), 'EDGE_SET');
  return true;
}

function atPath(root, path) {
  let value = root;
  for (const key of path) {
    fixtureRequire(value !== null && typeof value === 'object' && Object.hasOwn(value, key), 'EDIT_PATH');
    value = Object.getOwnPropertyDescriptor(value, key).value;
  }
  return value;
}
// Interprets only this closed fixture-data notation. It never accepts or filters
// subject outputs, repairs malformed input, or consumes registry source.
function materialize(spec) {
  if (spec === null || typeof spec !== 'object') return spec;
  if (Array.isArray(spec)) return spec.map(materialize);
  if (Object.hasOwn(spec, '$base')) {
    fixtureRequire(exactKeys(spec, ['$base', 'edits']) && Object.hasOwn(BASE_RECORDS, spec.$base) && Array.isArray(spec.edits), 'BASE_SPEC');
    let result = materialize(BASE_RECORDS[spec.$base]);
    for (const edit of spec.edits) {
      fixtureRequire(Array.isArray(edit) && ['set', 'omit', 'proto', 'inherit'].includes(edit[0]) && Array.isArray(edit[1]) &&
        edit.length === (edit[0] === 'omit' ? 2 : 3) && edit[1].every(key => typeof key === 'string' || Number.isSafeInteger(key)), 'EDIT_SPEC');
      const [action, path, value] = edit;
      if (action === 'set' || action === 'omit') {
        fixtureRequire(path.length > 0, 'EDIT_ROOT');
        const parent = atPath(result, path.slice(0, -1));
        const key = path.at(-1);
        if (action === 'set') {
          dataProperty(parent, key, materialize(value));
          const descriptor = Object.getOwnPropertyDescriptor(parent, key);
          fixtureRequire(descriptor.enumerable && descriptor.writable && descriptor.configurable && Object.hasOwn(descriptor, 'value'), 'OWN_DATA');
        } else {
          fixtureRequire(Object.hasOwn(parent, key), 'OMIT_OWN');
          delete parent[key];
          fixtureRequire(!Object.hasOwn(parent, key), 'OMITTED');
        }
      } else {
        const object = atPath(result, path);
        fixtureRequire(object && !Array.isArray(object) && Object.getPrototypeOf(object) === ordinaryPrototype, 'SPECIAL_OBJECT');
        if (action === 'proto') {
          dataProperty(object, '__proto__', materialize(value));
          const descriptor = Object.getOwnPropertyDescriptor(object, '__proto__');
          fixtureRequire(descriptor.enumerable && descriptor.writable && descriptor.configurable && Object.hasOwn(descriptor, 'value') &&
            Object.getPrototypeOf(object) === ordinaryPrototype, 'OWN_PROTO');
        } else {
          fixtureRequire(typeof value === 'string' && Object.hasOwn(object, value), 'INHERIT_OWN');
          const inheritedValue = object[value];
          delete object[value];
          const prototype = dataProperty({}, value, inheritedValue);
          Object.setPrototypeOf(object, prototype);
          fixtureRequire(!Object.hasOwn(object, value) && object[value] === inheritedValue &&
            Object.getPrototypeOf(prototype) === ordinaryPrototype && Reflect.ownKeys(prototype).length === 1, 'INHERITED');
        }
      }
    }
    return result;
  }
  if (Object.hasOwn(spec, '$ascii')) {
    fixtureRequire(exactKeys(spec, ['$ascii', 'length']) && ['MP', 'PP'].includes(spec.$ascii) && Number.isSafeInteger(spec.length) && spec.length >= 25, 'ASCII_SPEC');
    const prefix = URL_DATA[spec.$ascii];
    fixtureRequire(prefix.length === 25 && utf8(prefix).length === 25, 'PREFIX_LENGTH');
    const result = prefix + 'a'.repeat(spec.length - 25);
    fixtureRequire(result.length === spec.length && utf8(result).length === spec.length, 'ASCII_LENGTH');
    return result;
  }
  if (Object.hasOwn(spec, '$url')) {
    fixtureRequire(exactKeys(spec, ['$url']) && Object.hasOwn(URL_DATA, spec.$url) && !['MP', 'PP'].includes(spec.$url), 'URL_SPEC');
    const data = URL_DATA[spec.$url];
    if (typeof data === 'string') return data;
    const prefix = URL_DATA[data.prefix];
    fixtureRequire(prefix.length === 25 && utf8(prefix).length === 25, 'PREFIX_LENGTH');
    const result = prefix + data.middle + data.character.repeat(data.count);
    fixtureRequire(result.length === data.codeUnits && utf8(result).length === data.bytes &&
      25 + data.middle.length + data.count * utf8(data.character).length === data.bytes, 'RAW_URL_LENGTH');
    return result;
  }
  fixtureRequire(Object.getPrototypeOf(spec) === ordinaryPrototype, 'LITERAL_PROTOTYPE');
  const result = {};
  for (const key of Reflect.ownKeys(spec)) {
    const descriptor = Object.getOwnPropertyDescriptor(spec, key);
    fixtureRequire(typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'LITERAL_DATA');
    dataProperty(result, key, materialize(descriptor.value));
  }
  return result;
}
function inputFacts(value, path = [], facts = []) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const fact = { path, type };
  facts.push(fact);
  if (type === 'string') { fact.codeUnits = value.length; fact.rawUtf8Bytes = utf8(value).length; }
  if (value && typeof value === 'object') {
    fact.ownKeys = Object.keys(value);
    const prototype = Object.getPrototypeOf(value);
    fact.prototype = Array.isArray(value) ? 'Array.prototype' : prototype === ordinaryPrototype ? 'Object.prototype' : 'specified-inherited';
    for (const key of fact.ownKeys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      fixtureRequire(d.enumerable && d.configurable && d.writable && Object.hasOwn(d, 'value'), 'INPUT_DESCRIPTOR');
      inputFacts(d.value, [...path, key], facts);
    }
    if (fact.prototype === 'specified-inherited') inputFacts(prototype, [...path, '<prototype>'], facts);
  }
  return facts;
}
function buildDefinition(definition) {
  const input = materialize(definition.input);
  const expectation = materialize(definition.expectation);
  return { checkId: definition.checkId, helper: definition.helper, mode: definition.mode,
    input, expectation, preconditions: inputFacts(input), basis: definition.basis,
    grounding: definition.basis.includes('F') ? materialize(GROUNDING) : null };
}
export function buildFixture(checkId) {
  fixtureRequire(typeof checkId === 'string', 'LEAF_ID');
  const definition = CATALOGUE.find(item => item.checkId === checkId);
  fixtureRequire(definition, 'LEAF_ID');
  return buildDefinition(definition);
}
// Strict development comparison includes own undefined and the deliberately
// inherited prototype. This is NOT the future EQ subject-output predicate.
function sameFixtureData(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const ap = Object.getPrototypeOf(actual), ep = Object.getPrototypeOf(expected);
  if (ap !== ep && (ap === ordinaryPrototype || ep === ordinaryPrototype || ap === null || ep === null || !sameFixtureData(ap, ep))) return false;
  const ak = Reflect.ownKeys(actual), ek = Reflect.ownKeys(expected);
  if (ak.length !== ek.length || ak.some((key, index) => key !== ek[index])) return false;
  return ak.every(key => {
    const a = Object.getOwnPropertyDescriptor(actual, key), e = Object.getOwnPropertyDescriptor(expected, key);
    return Object.hasOwn(a, 'value') && Object.hasOwn(e, 'value') && a.enumerable === e.enumerable && a.writable === e.writable &&
      a.configurable === e.configurable && sameFixtureData(a.value, e.value);
  });
}
export function validateFixture(fixture) {
  fixtureRequire(fixture && typeof fixture === 'object' && Object.hasOwn(fixture, 'checkId'), 'DESCRIPTOR');
  fixtureRequire(sameFixtureData(fixture, buildFixture(fixture.checkId)), 'DESCRIPTOR');
  return true;
}
export function validateCatalogue(actual) {
  fixtureRequire(Array.isArray(actual), 'CATALOGUE');
  validateLeafIds(actual.map(item => item?.checkId));
  for (const item of actual) {
    fixtureRequire(sameFixtureData(item, CATALOGUE.find(reference => reference.checkId === item.checkId)), 'DEFINITION');
  }
  return true;
}
// Self-check relationships without allocating any scalar fixtures at import.
fixtureRequire(new Set(BASELINE_LEAF_IDS).size === BASELINE_LEAF_IDS.length, 'DUPLICATE_LEAF');
fixtureRequire(new Set(REQUIRED_EDGES.map(item => item.faultId + '\n' + item.checkId)).size === REQUIRED_EDGES.length, 'DUPLICATE_EDGE');
fixtureRequire(REQUIRED_EDGES.every(item => BASELINE_LEAF_IDS.includes(item.checkId)), 'UNKNOWN_EDGE_LEAF');

// S3 structural admission. Exact-source purity and recipe semantics are external
// review prerequisites; this validator cannot infer them from a token search.
const admission = (ok, code) => { if (!ok) throw new Error(code); };
const identifier = value => typeof value === 'string' && value.length > 0;
const dense = values => Array.isArray(values) && Reflect.ownKeys(values).length === values.length + 1 &&
  Array.from(values).every((_, i) => Object.hasOwn(values, i));
export function parseManifestJSON(bytes) {
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const value = JSON.parse(source);
  const stack = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{') stack.push(new Set());
    else if (source[i] === '}') stack.pop();
    else if (source[i] === '"') {
      const start = i++;
      while (source[i] !== '"') { if (source[i] === '\\') i++; i++; }
      const key = JSON.parse(source.slice(start, i + 1));
      let next = i + 1;
      while (next < source.length && /\s/.test(source[next])) next++;
      if (source[next] === ':') {
        admission(!stack.at(-1).has(key), 'MANIFEST_DUPLICATE_KEY');
        stack.at(-1).add(key);
      }
    }
  }
  return value;
}
export async function applyRecipe(original, recipe) {
  const needle = decodeBase64(recipe.needleBase64), replacement = decodeBase64(recipe.replacementBase64);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  decoder.decode(needle); decoder.decode(replacement); decoder.decode(original);
  admission(needle.length > 0 && recipe.expectedOccurrences === 1 && !sameBytes(needle, replacement), 'PATCH_SHAPE');
  let offset = -1;
  for (let i = 0; i <= original.length - needle.length; i++) {
    if (needle.every((byte, j) => byte === original[i + j])) {
      admission(offset === -1, 'PATCH_OCCURRENCES');
      offset = i;
    }
  }
  admission(offset >= 0, 'PATCH_OCCURRENCES');
  const bytes = new Uint8Array(original.length - needle.length + replacement.length);
  bytes.set(original.subarray(0, offset)); bytes.set(replacement, offset);
  bytes.set(original.subarray(offset + needle.length), offset + replacement.length);
  admission(HASH.test(recipe.mutantSha256) && await sha256(bytes) === recipe.mutantSha256, 'PATCH_HASH');
  return { bytes, offset };
}
export async function validateManifest(manifest, original, pins) {
  admission(exactKeys(pins, ['design', 'oracle', 'candidate', 'manifest']) && Object.values(pins).every(v => typeof v === 'string' && HASH.test(v)), 'PINS');
  admission(await sha256(original) === pins.candidate, 'CANDIDATE_HASH');
  admission(exactKeys(manifest, ['schemaVersion', 'designSha256', 'oracleSha256', 'candidateSha256', 'baselineLeafIds', 'recipes']) &&
    manifest.schemaVersion === 1 && manifest.designSha256 === pins.design && manifest.oracleSha256 === pins.oracle &&
    manifest.candidateSha256 === pins.candidate, 'MANIFEST_SHAPE');
  admission(dense(manifest.baselineLeafIds), 'MANIFEST_LEAVES');
  validateLeafIds(manifest.baselineLeafIds);
  admission(dense(manifest.recipes) && manifest.recipes.length > 0, 'MANIFEST_RECIPES');
  const ids = new Set(), hashes = new Set(), allEdges = [];
  for (const recipe of manifest.recipes) {
    admission(exactKeys(recipe, ['recipeId', 'needleBase64', 'replacementBase64', 'expectedOccurrences', 'mutantSha256', 'edges', 'rationale']) &&
      identifier(recipe.recipeId) && !ids.has(recipe.recipeId) && typeof recipe.mutantSha256 === 'string' && HASH.test(recipe.mutantSha256) &&
      recipe.mutantSha256 !== pins.candidate && !hashes.has(recipe.mutantSha256) &&
      typeof recipe.rationale === 'string' && recipe.rationale.trim().length > 0 && dense(recipe.edges) && recipe.edges.length > 0, 'RECIPE_SHAPE');
    ids.add(recipe.recipeId); hashes.add(recipe.mutantSha256);
    allEdges.push(...recipe.edges);
  }
  validateRequiredEdges(allEdges); // Exactly one recipe per required fault/check pair.
  for (const recipe of manifest.recipes) await applyRecipe(original, recipe); // Always original C, never accumulated.
  return manifest;
}
export async function authenticateCandidate(candidateBytes, manifestBytes, pins) {
  admission(await sha256(candidateBytes) === pins.candidate && await sha256(manifestBytes) === pins.manifest, 'CAPSULE_HASH');
  const manifest = parseManifestJSON(manifestBytes); // Hash BEFORE parsing.
  await validateManifest(manifest, candidateBytes, pins);
  return manifest;
}
export function expectedJobs(manifest) {
  const jobs = manifest.baselineLeafIds.map(checkId => ({ mode: 'baseline', checkId, recipeId: null, mutantSha256: null }));
  for (const recipe of manifest.recipes) for (const checkId of new Set(recipe.edges.map(edge => edge.checkId))) {
    jobs.push({ mode: 'mutation', checkId, recipeId: recipe.recipeId, mutantSha256: recipe.mutantSha256 });
  }
  return jobs;
}

// Candidate EQ: no getters, normalization, serialization, or descriptor-fixture
// comparison. Record key order is immaterial; array indices/order are exact.
export function rawEqual(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (!actual || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const prototype = Object.getPrototypeOf(actual);
  if (Array.isArray(expected) ? prototype !== Array.prototype : prototype !== null && prototype !== ordinaryPrototype) return false;
  const keys = Reflect.ownKeys(actual), wanted = Reflect.ownKeys(expected);
  if (keys.length !== wanted.length || keys.some(key => typeof key !== 'string' || !Object.hasOwn(expected, key))) return false;
  for (const key of wanted) {
    const descriptor = Object.getOwnPropertyDescriptor(actual, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== (key !== 'length' || !Array.isArray(expected)) ||
        !rawEqual(descriptor.value, Object.getOwnPropertyDescriptor(expected, key).value)) return false;
  }
  return true;
}
const newObservations = () => ({ fixtureReady: false, subjectEntered: false, subjectCompleted: false,
  assertionEntered: false, assertionFailed: false, calibrationPassed: false, assertionId: null, ...freshCounters() });
const genuineTypeError = TypeError;
const nativeIsError = Error.isError;
const isSubjectTypeError = error => nativeIsError(error) && error instanceof genuineTypeError;
export function observationPolicy(fixture) {
  let wholeInput = null, byteLimit = Infinity;
  const malformed = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key).value;
      if (['url', 'baseURL', 'transport'].includes(key)) {
        const bound = key === 'url' ? 65536 : 10485760;
        // Named baseURL's512 guard is UTF-16 units; its encoder budget is provider10MiB BYTES.
        const named = key === 'baseURL' && fixture.helper === 'sanitizeNamedAgents';
        if (typeof field === 'string' && key !== 'transport' && (named ? field.length > 512 : utf8(field).length > bound)) {
          wholeInput = field; byteLimit = bound;
        } else if (typeof field !== 'string') {
          malformed.push(field, String(field), JSON.stringify(field));
        }
      }
      visit(field);
    }
  }
  if (fixture.mode === 'P') visit(fixture.input);
  return { wholeInput, byteLimit, malformed };
}
export function evaluatePredicate(fixture, completion, counters, namespace) {
  const e = fixture.expectation;
  let ok;
  if (e.kind === 'API') {
    const d = Object.getOwnPropertyDescriptor(namespace, e.exportName);
    ok = !!d && Object.hasOwn(d, 'value') && typeof d.value === 'function';
  } else if (e.kind === 'TE') ok = completion.threw && isSubjectTypeError(completion.error);
  else if (completion.threw) ok = false;
  else if (e.kind === 'EQ') ok = rawEqual(completion.value, e.value);
  else {
    const d = completion.value && Object.getOwnPropertyDescriptor(completion.value, e.property);
    ok = !!d && Object.hasOwn(d, 'value') && (e.kind === 'CLS' ? d.value === e.value : d.value !== e.value);
  }
  if (e.absentOrdinaryPrototypeKeys) ok &&= e.absentOrdinaryPrototypeKeys.every(key => !Object.hasOwn(ordinaryPrototype, key));
  if (ok && e.absentInheritedKeys) {
    const inspect = value => {
      if (!value || typeof value !== 'object') return true;
      const prototype = Object.getPrototypeOf(value);
      return e.absentInheritedKeys.every(key => prototype === null || !(key in prototype)) &&
        Object.keys(value).every(key => inspect(Object.getOwnPropertyDescriptor(value, key).value));
    };
    ok = inspect(completion.value);
  }
  // rawEqual enforces the ordinary/null prototype obligation at EVERY depth.
  if (fixture.mode === 'V') ok &&= counters.urlConstructs > 0;
  if (fixture.mode === 'P') ok &&= counters.parserCalls === 0 && counters.wholeEncodeViolations === 0 && counters.encodeIntoViolations === 0;
  return !!ok;
}
// Internal callable seam for candidate-free negative mechanism vectors. It does
// not import a product, grant admission, or emit an official receipt.
export function observeLeaf(namespace, fixture, observers, mode) {
  const observations = newObservations();
  observations.calibrationPassed = true;
  observations.fixtureReady = true;
  let completion = { threw: false }, outcome, error = null;
  const api = fixture.mode === 'API';
  if (!api) {
    const descriptor = Object.getOwnPropertyDescriptor(namespace, fixture.helper);
    if (!descriptor || typeof descriptor.value !== 'function') return { outcome: 'SETUP_BLOCKED', observations, error: { stage: 'export', code: 'HELPER_MISSING' } };
    observations.subjectEntered = true;
    try { completion.value = observers.observe(() => Reflect.apply(descriptor.value, undefined, [fixture.input])); }
    catch (caught) { completion = { threw: true, error: caught }; }
    observations.subjectCompleted = true; // Return OR captured throw completed the synchronous call.
    Object.assign(observations, observers.snapshot().counters);
    if (observers.hasFailure()) return { outcome: 'SETUP_BLOCKED', observations, error: { stage: 'observer', code: 'OBSERVER_INSTRUMENTATION' } };
  }
  observations.assertionEntered = true;
  observations.assertionId = fixture.checkId;
  try {
    oracleAssert(evaluatePredicate(fixture, completion, observations, namespace), fixture.checkId);
    outcome = mode === 'baseline' ? 'BASELINE_PASS' : 'MUTANT_SURVIVED';
    if (mode === 'mutation') error = { stage: 'assertion', code: 'MUTANT_SURVIVED' };
  } catch (caught) {
    if (!isOracleAssertion(caught, fixture.checkId)) {
      outcome = 'WRONG_ASSERTION'; error = { stage: 'assertion', code: 'ASSERTION_ORIGIN' };
    } else {
      observations.assertionFailed = true;
      // Ordinary subject exceptions are not teeth. A TE assertion can expose a
      // missing/wrong TypeError, but an ordinary exception is always a crash.
      const ordinaryThrow = completion.threw && !isSubjectTypeError(completion.error);
      outcome = ordinaryThrow ? 'SUBJECT_CRASH' : mode === 'baseline' ? 'BASELINE_FAIL' : 'CAUGHT_NAMED_RED';
      if (outcome !== 'CAUGHT_NAMED_RED') error = { stage: 'subject', code: outcome };
    }
  }
  return { outcome, observations, error };
}

export async function runCandidate(options) {
  const pins = { design: options['--design-sha256'], oracle: options['--oracle-sha256'], candidate: options['--candidate-sha256'], manifest: options['--manifest-sha256'] };
  const job = { checkId: options['--check-id'], recipeId: options['--recipe-id'] ?? null, mutantSha256: null };
  let stage = 'capsule', observers;
  const observedHashes = { design: pins.design, oracle: pins.oracle, candidate: null, manifest: null };
  try {
    const read = typeof Deno === 'object' ? path => Deno.readFile(path) : (await import('node:fs/promises')).readFile;
    const candidate = new Uint8Array(await read(options['--candidate']));
    const manifestBytes = new Uint8Array(await read(options['--manifest']));
    observedHashes.candidate = await sha256(candidate);
    observedHashes.manifest = await sha256(manifestBytes);
    const manifest = await authenticateCandidate(candidate, manifestBytes, pins);
    const selected = expectedJobs(manifest).find(item => item.mode === options['--mode'] && item.checkId === job.checkId && item.recipeId === job.recipeId);
    admission(selected, 'JOB_ID');
    job.mutantSha256 = selected.mutantSha256;
    const recipe = manifest.recipes.find(item => item.recipeId === job.recipeId);
    const bytes = recipe ? (await applyRecipe(candidate, recipe)).bytes : candidate;
    stage = 'calibration';
    const calibration = await runMechanics();
    admission(calibration.outcome === 'MECHANICS_PASS', 'CALIBRATION');
    const policy = {}; // Observation stays inactive until the post-import fixture is ready.
    observers = createObservers(policy);
    observers.install();
    calibrateNative();
    stage = 'import';
    const namespace = await import(await verifiedDataURL(bytes, job.mutantSha256 ?? pins.candidate));
    stage = 'fixture';
    const fixture = buildFixture(job.checkId);
    validateFixture(fixture);
    Object.assign(policy, observationPolicy(fixture));
    stage = 'subject';
    return { job, observedHashes, ...observeLeaf(namespace, fixture, observers, options['--mode']) };
  } catch {
    return { job, observedHashes, outcome: stage === 'capsule' ? 'CUSTODY_FAILURE' : 'SETUP_BLOCKED', observations: newObservations(), error: { stage, code: 'ADMISSION_FAILURE' } };
  } finally {
    if (observers) { observers.restore(); calibrateNative(); }
  }
}

export function entryArgs(args) {
  const options = {};
  const common = ['--mode', '--run-id', '--oracle-sha256'];
  const candidate = ['--design-sha256', '--candidate', '--candidate-sha256', '--manifest', '--manifest-sha256', '--check-id'];
  const keys = [...common, ...candidate, '--recipe-id'];
  for (let i = 0; i < args.length; i += 2) {
    if (!keys.includes(args[i]) || Object.hasOwn(options, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  const mode = options['--mode'];
  const required = mode === 'mechanics' ? common : [...common, ...candidate, ...(mode === 'mutation' ? ['--recipe-id'] : [])];
  if (!['mechanics', 'baseline', 'mutation'].includes(mode) || !exactKeys(options, required) ||
      !UUID.test(options['--run-id']) || !HASH.test(options['--oracle-sha256']) ||
      (mode !== 'mechanics' && (!['--design-sha256', '--candidate-sha256', '--manifest-sha256'].every(key => HASH.test(options[key])) ||
        !['--candidate', '--manifest'].every(key => options[key].startsWith('/')) || !BASELINE_LEAF_IDS.includes(options['--check-id']) ||
        (mode === 'mutation' && !identifier(options['--recipe-id']))))) throw new Error('ARGUMENTS');
  return options;
}

if (import.meta.main) {
  const deno = typeof Deno === 'object';
  const runtime = deno ? { name: 'deno', version: Deno.version.deno, v8: Deno.version.v8, typescript: Deno.version.typescript } :
    { name: 'node', version: process.versions.node, v8: process.versions.v8, typescript: null };
  let status = 1;
  try {
    const options = entryArgs(deno ? Deno.args : process.argv.slice(2));
    const mechanics = options['--mode'] === 'mechanics';
    const result = mechanics ? await runMechanics() : await runCandidate(options);
    console.log(JSON.stringify({ schemaVersion: 1, mode: options['--mode'], runId: options['--run-id'], runtime,
      // O/D are host attributions, NOT self-authentication. C/M are verified buffers.
      observedHashes: mechanics ? { oracle: options['--oracle-sha256'] } : {
        design: options['--design-sha256'], oracle: options['--oracle-sha256'], candidate: options['--candidate-sha256'], manifest: options['--manifest-sha256'] },
      job: { checkId: null, recipeId: null, mutantSha256: null }, ...result }));
    status = ['MECHANICS_PASS', 'BASELINE_PASS', 'CAUGHT_NAMED_RED'].includes(result.outcome) ? 0 : 1;
  } catch {
    // Invalid entry/setup has no fabricated receipt. The host retains the failure.
    console.error('ORACLE_SETUP_FAILURE');
  }
  if (deno) Deno.exitCode = status;
  else process.exitCode = status;
}
