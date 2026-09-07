// Test-only extension-origin worker. Every executable path is a literal.
const assetUrl = (name) =>
  new URL(
    name === "authority-child.mjs" ? `./${name}` : `./assets/${name}`,
    import.meta.url,
  );
const verified = new Set();
let active = false;

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifiedBytes(name, pins) {
  const response = await fetch(assetUrl(name));
  if (!response.ok) {
    throw new Error(`asset read failed: ${name}: ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const digest = await sha256(bytes);
  if (digest !== pins[name]) {
    throw new Error(`asset hash drift: ${name}: ${digest}`);
  }
  verified.add(name);
  return new Uint8Array(bytes);
}

async function verifiedFactory(name, pins) {
  await verifiedBytes(name, pins);
  switch (name) {
    case "numeric.mjs":
      return (await import("./assets/numeric.mjs")).default;
    case "image-resize.mjs":
      return (await import("./assets/image-resize.mjs")).default;
    case "link-main.mjs":
      return (await import("./assets/link-main.mjs")).default;
    case "negative-main-em-asm.mjs":
      return (await import("./assets/negative-main-em-asm.mjs")).default;
    case "negative-main-em-js.mjs":
      return (await import("./assets/negative-main-em-js.mjs")).default;
    case "unsafe-authority.mjs":
      return (await import("./assets/unsafe-authority.mjs")).default;
    default:
      throw new Error(`factory is not in the fixed probe registry: ${name}`);
  }
}

async function positive(kind, pins) {
  if (kind === "numeric") {
    const factory = await verifiedFactory("numeric.mjs", pins);
    const module = await factory({
      wasmBinary: await verifiedBytes("numeric.wasm", pins),
    });
    return { output: module._cap_weighted_sum(6, 7, 0.5) };
  }
  if (kind === "image") {
    const factory = await verifiedFactory("image-resize.mjs", pins);
    const module = await factory({
      wasmBinary: await verifiedBytes("image-resize.wasm", pins),
    });
    const source = Uint8Array.from([
      255,
      0,
      0,
      255,
      0,
      255,
      0,
      255,
      0,
      0,
      255,
      255,
      255,
      255,
      255,
      255,
    ]);
    const input = module._malloc(source.length);
    const output = module._malloc(4);
    try {
      module.HEAPU8.set(source, input);
      const status = module._cap_resize_rgba(input, 2, 2, output, 1, 1);
      return { status, output: [...module.HEAPU8.slice(output, output + 4)] };
    } finally {
      module._free(input);
      module._free(output);
    }
  }
  if (kind === "link") {
    const factory = await verifiedFactory("link-main.mjs", pins);
    await verifiedBytes("link-side.wasm", pins);
    const module = await factory({
      wasmBinary: await verifiedBytes("link-main.wasm", pins),
    });
    return { output: module._cap_linked_compute(35) };
  }
  throw new Error(`unknown positive fixture: ${kind}`);
}

async function embedded(kind, pins) {
  const stem = kind === "em-asm"
    ? "negative-main-em-asm"
    : "negative-main-em-js";
  const side = kind === "em-asm"
    ? "negative-side-em-asm.wasm"
    : "negative-side-em-js.wasm";
  const factory = await verifiedFactory(`${stem}.mjs`, pins);
  await verifiedBytes(side, pins);
  const module = await factory({
    wasmBinary: await verifiedBytes(`${stem}.wasm`, pins),
  });
  return { unexpectedlyLinked: true, output: module._cap_linked_compute(35) };
}

async function rejectImport(factoryName, adversaryName, pins) {
  const factory = await verifiedFactory(factoryName, pins);
  const adversary = await verifiedBytes(adversaryName, pins);
  try {
    await factory({ wasmBinary: adversary, printErr: () => {} });
  } catch (error) {
    const message = String(error);
    if (
      !/LinkError/.test(message) ||
      !/cap_(ambient_global_probe|attempt_browser_authority)/.test(message)
    ) {
      throw new Error(`wrong adversarial-import refusal: ${message}`);
    }
    return { outcome: "refused-at-native-import", error: message };
  }
  throw new Error(`${factoryName} instantiated ${adversaryName}`);
}

async function unsafeControl(pins) {
  await verifiedBytes("authority-child.mjs", pins);
  const factory = await verifiedFactory("unsafe-authority.mjs", pins);
  const module = await factory({
    wasmBinary: await verifiedBytes("unsafe-authority.wasm", pins),
  });
  const output = module._cap_run_authority_attempt();
  const authority = await globalThis.__capAuthorityProbePromise;
  return { output, authority };
}

async function run(request) {
  const { operation, pins } = request;
  if (operation === "positive") return positive(request.fixture, pins);
  if (operation === "embedded") return embedded(request.fixture, pins);
  if (operation === "reject-import") {
    return rejectImport(request.factory, request.adversary, pins);
  }
  if (operation === "unsafe-control") return unsafeControl(pins);
  throw new Error(`operation is not in the fixed probe registry: ${operation}`);
}

function finish(payload) {
  if (!active) return;
  active = false;
  postMessage({ ...payload, verifiedAssets: [...verified].sort() });
}

addEventListener("error", (event) => {
  event.preventDefault();
  finish({ ok: false, error: event.error?.stack ?? event.message });
});
addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  finish({ ok: false, error: String(event.reason?.stack ?? event.reason) });
});
addEventListener("message", async (event) => {
  if (active) {
    return finish({ ok: false, error: "worker accepts exactly one operation" });
  }
  active = true;
  try {
    finish({
      ok: true,
      value: await run(event.data),
      environment: {
        origin: location.origin,
        crossOriginIsolated,
        hasFetch: typeof fetch === "function",
        hasStorage: typeof navigator.storage?.getDirectory === "function",
        hasWorker: typeof Worker === "function",
      },
    });
  } catch (error) {
    finish({ ok: false, error: String(error?.stack ?? error) });
  }
});
