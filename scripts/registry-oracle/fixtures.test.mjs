// Standalone candidate-free DEVELOPMENT checks, native Node or Deno; no product I/O.
// Independent literal r5 test data: no catalogue generator constructs these sets
// or expected inputs/outputs. Errors report only diagnostic IDs, never payloads.
import { isDeepStrictEqual } from 'node:util';
import { BASE_RECORDS, URL_DATA, CATALOGUE, BASELINE_LEAF_IDS, REQUIRED_EDGES, FAULT_IDS,
  GROUNDING, buildFixture, validateFixture, validateCatalogue, validateLeafIds, validateRequiredEdges } from './oracle.mjs';
const check = (ok, id) => { if (!ok) throw new Error('DEVELOPMENT_' + id); };
const equal = (a, b, id) => check(isDeepStrictEqual(a, b), id);
const refuses = (fn, code) => { let error; try { fn(); } catch (caught) { error = caught; } check(error?.message === code, 'REFUSAL_' + code); };
const id = x => x.startsWith('REG-') ? x : 'REG-BASE-' + x;
const words = text => text.trim().split(/\s+/);
// Literal expansion, not 1..98, not derived from CATALOGUE.
const expectedIds = words(`
01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30
31.number 31.boolean 32 33 34.stdio 34.pipe 35 36
37.apiKey 37.authToken 37.clientSecret 38.apiKey 38.authToken 38.clientSecret 39.apiKey 39.authToken 39.clientSecret
40 41 42 43 44 45 46 47.null 47.array 47.string 47.number 48 49 50 51 52.absent 52.null 53 54
55.map 55.agent 55.tools 55.provider 55.mcp 56.string 56.number 56.boolean 56.array 57.missing 57.inherited 57.array 57.number
58 59.apiKey 59.authToken 59.clientSecret 60 61 62 63 64.null 64.array 64.string 64.number
65.null 65.string 65.array 65.missing 65.inherited 65.nonprimitive 66 67 68.missing 68.inherited
69.array 69.object 69.number 69.boolean 70.array 70.object 70.number 70.boolean 71.username 71.password 72.query 72.fragment
73 74 75 76 77
78.valid 78.empty 78.canonical 78.unicode 78.username 78.password 78.query 78.fragment 78.scheme 78.hostless 78.malformed 78.url-array 78.url-object 78.url-number 78.url-boolean 78.bound 78.over 78.over-utf8 78.shrink
79.valid 79.empty 79.canonical 79.unicode 79.username 79.password 79.query 79.fragment 79.scheme 79.hostless 79.malformed 79.url-array 79.url-object 79.url-number 79.url-boolean 79.bound 79.over
80.valid 80.empty 80.canonical 80.unicode 80.username 80.password 80.query 80.fragment 80.scheme 80.hostless 80.malformed 80.url-array 80.url-object 80.url-number 80.url-boolean 80.bound 80.over 80.over-utf8 80.shrink
81 82 83 84 85 86 87.array 87.number 87.object 87.boolean 88.object 88.null 88.string 89 90 91.number 91.object 91.array 91.boolean 92
93.threads 93.assets 93.run-registry 94.scripts 94.board-wakes 95.enrolled 95.origins 95.wasmPkg 96.wasm-repair 96.asset-repair
97.private-root 97.transaction-root 97.unqualified-hmac 98.wasm 98.metadata 98.delete 98.upload 98.nested-negative
REG-MCP-UNICODE REG-MCP-IDENTITY REG-MCP-OWN-URL REG-MCP-OWN-TRANSPORT REG-MCP-URL-TYPE.null REG-MCP-URL-TYPE.undefined REG-MCP-URL-TYPE.number REG-MCP-URL-TYPE.boolean
REG-NAMED-IDENTITY REG-NAMED-EMPTY REG-NAMED-UNICODE REG-NAMED-MCP-TRANSPORT-ARRAY
REG-PROVIDER-UNICODE REG-PROVIDER-UTF8-OVER REG-PROVIDER-SHRINK REG-AGENTCONFIG-EMPTY
REG-CTX-legacy-apiKey REG-CTX-legacy-authToken REG-CTX-legacy-clientSecret
REG-CTX-named-apiKey REG-CTX-named-authToken REG-CTX-named-clientSecret
REG-CTX-origin-apiKey REG-CTX-origin-authToken REG-CTX-origin-clientSecret
REG-PATH-MEMORY-HIGH REG-PATH-MEMORY-PAIR
`).map(id);
// Every target is literal, including every "all" and twin expansion from §6.
const edgeTable = `
path-high: 06
path-low: 07
path-shortcircuit: 08
path-workspace-only: REG-PATH-MEMORY-HIGH
path-validpair-overreject: 09 REG-PATH-MEMORY-PAIR
path-fffd-overreject: 10
board-portable: 01
phantom-kv-admit: 02
provider-drop-apiKey: 11
provider-drop-authToken: 12
provider-drop-clientSecret: 13
recursive-apiKey-leak: 37.apiKey 38.apiKey 39.apiKey 59.apiKey REG-CTX-legacy-apiKey REG-CTX-named-apiKey REG-CTX-origin-apiKey
recursive-authToken-leak: 37.authToken 38.authToken 39.authToken 59.authToken REG-CTX-legacy-authToken REG-CTX-named-authToken REG-CTX-origin-authToken
recursive-clientSecret-leak: 37.clientSecret 38.clientSecret 39.clientSecret 59.clientSecret REG-CTX-legacy-clientSecret REG-CTX-named-clientSecret REG-CTX-origin-clientSecret
proto-own-leak: 14
proto-inheritance-leak: 15
proto-named-leak: 55.map 55.agent 55.tools 55.provider 55.mcp
proto-origin-leak: 62
benign-constructor-drop: 16 63
benign-prototype-drop: 17 63
benign-substring-drop: 18
mcp-auth-leak: 19 40
mcp-url-leak: 20 41
mcp-bound-omit: 22
mcp-codeunits: 23
mcp-normalize-first: 24
mcp-parse-first: 22 23 24
mcp-encode-first: 22 23 24
mcp-url-coercion: 27 28 REG-MCP-URL-TYPE.null REG-MCP-URL-TYPE.undefined REG-MCP-URL-TYPE.number REG-MCP-URL-TYPE.boolean 45
mcp-transport-admit: 29 30 31.number 31.boolean 46 REG-NAMED-MCP-TRANSPORT-ARRAY
mcp-malformed-fatal: 25 43
mcp-own-field-coercion: REG-MCP-OWN-URL REG-MCP-OWN-TRANSPORT
mcp-rest-overredact: 35 36
mcp-identity-change: REG-MCP-IDENTITY 42
named-bad-record: 47.null 47.array 47.string 47.number
named-bad-servers: 48 49 50
named-null-placeholder: 43
named-empty-or-identity-change: REG-NAMED-IDENTITY 42
named-optional-overreject: 51 52.absent 52.null REG-NAMED-EMPTY
named-provider-container-admit: 56.string 56.number 56.boolean 56.array 57.missing 57.inherited 57.array 57.number
agentconfig-api-loss: 58
agentconfig-body-leak: 59.apiKey 59.authToken 59.clientSecret
agentconfig-name-overreject: 60 61 REG-AGENTCONFIG-EMPTY
agentconfig-container-admit: 65.null 65.string 65.array 65.missing 65.inherited 65.nonprimitive
flat-provider-identity-admit: 68.missing 68.inherited 69.array 69.object 69.number 69.boolean
provider-url-type-admit: 70.array 70.object 70.number 70.boolean 78.url-array 78.url-object 78.url-number 78.url-boolean 79.url-array 79.url-object 79.url-number 79.url-boolean 80.url-array 80.url-object 80.url-number 80.url-boolean
provider-component-admit: 71.username 71.password 72.query 72.fragment 78.username 78.password 78.query 78.fragment 79.username 79.password 79.query 79.fragment 80.username 80.password 80.query 80.fragment
provider-scheme-admit: 73 78.scheme 79.scheme 80.scheme
provider-invalid-admit: 74 75 78.hostless 78.malformed 79.hostless 79.malformed 80.hostless 80.malformed
provider-empty-overreject: 67 78.empty 79.empty 80.empty
provider-unicode-overreject: REG-PROVIDER-UNICODE 78.unicode 79.unicode 80.unicode
provider-bound-bypass: 77 REG-PROVIDER-UTF8-OVER REG-PROVIDER-SHRINK 78.over 78.over-utf8 78.shrink 80.over 80.over-utf8 80.shrink
provider-parse-first: 77 REG-PROVIDER-UTF8-OVER REG-PROVIDER-SHRINK 78.over 78.over-utf8 78.shrink 80.over 80.over-utf8 80.shrink
provider-encode-first: 77 REG-PROVIDER-UTF8-OVER REG-PROVIDER-SHRINK 78.over 78.over-utf8 78.shrink 80.over 80.over-utf8 80.shrink
named-512-bypass: 54 79.over
legacy-identity-admit: 83 84 85 86 87.array 87.number 87.object 87.boolean 89
legacy-layout-admit: 88.object 88.null 88.string 90 91.number 91.object 91.array 91.boolean
legacy-default-or-trim: 82 92
frozen-classification-drift: 93.threads 93.assets 93.run-registry 94.scripts 94.board-wakes 95.enrolled 95.origins 95.wasmPkg 96.wasm-repair 96.asset-repair 97.private-root 97.transaction-root 97.unqualified-hmac 98.wasm 98.metadata 98.delete 98.upload 98.nested-negative
`;
const expectedEdges = edgeTable.trim().split('\n').flatMap(line => {
  const [faultId, checks] = line.split(': ');
  return words(checks).map(x => ({ faultId, checkId: id(x) }));
});
const edgeKey = e => e.faultId + '/' + e.checkId;
function checkSets() {
  check(new Set(expectedIds).size === expectedIds.length, 'TEST_DUPLICATE_LEAF');
  check(new Set(expectedEdges.map(edgeKey)).size === expectedEdges.length, 'TEST_DUPLICATE_EDGE');
  equal([...BASELINE_LEAF_IDS].sort(), [...expectedIds].sort(), 'LEAF_EQUALITY');
  equal(REQUIRED_EDGES.map(edgeKey).sort(), expectedEdges.map(edgeKey).sort(), 'EDGE_EQUALITY');
  equal([...FAULT_IDS].sort(), [...new Set(expectedEdges.map(e => e.faultId))].sort(), 'FAULT_EQUALITY');
  check(validateCatalogue(CATALOGUE) && validateLeafIds(expectedIds) && validateRequiredEdges(expectedEdges), 'VALID_SETS');
  const sparseIds = [...expectedIds]; delete sparseIds[0];
  for (const values of [null, [], sparseIds, expectedIds.slice(1), [...expectedIds, expectedIds[0]], [...expectedIds.slice(1), 'REG-BASE-99'], [...expectedIds.slice(1), 1]]) refuses(() => validateLeafIds(values), 'FIXTURE_LEAF_SET');
  for (const values of [[], expectedEdges.slice(1), [...expectedEdges, expectedEdges[0]]]) refuses(() => validateRequiredEdges(values), 'FIXTURE_EDGE_SET');
  refuses(() => validateRequiredEdges(null), 'FIXTURE_EDGE_LIST');
  for (const value of [{ faultId: 'unknown', checkId: id('06') }, { faultId: 'path-high', checkId: 'REG-BASE-99' },
    { faultId: 'path-high', checkId: id('06'), extra: true }, { faultId: 'path-high', checkId: 6 }]) refuses(() => validateRequiredEdges([value]), 'FIXTURE_EDGE_ID');
  refuses(() => validateRequiredEdges([{ faultId: 'path-high', checkId: id('07') }]), 'FIXTURE_EDGE_RELATIONSHIP');
  for (const x of [undefined, null, 6, '06', 'REG-BASE-31', 'REG-BASE-79.shrink', 'REG-BASE-79.over-utf8', 'REG-BASE-99']) refuses(() => buildFixture(x), 'FIXTURE_LEAF_ID');
  refuses(() => validateCatalogue(CATALOGUE.slice(1)), 'FIXTURE_LEAF_SET');
  const badDefinition = Object.freeze({ ...CATALOGUE[0], helper: 'notAHelper' });
  refuses(() => validateCatalogue([badDefinition, ...CATALOGUE.slice(1)]), 'FIXTURE_DEFINITION');
  for (const [prefix, count] of [['78.', 19], ['79.', 17], ['80.', 19]]) equal(BASELINE_LEAF_IDS.filter(x => x.startsWith(id(prefix))).length, count, 'TWIN_COUNT_' + prefix);
}
function frozen(value) {
  if (!value || typeof value !== 'object') return;
  check(Object.isFrozen(value), 'IMMUTABLE');
  for (const key of Object.keys(value)) frozen(value[key]);
}
// Independent direct literal construction, not the oracle's edit interpreter.
const P = () => ({ provider: 'openai', baseURL: 'https://api.example.test/v1', model: 'model-1' });
const S = () => ({ id: 'alpha', name: 'Alpha', transport: 'http', url: 'https://mcp.example.test/mcp', enabled: true });
const T = () => ({ id: 'beta', name: 'Beta', transport: 'http', url: 'https://mcp.example.test/beta', enabled: false });
const A = () => ({ writer: { id: 'writer', name: 'Writer', instanceId: 'd631d758-7304-4a5d-bf15-4f0c2436f91a', role: 'Draft', skills: [], canDelegateTo: [], mcpServers: [] } });
const B = () => ({ reader: { id: 'reader', name: 'Reader', instanceId: '263503a1-4966-48cc-9185-f770aa31ea08', role: 'Read', skills: [], canDelegateTo: [], mcpServers: [] } });
const C = () => ({ name: 'Site Bot', model: 'kept-model', note: 'kept-note' });
const L = () => ({ activeProvider: 'legacy', providers: [{ id: 'legacy', baseURL: 'https://api.example.test/v1', model: 'model-1' }] });
const AUTH = () => ({ headerName: 'Authorization', token: 'fixture-mcp-secret' });
const p = v => ({ ...P(), baseURL: v });
const s = v => ({ ...S(), url: v });
const n = servers => { const a = A(); a.writer.mcpServers = servers; return a; };
const np = provider => { const a = A(); a.writer.provider = provider; return a; };
const g = provider => ({ ...C(), provider });
const ownProto = (o, v) => Object.defineProperty(o, '__proto__', { value: v, enumerable: true, configurable: true, writable: true });
const inherited = (o, key) => { const value = o[key]; delete o[key]; return Object.assign(Object.create({ [key]: value }), o); };
const without = (o, key) => { delete o[key]; return o; };
const longM = size => 'https://mcp.example.test/' + 'a'.repeat(size - 25);
const longP = size => 'https://api.example.test/' + 'a'.repeat(size - 25);
const overM = () => 'https://mcp.example.test/' + 'é'.repeat(32756);
const shrinkM = () => 'https://mcp.example.test/mcp?x=' + 'a'.repeat(65507);
const overP = () => 'https://api.example.test/' + 'é'.repeat(5242868);
const shrinkP = () => 'https://api.example.test/v1?x=' + 'a'.repeat(10485732);
const dirty = 'https://u:p@mcp.example.test/mcp?tenant=a#frag';
const transport = () => ({ type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'fixture-header-secret' } });
const mUnicode = 'https://mcp.example.test/api/日本語';
const mEncoded = 'https://mcp.example.test/api/%E6%97%A5%E6%9C%AC%E8%AA%9E';
const pUnicode = 'https://api.example.test/é';
const pEncoded = 'https://api.example.test/%C3%A9';
const credentials = { apiKey: 'fixture-api-key', authToken: 'fixture-auth-token', clientSecret: 'fixture-client-secret' };
const refs = new Map();
const ref = (ids, helper, mode, kind, create) => {
  for (const x of words(ids)) { check(!refs.has(id(x)), 'TEST_DUPLICATE_REFERENCE'); refs.set(id(x), { helper, mode, kind, create }); }
};
const E = (ids, helper, mode, create) => ref(ids, helper, mode, 'EQ', create);
const X = (ids, helper, mode, create) => ref(ids, helper, mode, 'TE', () => [create()]);
const O = (ids, path, value, kind = 'CLS') => ref(ids, 'classifyOpfsPath', 'S', kind, () => [path, value]);
const hp = 'sanitizeProviderConfig', hm = 'sanitizeMcpServer', hn = 'sanitizeNamedAgents', hg = 'sanitizeAgentConfig';
O('01', 'memory/master/cap:board-deny-rules.json', 'portable-deny-union');
ref('02', 'classifyKvKey', 'S', 'CLS', () => ['cap:board-deny-rules', 'unclassified']);
O('03', 'memory/origins/https%3A%2F%2Fexample.com/cap:board-deny-rules.json', 'portable-deny-union', 'not-CLS');
O('04', 'memory/origins/https%3A%2F%2Fexample.com/cap:board-deny-rules.json', 'portable-user-data');
O('05', 'memory/master/cap:board-deny-rules', 'unclassified');
O('06', 'agent-workspaces/named-a/\uD800', 'unclassified');
O('07', 'agent-workspaces/named-a/\uDFFF', 'unclassified');
O('08', 'agent-workspaces/named-a/\uD83D\uDE00\uD800', 'unclassified');
O('09', 'agent-workspaces/named-a/\uD83D\uDE00', 'portable-user-data');
O('10', 'agent-workspaces/named-a/\uFFFD', 'portable-user-data');
E('11', hp, 'V', () => [{ ...P(), apiKey: 'fixture-api-key' }, P()]);
E('12', hp, 'V', () => [{ ...P(), authToken: 'fixture-auth-token' }, P()]);
E('13', hp, 'V', () => [{ ...P(), clientSecret: 'fixture-client-secret' }, P()]);
E('14', hp, 'V', () => [ownProto(P(), { injected: true }), P()]);
E('15', hp, 'V', () => [{ ...P(), nested: ownProto({ benign: 2 }, { evil: 1 }) }, { ...P(), nested: { benign: 2 } }]);
E('16', hp, 'V', () => [{ ...P(), constructor: 'benign' }, { ...P(), constructor: 'benign' }]);
E('17', hp, 'V', () => [{ ...P(), prototype: 'benign' }, { ...P(), prototype: 'benign' }]);
E('18', hp, 'V', () => [{ ...P(), tokenLimit: 4096, apiKeyPrefix: 'sk-', note: 'fixture-api-key', apiKey: 'fixture-api-key' }, { ...P(), tokenLimit: 4096, apiKeyPrefix: 'sk-', note: 'fixture-api-key' }]);
E('19', hm, 'V', () => [{ ...S(), auth: AUTH() }, S()]);
E('20', hm, 'V', () => [{ ...s(dirty), auth: AUTH() }, S()]);
E('21', hm, 'V', () => [s(longM(65536)), s(longM(65536))]);
X('22', hm, 'P', () => s(longM(65537)));
X('23', hm, 'P', () => s(overM()));
X('24', hm, 'P', () => s(shrinkM()));
E('25', hm, 'S', () => [s('not a URL'), null]);
E('26', hm, 'S', () => [s('file:///path'), null]);
X('27', hm, 'P', () => s([dirty]));
X('28', hm, 'P', () => s({ href: 'https://mcp.example.test/mcp' }));
X('29', hm, 'P', () => ({ ...S(), transport: transport() }));
X('30', hm, 'P', () => ({ ...S(), transport: ['http'] }));
X('31.number', hm, 'P', () => ({ ...S(), transport: 17 }));
X('31.boolean', hm, 'P', () => ({ ...S(), transport: true }));
E('32', hm, 'S', () => [without(S(), 'url'), null]);
E('33', hm, 'S', () => [without(S(), 'transport'), null]);
for (const key of ['stdio', 'pipe']) E('34.' + key, hm, 'S', () => [{ ...S(), transport: key }, null]);
E('35', hm, 'V', () => [Object.assign(ownProto(S(), { benign: 1 }), { auth: AUTH() }), ownProto(S(), { benign: 1 })]);
E('36', hm, 'V', () => [{ ...S(), description: 'Docs', icon: 'icon.png', customField: { kept: true }, auth: AUTH() }, { ...S(), description: 'Docs', icon: 'icon.png', customField: { kept: true } }]);
E('REG-MCP-UNICODE', hm, 'V', () => [s(mUnicode), s(mEncoded)]);
E('REG-MCP-IDENTITY', hm, 'V', () => [{ ...T(), auth: AUTH() }, T()]);
E('REG-MCP-OWN-URL', hm, 'S', () => [inherited(S(), 'url'), null]);
E('REG-MCP-OWN-TRANSPORT', hm, 'S', () => [inherited(S(), 'transport'), null]);
for (const [key, value] of [['null', null], ['undefined', undefined], ['number', 17], ['boolean', true]]) X('REG-MCP-URL-TYPE.' + key, hm, 'P', () => s(value));
for (const [key, marker] of Object.entries(credentials)) {
  E('37.' + key, hn, 'S', () => { const input = A(); input.writer[key] = marker; return [input, A()]; });
  E('38.' + key, hn, 'V', () => [np({ ...P(), [key]: marker }), np(P())]);
  E('39.' + key, hn, 'S', () => { const input = A(), output = A(); input.writer.tools = { lookup: { tokenLimit: 12, [key]: marker } }; output.writer.tools = { lookup: { tokenLimit: 12 } }; return [input, output]; });
}
E('40', hn, 'V', () => [n([{ ...S(), auth: AUTH() }]), n([S()])]);
E('41', hn, 'V', () => [n([{ ...s(dirty), auth: AUTH() }]), n([S()])]);
E('42', hn, 'V', () => [n([S(), T()]), n([S(), T()])]);
E('43', hn, 'S', () => [n([S(), { ...T(), url: 'not a URL' }, T()]), n([S(), T()])]);
X('44', hn, 'P', () => n([s(longM(65537))]));
X('45', hn, 'P', () => n([s([dirty])]));
X('46', hn, 'P', () => n([{ ...S(), transport: transport() }]));
for (const [key, value] of [['null', null], ['array', []], ['string', 'bad'], ['number', 17]]) X('47.' + key, hn, 'S', () => ({ writer: value }));
X('48', hn, 'S', () => n('not-an-array'));
X('49', hn, 'S', () => n(null));
X('50', hn, 'S', () => n(undefined));
E('51', hn, 'S', () => { const input = A(), output = A(); delete input.writer.mcpServers; delete output.writer.mcpServers; return [input, output]; });
E('52.absent', hn, 'S', () => [A(), A()]);
E('52.null', hn, 'S', () => [np(null), np(null)]);
E('53', hn, 'V', () => [np(p(longP(512))), np(p(longP(512)))]);
X('54', hn, 'P', () => np(p(longP(513))));
E('55.map', hn, 'S', () => [ownProto(A(), B().reader), A()]);
E('55.agent', hn, 'S', () => [{ writer: ownProto(A().writer, { evil: 1 }) }, A()]);
E('55.tools', hn, 'S', () => { const input = A(), output = A(); input.writer.tools = ownProto({ tokenLimit: 12 }, { evil: 1 }); output.writer.tools = { tokenLimit: 12 }; return [input, output]; });
E('55.provider', hn, 'S', () => [np(ownProto(P(), { evil: 1 })), np(P())]);
E('55.mcp', hn, 'S', () => [n([ownProto(S(), { evil: 1 })]), n([S()])]);
for (const [key, value] of [['string', 'openai'], ['number', 17], ['boolean', true], ['array', []]]) X('56.' + key, hn, 'S', () => np(value));
const identities = {
  missing: () => without(P(), 'provider'), inherited: () => inherited(P(), 'provider'),
  array: () => ({ ...P(), provider: ['openai'] }), number: () => ({ ...P(), provider: 17 }),
};
for (const [key, create] of Object.entries(identities)) X('57.' + key, hn, 'S', () => np(create()));
E('REG-NAMED-IDENTITY', hn, 'S', () => [{ ...A(), ...B() }, { ...A(), ...B() }]);
E('REG-NAMED-EMPTY', hn, 'S', () => [{}, {}]);
E('REG-NAMED-UNICODE', hn, 'V', () => [n([s(mUnicode)]), n([s(mEncoded)])]);
X('REG-NAMED-MCP-TRANSPORT-ARRAY', hn, 'P', () => n([{ ...S(), transport: ['http'] }]));
ref('58', hg, 'API', 'API', () => [null]);
for (const [key, marker] of Object.entries(credentials)) E('59.' + key, hg, 'V', () => [g({ ...P(), [key]: marker }), g(P())]);
E('60', hg, 'S', () => [{ name: 'Site Bot' }, { name: 'Site Bot' }]);
E('61', hg, 'S', () => [C(), C()]);
E('62', hg, 'S', () => [ownProto(C(), { evil: 1 }), C()]);
E('63', hg, 'S', () => [{ ...C(), constructor: 'benign', prototype: 'benign' }, { ...C(), constructor: 'benign', prototype: 'benign' }]);
for (const [key, value] of [['null', null], ['array', []], ['string', 'bad'], ['number', 17]]) X('64.' + key, hg, 'S', () => value);
for (const [key, create] of Object.entries({ null: () => null, string: () => 'openai', array: () => [], missing: identities.missing, inherited: identities.inherited, nonprimitive: identities.array })) X('65.' + key, hg, 'S', () => g(create()));
E('66', hp, 'V', () => [p('HTTPS://API.EXAMPLE.TEST:443/a/../v1'), P()]);
E('67', hp, 'S', () => [p(''), p('')]);
for (const key of ['missing', 'inherited']) X('68.' + key, hp, 'S', identities[key]);
for (const [key, value] of [['array', ['openai']], ['object', {}], ['number', 17], ['boolean', true]]) X('69.' + key, hp, 'S', () => ({ ...P(), provider: value }));
const urlTypes = { array: ['https://api.example.test/v1'], object: { href: 'https://api.example.test/v1' }, number: 17, boolean: true };
for (const [key, value] of Object.entries(urlTypes)) X('70.' + key, hp, 'P', () => p(value));
const componentValues = {
  username: 'https://u@api.example.test/v1', password: 'https://:p@api.example.test/v1',
  query: 'https://api.example.test/v1?tenant=a', fragment: 'https://api.example.test/v1#frag',
};
X('71.username', hp, 'S', () => p(componentValues.username));
X('71.password', hp, 'S', () => p(componentValues.password));
X('72.query', hp, 'S', () => p(componentValues.query));
X('72.fragment', hp, 'S', () => p(componentValues.fragment));
X('73', hp, 'S', () => p('ftp://api.example.test/v1'));
X('74', hp, 'S', () => p('file:///path'));
X('75', hp, 'S', () => p('http:///'));
E('76', hp, 'V', () => [p(longP(10485760)), p(longP(10485760))]);
X('77', hp, 'P', () => p(longP(10485761)));
E('REG-PROVIDER-UNICODE', hp, 'V', () => [p(pUnicode), p(pEncoded)]);
X('REG-PROVIDER-UTF8-OVER', hp, 'P', () => p(overP()));
X('REG-PROVIDER-SHRINK', hp, 'P', () => p(shrinkP()));
E('REG-AGENTCONFIG-EMPTY', hg, 'S', () => [{}, {}]);
for (const [prefix, contextName, helper, make, bound] of [
  ['78', 'legacy', hp, value => { const l = L(); l.providers[0].baseURL = value; return l; }, 10485760],
  ['79', 'named', hn, value => np(p(value)), 512], ['80', 'origin', hg, value => g(p(value)), 10485760],
]) {
  E(prefix + '.valid', helper, 'V', () => [make('https://api.example.test/v1'), make('https://api.example.test/v1')]);
  E(prefix + '.empty', helper, 'S', () => [make(''), make('')]);
  E(prefix + '.canonical', helper, 'V', () => [make('HTTPS://API.EXAMPLE.TEST:443/a/../v1'), make('https://api.example.test/v1')]);
  E(prefix + '.unicode', helper, 'V', () => [make(pUnicode), make(pEncoded)]);
  for (const [key, value] of Object.entries(componentValues)) X(prefix + '.' + key, helper, 'S', () => make(value));
  X(prefix + '.scheme', helper, 'S', () => make('ftp://api.example.test/v1'));
  X(prefix + '.hostless', helper, 'S', () => make('file:///path'));
  X(prefix + '.malformed', helper, 'S', () => make('http:///'));
  for (const [key, value] of Object.entries(urlTypes)) X(prefix + '.url-' + key, helper, 'P', () => make(value));
  E(prefix + '.bound', helper, 'V', () => [make(longP(bound)), make(longP(bound))]);
  X(prefix + '.over', helper, 'P', () => make(longP(bound + 1)));
  if (prefix === '78' || prefix === '80') {
    X(prefix + '.over-utf8', helper, 'P', () => make(overP()));
    X(prefix + '.shrink', helper, 'P', () => make(shrinkP()));
  }
  for (const [key, marker] of Object.entries(credentials)) E('REG-CTX-' + contextName + '-' + key, helper, 'V', () => {
    const input = make('https://api.example.test/v1');
    const record = prefix === '78' ? input.providers[0] : prefix === '79' ? input.writer.provider : input.provider;
    record[key] = marker;
    return [input, make('https://api.example.test/v1')];
  });
}
E('81', hp, 'V', () => [L(), L()]);
E('82', hp, 'V', () => { const input = L(), output = L(); input.providers[0].id = input.activeProvider = ' '; output.providers[0].id = output.activeProvider = ' '; return [input, output]; });
X('83', hp, 'S', () => { const l = L(); l.providers[0] = inherited(l.providers[0], 'id'); return l; });
X('84', hp, 'S', () => { const l = L(); delete l.providers[0].id; l.providers[0].provider = 'openai'; return l; });
X('85', hp, 'S', () => { const l = L(); l.providers[0].provider = 'openai'; return l; });
X('86', hp, 'S', () => { const l = L(); l.providers[0].id = ''; return l; });
for (const [key, value] of [['array', ['legacy']], ['number', 17], ['object', {}], ['boolean', true]]) X('87.' + key, hp, 'S', () => { const l = L(); l.providers[0].id = value; return l; });
for (const [key, value] of [['object', {}], ['null', null], ['string', 'bad']]) X('88.' + key, hp, 'S', () => ({ ...L(), providers: value }));
X('89', hp, 'S', () => { const l = L(); delete l.providers[0].id; return l; });
X('90', hp, 'S', () => ({ ...L(), provider: 'openai' }));
for (const [key, value] of [['number', 17], ['object', {}], ['array', []], ['boolean', true]]) X('91.' + key, hp, 'S', () => ({ ...L(), activeProvider: value }));
E('92', hp, 'V', () => [without(L(), 'activeProvider'), without(L(), 'activeProvider')]);
for (const [leaf, file, value] of [
  ['93.threads', 'threads.json', 'portable-terminal-validated'], ['93.assets', 'assets.json', 'portable-terminal-validated'],
  ['93.run-registry', 'run-registry.json', 'portable-terminal-validated'], ['94.scripts', 'scripts.json', 'portable-revalidate'],
  ['94.board-wakes', 'cap:board-wakes.json', 'portable-revalidate'], ['95.enrolled', 'enrolled.json', 'authority'],
  ['95.origins', 'origins.json', 'authority'], ['95.wasmPkg', 'wasmPkg.json', 'authority'],
  ['96.wasm-repair', 'wasmPkgRepair.json', 'transaction-private'], ['96.asset-repair', 'assetRepair.json', 'transaction-private'],
]) O(leaf, 'memory/master/' + file, value);
O('97.private-root', 'chrome-agent-platform-private', 'internal-secret');
O('97.transaction-root', 'archive-transactions-v1', 'transaction-private');
O('97.unqualified-hmac', 'owner-approval-hmac-v1', 'unclassified');
O('98.wasm', 'cap-user-wasm-v1/' + 'a'.repeat(64) + '.wasm', 'portable-user-data');
O('98.metadata', 'cap-user-wasm-v1/' + 'a'.repeat(64) + '.json', 'portable-user-data');
O('98.delete', 'cap-user-wasm-v1/delete-' + 'a'.repeat(64) + '.json', 'transaction-private');
O('98.upload', 'cap-user-wasm-v1/upload-d631d758-7304-4a5d-bf15-4f0c2436f91a.wasm', 'transaction-private');
O('98.nested-negative', 'cap-user-wasm-v1/sub/' + 'a'.repeat(64) + '.wasm', 'unclassified');
O('REG-PATH-MEMORY-HIGH', 'memory/master/note-\uD800.json', 'unclassified');
O('REG-PATH-MEMORY-PAIR', 'memory/master/note-\uD83D\uDE00.json', 'portable-user-data');

// Compare special prototypes structurally, rather than requiring the two fresh
// attacker prototypes to have identical object identity. All data descriptors
// are checked explicitly; util's deep equality alone ignores their attributes.
function raw(actual, expected, diagnostic) {
  if (expected === null || typeof expected !== 'object') { check(Object.is(actual, expected), diagnostic); return; }
  check(actual !== null && typeof actual === 'object' && Array.isArray(actual) === Array.isArray(expected), diagnostic);
  const ap = Object.getPrototypeOf(actual), ep = Object.getPrototypeOf(expected);
  if (ep === Object.prototype || ep === Array.prototype || ep === null) check(ap === ep, diagnostic + '_PROTOTYPE');
  else raw(ap, ep, diagnostic + '_INHERITANCE');
  equal(Reflect.ownKeys(actual), Reflect.ownKeys(expected), diagnostic + '_KEYS');
  for (const key of Reflect.ownKeys(expected)) {
    const a = Object.getOwnPropertyDescriptor(actual, key), e = Object.getOwnPropertyDescriptor(expected, key);
    check(Object.hasOwn(a, 'value') && a.enumerable === e.enumerable && a.writable === e.writable && a.configurable === e.configurable, diagnostic + '_DATA');
    raw(a.value, e.value, diagnostic); // Never put attacker key/value in diagnostics.
  }
}
function objects(value, found = new Set()) {
  if (!value || typeof value !== 'object' || found.has(value)) return found;
  found.add(value);
  for (const key of Reflect.ownKeys(value)) objects(Object.getOwnPropertyDescriptor(value, key).value, found);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) objects(prototype, found);
  return found;
}
function facts(value, path = [], list = []) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const fact = { path, type };
  if (typeof value === 'string') { fact.codeUnits = value.length; fact.rawUtf8Bytes = new TextEncoder().encode(value).length; }
  list.push(fact);
  if (value !== null && typeof value === 'object') {
    fact.ownKeys = Object.keys(value);
    const prototype = Object.getPrototypeOf(value);
    fact.prototype = Array.isArray(value) ? 'Array.prototype' : prototype === Object.prototype ? 'Object.prototype' : 'specified-inherited';
    for (const key of Object.keys(value)) facts(value[key], path.concat(key), list);
    if (prototype !== Object.prototype && prototype !== Array.prototype) facts(prototype, path.concat('<prototype>'), list);
  }
  return list;
}
const shape = { records: 'ordinary-or-null-prototype', ownEnumerableDataOnly: true, completeKeys: true, exactScalars: true,
  exactArrayLengthAndOrder: true, noAttackerInheritanceOrGetters: true };
function checkFixtures() {
  equal([...refs.keys()].sort(), [...expectedIds].sort(), 'REFERENCE_COVERAGE');
  for (const [key, template] of Object.entries({ P, S, T, A, B, C, L, AUTH })) equal(BASE_RECORDS[key], template(), 'BASE_' + key);
  for (const checkId of expectedIds) {
    const reference = refs.get(checkId), [input, expected] = reference.create();
    const fixture = buildFixture(checkId), second = buildFixture(checkId);
    equal([fixture.checkId, fixture.helper, fixture.mode], [checkId, reference.helper, reference.mode], 'HELPER_MODE_' + checkId);
    raw(fixture.input, input, 'INPUT_' + checkId);
    const expectation = reference.kind === 'EQ' ? { kind: 'EQ', value: expected, shape: { ...shape } } :
      reference.kind === 'TE' ? { kind: 'TE', error: 'TypeError', genuineSubjectError: true } :
      reference.kind === 'API' ? { kind: 'API', exportName: 'sanitizeAgentConfig', own: true, type: 'function', subjectCall: false } :
      { kind: reference.kind, value: expected, property: 'cls' };
    if (checkId === id('14')) expectation.absentInheritedKeys = ['injected'];
    if (checkId === id('35')) expectation.absentInheritedKeys = ['benign'];
    if (checkId === id('15') || checkId === id('62') || checkId.startsWith(id('55.'))) expectation.absentInheritedKeys = ['evil'];
    if (checkId === id('15')) expectation.absentOrdinaryPrototypeKeys = ['evil'];
    raw(fixture.expectation, expectation, 'EXPECTATION_' + checkId);
    equal(fixture.preconditions, facts(input), 'PRECONDITIONS_' + checkId);
    check(validateFixture(fixture), 'VALID_FIXTURE_' + checkId);
    const firstObjects = objects(fixture), secondObjects = objects(second);
    check([...firstObjects].every(object => !secondObjects.has(object)), 'FRESH_' + checkId);
    const inputObjects = objects(fixture.input), expectedObjects = objects(fixture.expectation);
    check([...inputObjects].every(object => !expectedObjects.has(object)), 'INPUT_EXPECTATION_ISOLATION_' + checkId);
    if (checkId.match(/^REG-BASE-9[3-8]\./) || checkId.startsWith('REG-PATH-MEMORY-')) {
      equal(fixture.grounding, { commit: '776118f85c83dee6b70e9b86bf89e4d7b61bb6cc', path: 'extension/lib/archive-target-registry.js', sha256: '1ce244933686d562df369e08415b18ae6d9d70aa30a2ed3aadfefc48f74ccd85' }, 'GROUNDING_' + checkId);
      check(fixture.basis.startsWith('F'), 'GROUNDING_LINES_' + checkId);
    }
  }
}
function specialChecks() {
  equal([URL_DATA.MP.length, URL_DATA.PP.length, new TextEncoder().encode(URL_DATA.MP).length, new TextEncoder().encode(URL_DATA.PP).length], [25, 25, 25, 25], 'PREFIX_25');
  for (const [leaf, create, units, bytes] of [['23', overM, 32781, 65537], ['24', shrinkM, 65538, 65538],
    ['REG-PROVIDER-UTF8-OVER', overP, 5242893, 10485761], ['REG-PROVIDER-SHRINK', shrinkP, 10485762, 10485762]]) {
    const value = create();
    equal([value.length, new TextEncoder().encode(value).length], [units, bytes], 'RAW_FORMULA_' + leaf);
  }
  for (const [leaf, suffix] of [['06', [0xd800]], ['07', [0xdfff]], ['08', [0xd83d, 0xde00, 0xd800]], ['09', [0xd83d, 0xde00]], ['10', [0xfffd]]]) {
    const value = buildFixture(id(leaf)).input.slice('agent-workspaces/named-a/'.length);
    equal(Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)), suffix, 'CODE_UNITS_' + leaf);
  }
  // Explicit corruption checks cannot silently repair own undefined/inheritance.
  const ownUndefined = buildFixture('REG-MCP-URL-TYPE.undefined');
  check(Object.hasOwn(ownUndefined.input, 'url') && ownUndefined.input.url === undefined, 'OWN_UNDEFINED');
  delete ownUndefined.input.url;
  refuses(() => validateFixture(ownUndefined), 'FIXTURE_DESCRIPTOR');
  const inheritedURL = buildFixture('REG-MCP-OWN-URL');
  inheritedURL.input.url = inheritedURL.input.url;
  refuses(() => validateFixture(inheritedURL), 'FIXTURE_DESCRIPTOR');
  const badExpected = buildFixture(id('42')); badExpected.expectation.value.writer.mcpServers.reverse();
  refuses(() => validateFixture(badExpected), 'FIXTURE_DESCRIPTOR');
  const marker = buildFixture(id('55.map'));
  equal(Object.getOwnPropertyDescriptor(marker.input, '__proto__').value, B().reader, 'MAP_PROTO_READER');
  check(!Object.hasOwn(marker.expectation.value, '__proto__') && !Object.hasOwn(Object.prototype, 'evil'), 'PROTO_ABSENCE');
  const global = buildFixture(id('35'));
  const pd = Object.getOwnPropertyDescriptor(global.expectation.value, '__proto__');
  check(pd.enumerable && pd.writable && pd.configurable && pd.value.benign === 1 && !('benign' in global.expectation.value), 'GLOBAL_PROTO_DATA');
  const clone = buildFixture(id('55.provider')); clone.input.writer.provider.__proto__.evil = 2;
  equal(buildFixture(id('55.provider')).input.writer.provider.__proto__.evil, 1, 'MUTATION_ISOLATION');
  refuses(() => validateFixture(clone), 'FIXTURE_DESCRIPTOR');
}
checkSets();
for (const value of [BASE_RECORDS, URL_DATA, CATALOGUE, BASELINE_LEAF_IDS, REQUIRED_EDGES, FAULT_IDS, GROUNDING]) frozen(value);
checkFixtures();
specialChecks();
const runtime = typeof Deno === 'object' ? { name: 'deno', version: Deno.version.deno, v8: Deno.version.v8, typescript: Deno.version.typescript } :
  { name: 'node', version: process.versions.node, v8: process.versions.v8, typescript: null };
console.log(JSON.stringify({ developmentOnly: true, runtime, fixtureLeaves: expectedIds.length, requiredEdges: expectedEdges.length,
  faultIds: new Set(expectedEdges.map(e => e.faultId)).size, result: 'FIXTURE_GRAPH_CHECKS_PASS', productObservations: 0 }));
