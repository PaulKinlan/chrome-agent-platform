// @ts-nocheck — real-module r5 regressions, runnable by Node and the focused Deno runner.
import { deepStrictEqual, strictEqual as same, throws, ok } from "node:assert/strict";
import * as registry from "../extension/lib/archive-target-registry.js";
// Node's equality alone does not prove absence of attacker-inherited members.
function assertData(value) {
  if (value === null || typeof value !== "object") return;
  const proto = Object.getPrototypeOf(value);
  ok(Array.isArray(value) ? proto === Array.prototype : proto === Object.prototype || proto === null,
    "output record prototype must be ordinary or null");
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    ok(Object.hasOwn(descriptor, "value"), "output must contain data, not getters");
    assertData(descriptor.value);
  }
}
function eq(actual, expected) { assertData(actual); deepStrictEqual(actual, expected); }
const test = globalThis.Deno?.test ?? (await import("node:test")).test;
const { classifyOpfsPath: opfs, classifyKvKey: kv, sanitizeProviderConfig: provider,
  sanitizeMcpServer: mcp, sanitizeNamedAgents: named } = registry;
const origin = (value) => registry.sanitizeAgentConfig(value);
const P = () => ({ provider: "openai", baseURL: "https://api.example.test/v1", model: "model-1" });
const S = () => ({ id: "alpha", name: "Alpha", transport: "http", url: "https://mcp.example.test/mcp", enabled: true });
const T = () => ({ id: "beta", name: "Beta", transport: "http", url: "https://mcp.example.test/beta", enabled: false });
const A = () => ({ writer: { id: "writer", name: "Writer", instanceId: "d631d758-7304-4a5d-bf15-4f0c2436f91a", role: "Draft", skills: [], canDelegateTo: [], mcpServers: [] } });
const C = () => ({ name: "Site Bot", model: "kept-model", note: "kept-note" });
const L = () => ({ activeProvider: "legacy", providers: [{ id: "legacy", baseURL: "https://api.example.test/v1", model: "model-1" }] });
const auth = () => ({ headerName: "Authorization", token: "fixture-mcp-secret" });
const ownProto = (value, data = { evil: 1 }) => Object.defineProperty(value, "__proto__", { value: data, enumerable: true, configurable: true, writable: true });
const inherited = (key, value, own) => Object.assign(Object.create({ [key]: value }), own);
const without = (value, key) => { delete value[key]; return value; };
const withProvider = (p) => { const a = A(); a.writer.provider = p; return a; };
const withServers = (servers) => { const a = A(); a.writer.mcpServers = servers; return a; };
const ascii = (prefix, size) => prefix + "a".repeat(size - prefix.length);
const PP = "https://api.example.test/", MP = "https://mcp.example.test/";

// Observes native consumers only around subject work; all fixture allocation is outside.
function beforeParse(call, malformed = false, oversizedScalar, rawByteBound) {
  const NativeURL = globalThis.URL, encode = TextEncoder.prototype.encode, into = TextEncoder.prototype.encodeInto;
  let parsers = 0, encodes = 0, whole = 0;
  globalThis.URL = new Proxy(NativeURL, {
    construct(target, args) { parsers++; return Reflect.construct(target, args); },
    get(target, key) {
      if ((key === "parse" || key === "canParse") && typeof target[key] === "function") {
        return (...args) => { parsers++; return Reflect.apply(target[key], target, args); };
      }
      return Reflect.get(target, key);
    },
  });
  TextEncoder.prototype.encode = function (value) {
    encodes++; if (oversizedScalar !== undefined && value === oversizedScalar) whole++;
    return Reflect.apply(encode, this, [value]);
  };
  TextEncoder.prototype.encodeInto = function (value, dest) {
    // encodeInto may consume the full scalar with a bounded destination.
    encodes++; if (dest?.length > rawByteBound) whole++;
    return Reflect.apply(into, this, [value, dest]);
  };
  try { throws(call, TypeError); } finally {
    globalThis.URL = NativeURL;
    TextEncoder.prototype.encode = encode;
    TextEncoder.prototype.encodeInto = into;
  }
  same(parsers, 0, "refuse before native parser");
  same(whole, 0, "no oversized whole encoding");
  if (malformed) same(encodes, 0, "no encoding malformed field");
}

test("native consumer controls: real URL delegation and encoder brands", () => {
  const NativeURL = globalThis.URL;
  let constructs = 0;
  globalThis.URL = new Proxy(NativeURL, {
    construct(target, args) { constructs++; return Reflect.construct(target, args); },
  });
  try {
    eq(provider({ ...P(), baseURL: "HTTPS://API.EXAMPLE.TEST:443/a/../v1" }), P());
    eq(mcp({ ...S(), url: "HTTPS://MCP.EXAMPLE.TEST:443/a/../mcp" }), S());
    ok(constructs >= 2, "valid helpers delegate to native URL construction");
  } finally { globalThis.URL = NativeURL; }
  const encoder = new TextEncoder(), dest = new Uint8Array(4);
  const encodeInto = encoder.encodeInto;
  eq(encodeInto.call(encoder, "\ud83d\ude00", dest), { read: 2, written: 4 });
  eq([...dest], [240, 159, 152, 128]);
});

test("k42c: global OPFS well-formedness precedes every root classification", () => {
  for (const unit of ["\ud800", "\ud801", "\udfff", "\ud83d\ude00\ud800"]) {
    for (const path of [`agent-workspaces/named-a/${unit}`, `memory/master/note-${unit}.json`,
      `cap-skills/research/${unit}`, `cache/${unit}`, `usage/${unit}`, `tool-jobs/${unit}`,
      `wasm-tool-streams-v1/${unit}`, `chrome-agent-platform-private/${unit}`,
      `archive-transactions-v1/${unit}`, `.staging/${unit}`, `${unit}/file`]) {
      same(opfs(path).cls, "unclassified");
    }
  }
  for (const text of ["\ud83d\ude00", "\ufffd"]) {
    for (const path of [`agent-workspaces/named-a/${text}`, `memory/master/note-${text}.json`, `cap-skills/research/${text}`]) {
      same(opfs(path).cls, "portable-user-data");
    }
  }
});

test("4egg: actual master deny policy, not phantom KV or sibling", () => {
  same(opfs("memory/master/cap:board-deny-rules.json").cls, "portable-deny-union");
  same(kv("cap:board-deny-rules").cls, "unclassified");
  same(opfs("memory/master/cap:board-deny-rules").cls, "unclassified");
  for (const scope of ["origins/https%3A%2F%2Fexample.com", "agents/writer", "background/reader"]) {
    same(opfs(`memory/${scope}/cap:board-deny-rules.json`).cls, "portable-user-data");
  }
  for (const key of ["cap:hooksDeny", "cap:destructiveActionPolicy"]) same(kv(key).cls, "portable-deny-union");
  same(opfs("chrome-agent-platform-private/owner-approval-hmac-v1").cls, "internal-secret");
  same(opfs("owner-approval-hmac-v1").cls, "unclassified");
});

test("recursive filters preserve benign values, prototypes and nested KV lone units", () => {
  const nested = JSON.parse('{"\\ud800":"\\ud801","\\ud801":"\\udfff","replacement":"\ufffd","pair":"\ud83d\ude00"}');
  const benign = { constructor: "benign", prototype: "benign", tokenLimit: 4096, apiKeyPrefix: "sk-", note: "fixture-api-key", nested };
  for (const key of ["apiKey", "authToken", "clientSecret"]) {
    eq(provider({ ...P(), ...benign, [key]: "fixture-api-key" }), { ...P(), ...benign });
    const a = withProvider({ ...P(), [key]: "fixture-api-key" });
    a.writer[key] = "fixture-api-key";
    a.writer.tools = { lookup: { tokenLimit: 12, [key]: "fixture-api-key" } };
    const expected = withProvider(P()); expected.writer.tools = { lookup: { tokenLimit: 12 } };
    eq(named(a), expected);
    eq(origin({ ...C(), provider: { ...P(), [key]: "fixture-api-key" } }), { ...C(), provider: P() });
    const l = L(); l.providers[0][key] = "fixture-api-key"; eq(provider(l), L());
  }
  eq(provider(ownProto({ ...P(), nested: ownProto({ benign: 2 }) })), { ...P(), nested: { benign: 2 } });
  eq(origin(ownProto({ ...C(), constructor: "benign", prototype: "benign" })), { ...C(), constructor: "benign", prototype: "benign" });
  same(Object.prototype.evil, undefined);
});

const contexts = [
  { name: "flat", run: provider, wrap: (p) => p, limit: 10485760 },
  { name: "legacy", run: provider, wrap: (p) => ({ activeProvider: "legacy", providers: [{ id: "legacy", baseURL: p.baseURL, model: p.model }] }), limit: 10485760 },
  { name: "named", run: named, wrap: withProvider, limit: 512 },
  { name: "origin", run: origin, wrap: (p) => ({ ...C(), provider: p }), limit: 10485760 },
];
for (const ctx of contexts) {
  test(`provider endpoints ${ctx.name}: canonical, empty, unicode, exact identity`, () => {
    for (const [input, output] of [["", ""], ["HTTPS://API.EXAMPLE.TEST:443/a/../v1", P().baseURL],
      ["https://api.example.test/é", "https://api.example.test/%C3%A9"],
      [ascii(PP, ctx.limit), ascii(PP, ctx.limit)]]) {
      eq(ctx.run(ctx.wrap({ ...P(), baseURL: input })), ctx.wrap({ ...P(), baseURL: output }));
    }
  });
  test(`provider endpoints ${ctx.name}: types, components and schemes refuse`, () => {
    for (const baseURL of [null, undefined, [P().baseURL], { href: P().baseURL }, 17, true]) {
      const input = ctx.wrap({ ...P(), baseURL }); beforeParse(() => ctx.run(input), true);
    }
    for (const baseURL of ["https://u@api.example.test/v1", "https://:p@api.example.test/v1", "https://api.example.test/v1?tenant=a",
      "https://api.example.test/v1#frag", "ftp://api.example.test/v1", "file:///path", "http:///"]) {
      throws(() => ctx.run(ctx.wrap({ ...P(), baseURL })), TypeError);
    }
  });
  test(`provider endpoints ${ctx.name}: raw bounds before parse or oversized encoding`, () => {
    const values = [ascii(PP, ctx.limit + 1)];
    if (ctx.name !== "named") values.push(PP + "é".repeat(5242868), PP + "v1?x=" + "a".repeat(10485732));
    for (const baseURL of values) {
      const input = ctx.wrap({ ...P(), baseURL });
      // Named 512 is a UTF-16 code-unit guard, not a 512-byte budget.
      beforeParse(() => ctx.run(input), false, baseURL, 10485760);
    }
  });
}

test("current and embedded providers require own primitive identity and record containers", () => {
  for (const run of [provider, (p) => named(withProvider(p)), (p) => origin({ ...C(), provider: p })]) {
    for (const bad of [undefined, "openai", 17, true, [], without(P(), "provider"),
      inherited("provider", "openai", without(P(), "provider")), ...[null, undefined, [], {}, 17, true].map((provider) => ({ ...P(), provider }))]) {
      throws(() => run(bad), TypeError);
    }
  }
  throws(() => provider(null), TypeError); throws(() => origin({ ...C(), provider: null }), TypeError);
  eq(provider({ provider: "openai" }), { provider: "openai" });
  eq(named(withProvider(null)), withProvider(null));
});

test("legacy provider ID is nonempty, own, untrimmed and never a provider alias", () => {
  eq(provider(L()), L());
  const spaces = L(); spaces.activeProvider = spaces.providers[0].id = " "; eq(provider(spaces), spaces);
  eq(provider(without(L(), "activeProvider")), without(L(), "activeProvider"));
  for (const id of ["", undefined, null, [], {}, 17, true]) {
    const l = L(); l.providers[0].id = id; throws(() => provider(l), TypeError);
  }
  for (const record of [null, [], "bad", 17, without(L().providers[0], "id"),
    inherited("id", "legacy", without(L().providers[0], "id")),
    { ...L().providers[0], provider: "openai" }, { provider: "openai" }]) {
    throws(() => provider({ ...L(), providers: [record] }), TypeError);
  }
  for (const providers of [{}, null, "bad", undefined]) throws(() => provider({ ...L(), providers }), TypeError);
  throws(() => provider({ ...L(), provider: "openai" }), TypeError);
  for (const activeProvider of [null, undefined, 17, {}, [], true]) throws(() => provider({ ...L(), activeProvider }), TypeError);
});

test("MCP: native normalization, auth removal, rest parity and identity", () => {
  eq(mcp({ ...S(), auth: auth(), url: "https://u:p@mcp.example.test/mcp?tenant=a#frag" }), S());
  eq(mcp({ ...T(), auth: auth() }), T());
  eq(mcp({ ...S(), url: "https://mcp.example.test/api/日本語" }), { ...S(), url: "https://mcp.example.test/api/%E6%97%A5%E6%9C%AC%E8%AA%9E" });
  const rest = { description: "Docs", icon: "icon.png", customField: { kept: true }, apiKey: "benign-global-rest" };
  eq(mcp(ownProto({ ...S(), ...rest, auth: auth() }, { benign: 1 })), ownProto({ ...S(), ...rest }, { benign: 1 }));
  for (const transport of ["http", "sse"]) eq(mcp({ ...S(), transport }), { ...S(), transport });
});

test("MCP: missing own fields and malformed strings omit, nonprimitive fields throw", () => {
  for (const key of ["url", "transport"]) {
    same(mcp(without(S(), key)), null);
    same(mcp(inherited(key, S()[key], without(S(), key))), null);
    for (const bad of [null, undefined, 17, true, [S()[key]], { href: S().url }]) {
      beforeParse(() => mcp({ ...S(), [key]: bad }), true);
    }
  }
  for (const url of ["not a URL", "file:///path"]) same(mcp({ ...S(), url }), null);
  for (const transport of ["stdio", "pipe", "streamable-http", ""]) same(mcp({ ...S(), transport }), null);
});

test("MCP: UTF8 boundary and shrink attack are checked on raw input", () => {
  const url = ascii(MP, 65536); eq(mcp({ ...S(), url }), { ...S(), url });
  // Four-byte pairs and replacement characters use raw bytes, not percent-encoded length.
  const unicode = MP + "é".repeat(32753) + "\ud83d\ude00" + "a";
  eq(mcp({ ...S(), url: unicode }), { ...S(), url: MP + "%C3%A9".repeat(32753) + "%F0%9F%98%80a" });
  eq(mcp({ ...S(), url: MP + "\ufffd" }), { ...S(), url: MP + "%EF%BF%BD" });
  for (const url of [ascii(MP, 65537), MP + "é".repeat(32756), MP + "mcp?x=" + "a".repeat(65507)]) {
    beforeParse(() => mcp({ ...S(), url }), false, url, 65536);
    beforeParse(() => named(withServers([{ ...S(), url }])), false, url, 65536);
  }
});

test("named: map/agent/provider/tools/MCP proto removal and exact record identity", () => {
  const b = { reader: { id: "reader", name: "Reader", instanceId: "263503a1-4966-48cc-9185-f770aa31ea08", role: "Read", skills: [], canDelegateTo: [], mcpServers: [] } };
  eq(named({ ...A(), ...b }), { ...A(), ...b });
  eq(named(ownProto(A(), b.reader)), A());
  const agent = A(); ownProto(agent.writer); eq(named(agent), A());
  const tools = A(); tools.writer.tools = ownProto({ tokenLimit: 12 });
  const cleanTools = A(); cleanTools.writer.tools = { tokenLimit: 12 }; eq(named(tools), cleanTools);
  eq(named(withProvider(ownProto(P()))), withProvider(P()));
  eq(named(withServers([ownProto(S())])), withServers([S()]));
});

test("named: shared MCP sanitizer preserves order/duplicates, drops only malformed server", () => {
  eq(named(withServers([{ ...S(), auth: auth(), url: "https://u:p@mcp.example.test/mcp?tenant=a#frag" },
    { ...T(), url: "not a URL" }, T(), S()])), withServers([S(), T(), S()]));
  for (const bad of [[S().url], { href: S().url }, null, undefined, 17, true]) {
    beforeParse(() => named(withServers([{ ...S(), url: bad }])), true);
  }
  for (const transport of [{ type: "http", url: S().url, headers: { Authorization: "fixture-header-secret" } }, ["http"], 17, true]) {
    beforeParse(() => named(withServers([{ ...S(), transport }])), true);
  }
});

test("named and origin: malformed containers refuse, absent logical fields stay absent", () => {
  same(Object.hasOwn(registry, "sanitizeAgentConfig"), true); same(typeof registry.sanitizeAgentConfig, "function");
  for (const value of [null, [], "bad", 17]) {
    throws(() => named(value), TypeError); throws(() => origin(value), TypeError);
    throws(() => named({ writer: value }), TypeError);
  }
  for (const servers of [null, undefined, "not-an-array", {}]) throws(() => named(withServers(servers)), TypeError);
  const noServers = A(); delete noServers.writer.mcpServers;
  eq(named(noServers), noServers); eq(named(A()), A()); eq(named({}), {});
  eq(origin({}), {}); eq(origin({ name: "Site Bot" }), { name: "Site Bot" }); eq(origin(C()), C());
});

// Explicitly authorized non-JSON hardening, not additional r5 baseline leaves.
test("global MCP: nested rest copies keep all own data without attacker prototypes", () => {
  const customField = inherited("evil", 1, { kept: true, apiKey: "benign-global-rest" });
  ownProto(customField, { benign: 1 });
  eq(mcp({ ...S(), customField }), { ...S(), customField: ownProto({ kept: true, apiKey: "benign-global-rest" }, { benign: 1 }) });
});

test("global MCP: unsupported accessors reject without invoking getters", () => {
  for (const location of ["url", "customField", "nested", "array"]) {
    let calls = 0;
    const getter = { enumerable: true, get() { calls++; return "not archive data"; } };
    const server = S();
    if (location === "nested") server.customField = Object.defineProperty({}, "kept", getter);
    else if (location === "array") server.customField = Object.defineProperty([], "0", getter);
    else Object.defineProperty(server, location, getter);
    throws(() => mcp(server), TypeError);
    same(calls, 0, "never execute an accessor while copying data");
  }
});
