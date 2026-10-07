import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { registerWasmPackageAdmissionHost } from "../extension/lib/wasm-package-admission.js";

// chrome-agent-platform-ltkj.2 review F1 (REJECT finding): the admission host
// must accept messages ONLY from the trusted service worker — the preview-host
// fence. A same-extension, non-tab sender that is NOT the SW (e.g. another
// extension document) must be denied before any admission context is built;
// without the isTrustedServiceWorkerSender leg such a sender passes the bare
// id/tab checks and reaches the admission path, bypassing the SW's exact
// Settings-document check that fronts the forwarded route.

const EXT_ID = "lkjfiiiiiiiiiiiiiiiilikjf";
const SW_PATH = "dist/background/service-worker.js";

const makeRuntime = () => {
  const listeners: unknown[] = [];
  return {
    id: EXT_ID,
    getURL: (p: string) => `chrome-extension://${EXT_ID}/${p}`,
    getManifest: () => ({ background: { service_worker: SW_PATH } }),
    onMessage: {
      addListener: (fn: unknown) => void listeners.push(fn),
      hasListeners: () => listeners.length > 0,
    },
    __listeners: listeners,
  };
};

const deliver = (runtime: ReturnType<typeof makeRuntime>, message: unknown, sender: unknown) => {
  let responded: unknown = undefined;
  let respondedFlag = false;
  for (const fn of runtime.__listeners as ((m: unknown, s: unknown, r: (x: unknown) => void) => unknown)[]) {
    const keepOpen = fn(message, sender, (x: unknown) => {
      responded = x;
      respondedFlag = true;
    });
    if (respondedFlag) return { response: responded, keepOpen };
  }
  return { response: undefined, keepOpen: undefined, delivered: false } as { response: unknown; keepOpen?: unknown };
};

Deno.test("admission host: a non-SW extension document sender is denied before any admission context (review F1)", () => {
  const runtime = makeRuntime();
  const unregister = registerWasmPackageAdmissionHost({ runtime: runtime as never });
  assert(typeof unregister === "function", "host registers against the mock runtime");

  // Same extension id, no tab — but the URL is an options document, not the SW
  // bundle. This is exactly the sender shape the bare id/tab checks accepted.
  const rogue = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options/options.html` };
  const { response } = deliver(runtime, { type: "wasm.package.options.validate", packageId: "cap.acceptance.a0.numeric", version: "1.0.0" }, rogue);
  assertEquals(
    (response as { ok?: boolean; error?: string } | undefined)?.error,
    "wasm package admission host denied: sender is not the service worker",
    "a non-SW extension document must be refused with the sender denial — reaching any admission error instead means the fence is open",
  );

  if (typeof unregister === "function") unregister();
});

Deno.test("admission host: the trusted SW sender passes the fence (positive control)", () => {
  const runtime = makeRuntime();
  const unregister = registerWasmPackageAdmissionHost({ runtime: runtime as never });

  const sw = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/${SW_PATH}` };
  const { response } = deliver(runtime, { type: "wasm.package.options.validation-list" }, sw);
  const err = (response as { ok?: boolean; error?: string } | undefined)?.error ?? "";
  assert(
    !err.includes("sender is not the service worker"),
    `the SW sender must clear the sender fence (got: ${err})`,
  );

  if (typeof unregister === "function") unregister();
});

// Guard the guard: this file's fence test must target the REAL SW path shape.
Deno.test("admission host: the fence test's SW path matches the runtime's declared service worker", () => {
  // If SERVICE_WORKER_BUNDLE_PATH ever moves, the positive control above would
  // silently degrade into a second negative test. Bind the literal here.
  const pure = Deno.readTextFileSync(fileURLToPath(new URL("../extension/lib/pure.js", import.meta.url)));
  assert(pure.includes('export const SERVICE_WORKER_BUNDLE_PATH = "dist/background/service-worker.js"'), "SW bundle path moved — update this test's SW_PATH");
});
