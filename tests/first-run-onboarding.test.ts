// @ts-nocheck — browser permission and storage APIs are intentionally mocked.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  credentialNeedsDurableStorage,
  firstRunGuideState,
  keyedProviderConfigured,
  loadFirstRunGuideState,
  requestStorageFromOwnerClick,
  requestBrowserControlFromOwnerClick,
} from "../extension/lib/first-run-onboarding.js";
import { freshKv } from "./test-hooks.js";

Deno.test("first run: credential warning is required before an ungranted key can be accepted", () => {
  assert(
    credentialNeedsDurableStorage({
      enteredKey: "secret",
      storageGranted: false,
    }),
  );
  assertEquals(
    credentialNeedsDurableStorage({ enteredKey: "", storageGranted: false }),
    false,
  );
  assertEquals(
    credentialNeedsDurableStorage({
      enteredKey: "secret",
      storageGranted: true,
    }),
    false,
  );
});

Deno.test("first run: storage request requires a genuine active owner click", async () => {
  const calls = [];
  const permissionsApi = {
    request: (value) => {
      calls.push(value);
      return Promise.resolve(true);
    },
  };
  assertEquals(
    (await requestStorageFromOwnerClick({
      event: { isTrusted: false },
      userActivation: { isActive: true },
      permissionsApi,
    })).reason,
    "owner-click-required",
  );
  assertEquals(
    (await requestStorageFromOwnerClick({
      event: { isTrusted: true },
      userActivation: { isActive: false },
      permissionsApi,
    })).reason,
    "owner-click-required",
  );
  assertEquals(calls.length, 0);

  const accepted = await requestStorageFromOwnerClick({
    event: { isTrusted: true },
    userActivation: { isActive: true },
    permissionsApi,
  });
  assertEquals(accepted, { granted: true, requested: true, reason: "granted" });
  assertEquals(calls, [{ permissions: ["storage"] }]);
});

Deno.test("first run: zero-permission boot remains clean when every authority is unavailable", async () => {
  const state = await loadFirstRunGuideState({
    containsStorage: () => {
      throw new Error("permission unavailable");
    },
    readProvider: () => Promise.reject(new Error("worker starting")),
    listArtifacts: () => Promise.reject(new Error("worker starting")),
    dismissed: false,
  });
  assertEquals(state, {
    storageGranted: false,
    providerReady: false,
    hasArtifact: false,
    show: true,
    canSeedTask: false,
    browserControlGranted: false,
    browserControlChoice: "unselected",
  });
});

Deno.test("first run: redacted setup readiness requires a complete keyed network provider", () => {
  assertEquals(keyedProviderConfigured({ provider: "demo" }), false);
  assertEquals(
    keyedProviderConfigured({
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-test",
    }),
    false,
  );
  assertEquals(
    keyedProviderConfigured({
      provider: "openai",
      baseURL: "https://api.openai.com/v1",
      apiKey: "key",
      model: "gpt-test",
    }),
    true,
  );
});

Deno.test("first run: guide enables the starter only after durable keyed provider setup and ends at a real artifact", () => {
  const ready = firstRunGuideState({
    storageGranted: true,
    providerConfig: { provider: "openai", hasApiKey: true, model: "gpt-test" },
    assets: [],
  });
  assertEquals(ready.canSeedTask, true);
  assertEquals(ready.show, true);
  const complete = firstRunGuideState({
    storageGranted: true,
    providerConfig: { provider: "openai", hasApiKey: true, model: "gpt-test" },
    assets: [{ id: "first-artifact" }],
  });
  assertEquals(complete.show, false);
});

Deno.test("first run: session-only key is lost across a worker-module restart", async () => {
  globalThis.chrome = {};
  const firstWorker = await freshKv();
  await firstWorker.kvSet({
    providerConfig: { provider: "openai", apiKey: "session-key" },
  });
  assertEquals(
    (await firstWorker.kvGet("providerConfig")).providerConfig.apiKey,
    "session-key",
  );

  const restartedWorker = await freshKv();
  assertEquals(
    (await restartedWorker.kvGet("providerConfig")).providerConfig,
    undefined,
  );
});

Deno.test("first run: storage-backed key survives a worker-module restart", async () => {
  const persistent = new Map();
  globalThis.chrome = {
    permissions: { contains: async () => true },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const key of (Array.isArray(keys) ? keys : [keys])) {
            if (persistent.has(key)) {
              out[key] = structuredClone(persistent.get(key));
            }
          }
          return out;
        },
        set: async (values) => {
          for (const [key, value] of Object.entries(values)) {
            persistent.set(key, structuredClone(value));
          }
        },
        remove: async (keys) => {
          for (const key of (Array.isArray(keys) ? keys : [keys])) {
            persistent.delete(key);
          }
        },
      },
    },
  };
  const firstWorker = await freshKv();
  await firstWorker.kvSet({
    providerConfig: { provider: "openai", apiKey: "durable-key" },
  });
  const restartedWorker = await freshKv();
  assertEquals(
    (await restartedWorker.kvGet("providerConfig")).providerConfig.apiKey,
    "durable-key",
  );
});

Deno.test("first run: permissionless storage is informational, not an error-console warning", async () => {
  globalThis.chrome = {};
  const kv = await freshKv();
  const originalWarn = console.warn;
  const originalInfo = console.info;
  let warnings = 0;
  let infos = 0;
  console.warn = () => {
    warnings += 1;
  };
  console.info = () => {
    infos += 1;
  };
  try {
    await kv.kvGet("providerConfig");
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
  assertEquals(warnings, 0);
  assertEquals(infos, 1);
});

Deno.test("first run: shared setup components use native labelled controls and restore the next action", async () => {
  const source = await Deno.readTextFile(
    new URL("../extension/shared/components.js", import.meta.url),
  );
  for (
    const marker of [
      'customElements.define("first-run-guide"',
      'customElements.define("storage-durability-warning"',
      'type="button" aria-label="Dismiss first-run setup"',
      'class="primary seed-task" type="button"',
      'role="alert"',
      "focusNextAction()",
      ":focus-visible",
    ]
  ) {
    assert(
      source.includes(marker),
      `missing accessible onboarding marker: ${marker}`,
    );
  }
});

Deno.test("first run: options blocks session-only credentials before provider.set and exposes only optional storage", async () => {
  const source = await Deno.readTextFile(
    new URL("../extension/options/options.js", import.meta.url),
  );
  const binding = source.indexOf("bindProviderSetDefault({");
  const guard = source.indexOf(
    "blockSessionOnlyCredentialSave(credentialInput, durabilityWarning)",
    binding,
  );
  const hostRequest = source.indexOf(
    "requestHostAccess: requestProviderHostAccess",
    guard,
  );
  assert(
    binding >= 0 && guard > binding && hostRequest > guard,
    "durability guard must be installed before the provider save/request path",
  );
  const helper = await Deno.readTextFile(
    new URL("../extension/lib/provider-options-save.js", import.meta.url),
  );
  const bindStart = helper.indexOf("export function bindProviderSetDefault");
  const helperGuard = helper.indexOf("shouldBlock?.(sourceEvent)", bindStart);
  const helperSave = helper.indexOf(
    "const outcome = await saveProviderFromCard",
    bindStart,
  );
  assert(
    bindStart >= 0 && helperGuard > bindStart && helperSave > helperGuard,
    "the synchronous durability guard must run before provider persistence",
  );
  assert(source.includes("requestStorageFromOwnerClick"));
  assert(source.includes("event.detail?.sourceEvent"));

  const manifest = JSON.parse(
    await Deno.readTextFile(
      new URL("../extension/manifest.json", import.meta.url),
    ),
  );
  assertEquals(manifest.permissions, []);
  assert(manifest.optional_permissions.includes("storage"));
});

Deno.test("first run: browser control request requires a genuine active owner click", async () => {
  const calls = [];
  const permissionsApi = {
    request: (value) => {
      calls.push(value);
      return Promise.resolve(true);
    },
  };
  assertEquals(
    (await requestBrowserControlFromOwnerClick({
      event: { isTrusted: false },
      userActivation: { isActive: true },
      permissionsApi,
    })).reason,
    "owner-click-required",
  );
  assertEquals(
    (await requestBrowserControlFromOwnerClick({
      event: { isTrusted: true },
      userActivation: { isActive: false },
      permissionsApi,
    })).reason,
    "owner-click-required",
  );
  assertEquals(
    (await requestBrowserControlFromOwnerClick({
      event: { isTrusted: true },
      userActivation: { isActive: true },
      permissionsApi,
    })).granted,
    true,
  );
  assertEquals(calls, [{ permissions: ["tabs"] }]);
});

Deno.test("first run: browser control consent state reflects granted, declined, and unselected states", () => {
  const unselected = firstRunGuideState({
    storageGranted: true,
    providerConfig: { provider: "openai", configured: true },
    browserControlGranted: false,
    browserControlChoice: "unselected",
  });
  assertEquals(unselected.browserControlGranted, false);
  assertEquals(unselected.browserControlChoice, "unselected");
  assertEquals(unselected.canSeedTask, true); // product remains usable

  const granted = firstRunGuideState({
    storageGranted: true,
    providerConfig: { provider: "openai", configured: true },
    browserControlGranted: true,
    browserControlChoice: "granted",
  });
  assertEquals(granted.browserControlGranted, true);
  assertEquals(granted.browserControlChoice, "granted");

  const declined = firstRunGuideState({
    storageGranted: true,
    providerConfig: { provider: "openai", configured: true },
    browserControlGranted: false,
    browserControlChoice: "declined",
  });
  assertEquals(declined.browserControlGranted, false);
  assertEquals(declined.browserControlChoice, "declined");
  assertEquals(declined.canSeedTask, true); // product remains fully usable in reduced capability mode
});

Deno.test("first run: component template contains truthful browser control consent copy and Settings revisit link", async () => {
  const source = await Deno.readTextFile(
    new URL("../extension/shared/components.js", import.meta.url),
  );
  const ntpSource = await Deno.readTextFile(
    new URL("../extension/ntp/ntp.js", import.meta.url),
  );
  assert(
    source.includes("Browser control (optional)"),
    "guide must label browser control as optional",
  );
  assert(
    source.includes("You can change this choice any time in Settings → Browser control."),
    "guide must state that choice is revisitable in Settings",
  );
  assert(
    source.includes("inspect tab URLs and titles (reading page content requires separate per-origin site enrollment)"),
    "guide must truthfully explain what browser control means and that page content needs site enrollment",
  );
  assert(
    source.includes("grant-browser"),
    "guide must provide grant button",
  );
  assert(
    source.includes("decline-browser"),
    "guide must provide decline button",
  );
  assert(
    ntpSource.includes("requestBrowserControlFromOwnerClick"),
    "ntp.js must wire the tested requestBrowserControlFromOwnerClick gesture helper",
  );
});
