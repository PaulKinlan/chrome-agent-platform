// chrome-agent-platform-ltkj.1 — loaded test-only Emscripten ABI proof.
// Requires a production build, then copies it byte-for-byte to durable scratch
// and adds only hash-pinned probe assets. It does not modify or admit a package.
import {
  type CdpSend,
  launchChrome,
  openCdp,
  waitForServiceWorker,
  withTimeout,
} from "./lib/chrome-launch.ts";
import { validateDistCompleteMarker } from "./dist-complete.mjs";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const dirname = (value: string) => value.slice(0, value.lastIndexOf("/"));
const EXTENSION = join(ROOT, "extension");
const PROBE_ROOT = join(ROOT, "packages/bundled/evidence/emscripten-abi");
const SNAPSHOT_PATH = join(PROBE_ROOT, "loaded-probe/snapshot.json");
export const SNAPSHOT_SHA256 =
  "34b6d91a77fad1b7fd3fa2f5e60a5327df640fd8e385bb81a0e2013b9890ff78";
const PROBE_DEST = "_emscripten_abi_probe";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function digest(bytes: Uint8Array | string) {
  const input = typeof bytes === "string"
    ? new TextEncoder().encode(bytes)
    : bytes;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", input.buffer as ArrayBuffer),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fileRecord(file: string) {
  const bytes = await Deno.readFile(file);
  return { bytes: bytes.length, sha256: await digest(bytes) };
}

export async function treeRecords(root: string, prefix = "") {
  const records: Record<
    string,
    { kind: string; bytes?: number; sha256: string }
  > = {};
  const entries = [];
  for await (const entry of Deno.readDir(join(root, prefix))) {
    entries.push(entry);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory) Object.assign(records, await treeRecords(root, rel));
    else if (entry.isSymlink) {
      records[rel] = {
        kind: "symlink",
        sha256: await digest(await Deno.readLink(join(root, rel))),
      };
    } else if (entry.isFile) {
      records[rel] = {
        kind: "file",
        ...await fileRecord(join(root, rel)),
      };
    }
  }
  return records;
}

export async function verifyCopiedTree(
  sourceClosure: Awaited<ReturnType<typeof treeRecords>>,
  destination: string,
) {
  const copiedClosure = await treeRecords(destination);
  if (JSON.stringify(copiedClosure) !== JSON.stringify(sourceClosure)) {
    throw new Error(
      "durable extension copy is not byte-identical to the production tree",
    );
  }
  return copiedClosure;
}

export async function verifyPinnedFile(
  file: string,
  expected: { bytes: number; sha256: string },
  label: string,
) {
  const record = await fileRecord(file);
  if (record.bytes !== expected.bytes || record.sha256 !== expected.sha256) {
    throw new Error(`loaded probe asset drift: ${label}`);
  }
  return record;
}

async function copyTree(source: string, destination: string) {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isSymlink) await Deno.symlink(await Deno.readLink(from), to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

export async function verifyCurrentManifest(
  manifestBytes: Uint8Array,
  reference: any,
) {
  let manifest: any;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error("current production manifest is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("current production manifest is not an object");
  }
  if (
    JSON.stringify(reference.releaseFieldsAllowedToDiffer) !==
      JSON.stringify(["version", "version_name"])
  ) {
    throw new Error("manifest release-field contract drift");
  }
  if (
    typeof manifest.version !== "string" ||
    (manifest.version_name !== undefined &&
      typeof manifest.version_name !== "string")
  ) {
    throw new Error("current production manifest release fields are invalid");
  }
  if (
    manifest.content_security_policy?.extension_pages !==
      reference.extensionPagesCsp
  ) {
    throw new Error(
      "production extension-pages CSP drift from loaded-probe contract",
    );
  }
  const { version: _version, version_name: _versionName, ...contract } =
    manifest;
  const contractSha256 = await digest(JSON.stringify(contract));
  if (contractSha256 !== reference.nonReleaseContractSha256) {
    throw new Error("production manifest non-release contract drift");
  }
  return {
    bytes: manifestBytes.length,
    sha256: await digest(manifestBytes),
    version: manifest.version,
    versionName: manifest.version_name ?? null,
    extensionPagesCsp: manifest.content_security_policy.extension_pages,
    nonReleaseContractSha256: contractSha256,
    value: manifest,
  };
}

export async function verifyLoadedProbeSnapshot() {
  const snapshotBytes = await Deno.readFile(SNAPSHOT_PATH);
  if (await digest(snapshotBytes) !== SNAPSHOT_SHA256) {
    throw new Error("loaded probe snapshot hash drift");
  }
  const snapshot = JSON.parse(new TextDecoder().decode(snapshotBytes));
  const manifestBytes = await Deno.readFile(
    join(ROOT, snapshot.manifest.source),
  );
  const currentManifest = await verifyCurrentManifest(
    manifestBytes,
    snapshot.manifest,
  );
  for (const source of [...snapshot.sourcePins, ...snapshot.assets]) {
    await verifyPinnedFile(
      join(PROBE_ROOT, source.path ?? source.source),
      source,
      source.path ?? source.source,
    );
  }
  const authority = snapshot.assets.find((entry: any) =>
    entry.destination === "assets/unsafe-authority.wasm"
  );
  const module = new WebAssembly.Module(
    await Deno.readFile(join(PROBE_ROOT, authority.source)),
  );
  const imports = WebAssembly.Module.imports(module);
  if (
    JSON.stringify(imports) !==
      JSON.stringify([{
        module: "env",
        name: "cap_attempt_browser_authority",
        kind: "function",
      }])
  ) {
    throw new Error(
      `unsafe authority fixture import drift: ${JSON.stringify(imports)}`,
    );
  }
  return { snapshot, currentManifest };
}

export async function assertNoExistingProbe(extension: string) {
  // lstat catches empty directories and dangling links without changing closure keys.
  try {
    await Deno.lstat(join(extension, PROBE_DEST));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(
    "production extension unexpectedly contains the test-only probe path",
  );
}

export async function prepareLoadedExtension() {
  const { snapshot, currentManifest } = await verifyLoadedProbeSnapshot();
  await Deno.stat(join(EXTENSION, "dist/background/service-worker.js"))
    .catch(() => {
      throw new Error(
        "production dist is absent; run npm run build:production before the loaded proof",
      );
    });
  await validateDistCompleteMarker({
    root: ROOT,
    distRoot: join(EXTENSION, "dist"),
    expectedTarget: "store",
  }).catch((error) => {
    throw new Error(
      `production dist is not a current Store build; run npm run build:production before the loaded proof: ${error}`,
    );
  });
  await assertNoExistingProbe(EXTENSION);
  const sourceClosure = await treeRecords(EXTENSION);

  const destination = await Deno.makeTempDir({
    dir: durableDir("scratch"),
    prefix: "cap-emscripten-loaded-ext-",
  });
  await copyTree(EXTENSION, destination);
  const copiedClosure = await verifyCopiedTree(sourceClosure, destination);

  const probe = join(destination, PROBE_DEST);
  await Deno.mkdir(probe, { recursive: true });
  await Deno.copyFile(SNAPSHOT_PATH, join(probe, "snapshot.json"));
  if (
    await digest(await Deno.readFile(join(probe, "snapshot.json"))) !==
      SNAPSHOT_SHA256
  ) {
    throw new Error("copied probe snapshot hash drift");
  }
  for (const asset of snapshot.assets) {
    const target = join(probe, asset.destination);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.copyFile(join(PROBE_ROOT, asset.source), target);
    await verifyPinnedFile(target, asset, asset.destination);
  }
  const copiedManifest = await Deno.readFile(
    join(destination, "manifest.json"),
  );
  if (await digest(copiedManifest) !== currentManifest.sha256) {
    throw new Error(
      "copied manifest is not byte-identical to the current shipped manifest",
    );
  }
  return {
    destination,
    snapshot,
    currentManifest,
    sourceClosure,
    copiedClosure,
    loadedClosure: await treeRecords(destination),
  };
}

export function verifiedAssetNames(
  value: unknown,
  result = new Set<string>(),
) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) verifiedAssetNames(item, result);
    return result;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.verifiedAssets)) {
    for (const name of record.verifiedAssets) result.add(String(name));
  }
  for (const nested of Object.values(record)) {
    verifiedAssetNames(nested, result);
  }
  return result;
}

function errorText(reason: unknown) {
  return String(
    reason instanceof Error ? reason.stack ?? reason.message : reason,
  );
}

type FinalizationContext = {
  evidence: string;
  profile: string;
  error: string | null;
  prepared?: Awaited<ReturnType<typeof prepareLoadedExtension>>;
  browserVersion: unknown;
  loadedState: unknown;
  requests: unknown[];
  blocked: unknown[];
  unexpectedExternal: string[];
  workerTargets: unknown[];
  setupErrors: string[];
  screenshot: unknown;
  safeExternalAttempts: string[] | null;
  cdp?: Awaited<ReturnType<typeof openCdp>>;
  chrome?: Awaited<ReturnType<typeof launchChrome>>;
  writeResult?: (path: string, data: string) => Promise<void>;
};

export async function finalizeLoadedProof(context: FinalizationContext) {
  let finalError = context.error;
  const fail = (label: string, reason: unknown) => {
    const detail = `${label}: ${errorText(reason)}`;
    finalError = finalError ? `${finalError}\n${detail}` : detail;
    console.error(detail);
  };

  let sourceHead: string | null = null;
  try {
    const identity = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    sourceHead = new TextDecoder().decode(identity.stdout).trim();
    if (!identity.success || !/^[0-9a-f]{40,64}$/.test(sourceHead)) {
      throw new Error(
        `git rev-parse failed (${identity.code}): ${
          new TextDecoder().decode(identity.stderr).trim() || sourceHead
        }`,
      );
    }
  } catch (reason) {
    sourceHead = null;
    fail("source identity failed", reason);
  }

  if (context.cdp) {
    try {
      await context.cdp.send("Browser.close");
    } catch (reason) {
      fail("Browser.close failed", reason);
    }
  }
  if (context.chrome) {
    let status: Promise<unknown> | undefined;
    try {
      status = context.chrome.proc.status;
      await withTimeout(status, 8_000);
    } catch {
      try {
        context.chrome.proc.kill("SIGKILL");
      } catch (reason) {
        fail("browser process kill failed", reason);
      }
      try {
        status ??= context.chrome.proc.status;
        await withTimeout(status, 8_000);
      } catch (reason) {
        fail("browser process teardown unconfirmed", reason);
      }
    }
  }
  try {
    context.cdp?.close();
  } catch (reason) {
    fail("CDP close failed", reason);
  }
  await Deno.remove(context.profile, { recursive: true }).catch((reason) =>
    fail("profile cleanup failed", reason)
  );

  try {
    const report = {
      state: finalError ? "RED" : "GREEN",
      error: finalError,
      sourceHead,
      copiedExtension: context.prepared
        ? {
          path: context.prepared.destination,
          sourceClosure: context.prepared.sourceClosure,
          copiedClosure: context.prepared.copiedClosure,
          loadedClosure: context.prepared.loadedClosure,
          manifest: {
            current: context.prepared.currentManifest,
            historicalReference: context.prepared.snapshot.manifest,
          },
        }
        : null,
      browserVersion: context.browserVersion,
      loadedState: context.loadedState,
      requestEvidence: {
        safeExternalAttempts: context.safeExternalAttempts,
        allRequests: context.requests,
        blockedExternalAttempts: context.blocked,
        unexpectedExternal: context.unexpectedExternal,
      },
      workerTargets: context.workerTargets,
      setupErrors: context.setupErrors,
      screenshot: context.screenshot,
      note:
        "Test-only loaded proof; no package admission, production host, vips, pthread, custody, or generic-runtime claim.",
    };
    await (context.writeResult ?? Deno.writeTextFile)(
      join(context.evidence, "result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  } catch (reason) {
    fail("evidence finalization failed", reason);
  }
  return finalError;
}

const EXTERNAL_BLOCK_PATTERNS = [
  { urlPattern: "http://*:*/*", block: true },
  { urlPattern: "https://*:*/*", block: true },
];

type RequestEvidence = {
  url: string;
  type?: string;
  sessionId?: string;
  requestId?: string;
};

export async function configureExternalRequestBlocking(
  send: CdpSend,
  sessionId: string,
) {
  await send("Network.enable", {}, sessionId);
  await send("Network.setBlockedURLs", {
    urlPatterns: EXTERNAL_BLOCK_PATTERNS,
  }, sessionId);
}

type WorkerTargetEvidence = {
  targetId: string;
  url: string;
  sessionId: string;
  configuredBeforeRun: boolean;
};

export async function setupAttachedWorker(
  send: CdpSend,
  target: WorkerTargetEvidence,
  setupErrors: string[],
) {
  try {
    await configureExternalRequestBlocking(send, target.sessionId);
    await send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }, target.sessionId);
    target.configuredBeforeRun = true;
    await send("Runtime.runIfWaitingForDebugger", {}, target.sessionId);
    return true;
  } catch (reason) {
    setupErrors.push(`worker ${target.targetId}: ${reason}`);
    return false;
  }
}

export function assertWorkerSetupSucceeded(setupErrors: string[]) {
  if (setupErrors.length) {
    throw new Error(`worker CDP setup failed: ${setupErrors.join("; ")}`);
  }
}

export function correlateInspectorBlock(
  requests: RequestEvidence[],
  failure: {
    requestId: string;
    type?: string;
    errorText?: string;
    blockedReason?: string;
  },
  sessionId?: string,
) {
  if (failure.blockedReason !== "inspector") return null;
  const request = requests.findLast((entry) =>
    entry.requestId === failure.requestId && entry.sessionId === sessionId
  );
  if (!request || !/^https?:/.test(request.url)) return null;
  return {
    url: request.url,
    type: failure.type,
    sessionId,
    requestId: failure.requestId,
    errorText: failure.errorText,
    blockedReason: failure.blockedReason,
  };
}

async function main() {
  const evidence = await Deno.makeTempDir({
    dir: durableDir("astra", "ltkj1"),
    prefix: "loaded-proof-",
  });
  const profile = await Deno.makeTempDir({
    dir: durableDir("chrome-profiles"),
    prefix: "cap-emscripten-loaded-",
  });
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let cdp: Awaited<ReturnType<typeof openCdp>> | undefined;
  let pageSession = "";
  let error: string | null = null;
  const requests: RequestEvidence[] = [];
  const blocked: {
    url: string;
    type?: string;
    sessionId?: string;
    requestId: string;
    errorText?: string;
    blockedReason: string;
  }[] = [];
  const unexpectedExternal: string[] = [];
  const workerTargets: WorkerTargetEvidence[] = [];
  const setupErrors: string[] = [];
  let prepared: Awaited<ReturnType<typeof prepareLoadedExtension>> | undefined;
  let browserVersion: unknown = null;
  let loadedState: any = null;
  let screenshot: { path: string; bytes: number; sha256: string } | null = null;
  let safeExternalAttempts: string[] | null = null;

  try {
    prepared = await prepareLoadedExtension();
    chrome = await launchChrome({
      extension: prepared.destination,
      profile,
      windowSize: "1440,1000",
    });
    cdp = await openCdp(chrome.wsUrl, { timeoutMs: 30_000 });
    browserVersion = (await cdp.send("Browser.getVersion")).result;
    const serviceWorker = await waitForServiceWorker(cdp.send, {
      timeoutMs: 20_000,
      match: (target) =>
        target.type === "service_worker" &&
        target.url.endsWith("/dist/background/service-worker.js"),
    });
    if (!serviceWorker) {
      throw new Error(
        "copied production extension did not register its service worker",
      );
    }
    const extensionId = new URL(serviceWorker.url).host;
    const expectedControlUrl = prepared.snapshot.expectedExternalControlAttempt;

    cdp.on("Network.requestWillBeSent", (params, sessionId) => {
      const request = {
        url: String(params.request.url),
        type: params.type,
        sessionId,
        requestId: params.requestId,
      };
      requests.push(request);
      if (
        /^https?:/.test(request.url) && request.url !== expectedControlUrl
      ) {
        unexpectedExternal.push(request.url);
      }
    });
    cdp.on("Network.loadingFailed", (params, sessionId) => {
      if (params.blockedReason !== "inspector") return;
      const failure = correlateInspectorBlock(requests, params, sessionId);
      if (failure) blocked.push(failure);
      else {
        setupErrors.push(
          `uncorrelated inspector block ${
            sessionId ?? "root"
          }/${params.requestId}`,
        );
      }
    });
    cdp.on("Target.attachedToTarget", (params) => {
      if (params.targetInfo.type !== "worker") return;
      const row = {
        targetId: params.targetInfo.targetId,
        url: params.targetInfo.url,
        sessionId: params.sessionId,
        configuredBeforeRun: false,
      };
      workerTargets.push(row);
      setupAttachedWorker(cdp!.send, row, setupErrors);
    });

    const page = await cdp.open("about:blank");
    pageSession = page.sessionId;
    await configureExternalRequestBlocking(cdp.send, pageSession);
    await cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }, pageSession);
    await cdp.send("Page.navigate", {
      url: `chrome-extension://${extensionId}/${PROBE_DEST}/probe.html`,
    }, pageSession);

    const waitForPhase = async (wanted: string, timeout = 60_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const phase = await cdp?.eval(
          pageSession,
          "globalThis.__capEmscriptenProbe?.phase",
        ).catch(() => null);
        assertWorkerSetupSucceeded(setupErrors);
        if (phase === wanted) return;
        if (phase === "failed") {
          throw new Error(
            await cdp?.eval(
              pageSession,
              "globalThis.__capEmscriptenProbe.error",
            ),
          );
        }
        await sleep(100);
      }
      throw new Error(`timed out waiting for loaded probe phase ${wanted}`);
    };

    await waitForPhase("safe-ready");
    assertWorkerSetupSucceeded(setupErrors);
    safeExternalAttempts = [
      ...new Set([
        ...requests.map((entry) => entry.url),
        ...blocked.map((entry) => entry.url),
      ].filter((url) => /^https?:/.test(url))),
    ];
    if (safeExternalAttempts.length) {
      throw new Error(
        `safe profile attempted external requests: ${
          safeExternalAttempts.join(", ")
        }`,
      );
    }
    if (
      workerTargets.length < 11 ||
      workerTargets.some((target) => !target.configuredBeforeRun)
    ) {
      throw new Error(
        `worker targets were not all configured before execution: ${
          JSON.stringify(workerTargets)
        }`,
      );
    }

    await cdp.eval(pageSession, "globalThis.__capStartUnsafeControl()");
    await waitForPhase("complete");
    loadedState = await cdp.eval(
      pageSession,
      "globalThis.__capEmscriptenProbe",
    );
    assertWorkerSetupSucceeded(setupErrors);
    if (unexpectedExternal.length) {
      throw new Error(
        `unexpected external request attempts: ${
          unexpectedExternal.join(", ")
        }`,
      );
    }
    const blockedUrls = [...new Set(blocked.map((entry) => entry.url))];
    if (
      blocked.length !== 1 || blockedUrls.length !== 1 ||
      blockedUrls[0] !== expectedControlUrl
    ) {
      throw new Error(
        `unsafe control request was not observed and blocked exactly: ${
          JSON.stringify(blockedUrls)
        }`,
      );
    }

    const expectedAssets = new Set<string>(
      prepared.snapshot.assets.map((asset: any) =>
        String(asset.destination.split("/").at(-1))
      ),
    );
    const verifiedAssets = verifiedAssetNames(loadedState);
    verifiedAssets.add("probe.html");
    verifiedAssets.add("probe-page.mjs");
    verifiedAssets.add("probe-worker.mjs");
    const missingAssets = [...expectedAssets].filter((asset) =>
      !verifiedAssets.has(asset)
    );
    if (missingAssets.length) {
      throw new Error(
        `loaded asset closure was incomplete: ${missingAssets.join(", ")}`,
      );
    }

    const allowedPaths = new Set<string>(
      prepared.snapshot.assets.map((asset: any) =>
        `/${PROBE_DEST}/${asset.destination}`
      ),
    );
    allowedPaths.add(`/${PROBE_DEST}/snapshot.json`);
    const unexpectedLocal = requests
      .map((entry) => entry.url)
      .filter((url) => url.startsWith(`chrome-extension://${extensionId}/`))
      .map((url) => new URL(url).pathname)
      .filter((pathname) => !allowedPaths.has(pathname));
    if (unexpectedLocal.length) {
      throw new Error(
        `unexpected local probe assets: ${unexpectedLocal.join(", ")}`,
      );
    }

    const shot = await cdp.screenshot(pageSession, {
      fromSurface: false,
      captureBeyondViewport: true,
    });
    if (!shot) throw new Error("loaded native proof screenshot failed");
    const screenshotPath = join(evidence, "loaded-proof.png");
    await Deno.writeFile(screenshotPath, shot);
    screenshot = {
      path: screenshotPath,
      bytes: shot.length,
      sha256: await digest(shot),
    };
  } catch (reason) {
    error = errorText(reason);
    console.error(error);
  } finally {
    error = await finalizeLoadedProof({
      evidence,
      profile,
      error,
      prepared,
      browserVersion,
      loadedState,
      requests,
      blocked,
      unexpectedExternal,
      workerTargets,
      setupErrors,
      screenshot,
      safeExternalAttempts,
      cdp,
      chrome,
    });
    console.log(`RESULT: ${error ? "RED" : "GREEN"}; evidence ${evidence}`);
  }
  Deno.exit(error ? 1 : 0);
}

if (import.meta.main) await main();
