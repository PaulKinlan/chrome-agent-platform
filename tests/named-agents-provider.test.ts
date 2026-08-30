// tests/named-agents-provider.test.ts — the per-agent provider OVERRIDE.
//
// A named agent can have its OWN provider/model (a COMPLETE provider-specific
// config) that overrides the global. The override's apiKey must NEVER leak into
// a list/get (only the SW's model-resolution path reads it back). This drives
// the registry (kv) + the pure provider resolution without the OPFS sandbox.
// @ts-nocheck — the chrome/kv mock is intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  getNamedAgent,
  getNamedAgentProvider,
  listNamedAgents,
  normalizeAgentProvider,
  redactAgentProvider,
  setNamedAgentProvider,
} from "../extension/lib/named-agents.js";
import { getModelForAgent, resolveModelFromConfig } from "../extension/lib/provider.js";
import { kvSet } from "../extension/lib/kv.js";


const store = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
};

const COMPLETE = {
  provider: "deepseek",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test-not-a-real-key",
  model: "deepseek-chat",
};

Deno.test("per-agent provider: normalizeAgentProvider validates + normalizes", () => {
  const ok = normalizeAgentProvider(COMPLETE);
  assertEquals(ok.provider, "deepseek");
  assertEquals(ok.apiKey, "sk-test-not-a-real-key");
  // Unknown provider id → null (never mix an unknown endpoint with a credential).
  assertEquals(normalizeAgentProvider({ ...COMPLETE, provider: "not-a-provider" }), null);
  assertEquals(normalizeAgentProvider(null), null);
  assertEquals(normalizeAgentProvider(undefined), null);
});

Deno.test("per-agent provider: redactAgentProvider strips the apiKey", () => {
  const r = redactAgentProvider(COMPLETE);
  assertEquals(r.provider, "deepseek");
  assertEquals(r.model, "deepseek-chat");
  assert(!("apiKey" in r), "the redacted provider must never carry the apiKey");
});

Deno.test("per-agent provider: set + clear round-trips, and list/get are redacted", async () => {
  store.clear();
  // Seed the registry directly (no OPFS needed for the provider path).
  await kvSet({ "cap:namedAgents": { paul: { id: "paul", name: "Paul", role: "reader", createdAt: 1, updatedAt: 1 } } });

  const set = await setNamedAgentProvider("paul", COMPLETE);
  assert(set.ok, "setNamedAgentProvider must succeed");

  // The SW-only resolution path reads the FULL config (with the key).
  const full = await getNamedAgentProvider("paul");
  assertEquals(full.provider, "deepseek");
  assertEquals(full.apiKey, "sk-test-not-a-real-key");

  // The list/get surfaces are REDACTED (no key).
  const listed = await listNamedAgents();
  assertEquals(listed.length, 1);
  assert(!("apiKey" in (listed[0].provider ?? {})), "listNamedAgents must redact the key");
  const got = await getNamedAgent("paul");
  assert(!("apiKey" in (got.provider ?? {})), "getNamedAgent must redact the key");

  // null clears the override (inherit the global).
  await setNamedAgentProvider("paul", null);
  assertEquals(await getNamedAgentProvider("paul"), null);
});

Deno.test("per-agent provider: getModelForAgent resolves the override, else the global", async () => {
  // An override with a missing model id resolves to the provider's CATALOGUE
  // default (CAP-FB-20260830-MODEL-CATALOG-CURRENT-01) — never silently the
  // demo model when a recommended id exists.
  const resolved = await resolveModelFromConfig({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-x",
    model: "",
  });
  assertEquals(resolved.modelId, "deepseek-v4-flash");
  assertEquals(resolved.usingDefaultModel, true);
  assert(resolved.providerName.includes("deepseek"), "the resolution names the override provider");
  // A provider WITHOUT a catalogue (BYO endpoint) still needs an explicit id —
  // the demo fallback remains, and the providerName still names the override.
  const byo = await resolveModelFromConfig({
    provider: "openai-compatible",
    baseURL: "https://byo.example/v1",
    apiKey: "sk-x",
    model: "",
  });
  assertEquals(byo.modelId, "demo-local");
  assert(byo.providerName.includes("openai-compatible"), "the fallback names the override provider");

  // A null override → the global (demo) path (getModelForAgent falls back).
  const viaAgent = await getModelForAgent(null);
  assertEquals(viaAgent.modelId, "demo-local");
});

// ── k3 review fixes (2026-08-18) ────────────────────────────────────────────
  // Seed the registry directly (no OPFS needed for the provider path).
  const seed = (id) =>
    kvSet({ "cap:namedAgents": { [id]: { id, name: id, role: "", createdAt: 1, updatedAt: 1 } } });

Deno.test("k3 HIGH-1: a blank same-provider Save PRESERVES the stored key", async () => {
  store.clear();
  await seed("keeper");
  // The settings page routes through the SW — JSON serialization DROPS
  // `apiKey: undefined`, so the route receives a config with NO apiKey key.
  // The old code coerced that to "" and silently erased the stored key.
  await setNamedAgentProvider("keeper", {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-keep-me",
    model: "deepseek-chat",
  });
  const before = await getNamedAgentProvider("keeper");
  assertEquals(before.apiKey, "sk-keep-me");

  // Re-save the SAME provider with the key field blank: the serialized config
  // has no apiKey property at all (exactly what the SW route receives).
  const serialized = JSON.parse(JSON.stringify({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: undefined, // dropped by serialization
    model: "deepseek-v4-pro",
  }));
  assert(!("apiKey" in serialized), "serialization drops undefined apiKey (the HIGH-1 chain)");
  const r = await setNamedAgentProvider("keeper", serialized);
  assertEquals(r.ok, true);
  const after = await getNamedAgentProvider("keeper");
  assertEquals(after.apiKey, "sk-keep-me", "blank same-provider Save keeps the stored key");
  assertEquals(after.model, "deepseek-v4-pro", "the OTHER fields still update");

  // An EXPLICIT empty string still clears the key (the only removal path).
  await setNamedAgentProvider("keeper", {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
  });
  assertEquals((await getNamedAgentProvider("keeper")).apiKey, "", "explicit '' clears the key");
});

Deno.test("provider/model/key sentinels preserve on same-provider Save and stay isolated on swap", async () => {
  store.clear();
  await kvSet({ "cap:namedAgents": {
    alpha: { id: "alpha", name: "Alpha", role: "", createdAt: 1, updatedAt: 1 },
    beta: { id: "beta", name: "Beta", role: "", createdAt: 1, updatedAt: 1 },
  } });
  await setNamedAgentProvider("alpha", {
    provider: "deepseek", baseURL: "https://api.deepseek.com/v1",
    apiKey: "alpha-key-sentinel", model: "alpha-model-before",
  });
  await setNamedAgentProvider("beta", {
    provider: "openai", baseURL: "https://api.openai.com/v1",
    apiKey: "beta-key-sentinel", model: "beta-model-sentinel",
  });

  await setNamedAgentProvider("alpha", {
    provider: "deepseek", baseURL: "https://api.deepseek.com/v1",
    model: "alpha-custom-model-sentinel",
  });
  const preserved = await getNamedAgentProvider("alpha");
  assertEquals(preserved.provider, "deepseek");
  assertEquals(preserved.model, "alpha-custom-model-sentinel");
  assertEquals(preserved.apiKey, "alpha-key-sentinel", "omitted same-provider key is preserved");

  await setNamedAgentProvider("alpha", {
    provider: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "", model: "gemini-model-sentinel",
  });
  const swapped = await getNamedAgentProvider("alpha");
  const isolated = await getNamedAgentProvider("beta");
  assertEquals(swapped.provider, "gemini");
  assertEquals(swapped.model, "gemini-model-sentinel");
  assertEquals(swapped.apiKey, "", "a provider swap cannot inherit the old provider key");
  assertEquals(isolated.apiKey, "beta-key-sentinel", "another agent's key remains isolated");
  assertEquals(isolated.model, "beta-model-sentinel", "another agent's model remains isolated");
});

Deno.test("k3 HIGH-1: set-provider's RESULT is redacted (no apiKey crosses back)", async () => {
  store.clear();
  await seed("redact-probe");
  const r = await setNamedAgentProvider("redact-probe", {
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "sk-never-echo",
    model: "gpt-5.6-sol",
  });
  assertEquals(r.ok, true);
  assert(!("apiKey" in (r.agent?.provider ?? {})), "the returned agent's provider has no apiKey");
});

Deno.test("k3 HIGH-2: openai-compatible is a first-class provider everywhere", async () => {
  // The Settings page offers it — normalize must ACCEPT it (it silently
  // returned null before, clearing a saved override on every Save).
  const ok = normalizeAgentProvider({
    provider: "openai-compatible",
    baseURL: "https://my-endpoint.example/v1",
    apiKey: "sk-byo",
    model: "my-model",
  });
  assertEquals(ok?.provider, "openai-compatible");
  assertEquals(ok?.baseURL, "https://my-endpoint.example/v1");

  // Global resolution: it must NOT fall through to demo once configured.
  const resolved = await resolveModelFromConfig({
    provider: "openai-compatible",
    baseURL: "https://my-endpoint.example/v1",
    apiKey: "sk-byo",
    model: "my-model",
  });
  assertEquals(resolved.modelId, "my-model", "a configured openai-compatible resolves");
  assertEquals(resolved.providerName, "openai-compatible");

  // And an UNCONFIGURED one degrades honestly (demo fallback, named reason).
  const missing = await resolveModelFromConfig({
    provider: "openai-compatible",
    baseURL: "",
    apiKey: "",
    model: "",
  });
  assertEquals(missing.modelId, "demo-local");
  assert(missing.providerName.includes("missing"), "the fallback names what is missing");

  // The override round-trips (not silently dropped).
  store.clear();
  await seed("byo");
  await setNamedAgentProvider("byo", ok);
  const stored = await getNamedAgentProvider("byo");
  assertEquals(stored?.provider, "openai-compatible");
  assertEquals(stored?.model, "my-model");
});

Deno.test("k3 LOW: the gemini cloud catalogue excludes on-device nano ids", async () => {
  const { modelsForVendor } = await import("../extension/lib/model-prices.js");
  const gemini = modelsForVendor("gemini");
  assert(!gemini.some((m) => m.includes("nano")), "no gemini-nano ids in the cloud catalogue");
  assert(!gemini.some((m) => m.includes("prompt-api")), "no prompt-api ids in the cloud catalogue");
  assert(gemini.length > 0, "the real cloud models remain");
});

// ── review a258f814: bump regression — unmodified script, complete mirror,
//    --message, canonical+bundled changelog equality, all version surfaces,
//    and a controlled-failure atomicity check. ──
Deno.test("bump-version: unmodified script in a complete scratch mirror (--message; canonical + bundled changelog + all version surfaces)", async () => {
  const fsQ = "node:fs/promises", pathQ = "node:path", osQ = "node:os", cpQ = "node:child_process";
  const fsp = await import(fsQ);
  const path = (await import(pathQ)).default;
  const os = await import(osQ);
  const { execFileSync } = await import(cpQ);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cap-bump2-"));
  try {
    // COMPLETE mirror: the real scripts/ dir (bump + sync-changelog), package,
    // lock, manifest, changelog, extension/ — no rewrites of the script.
    const repoScripts = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts");
    await fsp.mkdir(path.join(dir, "scripts"), { recursive: true });
    for (const f of ["bump-version.mjs", "sync-changelog.mjs"]) {
      await fsp.copyFile(path.join(repoScripts, f), path.join(dir, "scripts", f));
    }
    await fsp.mkdir(path.join(dir, "extension"), { recursive: true });
    await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.2.3" }, null, 2));
    await fsp.writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ name: "t", version: "1.2.3", packages: { "": { name: "t", version: "1.2.3" } } }, null, 2));
    await fsp.writeFile(path.join(dir, "extension", "manifest.json"), JSON.stringify({ manifest_version: 3, version: "1.2.3", version_name: "1.2.3" }, null, 2));
    const changelog = "# Changelog\n\n## [1.2.3] — 2026-01-01\n- init\n";
    await fsp.writeFile(path.join(dir, "CHANGELOG.md"), changelog);
    await fsp.writeFile(path.join(dir, "extension", "CHANGELOG.md"), changelog);
    // Run the UNMODIFIED bump script WITH --message.
    execFileSync("node", [path.join(dir, "scripts", "bump-version.mjs"), "patch", "--message", "test: the fix"], { cwd: dir, stdio: "pipe" });
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8"));
    const lock = JSON.parse(await fsp.readFile(path.join(dir, "package-lock.json"), "utf8"));
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, "extension", "manifest.json"), "utf8"));
    assertEquals(pkg.version, "1.2.4", "package");
    assertEquals(lock.version, "1.2.4", "lock root");
    assertEquals(lock.packages[""].version, "1.2.4", "lock packages[\"\"]");
    assertEquals(manifest.version, "1.2.4", "manifest.version");
    assertEquals(manifest.version_name, "1.2.4", "manifest.version_name");
    // canonical changelog: exactly one 1.2.4 entry with the message
    const canon = await fsp.readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((canon.match(/## \[1\.2\.4\]/g) ?? []).length, 1, "one canonical entry");
    assert(canon.includes("test: the fix"), "message present");
    // bundled changelog: byte-equal to canonical
    const bundled = await fsp.readFile(path.join(dir, "extension", "CHANGELOG.md"), "utf8");
    assertEquals(bundled, canon, "bundled == canonical (byte equality)");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

Deno.test("bump-version: controlled failure leaves NO partial write (atomicity)", async () => {
  const fsQ = "node:fs/promises", pathQ = "node:path", osQ = "node:os", cpQ = "node:child_process";
  const fsp = await import(fsQ);
  const path = (await import(pathQ)).default;
  const os = await import(osQ);
  const { spawnSync } = await import(cpQ);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cap-bump3-"));
  try {
    const repoScripts = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts");
    await fsp.mkdir(path.join(dir, "scripts"), { recursive: true });
    for (const f of ["bump-version.mjs", "sync-changelog.mjs"]) {
      await fsp.copyFile(path.join(repoScripts, f), path.join(dir, "scripts", f));
    }
    await fsp.mkdir(path.join(dir, "extension"), { recursive: true });
    await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.2.3" }, null, 2));
    // NO package-lock, NO manifest, NO changelog → the bump must FAIL (readJson
    // of manifest throws) WITHOUT having bumped package.json (write ordering:
    // all reads precede all writes).
    const before = await fsp.readFile(path.join(dir, "package.json"), "utf8");
    const r = spawnSync("node", [path.join(dir, "scripts", "bump-version.mjs"), "patch"], { cwd: dir, stdio: "pipe" });
    assertEquals(r.status !== 0, true, "bump fails on the incomplete mirror");
    const after = await fsp.readFile(path.join(dir, "package.json"), "utf8");
    assertEquals(after, before, "package.json UNCHANGED (no partial write)");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
