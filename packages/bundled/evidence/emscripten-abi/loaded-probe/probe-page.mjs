// Test-only orchestrator. Worker operations and assets are fixed in source.
const phase = document.querySelector("#phase");
const output = document.querySelector("#results");
const state = {
  phase: "starting",
  environment: {
    origin: location.origin,
    crossOriginIsolated,
    userAgent: navigator.userAgent,
  },
  safe: null,
  unsafeControl: null,
  error: null,
};
globalThis.__capEmscriptenProbe = state;

function render() {
  phase.textContent = state.phase;
  output.textContent = JSON.stringify(state, null, 2);
}

async function runWorker(request) {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("probe-worker.mjs", import.meta.url), {
      type: "module",
    });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`worker timeout: ${JSON.stringify(request)}`));
    }, 15_000);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(request);
  });
}

function requireResult(condition, message, detail) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`);
}

async function safeProof(pins) {
  const positive = {};
  for (const fixture of ["numeric", "image", "link"]) {
    positive[fixture] = await runWorker({
      operation: "positive",
      fixture,
      pins,
    });
    requireResult(
      positive[fixture].ok,
      `${fixture} did not run`,
      positive[fixture],
    );
    requireResult(
      positive[fixture].environment.origin.startsWith("chrome-extension://") &&
        positive[fixture].environment.crossOriginIsolated,
      `${fixture} did not run in an isolated extension-origin worker`,
      positive[fixture].environment,
    );
  }
  requireResult(
    positive.numeric.value.output === 42.5,
    "numeric golden mismatch",
    positive.numeric,
  );
  requireResult(
    positive.image.value.status === 1 &&
      positive.image.value.output.join(",") === "128,128,128,255",
    "image golden mismatch",
    positive.image,
  );
  requireResult(
    positive.link.value.output === 42,
    "linked golden mismatch",
    positive.link,
  );

  const embedded = {};
  for (const fixture of ["em-asm", "em-js"]) {
    embedded[fixture] = await runWorker({
      operation: "embedded",
      fixture,
      pins,
    });
    requireResult(
      !embedded[fixture].ok &&
        /DYNAMIC_EXECUTION=0 was set, cannot eval/.test(
          embedded[fixture].error,
        ),
      `${fixture} did not fail at the no-eval linker guard`,
      embedded[fixture],
    );
  }

  const refusedImports = [];
  for (const factory of ["numeric.mjs", "image-resize.mjs", "link-main.mjs"]) {
    for (const adversary of ["negative-global.wasm", "unsafe-authority.wasm"]) {
      const result = await runWorker({
        operation: "reject-import",
        factory,
        adversary,
        pins,
      });
      requireResult(
        result.ok && result.value.outcome === "refused-at-native-import" &&
          /LinkError/.test(result.value.error),
        `${factory} did not reject ${adversary} at the native import boundary`,
        result,
      );
      refusedImports.push({
        factory,
        adversary,
        ...result.value,
        verifiedAssets: result.verifiedAssets,
      });
    }
  }
  return { positive, embedded, refusedImports };
}

try {
  const snapshotResponse = await fetch("snapshot.json");
  if (!snapshotResponse.ok) {
    throw new Error(`snapshot read failed: ${snapshotResponse.status}`);
  }
  const snapshot = await snapshotResponse.json();
  const pins = Object.fromEntries(
    snapshot.assets.map((
      asset,
    ) => [asset.destination.split("/").at(-1), asset.sha256]),
  );
  state.snapshot = {
    format: snapshot.format,
    baselineCommit: snapshot.baselineCommit,
    historicalManifestSha256: snapshot.manifest.sha256,
  };
  state.safe = await safeProof(pins);
  state.phase = "safe-ready";
  render();

  globalThis.__capStartUnsafeControl = async () => {
    if (state.phase !== "safe-ready") {
      throw new Error(`unsafe control cannot start during ${state.phase}`);
    }
    state.phase = "unsafe-control-running";
    render();
    const result = await runWorker({ operation: "unsafe-control", pins });
    requireResult(
      result.ok && result.value.output === 0x434150,
      "unsafe control did not execute",
      result,
    );
    requireResult(
      result.value.authority.network === "blocked" &&
        result.value.authority.storage === "opened" &&
        result.value.authority.worker === "started",
      "unsafe control did not demonstrate all ambient Worker authority",
      result,
    );
    state.unsafeControl = result;
    state.phase = "complete";
    render();
    return state;
  };
} catch (error) {
  state.error = String(error?.stack ?? error);
  state.phase = "failed";
  render();
}
render();
