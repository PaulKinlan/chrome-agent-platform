// @ts-nocheck — response/fetch doubles intentionally implement only the probe surface.
import {
  isPublisherSourceUrl,
  LOCAL_MODEL_CATALOG,
  localModelFeasibility,
  PREFLIGHT_RANGE,
  preflightLocalModel,
  probePublisherFile,
} from "../extension/lib/local-model-catalog.js";

const EXPECTED = [
  {
    id: "gemma-4-e4b-it-qat-q4_0",
    revision: "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
    baseRevision: "ee0ef6023621cff504d758262d4e04895a5af4a2",
    installedBytes: 6_146_493_536,
    installedGiB: "5.72 GiB",
    files: [
      [
        "gemma-4-E4B_q4_0-it.gguf",
        5_154_941_280,
        "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee",
      ],
      [
        "gemma-4-E4B-it-mmproj.gguf",
        991_552_256,
        "7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578",
      ],
    ],
  },
  {
    id: "gemma-4-26b-a4b-it-qat-q4_0",
    revision: "d1c082be9cf3c8a514acf63b8761f4b41935842e",
    baseRevision: "4d7ae4984b7db7de8f8457170b3f1a419ee76d52",
    installedBytes: 15_634_191_744,
    installedGiB: "14.56 GiB",
    files: [
      [
        "gemma-4-26B_q4_0-it.gguf",
        14_439_363_584,
        "3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d",
      ],
      [
        "gemma-4-26B-it-mmproj.gguf",
        1_194_828_160,
        "a359953a076b877db30c31dbbb4c6d93b4a6e017ee5db5784247e4d4c0dd4f3b",
      ],
    ],
  },
];

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function rangeResponse(file, overrides = {}) {
  return {
    redirected: true,
    url: "https://cdn-lfs-us-1.hf.co/repos/example",
    status: 206,
    headers: new Headers({
      "content-range": `bytes 0-0/${file.bytes}`,
      "content-length": "1",
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0]));
        controller.close();
      },
    }),
    ...overrides,
  };
}

Deno.test("local model catalog binds exact official revisions, files, sizes and SHA-256 pins", () => {
  assert(Object.isFrozen(LOCAL_MODEL_CATALOG), "catalog must be frozen");
  assert(
    LOCAL_MODEL_CATALOG.length === 2,
    "catalog widened beyond two Gemma 4 entries",
  );
  for (let i = 0; i < EXPECTED.length; i++) {
    const actual = LOCAL_MODEL_CATALOG[i];
    const expected = EXPECTED[i];
    assert(actual.id === expected.id, `wrong id at ${i}`);
    assert(
      actual.revision === expected.revision,
      `wrong artifact revision for ${actual.id}`,
    );
    assert(
      actual.baseRevision === expected.baseRevision,
      `wrong base revision for ${actual.id}`,
    );
    assert(
      actual.installedBytes === expected.installedBytes,
      `wrong installed bytes for ${actual.id}`,
    );
    assert(
      actual.installedGiB === expected.installedGiB,
      `wrong size display for ${actual.id}`,
    );
    assert(actual.files.length === 2, `model+mmproj required for ${actual.id}`);
    actual.files.forEach((file, j) => {
      const [name, bytes, sha256] = expected.files[j];
      assert(
        file.name === name && file.bytes === bytes && file.sha256 === sha256,
        `wrong file pin ${actual.id}/${j}`,
      );
      assert(
        isPublisherSourceUrl(file.url),
        `non-publisher source ${file.url}`,
      );
      assert(
        new URL(file.url).hostname === "huggingface.co",
        "catalog contains a third-party host",
      );
      assert(
        file.url.includes(`/${actual.revision}/`),
        "URL is not revision pinned",
      );
    });
  }
});

Deno.test("publisher probe sends a bounded one-byte Range request without credentials", async () => {
  const file = LOCAL_MODEL_CATALOG[0].files[0];
  let request;
  const result = await probePublisherFile(file, {
    fetchImpl: async (url, init) => {
      request = { url, init };
      return rangeResponse(file);
    },
  });
  assert(result.ok, result.error ?? "probe failed");
  assert(request.url === file.url, "probe changed the pinned URL");
  assert(request.init.method === "GET", "probe was not GET");
  assert(
    request.init.headers.Range === PREFLIGHT_RANGE,
    "probe range was not bytes=0-0",
  );
  assert(request.init.credentials === "omit", "credentials were not omitted");
  assert(
    request.init.redirect === "follow",
    "redirect mode must be follow (the browser chases the publisher → CDN hops natively; the final response.url is validated)",
  );
  assert(
    request.init.cache === "no-store",
    "probe could use a stale cache entry",
  );
  assert(
    request.init.referrerPolicy === "no-referrer",
    "probe leaked a referrer",
  );
});

Deno.test("publisher probe validates the FINAL response.url against the delivery allowlist", async () => {
  const file = LOCAL_MODEL_CATALOG[0].files[0];
  // The browser follows the redirect; the FINAL url is a hostile host.
  const hostile = await probePublisherFile(file, {
    fetchImpl: async () => rangeResponse(file, { url: "https://evil.example/file.gguf" }),
  });
  assert(!hostile.ok && hostile.error.includes("allowlist"), `hostile final url passed: ${hostile.error}`);
  // A wrong scheme on a trusted-looking host is refused.
  const scheme = await probePublisherFile(file, {
    fetchImpl: async () => rangeResponse(file, { url: "http://cdn.hf.co/file.gguf" }),
  });
  assert(!scheme.ok && scheme.error.includes("allowlist"), `http final url passed: ${scheme.error}`);
});

Deno.test("publisher probe fails closed on an opaque (status 0 / empty url) cross-origin response", async () => {
  const file = LOCAL_MODEL_CATALOG[0].files[0];
  // A cross-origin redirect without the CDN's CORP/CORS grant surfaces as an
  // OPAQUE response: status 0 and an empty url. The final-url validation
  // rejects it before any status/header/body trust.
  const result = await probePublisherFile(file, {
    fetchImpl: async () => rangeResponse(file, { status: 0, url: "" }),
  });
  assert(!result.ok && result.error.includes("allowlist"), `opaque response passed: ${result.error}`);
});

Deno.test("publisher probe honors ONE absolute deadline (no clock reset)", async () => {
  const file = LOCAL_MODEL_CATALOG[0].files[0];
  const started = Date.now();
  const result = await probePublisherFile(file, {
    timeoutMs: 120,
    fetchImpl: async (_url, init) => {
      // The fetch never completes: only the shared AbortController's deadline
      // can terminate it — the browser-follow redirects cannot reset the clock.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error(String(init.signal?.reason ?? "aborted"))),
        );
      });
    },
  });
  const elapsed = Date.now() - started;
  assert(!result.ok && result.error.includes("timed out"), `deadline not enforced: ${result.error}`);
  assert(elapsed >= 100 && elapsed < 2000, `deadline not absolute: ${elapsed}ms`);
});

Deno.test("publisher probe reports the browser's truthful redirect fields", async () => {
  const file = LOCAL_MODEL_CATALOG[0].files[0];
  const result = await probePublisherFile(file, {
    fetchImpl: async () => rangeResponse(file, {
      redirected: true,
      url: "https://cdn.hf.co/repos/b/2",
    }),
  });
  assert(result.ok, `probe failed: ${result.error}`);
  assert(
    result.redirected === true && result.finalUrl === "https://cdn.hf.co/repos/b/2",
    `redirected=${result.redirected} final=${result.finalUrl}`,
  );
  assert(!("hops" in result), "the manual-hop field must not survive the browser-follow schema");
});

Deno.test("publisher probe fails closed on status, Content-Range, Content-Length and body mismatches", async () => {
  const file = LOCAL_MODEL_CATALOG[0].files[0];
  const cases = [
    rangeResponse(file, { status: 200 }),
    rangeResponse(file, {
      headers: new Headers({
        "content-range": "bytes 0-0/9",
        "content-length": "1",
      }),
    }),
    rangeResponse(file, {
      headers: new Headers({
        "content-range": `bytes 0-0/${file.bytes}`,
        "content-length": "2",
      }),
    }),
    rangeResponse(file, {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1]));
          controller.close();
        },
      }),
    }),
  ];
  for (const response of cases) {
    const result = await probePublisherFile(file, {
      fetchImpl: async () => response,
    });
    assert(!result.ok, "malformed probe response passed");
  }
});

Deno.test("preflight stops at the first failed file and unknown models never reach fetch", async () => {
  const model = LOCAL_MODEL_CATALOG[0];
  let calls = 0;
  const failed = await preflightLocalModel(model, {
    fetchImpl: async () => {
      calls++;
      return rangeResponse(model.files[0], { status: 500 });
    },
  });
  assert(
    !failed.ok && calls === 1,
    "preflight did not fail closed immediately",
  );
  const unknown = await preflightLocalModel({ ...model }, {
    fetchImpl: async () => {
      calls++;
    },
  });
  assert(!unknown.ok && calls === 1, "unknown model reached fetch");
});

Deno.test("feasibility states no auto-eviction and reflects OPFS install and user removal policy", () => {
  const state = localModelFeasibility({
    deviceMemory: 4,
    memory64: false,
    opfs: false,
    availableStorageBytes: 1,
  });
  assert(!state.feasible, "infeasible environment marked feasible");
  assert(
    state.warnings.some((warning) => warning.includes("Memory64")),
    "Memory64 warning missing",
  );
  assert(
    state.warnings.some((warning) => warning.includes("OPFS")),
    "OPFS warning missing",
  );
  assert(
    state.opfsInstallImplemented === true,
    "OPFS install implemented state",
  );
  assert(state.automaticEviction === false, "automatic eviction disabled per settled policy");
  assert(
    state.userControlledRemoval === true && state.removalImplemented === true,
    "user-controlled removal enabled per settled policy",
  );
  assert(
    state.removalPolicy.includes("User-controlled model removal only"),
    "removal policy must state user-controlled removal only",
  );
});

Deno.test("local model UI contract exposes exact size, disabled-until-pass and truthful policy copy", async () => {
  const source = await Deno.readTextFile(
    new URL("../extension/shared/components.js", import.meta.url),
  );
  const options = await Deno.readTextFile(
    new URL("../extension/options/options.html", import.meta.url),
  );
  assert(
    source.includes("`${model.installedGiB} installed payload`"),
    "installed size is not rendered",
  );
  assert(
    source.includes('download.disabled = probe.state !== "passed"'),
    "Download is not probe gated",
  );
  assert(
    source.includes(
      "Publisher-source downloads only. Stored locally in Origin Private File System (OPFS). User-controlled removal; automatic eviction is disabled.",
    ),
    "policy copy must state publisher downloads and user-controlled removal",
  );
  assert(
    source.includes('preflight.setAttribute("aria-label", `Probe publisher for ${model.name}`)'),
    "Probe lacks the model-bound accessible name",
  );
  assert(
    source.includes('download.setAttribute("aria-label", `Download ${model.name}`)'),
    "Download lacks the model-bound accessible name",
  );
  assert(
    options.includes('<local-model-catalog id="local-model-catalog">'),
    "Settings does not host shared component",
  );
});
