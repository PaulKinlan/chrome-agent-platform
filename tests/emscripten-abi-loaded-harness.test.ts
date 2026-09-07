// chrome-agent-platform-ltkj.1 — static/local checks only; never launches Chrome.
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";

const root = "packages/bundled/evidence/emscripten-abi";
const snapshotPath = `${root}/loaded-probe/snapshot.json`;
const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array) =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer),
    ),
  );

Deno.test("loaded Emscripten probe snapshot binds shipped CSP and every test-only asset", async () => {
  const snapshotBytes = await Deno.readFile(snapshotPath);
  const snapshotDigest = await sha256(snapshotBytes);
  const snapshot = JSON.parse(new TextDecoder().decode(snapshotBytes));
  assertEquals(snapshot.format, "cap-emscripten-abi-loaded-probe-v1");
  assertEquals(snapshot.assets.length, 20);
  assertEquals(
    snapshot.manifest.sha256,
    "70bd0c50f6a9158083f23f228a993300c23b54a85be14121ad38721e03623e7a",
  );
  assertEquals(
    snapshot.manifest.extensionPagesCsp,
    "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-src 'self' about: blob: data:",
  );
  assertEquals(
    snapshotDigest,
    "081ee1b8f6a70e93af8bf44ee0620def12103331325e5a59620cb41fede51f45",
  );
  const harness = Deno.readTextFileSync("scripts/emscripten-abi-loaded.ts");
  assert(
    harness.includes(snapshotDigest),
    "harness hard pin must match snapshot bytes",
  );
  assertEquals(snapshot.manifest.historicalVersion, "0.3.256");
  assertEquals(snapshot.manifest.historicalVersionName, "0.3.256");
  assertEquals(snapshot.manifest.releaseFieldsAllowedToDiffer, [
    "version",
    "version_name",
  ]);
  assertEquals(
    snapshot.manifest.nonReleaseContractSha256,
    "2c865a5783d1d063055f5595b93c69e3762dc47ebf78446f4c1fc5d334bb2288",
  );
  const manifestBytes = await Deno.readFile(snapshot.manifest.source);
  const { verifyCurrentManifest } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const current = await verifyCurrentManifest(manifestBytes, snapshot.manifest);
  assertEquals(current.bytes, manifestBytes.length);
  assertEquals(current.sha256, await sha256(manifestBytes));
  assertEquals(current.value.version, current.version);
  assertEquals(
    current.value.content_security_policy.extension_pages,
    snapshot.manifest.extensionPagesCsp,
  );
  for (const source of [...snapshot.sourcePins, ...snapshot.assets]) {
    const file = `${root}/${source.path ?? source.source}`;
    const bytes = await Deno.readFile(file);
    assertEquals(bytes.length, source.bytes, file);
    assertEquals(await sha256(bytes), source.sha256, file);
  }
  const authorityBytes = await Deno.readFile(
    `${root}/loaded-probe/assets/unsafe-authority.wasm`,
  );
  assertEquals(
    WebAssembly.Module.imports(new WebAssembly.Module(authorityBytes)),
    [{
      module: "env",
      name: "cap_attempt_browser_authority",
      kind: "function",
    }],
  );
  const destinations: string[] = snapshot.assets.map((asset: any) =>
    asset.destination
  );
  assertEquals(new Set(destinations).size, destinations.length);
  assertEquals(
    destinations.some((name) => name.startsWith("/") || name.includes("..")),
    false,
  );
  assertEquals(
    snapshot.assets.filter((asset: any) => asset.role === "positive").length,
    7,
  );
  assertEquals(
    snapshot.assets.filter((asset: any) => asset.role === "negative").length,
    7,
  );
  assertEquals(
    snapshot.assets.filter((asset: any) => asset.role === "unsafe-control")
      .length,
    2,
  );
  await Deno.stat("extension/_emscripten_abi_probe").then(
    () => assert(false, "test-only probe leaked into the production extension"),
    () => {},
  );
});

Deno.test("manifest contract accepts only version fields and refuses non-version or CSP drift", async () => {
  const { verifyCurrentManifest } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const snapshot = JSON.parse(await Deno.readTextFile(snapshotPath));
  const manifest = JSON.parse(
    await Deno.readTextFile(snapshot.manifest.source),
  );
  const release = {
    ...manifest,
    version: "0.3.257",
    version_name: "0.3.257",
  };
  const accepted = await verifyCurrentManifest(
    new TextEncoder().encode(JSON.stringify(release)),
    snapshot.manifest,
  );
  assertEquals(accepted.version, "0.3.257");
  assertEquals(accepted.versionName, "0.3.257");
  assert(
    accepted.sha256 !== snapshot.manifest.sha256,
    "version-only release must bind its current digest, not the historical digest",
  );

  const nonRelease = structuredClone(release);
  nonRelease.permissions = [...nonRelease.permissions, "tabs"];
  await assertRejects(
    () =>
      verifyCurrentManifest(
        new TextEncoder().encode(JSON.stringify(nonRelease)),
        snapshot.manifest,
      ),
    Error,
    "non-release contract drift",
  );

  const cspDrift = structuredClone(release);
  cspDrift.content_security_policy.extension_pages = "script-src 'self'";
  await assertRejects(
    () =>
      verifyCurrentManifest(
        new TextEncoder().encode(JSON.stringify(cspDrift)),
        snapshot.manifest,
      ),
    Error,
    "CSP drift",
  );
});

Deno.test("copied-tree and pinned-asset drift are refused by executed verifiers", async () => {
  const { treeRecords, verifyCopiedTree, verifyPinnedFile } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const temporary = await Deno.makeTempDir();
  const source = `${temporary}/source`;
  const copied = `${temporary}/copied`;
  await Deno.mkdir(source);
  await Deno.mkdir(copied);
  await Deno.writeTextFile(`${source}/manifest.json`, "source bytes");
  await Deno.writeTextFile(`${copied}/manifest.json`, "source bytes");
  const sourceClosure = await treeRecords(source);
  await verifyCopiedTree(sourceClosure, copied);
  await Deno.writeTextFile(`${copied}/manifest.json`, "drifted bytes");
  await assertRejects(
    () => verifyCopiedTree(sourceClosure, copied),
    Error,
    "not byte-identical",
  );

  const snapshot = JSON.parse(await Deno.readTextFile(snapshotPath));
  const asset = snapshot.assets.find((entry: any) =>
    entry.destination === "assets/numeric.wasm"
  );
  const assetCopy = `${temporary}/numeric.wasm`;
  const bytes = await Deno.readFile(`${root}/${asset.source}`);
  bytes[0] ^= 1;
  await Deno.writeFile(assetCopy, bytes);
  await assertRejects(
    () => verifyPinnedFile(assetCopy, asset, asset.destination),
    Error,
    "loaded probe asset drift",
  );
  await Deno.remove(temporary, { recursive: true });
});

for (const kind of ["file", "empty-directory", "descendant", "file-link", "directory-link", "dangling-link"]) {
  Deno.test(`j7km: pre-existing probe ${kind} is refused without modifying the tree`, async () => {
    const { assertNoExistingProbe, treeRecords } = await import(
      new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
    );
    const extension = await Deno.makeTempDir();
    const probe = `${extension}/_emscripten_abi_probe`;
    try {
      if (kind === "file") await Deno.writeTextFile(probe, "reserved file");
      else if (kind === "empty-directory") await Deno.mkdir(probe);
      else if (kind === "descendant") {
        await Deno.mkdir(`${probe}/nested`, { recursive: true });
        await Deno.writeTextFile(`${probe}/nested/fixture.wasm`, "reserved descendant");
      } else {
        if (kind === "file-link") await Deno.writeTextFile(`${extension}/target`, "target bytes");
        if (kind === "directory-link") await Deno.mkdir(`${extension}/target`);
        await Deno.symlink("target", probe);
      }
      const before = await treeRecords(extension);
      await assertRejects(
        () => assertNoExistingProbe(extension),
        Error,
        "production extension unexpectedly contains the test-only probe path",
      );
      assertEquals(await treeRecords(extension), before);
      assertEquals((await Deno.lstat(probe)).isDirectory, ["empty-directory", "descendant"].includes(kind));
    } finally {
      await Deno.remove(extension, { recursive: true });
    }
  });
}

Deno.test("j7km: absent probe permits neighboring prefixes and preserves rooted closure keys", async () => {
  const { assertNoExistingProbe, treeRecords } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const extension = await Deno.makeTempDir();
  try {
    await assertNoExistingProbe(extension);
    await Deno.writeTextFile(`${extension}/_emscripten_abi_probe-other`, "neighbor");
    await Deno.mkdir(`${extension}/_emscripten_abi_probe_backup`);
    await Deno.writeTextFile(`${extension}/_emscripten_abi_probe_backup/child`, "neighbor child");
    await Deno.symlink("missing", `${extension}/_emscripten_abi_probe-link`);
    const before = await treeRecords(extension);
    assertEquals(Object.keys(before).sort(), [
      "/_emscripten_abi_probe-other",
      "/_emscripten_abi_probe-link",
      "/_emscripten_abi_probe_backup/child",
    ].sort());
    await assertNoExistingProbe(extension);
    assertEquals(await treeRecords(extension), before);
  } finally {
    await Deno.remove(extension, { recursive: true });
  }
});

Deno.test("dqxa: prepareLoadedExtension refuses a pre-existing probe before destination copying or injection", async () => {
  const { prepareLoadedExtension, treeRecords } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const { durableDir } = await import("../scripts/lib/durable-root.mjs");
  const extension = new URL("../extension", import.meta.url).pathname;
  const probe = `${extension}/_emscripten_abi_probe`;
  // Never replace a real fixture, including a dangling link. mkdir below also
  // refuses a path created after this check; only our empty directory is removed.
  await assertRejects(() => Deno.lstat(probe), Deno.errors.NotFound);
  const before = await treeRecords(extension);
  const makeTempDir = Deno.makeTempDir;
  const scratch = await makeTempDir({
    dir: durableDir("scratch"),
    prefix: "cap-emscripten-prepare-test-",
  });
  const destinations: string[] = [];
  let ownsProbe = false;
  try {
    // Observe the real allocation/copy path, forwarding to native filesystem
    // operations inside a fresh test-owned directory (no retained loaded copy).
    Deno.makeTempDir = async (options) => {
      assertEquals(options?.dir, durableDir("scratch"));
      assertEquals(options?.prefix, "cap-emscripten-loaded-ext-");
      const destination = await makeTempDir({ ...options, dir: scratch });
      destinations.push(destination);
      return destination;
    };
    // Positive control executes every real snapshot/Store/copy/asset check.
    // An unrelated early failure cannot stand in for the reserved-path refusal.
    const prepared = await prepareLoadedExtension();
    assertEquals(destinations, [prepared.destination]);
    assertEquals(prepared.sourceClosure, before);
    assertEquals(prepared.copiedClosure, before);
    assert(prepared.loadedClosure["/_emscripten_abi_probe/snapshot.json"]);

    // Empty directories add no indexed source bytes, so the real Store marker
    // stays valid. The guard must still refuse this reserved filesystem entry.
    await Deno.mkdir(probe);
    ownsProbe = true;
    await assertRejects(
      () => prepareLoadedExtension(),
      Error,
      "production extension unexpectedly contains the test-only probe path",
    );
    assertEquals(
      destinations.length,
      1,
      "reserved probe must be refused before allocating, copying or injecting a destination",
    );
    const probeEntries = [];
    for await (const entry of Deno.readDir(probe)) probeEntries.push(entry.name);
    assertEquals(probeEntries, []);
    assertEquals(await treeRecords(extension), before);
  } finally {
    Deno.makeTempDir = makeTempDir;
    try {
      if (ownsProbe) await Deno.remove(probe);
    } finally {
      await Deno.remove(scratch, { recursive: true });
    }
  }
});

Deno.test("worker setup uses Network blocking and correlates inspector failure evidence", async () => {
  const { configureExternalRequestBlocking, correlateInspectorBlock } =
    await import(
      new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
    );
  const calls: { method: string; params: unknown; sessionId?: string }[] = [];
  await configureExternalRequestBlocking(
    (method: string, params?: unknown, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      if (method === "Fetch.enable") {
        return Promise.reject(new Error("'Fetch.enable' wasn't found"));
      }
      return Promise.resolve({});
    },
    "worker-session",
  );
  assertEquals(calls, [
    { method: "Network.enable", params: {}, sessionId: "worker-session" },
    {
      method: "Network.setBlockedURLs",
      params: {
        urlPatterns: [
          { urlPattern: "http://*:*/*", block: true },
          { urlPattern: "https://*:*/*", block: true },
        ],
      },
      sessionId: "worker-session",
    },
  ]);

  const requests = [{
    url: "https://cap-native-authority.invalid/escape",
    type: "Fetch",
    sessionId: "worker-session",
    requestId: "request-1",
  }];
  assertEquals(
    correlateInspectorBlock(requests, {
      requestId: "request-1",
      type: "Fetch",
      errorText: "",
      blockedReason: "inspector",
    }, "worker-session"),
    {
      url: "https://cap-native-authority.invalid/escape",
      type: "Fetch",
      sessionId: "worker-session",
      requestId: "request-1",
      errorText: "",
      blockedReason: "inspector",
    },
  );
  assertEquals(
    correlateInspectorBlock(requests, {
      requestId: "request-1",
      blockedReason: "cors",
    }, "worker-session"),
    null,
  );
  assertEquals(
    correlateInspectorBlock(requests, {
      requestId: "request-1",
      blockedReason: "inspector",
    }, "other-session"),
    null,
  );
});

Deno.test("attached worker setup never resumes after a failed prerequisite", async () => {
  const { assertWorkerSetupSucceeded, setupAttachedWorker } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const methods = [
    "Network.enable",
    "Network.setBlockedURLs",
    "Target.setAutoAttach",
    "Runtime.runIfWaitingForDebugger",
  ];
  const cases = [
    { failedMethod: methods[0], targetId: "safe-network-enable-worker" },
    { failedMethod: methods[1], targetId: "safe-network-block-worker" },
    { failedMethod: methods[2], targetId: "unsafe-control-worker" },
  ];

  for (const { failedMethod, targetId } of cases) {
    const calls: string[] = [];
    const setupErrors: string[] = [];
    const target = {
      targetId,
      url: "chrome-extension://test/_emscripten_abi_probe/probe-worker.mjs",
      sessionId: `${targetId}-session`,
      configuredBeforeRun: false,
    };
    const configured = await setupAttachedWorker(
      (method: string) => {
        calls.push(method);
        return method === failedMethod
          ? Promise.reject(new Error(`injected ${method} failure`))
          : Promise.resolve({});
      },
      target,
      setupErrors,
    );

    assertEquals(configured, false);
    assertEquals(target.configuredBeforeRun, false);
    assertEquals(calls, methods.slice(0, methods.indexOf(failedMethod) + 1));
    assertEquals(calls.includes("Runtime.runIfWaitingForDebugger"), false);
    assertEquals(setupErrors, [
      `worker ${targetId}: Error: injected ${failedMethod} failure`,
    ]);
    assertThrows(
      () => assertWorkerSetupSucceeded(setupErrors),
      Error,
      `worker CDP setup failed: worker ${targetId}`,
    );
  }

  const calls: string[] = [];
  const setupErrors: string[] = [];
  const target = {
    targetId: "fully-configured-worker",
    url: "chrome-extension://test/_emscripten_abi_probe/probe-worker.mjs",
    sessionId: "successful-session",
    configuredBeforeRun: false,
  };
  assertEquals(
    await setupAttachedWorker(
      (method: string) => {
        calls.push(method);
        return Promise.resolve({});
      },
      target,
      setupErrors,
    ),
    true,
  );
  assertEquals(target.configuredBeforeRun, true);
  assertEquals(calls, methods);
  assertEquals(
    calls.filter((method) => method === "Runtime.runIfWaitingForDebugger")
      .length,
    1,
  );
  assertEquals(setupErrors, []);
  assertWorkerSetupSucceeded(setupErrors);
});

Deno.test("loaded harness uses canonical launch, durable custody, pre-run worker attach, request capture, and derived exit", () => {
  const source = Deno.readTextFileSync("scripts/emscripten-abi-loaded.ts");
  assertMatch(source, /launchChrome\(\{/);
  assertMatch(source, /waitForServiceWorker\(/);
  assertMatch(source, /durableDir\("scratch"\)/);
  assertEquals(source.match(/waitForDebuggerOnStart: true/g)?.length, 2);
  assertMatch(source, /Network\.requestWillBeSent/);
  assertMatch(source, /Network\.loadingFailed/);
  assertMatch(source, /Network\.setBlockedURLs/);
  assertMatch(source, /blockedReason !== "inspector"/);
  assertEquals(source.includes("Fetch.enable"), false);
  assertEquals(source.includes("Fetch.requestPaused"), false);
  assertEquals(source.includes("Fetch.failRequest"), false);
  assertMatch(source, /safeExternalAttempts/);
  assertMatch(source, /Deno\.exit\(error \? 1 : 0\)/);
  assertMatch(source, /!identity\.success/);
  assertEquals(source.match(/withTimeout\(status, 8_000\)/g)?.length, 2);
  assertMatch(source, /browser process teardown unconfirmed/);
  assertEquals(source.includes("--remote-debugging-port"), false);
  assertEquals(source.includes("Deno.makeTempDir({ prefix:"), false);
});

Deno.test("local safe factories reject both adversarial native imports before execution", async () => {
  const result = await new Deno.Command("node", {
    args: [`${root}/loaded-probe/local-import-refusal.mjs`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
  assertEquals(result.success, true, text);
  const report = JSON.parse(text.trim());
  assertEquals(report.cases, 6);
  assertEquals(
    report.outcome,
    "refused-at-native-import-before-guest-execution",
  );
  assertEquals(report.networkObservation, {
    instrumentedForFullProbeLifecycle: true,
    fetchAttempts: [],
  });
});

Deno.test("executed page aggregation retains assets used exclusively by refusal cases", async () => {
  const { verifiedAssetNames } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const snapshot = JSON.parse(await Deno.readTextFile(snapshotPath));
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const replaceGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  const resultFor = (request: any) => {
    const environment = {
      origin: "chrome-extension://test",
      crossOriginIsolated: true,
    };
    if (request.operation === "positive") {
      const values: Record<string, unknown> = {
        numeric: { output: 42.5 },
        image: { status: 1, output: [128, 128, 128, 255] },
        link: { output: 42 },
      };
      const assets: Record<string, string[]> = {
        numeric: ["numeric.mjs", "numeric.wasm"],
        image: ["image-resize.mjs", "image-resize.wasm"],
        link: ["link-main.mjs", "link-main.wasm", "link-side.wasm"],
      };
      return {
        ok: true,
        value: values[request.fixture],
        environment,
        verifiedAssets: assets[request.fixture],
      };
    }
    if (request.operation === "embedded") {
      const stem = `negative-main-${request.fixture}`;
      return {
        ok: false,
        error: "DYNAMIC_EXECUTION=0 was set, cannot eval",
        verifiedAssets: [
          `${stem}.mjs`,
          `${stem}.wasm`,
          `negative-side-${request.fixture}.wasm`,
        ],
      };
    }
    if (request.operation === "reject-import") {
      return {
        ok: true,
        value: {
          outcome: "refused-at-native-import",
          error: `LinkError: env.${
            request.adversary === "negative-global.wasm"
              ? "cap_ambient_global_probe"
              : "cap_attempt_browser_authority"
          }`,
        },
        verifiedAssets: [request.factory, request.adversary],
      };
    }
    return {
      ok: true,
      value: {
        output: 0x434150,
        authority: {
          network: "blocked",
          storage: "opened",
          worker: "started",
        },
      },
      verifiedAssets: [
        "authority-child.mjs",
        "unsafe-authority.mjs",
        "unsafe-authority.wasm",
      ],
    };
  };
  class ProbeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    constructor(_url: URL, _options: unknown) {}
    postMessage(request: unknown) {
      queueMicrotask(() => this.onmessage?.({ data: resultFor(request) }));
    }
    terminate() {}
  }

  replaceGlobal("document", {
    querySelector: () => ({ textContent: "" }),
  });
  replaceGlobal("location", { origin: "chrome-extension://test" });
  replaceGlobal("crossOriginIsolated", true);
  replaceGlobal("Worker", ProbeWorker);
  replaceGlobal("fetch", async () => ({
    ok: true,
    json: async () => snapshot,
  }));
  try {
    await import(
      `../packages/bundled/evidence/emscripten-abi/loaded-probe/probe-page.mjs?aggregation=${crypto.randomUUID()}`
    );
    const state = (globalThis as any).__capEmscriptenProbe;
    assertEquals(state.phase, "safe-ready", state.error);
    assertEquals(
      state.snapshot.historicalManifestSha256,
      snapshot.manifest.sha256,
    );
    assertEquals("manifestSha256" in state.snapshot, false);
    await (globalThis as any).__capStartUnsafeControl();
    assertEquals(state.phase, "complete", state.error);
    const verified = verifiedAssetNames(state);
    for (const asset of ["probe.html", "probe-page.mjs", "probe-worker.mjs"]) {
      verified.add(asset);
    }
    const expected = snapshot.assets.map((asset: any) =>
      asset.destination.split("/").at(-1)
    );
    assertEquals(expected.filter((asset: string) => !verified.has(asset)), []);
    assert(verified.has("negative-global.wasm"));
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
    delete (globalThis as any).__capEmscriptenProbe;
    delete (globalThis as any).__capStartUnsafeControl;
  }
});

Deno.test("report-write failure still executes all cleanup and remains RED", async () => {
  const { finalizeLoadedProof } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const profile = await Deno.makeTempDir();
  let browserClose = false;
  let processObserved = false;
  let cdpClose = false;
  const cdp = {
    send(command: string) {
      if (command === "Browser.close") browserClose = true;
      return Promise.resolve({});
    },
    close() {
      cdpClose = true;
    },
  };
  const chrome = {
    proc: {
      get status() {
        processObserved = true;
        return Promise.resolve({ success: true, code: 0, signal: null });
      },
      kill() {},
    },
  };
  const error = await finalizeLoadedProof({
    evidence: profile,
    profile,
    error: null,
    browserVersion: null,
    loadedState: null,
    requests: [],
    blocked: [],
    unexpectedExternal: [],
    workerTargets: [],
    setupErrors: [],
    screenshot: null,
    safeExternalAttempts: [],
    cdp: cdp as any,
    chrome: chrome as any,
    writeResult: async () => {
      assertEquals({ browserClose, processObserved, cdpClose }, {
        browserClose: true,
        processObserved: true,
        cdpClose: true,
      });
      const profileExists = await Deno.stat(profile).then(
        () => true,
        () => false,
      );
      assertEquals(profileExists, false);
      throw new Error("injected report write refusal");
    },
  });
  assertMatch(error ?? "", /injected report write refusal/);
  assertEquals(error ? 1 : 0, 1);
});

Deno.test("cleanup failure persists the same RED verdict returned to derived exit", async () => {
  const { finalizeLoadedProof } = await import(
    new URL("../scripts/emscripten-abi-loaded.ts", import.meta.url).href
  );
  const profile = await Deno.makeTempDir();
  let persisted = "";
  const error = await finalizeLoadedProof({
    evidence: profile,
    profile,
    error: null,
    browserVersion: null,
    loadedState: null,
    requests: [],
    blocked: [],
    unexpectedExternal: [],
    workerTargets: [],
    setupErrors: [],
    screenshot: null,
    safeExternalAttempts: [],
    cdp: {
      send: () => Promise.resolve({}),
      close: () => {
        throw new Error("injected CDP close failure");
      },
    } as any,
    writeResult: async (_path: string, data: string) => {
      persisted = data;
    },
  });
  const report = JSON.parse(persisted);
  assertMatch(error ?? "", /injected CDP close failure/);
  assertEquals(report.state, "RED");
  assertEquals(report.error, error);
  assertEquals(error ? 1 : 0, 1);
  assertMatch(report.sourceHead, /^[0-9a-f]{40,64}$/);
});

Deno.test("local runtime report corrects the resize filter and makes no unmeasured network claim", () => {
  const report = JSON.parse(
    Deno.readTextFileSync(`${root}/runtime-report.json`),
  );
  assertEquals(
    report.results.imageResize.operation,
    "stb linear-colorspace RGBA 2x2 to 1x1 using default Mitchell downsampling",
  );
  assertEquals(report.networkObservation.verdict, "not-measured");
  assertEquals("actualNetworkRequests" in report, false);
  const readme = Deno.readTextFileSync(`${root}/README.md`);
  assertMatch(readme, /Catmull–Rom is the default for\s+upsampling/);
  assertMatch(
    readme,
    /total imported-plus-defined global\s+counts/,
  );
  assertMatch(
    readme,
    /not a full typed-export\/global decoder or an admission validator/,
  );
});
