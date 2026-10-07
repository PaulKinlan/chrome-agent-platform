// chrome-agent-platform-ltkj.2 — loaded schema-2 admission acceptance proof.
//
// The ltkj.2 contract requires a REAL numeric admission through the REAL chain:
//   actual Settings click → real runtime message broker → packaged fetch →
//   typed audit → real OPFS-backed registry/WAL → rendered validation receipt.
//
// Post-build file injection is NOT valid attestation: this harness copies the
// tracked tree into a disposable durable copy, regenerates the inventory with
// the explicit build-time-only acceptance target
// (scripts/build-bundled-tool-packages.mjs --acceptance-emscripten-numeric)
// and REBUNDLES the real service-worker/options inventory imports there, then
// loads that build in Chrome and drives the owner Settings surface.
//
// Modes:
//   --positive          full numeric admission succeeds; receipt + committed
//                       registry record with the pinned digests; execution is
//                       NOT enabled (validated-not-enabled).
//   --negative-asset    exactly one byte of the admitted main Wasm is mutated
//                       on disk before Chrome starts; validation fails closed
//                       (inventory_mismatch at the mutated path); no committed
//                       record exists.
//   --negative-manifest exactly one byte of the shipped manifest is mutated;
//                       fails closed the same way.
//   --negative-sidecar  exactly one byte of the provenance sidecar is mutated;
//                       fails closed the same way.
//
// Every mode: fresh profile + fresh Chrome (fresh authority), zero external
// requests, screenshots + result.json in the durable evidence directory,
// teardown via teardownChrome (never-delete-live), copy removed only after
// the browser is confirmed dead. The reviewed source tree is NEVER written.

import { fileURLToPath } from "node:url";
import {
  launchChrome,
  openCdp,
  waitForServiceWorker,
  teardownChrome,
} from "./lib/chrome-launch.ts";
import { validateDistCompleteMarker } from "./dist-complete.mjs";
import { durableDir } from "./lib/durable-root.mjs";
import { NUMERIC_ACCEPTANCE_PINS } from "./lib/emscripten-numeric-acceptance.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const P = NUMERIC_ACCEPTANCE_PINS;
const PACKAGE_ID = P.packageId; // cap.acceptance.a0.numeric
const CAS_REL = `extension/wasm/cas/${P.main.sha256}.wasm`;
const MANIFEST_REL = `extension/wasm/manifests/${PACKAGE_ID}-${P.packageVersion}.manifest.json`;
const SIDECAR_REL = P.sidecarRel;
const SUCCESS_COPY = "Package validated. Execution is not enabled.";
const DEVELOPER_FEATURES_KEY = "cap:developerFeatures";

// ── Copy planning (pure, unit-tested) ───────────────────────────────────────

/** The copy contains ONLY tracked files; generated/build outputs are rebuilt. */
export const COPY_SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-versions", "dist-archives"]);

/**
 * One-byte mutation plan per negative mode. `needle` is located in the file
 * bytes (exactly once) and the byte at `needleOffset` within it is XORed with
 * `xor`. For the binary asset the plan is a fixed tail offset instead.
 */
export function mutationPlan(kind: "asset" | "manifest" | "sidecar") {
  if (kind === "asset") {
    return { rel: CAS_REL, needle: null, offsetFromEnd: 3, xor: 0xff };
  }
  if (kind === "manifest") {
    // Flip the case of the leading 'A' inside the meta description: JSON stays
    // valid and canonical-shaped, so the refusal comes from the inventory hash
    // verification (fail closed at the first layer that can see the drift).
    return { rel: MANIFEST_REL, needle: new TextEncoder().encode("A0 numeric acceptance fixture"), offsetFromEnd: 0, xor: 0x20 };
  }
  return { rel: SIDECAR_REL, needle: new TextEncoder().encode("cap-emscripten-admission-provenance-v1"), offsetFromEnd: 0, xor: 0x20 };
}

/** Locate the single byte offset a plan mutates; throws when ambiguous. */
export function planOffset(bytes: Uint8Array, plan: ReturnType<typeof mutationPlan>): number {
  if (plan.needle === null) {
    const offset = bytes.byteLength - plan.offsetFromEnd;
    if (offset < 8) throw new Error("mutation target too small");
    return offset;
  }
  const needle = plan.needle;
  let found = -1;
  let count = 0;
  outer: for (let i = 0; i + needle.length <= bytes.byteLength; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    found = i;
    count += 1;
  }
  if (count !== 1) throw new Error(`mutation needle found ${count} times (expected exactly 1)`);
  return found;
}

/** Apply the one-byte mutation; returns a new buffer differing in exactly one byte. */
export function applyMutation(bytes: Uint8Array, plan: ReturnType<typeof mutationPlan>): { mutated: Uint8Array; offset: number } {
  const offset = planOffset(bytes, plan);
  const mutated = bytes.slice();
  mutated[offset] ^= plan.xor;
  if (mutated[offset] === bytes[offset]) throw new Error("mutation xor is a no-op");
  return { mutated, offset };
}

/** Classify the rendered validation status copy (pure, unit-tested). */
export function parseValidationStatus(text: string | null): { state: "success" | "failed" | "busy" | "empty" | "none"; error?: string; path?: string } {
  if (text === null || text === "") return { state: "none" };
  if (text === SUCCESS_COPY) return { state: "success" };
  if (text === "Validating package…") return { state: "busy" };
  if (text.startsWith("No Emscripten packages")) return { state: "empty" };
  const failed = /^Validation failed: ([a-z0-9_]+)(?: \(at ([^)]+)\))?\.$/u.exec(text);
  if (failed) return { state: "failed", error: failed[1], path: failed[2] };
  return { state: "failed", error: "unparsed", path: text };
}

/** The receipt/registry assertions for the positive mode (pure, unit-tested). */
export function assertPositiveRegistry(result: unknown): { graphDigest: string; manifestDigest: string; state: string } {
  const record = (result as { ok?: boolean; record?: { current?: { state?: string; graphDigest?: string; manifestDigest?: string; version?: string }; history?: unknown[] } }) ?? {};
  if (record.ok !== true) throw new Error(`registry query did not return a committed record: ${JSON.stringify(result)}`);
  const current = record.record?.current;
  if (current?.state !== "committed") throw new Error(`registry record is not committed: ${current?.state}`);
  if (current?.version !== P.packageVersion) throw new Error(`registry record version drift: ${current?.version}`);
  if (current?.graphDigest !== "00544d07c39c5cee8473217ef1472d19dc8e0e60f36c3cbef4eb9f63833e7771") throw new Error(`graph digest drift: ${current?.graphDigest}`);
  if (current?.manifestDigest !== "97621e5e889b272b79b7e0723a7f5b94254ac187be2cd896e02a35a3a2119343") throw new Error(`manifest digest drift: ${current?.manifestDigest}`);
  if (!Array.isArray(record.record?.history) || record.record!.history.length !== 0) throw new Error("fresh admission must have empty history");
  return { graphDigest: current.graphDigest!, manifestDigest: current.manifestDigest!, state: current.state };
}

/** Negative modes must find NO committed record (pure, unit-tested). */
export function assertNegativeRegistry(result: unknown): string {
  const record = (result as { ok?: boolean; error?: string }) ?? {};
  if (record.ok === true) throw new Error(`mutated fixture must not admit: ${JSON.stringify(result).slice(0, 400)}`);
  if (record.error !== "absent") throw new Error(`unexpected registry refusal for mutated fixture: ${record.error}`);
  return record.error;
}

// ── Copy + rebuild (disposable durable copy; reviewed tree is never written) ─

async function listTrackedFiles(): Promise<string[]> {
  // Tracked files PLUS untracked-but-not-ignored ones (a fresh slice-2 file is
  // copied before it is committed); gitignored build outputs are excluded and
  // rebuilt inside the copy.
  const proc = new Deno.Command("git", {
    args: ["-C", ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    stdout: "piped",
  });
  const { success, stdout } = await proc.output();
  if (!success) throw new Error("git ls-files failed in the reviewed tree");
  return new TextDecoder().decode(stdout).split("\0").filter((rel) => {
    if (!rel) return false;
    const top = rel.split("/")[0];
    return !COPY_SKIP_DIRS.has(top);
  });
}

export async function prepareAcceptanceCopy(copyRoot: string, { buildTimeoutMs = 1_500_000 } = {}) {
  const tracked = await listTrackedFiles();
  for (const rel of tracked) {
    const target = join(copyRoot, rel);
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
    await Deno.copyFile(join(ROOT, rel), target);
  }
  // node_modules via hardlinks (fleet-deps store): no network, seconds, no
  // writable inode shared with the reviewed tree (writeFileSync replaces via
  // rename in esbuild's cache paths; the generator/build never edit deps).
  const nodeModules = new Deno.Command("cp", {
    args: ["-al", join(ROOT, "node_modules"), join(copyRoot, "node_modules")],
    stdout: "null", stderr: "piped",
  });
  const nm = await nodeModules.output();
  if (!nm.success) {
    throw new Error(`node_modules hardlink copy failed (run fleet-deps first): ${new TextDecoder().decode(nm.stderr).slice(0, 400)}`);
  }

  const env = { ...Deno.env.toObject(), CAP_ACCEPTANCE_EMSCRIPTEN_NUMERIC: "1" };
  // 1) Regenerate the inventory with the acceptance target (measured, pinned).
  const generator = await new Deno.Command("node", {
    args: ["scripts/build-bundled-tool-packages.mjs", "--acceptance-emscripten-numeric"],
    cwd: copyRoot, env, stdout: "piped", stderr: "piped",
  }).output();
  const generatorOut = new TextDecoder().decode(generator.stdout) + new TextDecoder().decode(generator.stderr);
  if (!generator.success) throw new Error(`acceptance generator failed:\n${generatorOut.slice(-2000)}`);
  if (!generatorOut.includes("acceptance: emitted 6 schema-2 fixture files")) {
    throw new Error(`acceptance generator did not emit the fixture:\n${generatorOut.slice(-1000)}`);
  }
  // 1b) The store build binds itself to a git-indexed source authority
  // (dist.complete binds commit identity + indexed source bytes). The
  // disposable copy therefore gets its OWN throwaway repository AFTER the
  // generator ran, so the regenerated acceptance files are part of the
  // indexed authority and every production security assertion runs
  // unrelaxed against exactly the tree being built. The reviewed tree's
  // history is never touched; node_modules stays ignored via the copied
  // .gitignore.
  for (const [label, args] of [
    ["git init", ["init", "--quiet", "-b", "main"]],
    ["git add", ["add", "-A"]],
    ["git commit", ["-c", "user.email=acceptance@cap.invalid", "-c", "user.name=cap-acceptance-copy", "commit", "--quiet", "-m", "disposable acceptance-copy snapshot (never pushed)"]],
  ] as const) {
    const step = await new Deno.Command("git", { args: [...args], cwd: copyRoot, stdout: "piped", stderr: "piped" }).output();
    if (!step.success) {
      throw new Error(`${label} failed in acceptance copy: ${new TextDecoder().decode(step.stderr).slice(0, 400)}`);
    }
  }
  // 2) Rebuild + rebundle the REAL service-worker/options inventory imports.
  const build = await new Deno.Command("node", {
    args: ["build.mjs", "--target=store"],
    cwd: copyRoot, env, stdout: "piped", stderr: "piped",
    signal: AbortSignal.timeout(buildTimeoutMs),
  }).output();
  if (!build.success) {
    const out = new TextDecoder().decode(build.stdout) + new TextDecoder().decode(build.stderr);
    throw new Error(`acceptance build failed:\n${out.slice(-3000)}`);
  }
  // 3) The rebuilt copy is a complete Store build bound to its own tree.
  await validateDistCompleteMarker({
    root: copyRoot,
    distRoot: join(copyRoot, "extension/dist"),
    expectedTarget: "store",
  });
  // 4) The regenerated inventory carries exactly one schema-2 identity with the
  //    pinned digest — read back from the copy's generated module source.
  const inventoryText = await Deno.readTextFile(join(copyRoot, "extension/lib/bundled-inventory-data.js"));
  if (!inventoryText.includes(`"${PACKAGE_ID}"`)) throw new Error("rebuilt inventory is missing the acceptance identity");
  if (!inventoryText.includes(P.packageVersion)) throw new Error("rebuilt inventory is missing the acceptance version");
  const acceptanceManifest = JSON.parse(await Deno.readTextFile(join(copyRoot, MANIFEST_REL)));
  if (acceptanceManifest.schemaVersion !== 2) throw new Error("acceptance manifest on disk is not schema-2");
  return { trackedCount: tracked.length, generatorOut: generatorOut.trim().split("\n").slice(-2) };
}

async function applyNegativeMutation(copyRoot: string, kind: "asset" | "manifest" | "sidecar") {
  const plan = mutationPlan(kind);
  const path = join(copyRoot, plan.rel);
  const bytes = await Deno.readFile(path);
  const { mutated, offset } = applyMutation(bytes, plan);
  await Deno.writeFile(path, mutated);
  const after = await Deno.readFile(path);
  if (after.byteLength !== bytes.byteLength) throw new Error("mutation changed the file length");
  let diff = 0;
  for (let i = 0; i < after.byteLength; i++) if (after[i] !== bytes[i]) diff += 1;
  if (diff !== 1) throw new Error(`mutation changed ${diff} bytes (expected exactly 1)`);
  return { rel: plan.rel, offset, xor: plan.xor, beforeSha256: await sha256(bytes), afterSha256: await sha256(after) };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Page driving ────────────────────────────────────────────────────────────

const LIBRARY_EVAL = (expr: string) => `(() => {
  const el = document.querySelector("#tool-library-view");
  const root = el && (el.shadowRoot || el);
  if (!root) return null;
  return ${expr};
})()`;

type Cdp = Awaited<ReturnType<typeof openCdp>>;

async function waitForLibrary(cdp: Cdp, sessionId: string, predicate: string, timeoutMs: number, consoleTail: string[] = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdp.eval(sessionId, LIBRARY_EVAL(predicate)).catch(() => null);
    if (value !== null && value !== undefined && value !== false) return value;
    await sleep(150);
  }
  // Diagnostics BEFORE throwing: the exact refusal string from the live SW
  // route + host fence, the rendered section, and page errors — so a red run
  // self-diagnoses instead of needing a rerun with printfs.
  const diag = await cdp.eval(sessionId, `(async () => {
    const out = {};
    try {
      out.routeProbe = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "tool.package.validation-list" }, (r) => {
            out.lastError = chrome.runtime.lastError?.message ?? null;
            resolve(JSON.stringify(r));
          });
        } catch (e) { resolve("throw: " + (e?.message ?? e)); }
      });
    } catch (e) { out.routeProbe = "eval-failed: " + (e?.message ?? e); }
    try {
      out.hostRegistered = await import(chrome.runtime.getURL("lib/wasm-package-admission.js"))
        .then(() => "import-ok")
        .catch((e) => "import-failed: " + (e?.message ?? e));
    } catch (e) { out.hostRegistered = "eval-failed: " + (e?.message ?? e); }
    try {
      const el = document.querySelector("#tool-library-view");
      const root = el && (el.shadowRoot || el);
      out.sectionHtml = root?.querySelector(".validation-packages")?.outerHTML?.slice(0, 800) ?? "no section";
      out.libraryState = JSON.stringify({
        validationPackages: el?.validationPackages ?? null,
        validationListDiag: el?.validationListDiag ?? null,
      });
    } catch (e) { out.sectionHtml = "err: " + (e?.message ?? e); }
    try {
      out.flagProbe = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "kv.get", keys: ["cap:developerFeatures"] }, (r) => {
            out.flagLastError = chrome.runtime.lastError?.message ?? null;
            resolve(JSON.stringify(r));
          });
        } catch (e) { resolve("throw: " + (e?.message ?? e)); }
      });
    } catch (e) { out.flagProbe = "eval-failed: " + (e?.message ?? e); }
    return JSON.stringify(out);
  })()`).catch((e) => `diag-eval-failed: ${e?.message ?? e}`);
  throw new Error(`timed out waiting for tool-library predicate: ${predicate}\ndiagnostics: ${diag}\nconsole tail:\n${consoleTail.join("\n")}`);
}

const REGISTRY_QUERY = `(async () => {
  const [{ WasmPackageAuthority }, { masterMemory }] = await Promise.all([
    import(chrome.runtime.getURL("lib/wasm-package-authority.js")),
    import(chrome.runtime.getURL("lib/memory.js")),
  ]);
  const authority = new WasmPackageAuthority({ getStore: () => masterMemory() });
  return await authority.query({ packageId: ${JSON.stringify(PACKAGE_ID)} });
})()`;

// ── Main ────────────────────────────────────────────────────────────────────

type Mode = "positive" | "negative-asset" | "negative-manifest" | "negative-sidecar";

function parseMode(args: string[]): Mode {
  if (args.includes("--positive")) return "positive";
  if (args.includes("--negative-asset")) return "negative-asset";
  if (args.includes("--negative-manifest")) return "negative-manifest";
  if (args.includes("--negative-sidecar")) return "negative-sidecar";
  throw new Error("pass exactly one mode: --positive | --negative-asset | --negative-manifest | --negative-sidecar");
}

async function main() {
  const mode = parseMode(Deno.args);
  const evidence = await Deno.makeTempDir({ dir: durableDir("astra", "ltkj2"), prefix: "admission-loaded-" });
  const copyRoot = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-emscripten-admission-copy-" });
  const profile = await Deno.makeTempDir({ dir: durableDir("chrome-profiles"), prefix: "cap-emscripten-admission-" });
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let error: string | null = null;
  const externalRequests: string[] = [];
  const result: Record<string, unknown> = { mode, packageId: PACKAGE_ID, version: P.packageVersion };

  try {
    console.log(`[${mode}] preparing acceptance copy at ${copyRoot}`);
    const prepared = await prepareAcceptanceCopy(copyRoot);
    result.copy = prepared;

    let mutation = null;
    if (mode !== "positive") {
      mutation = await applyNegativeMutation(copyRoot, mode.slice("negative-".length) as "asset" | "manifest" | "sidecar");
      result.mutation = mutation;
      console.log(`[${mode}] mutated one byte: ${mutation.rel} @${mutation.offset}`);
    }

    chrome = await launchChrome({ extension: join(copyRoot, "extension"), profile, windowSize: "1440,1000" });
    const cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30_000 });
    result.browser = (await cdp.send("Browser.getVersion")).result;
    const serviceWorker = await waitForServiceWorker(cdp.send, { timeoutMs: 20_000 });
    if (!serviceWorker) throw new Error("acceptance extension did not register its service worker");
    const extensionId = new URL(serviceWorker.url).host;
    result.extensionId = extensionId;

    const page = await cdp.open("about:blank");
    const sessionId = page.sessionId;
    await cdp.send("Network.enable", {}, sessionId);
    const consoleTail = [] as string[];
    cdp.on("Runtime.consoleAPICalled", (params) => {
      const text = (params?.args ?? []).map((a) => String(a?.value ?? a?.description ?? "")).join(" ").slice(0, 300);
      consoleTail.push(`${params?.type ?? "log"}: ${text}`);
      if (consoleTail.length > 60) consoleTail.shift();
    });
    cdp.on("Runtime.exceptionThrown", (params) => {
      const d = params?.exceptionDetails ?? {};
      consoleTail.push(`EXCEPTION: ${d.text ?? ""} ${d.exception?.description ?? ""}`.slice(0, 400));
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    cdp.on("Network.requestWillBeSent", (params) => {
      const url = String(params?.request?.url ?? "");
      if (/^https?:/u.test(url)) externalRequests.push(url);
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/options/options.html` }, sessionId);
    await waitForLibraryReady(cdp, sessionId);

    // Enable developer features through the SAME kv path the About switch uses,
    // then RELOAD (a hash navigation does not re-run the page module, and the
    // flag is read once at module init — the page must boot again to see it).
    const kvSet = await cdp.eval(sessionId, `(async () => await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "kv.set", values: { ${JSON.stringify(DEVELOPER_FEATURES_KEY)}: true } }, (r) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? "kv.set failed")); else resolve(JSON.stringify(r));
      });
    }))()`).catch((e) => `kv.set-failed: ${e?.message ?? e}`);
    if (typeof kvSet === "string" && kvSet.startsWith("kv.set-failed")) {
      throw new Error(`developer-features flag could not be set: ${kvSet}`);
    }
    await cdp.eval(sessionId, "window.__harnessPreReload = true");
    await cdp.eval(sessionId, "location.reload()");
    await waitForLibraryReady(cdp, sessionId);
    const preReloadMarker = await cdp.eval(sessionId, "window.__harnessPreReload ?? 'gone'").catch(() => "eval-failed");
    (result as Record<string, unknown>).reloadVerified = preReloadMarker === "gone" ? "fresh-context (reload worked)" : `STALE CONTEXT (marker=${String(preReloadMarker)})`;

    // The validation list must name the acceptance package exactly once.
    const rows = await waitForLibrary(cdp, sessionId, `(() => { const r = Array.from(root.querySelectorAll(".validation-packages .validation-row .validation-pkg-info")).map((n) => n.textContent); return r.length ? r : false; })()`, 30_000, consoleTail);
    result.listRows = rows;
    const expectedRow = `${PACKAGE_ID} (v${P.packageVersion})`;
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0] !== expectedRow) {
      throw new Error(`validation list is wrong: ${JSON.stringify(rows)} (expected exactly [${expectedRow}])`);
    }
    const buttonVisible = await cdp.eval(sessionId, LIBRARY_EVAL(`(() => { const b = root.querySelector(".package-validate-btn"); return Boolean(b && !b.hidden && !b.disabled); })()`));
    if (buttonVisible !== true) throw new Error("validate button is not visible/enabled with a listed package");

    // Real owner click on the real button.
    await cdp.eval(sessionId, LIBRARY_EVAL(`(() => { root.querySelector(".package-validate-btn").click(); return true; })()`));

    // Poll the aria-live status until it settles (busy → success/failed).
    const deadline = Date.now() + 90_000;
    let statusText: string | null = null;
    let parsed: ReturnType<typeof parseValidationStatus> = { state: "none" };
    while (Date.now() < deadline) {
      statusText = await cdp.eval(sessionId, LIBRARY_EVAL(`(() => { const s = root.querySelector(".validation-status"); return s ? s.textContent : null; })()`)) as string | null;
      parsed = parseValidationStatus(statusText);
      if (parsed.state !== "busy" && parsed.state !== "none") break;
      await sleep(200);
    }
    result.statusText = statusText;
    result.parsedStatus = parsed;

    const registry = await cdp.eval(sessionId, REGISTRY_QUERY);
    result.registry = registry;

    if (mode === "positive") {
      if (parsed.state !== "success") throw new Error(`positive validation did not render the success receipt: ${statusText}`);
      result.positive = assertPositiveRegistry(registry);
    } else {
      if (parsed.state !== "failed") throw new Error(`mutated fixture did not render a fail-closed refusal: ${statusText}`);
      if (parsed.error !== "inventory_mismatch") throw new Error(`unexpected refusal code: ${parsed.error} (${statusText})`);
      if (!mutation || parsed.path !== mutation.rel) {
        throw new Error(`refusal path does not name the mutated file: ${parsed.path} (mutation ${mutation?.rel})`);
      }
      result.negative = assertNegativeRegistry(registry);
    }

    if (externalRequests.length !== 0) {
      throw new Error(`validation attempted external requests: ${externalRequests.join(", ")}`);
    }
    result.externalRequests = externalRequests;

    const png = await cdp.screenshot(sessionId);
    if (!png) throw new Error("screenshot capture returned nothing");
    const shotPath = join(evidence, `${mode}.png`);
    await Deno.writeFile(shotPath, png);
    result.screenshot = { path: shotPath, bytes: png.byteLength, sha256: await sha256(png) };
  } catch (reason) {
    error = String(reason instanceof Error ? reason.stack ?? reason.message : reason);
    result.error = error;
    result.externalRequests = externalRequests;
    console.error(error);
    console.log(`RESULT: RED; mode ${mode}; evidence ${evidence}`);
  } finally {
    // Kill first, verify death, only then remove the disposable copy/profile
    // (never-delete-live: teardownChrome gates profile removal on liveness;
    // the scratch COPY is likewise removed only after confirmed teardown — a
    // failed teardown retains it for inspection instead of deleting live).
    let teardownOk = false;
    try {
      await teardownChrome(chrome, profile);
      teardownOk = true;
    } catch (reason) {
      console.error(`teardown failed: ${reason}`);
      if (!error) error = String(reason);
      result.teardownFailed = true;
      result.retainedCopyRoot = copyRoot;
    }
    if (teardownOk) {
      try {
        await Deno.remove(copyRoot, { recursive: true });
      } catch {
        // scratch copy: best-effort removal AFTER confirmed teardown
      }
    } else {
      console.error(`RETAINED scratch copy (teardown unconfirmed, never-delete-live): ${copyRoot}`);
    }
    // result.json is written ONCE here — after teardown — so teardownFailed /
    // retainedCopyRoot are persisted in the evidence, not lost to an earlier write.
    try {
      await Deno.writeTextFile(join(evidence, "result.json"), JSON.stringify(result, null, 1) + "\n");
    } catch (writeErr) {
      if (!error) error = String(writeErr);
    }
    console.log(`RESULT: ${error ? "RED" : "GREEN"}; mode ${mode}; evidence ${evidence}`);
  }
  Deno.exit(error ? 1 : 0);
}

async function waitForLibraryReady(cdp: Cdp, sessionId: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await cdp.eval(sessionId, LIBRARY_EVAL(`Boolean(root.querySelector(".validation-packages"))`)).catch(() => null);
    if (ready === true) return;
    await sleep(200);
  }
  throw new Error("tool-library never rendered its validation section (developer features flag not applied?)");
}

if (import.meta.main) {
  await main();
}
