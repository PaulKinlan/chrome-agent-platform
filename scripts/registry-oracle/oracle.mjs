// S1 only. Self-contained stdin ES module; no imports except the verified tiny
// mechanics data URL below. No registry fixtures, candidate, manifest, or I/O.
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

export function createObservers() {
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
            if (active) {
              const inputLength = typeof args[0] === 'string' ? args[0].length : null;
              const destinationLength = args[1] instanceof Uint8Array ? args[1].length : null;
              lengths.push({ kind: key, inputLength, destinationLength });
              if (key === 'encode' && inputLength > ceiling) count('wholeEncodeViolations');
              if (key === 'encodeInto' && destinationLength > ceiling) count('encodeIntoViolations');
            }
            return Reflect.apply(target, receiver, args);
          },
        }));
      }
    },
    observe(subject) {
      requireMechanics(installed && !active);
      counters = freshCounters(); lengths = [];
      active = true;
      try { return subject(); } finally { active = false; }
    },
    snapshot() { return { counters: { ...counters }, lengths: lengths.map(item => ({ ...item })) }; },
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

export function entryArgs(args) {
  const options = {};
  const keys = ['--mode', '--run-id', '--oracle-sha256'];
  for (let i = 0; i < args.length; i += 2) {
    if (!keys.includes(args[i]) || Object.hasOwn(options, args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  if (keys.some(key => !Object.hasOwn(options, key)) || options['--mode'] !== 'mechanics' ||
      !UUID.test(options['--run-id']) || !HASH.test(options['--oracle-sha256'])) throw new Error('ARGUMENTS');
  return options;
}

if (import.meta.main) {
  const deno = typeof Deno === 'object';
  const runtime = deno ? { name: 'deno', version: Deno.version.deno, v8: Deno.version.v8, typescript: Deno.version.typescript } :
    { name: 'node', version: process.versions.node, v8: process.versions.v8, typescript: null };
  let status = 1;
  try {
    const options = entryArgs(deno ? Deno.args : process.argv.slice(2));
    const result = await runMechanics();
    console.log(JSON.stringify({ schemaVersion: 1, mode: 'mechanics', runId: options['--run-id'], runtime,
      // O is a host-provided attribution, NOT self-authentication. Direct runs are unofficial.
      observedHashes: { oracle: options['--oracle-sha256'] },
      job: { checkId: null, recipeId: null, mutantSha256: null }, ...result }));
    status = result.outcome === 'MECHANICS_PASS' ? 0 : 1;
  } catch {
    // Invalid entry/setup has no fabricated receipt. The host retains the failure.
    console.error('ORACLE_SETUP_FAILURE');
  }
  if (deno) Deno.exitCode = status;
  else process.exitCode = status;
}
