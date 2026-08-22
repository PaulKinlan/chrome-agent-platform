// Adversarial tests for the shipped-code scanner (scripts/scan-shipped.mjs):
// every export/oracle bypass form + parse failure + the scoped __zod/__vite
// exemption must be caught (or, for the exemption, correctly allowed only inside
// a generated dependency bundle).

// @ts-nocheck — the injected readText shim + acorn types are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { scanShippedJs } from "../scripts/scan-shipped.mjs";

async function withTemp(name, code) {
  const dir = await Deno.makeTempDir({ prefix: "scan-test-" });
  const file = `${dir}/${name}`;
  await Deno.writeTextFile(file, code);
  return { dir, file };
}

async function violations(code, opts) {
  const { dir, file } = await withTemp("case.js", code);
  try {
    return await scanShippedJs([file], {
      readText: (f) => Deno.readTextFile(f),
      ...(opts ?? {}),
    });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("scan: export default function __reset(){} is caught", async () => {
  const v = await violations(`export default function __reset() {}`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes("default-exports"), true);
});

Deno.test("scan: export default class __reset {} is caught", async () => {
  const v = await violations(`export default class __reset {}`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes("default-exports"), true);
});

Deno.test("scan: export default __x (identifier) is caught", async () => {
  const v = await violations(`const __x = 1; export default __x;`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes("default-exports"), true);
});

Deno.test("scan: export { x as __y } alias is caught", async () => {
  const v = await violations(`const x = 1; export { x as __y };`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes("exports `__y`"), true);
});

Deno.test("scan: export const __z = 1 is caught", async () => {
  const v = await violations(`export const __z = 1;`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes("exports `__z`"), true);
});

Deno.test("scan: window.__oracle = 1 is caught", async () => {
  const v = await violations(`window.__oracle = 1;`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes('window["__oracle"]'), true);
});

Deno.test("scan: globalThis[`__reset`] (template literal) is caught", async () => {
  const v = await violations("globalThis[`__reset`] = 1;");
  assertEquals(v.length, 1);
  assertEquals(v[0].includes('globalThis["__reset"]'), true);
});

Deno.test('scan: self["__" + "reset"] (folded string concat) is caught', async () => {
  const v = await violations(`self["__" + "reset"] = 1;`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes('self["__reset"]'), true);
});

Deno.test("scan: globalThis.__zodResetForTest in SOURCE is caught (no exemption outside bundles)", async () => {
  const v = await violations(`globalThis.__zodResetForTest = 1;`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes("__zodResetForTest"), true);
});

Deno.test("scan: globalThis.__zod_ok is ALLOWED only inside a generated bundle", async () => {
  // Without the generated-bundle scope → violation.
  const v1 = await violations(`globalThis.__zod_ok = 1;`);
  assertEquals(v1.length, 1);
  // With the generated-bundle scope → allowed.
  const { dir, file } = await withTemp("bundle.js", `globalThis.__zod_ok = 1;`);
  const v2 = await scanShippedJs([file], {
    readText: (f) => Deno.readTextFile(f),
    generatedBundles: new Set([file]),
  });
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  assertEquals(v2.length, 0);
});

Deno.test("scan: remote static/dynamic/importScripts script URLs are caught", async () => {
  const staticImport = await violations(`import "https://evil.example/x.js";`);
  assertEquals(
    staticImport.some((row) => row.includes("remote script URL")),
    true,
  );
  const dynamicImport = await violations(
    `await import("//evil.example/x.js");`,
  );
  assertEquals(
    dynamicImport.some((row) => row.includes("remote script URL")),
    true,
  );
  const imported = await violations(
    `importScripts("https://evil.example/x.js");`,
  );
  assertEquals(
    imported.some((row) => row.includes("package-local literal")),
    true,
  );
  const indirect = await violations(`importScripts(scriptUrl);`);
  assertEquals(
    indirect.some((row) => row.includes("package-local literal")),
    true,
  );
});

Deno.test("scan: remote src assignments are caught", async () => {
  const assigned = await violations(
    `script.src = "https://evil.example/x.js";`,
  );
  assertEquals(assigned.some((row) => row.includes("remote script URL")), true);
  const attribute = await violations(
    `script.setAttribute("src", "//evil.example/x.js");`,
  );
  assertEquals(
    attribute.some((row) => row.includes("remote script URL")),
    true,
  );
  const tainted = await violations(
    `const loader = document.createElement("script"); loader.src = "https://evil.example/x.js";`,
  );
  assertEquals(tainted.some((row) => row.includes("remote script URL")), true);
});

Deno.test("scan: Worker policy rejects dynamic, remote and alternate literals", async () => {
  const dynamic = await violations(`new Worker(workerUrl);`);
  assertEquals(
    dynamic.some((row) => row.includes("URL is not a literal")),
    true,
  );
  const remote = await violations(`new Worker("https://evil.example/w.js");`);
  assertEquals(remote.some((row) => row.includes("not allowlisted")), true);
  const alternate = await violations(`new Worker("alternate-worker.js");`);
  assertEquals(alternate.some((row) => row.includes("not allowlisted")), true);

  const { dir, file } = await withTemp(
    "worker.js",
    `new Worker("reviewed-worker.js");`,
  );
  const allowed = await scanShippedJs([file], {
    readText: (value) => Deno.readTextFile(value),
    allowedWorkerLiterals: new Set(["reviewed-worker.js"]),
  });
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  assertEquals(allowed, []);
});

Deno.test("scan: a parse failure is a violation", async () => {
  const v = await violations(`export default function {`);
  assertEquals(v.length, 1);
  assertEquals(v[0].includes("not parseable"), true);
});

Deno.test("scan: a clean file has zero violations", async () => {
  const v = await violations(
    `export const ok = 1; const fine = () => 2; globalThis.__internalLib = 3;`,
  );
  // __internalLib is NOT zod/vite — but it IS a __-prefixed global access, so it
  // is a violation. Use a truly clean file instead.
  const v2 = await violations(
    `export const ok = 1; export function fine() { return 2; }`,
  );
  assertEquals(v2.length, 0);
});

// ── canonical exemption path matcher (CAP-FB-20260822-WASM-EXECUTION-HOST-01) ──
// The Store pipeline passes ABSOLUTE source paths, so the scanner-owned
// canonical exemptions must bind to the exact normalized repo tail — accepting
// the absolute form and rejecting lookalikes/suffix tricks.

const EXECUTION_CANONICAL_REL = "extension/lib/wasm-execution-worker.js";
const WORKER_CANONICAL_REL = "extension/lib/wasm-executor.js";

async function realCanonicalContents() {
  const workerJs = await Deno.readTextFile(
    new URL("../extension/lib/wasm-execution-worker.js", import.meta.url),
  );
  const executorJs = await Deno.readTextFile(
    new URL("../extension/lib/wasm-executor.js", import.meta.url),
  );
  return { workerJs, executorJs };
}

Deno.test("scan: BOTH canonical exemptions accept the ABSOLUTE repo-tail path (Store pipeline shape)", async () => {
  const { workerJs, executorJs } = await realCanonicalContents();
  const absWorker = `/some/repo/root/${EXECUTION_CANONICAL_REL}`;
  const absExecutor = `/some/repo/root/${WORKER_CANONICAL_REL}`;
  const vWorker = await scanShippedJs([absWorker], {
    readText: async () => workerJs,
  });
  assertEquals(vWorker.length, 0, "absolute canonical worker path with the exact Wasm shape is clean");
  const vExecutor = await scanShippedJs([absExecutor], {
    readText: async () => executorJs,
  });
  assertEquals(vExecutor.length, 0, "absolute canonical executor path with the exact worker node is clean");
});

Deno.test("scan: BOTH canonical exemptions accept the RELATIVE form (regression)", async () => {
  const { workerJs, executorJs } = await realCanonicalContents();
  const vWorker = await scanShippedJs([EXECUTION_CANONICAL_REL], {
    readText: async () => workerJs,
  });
  assertEquals(vWorker.length, 0, "relative canonical worker path stays clean");
  const vExecutor = await scanShippedJs([WORKER_CANONICAL_REL], {
    readText: async () => executorJs,
  });
  assertEquals(vExecutor.length, 0, "relative canonical executor path stays clean");
});

Deno.test("scan: lookalike/suffix paths NEVER inherit the canonical exemptions", async () => {
  const { workerJs, executorJs } = await realCanonicalContents();
  // Execution-host lookalikes: same exact bytes, hostile path shapes.
  const workerLookalikes = [
    `/repo/${EXECUTION_CANONICAL_REL}.evil`,
    `/repo/${EXECUTION_CANONICAL_REL}.bak`,
    `/repo/xx${EXECUTION_CANONICAL_REL}`, // prefix segment trick
    `/repo/not-extension/lib/wasm-execution-worker.js`,
    `/repo/extension/lib/other-wasm-execution-worker.js`, // different filename
    `/repo/extension/lib/wasm-execution-worker.js\u0000x`, // NUL injection
  ];
  for (const file of workerLookalikes) {
    const v = await scanShippedJs([file], { readText: async () => workerJs });
    assert(v.length >= 1, `execution-host lookalike ${JSON.stringify(file)} must violate`);
  }
  // Worker-host lookalikes: same exact bytes (the canonical executor file),
  // hostile path shapes — the one non-literal `new Worker` must be flagged.
  const workerHostLookalikes = [
    `/repo/${WORKER_CANONICAL_REL}.evil`,
    `/repo/${WORKER_CANONICAL_REL}/..`, // resolves away from the canonical file
    `/repo/xx${WORKER_CANONICAL_REL}`,
    `/repo/extension/lib/not-wasm-executor.js`,
    `/repo/extension/lib/wasm-executor.js\u0000x`,
  ];
  for (const file of workerHostLookalikes) {
    const v = await scanShippedJs([file], { readText: async () => executorJs });
    assert(v.length >= 1, `worker-host lookalike ${JSON.stringify(file)} must violate`);
  }
});
