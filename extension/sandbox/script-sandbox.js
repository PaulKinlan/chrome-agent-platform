// sandbox/script-sandbox.js — the SANDBOXED extension page that runs an
// agent-generated script (Paul 2026-08-17). This page is declared in the
// manifest `sandbox` key, so it has NO access to chrome.* APIs, no same-origin,
// and its CSP permits the inline/eval execution that a regular extension page
// forbids (the extension CSP blocks inline scripts in srcdoc iframes). The host
// (the offscreen doc / NTP hub) loads this page in an iframe, sends the source +
// a one-time nonce over postMessage, bridges the controlled fetch, and receives
// the result back. The script's ONLY capabilities are `fetch(url, opts)` (the
// HOST fetches on the extension's behalf — URL-validated + size-bounded) and
// `log(...)` — no DOM of the host, no extension APIs, no direct network.

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const d = event.data;
  if (!d || typeof d !== "object" || d.type !== "cap:script-source") return;
  runScript(
    String(d.source ?? ""),
    String(d.runId ?? ""),
    String(d.nonce ?? ""),
    Array.isArray(d.modules) ? d.modules : []
  );
});

// chrome-agent-platform-np64 (2026-09-03): the manifest-sandbox page is an
// opaque origin (no allow-same-origin), so a script source that reaches for
// localStorage/sessionStorage/indexedDB/cookies/OPFS gets a raw SecurityError
// and the agent — who often guesses those APIs to cache state between runs —
// learns nothing. Redefine the known-broken storage surfaces so the thrown
// error TEACHES: a sandboxed script shares no state between runs, so compute
// and return the value; durable state lives with the platform (the agent's
// memory_set / create_asset), never in the script. window.fetch is NOT touched
// — it IS the script's controlled host-bridged api.
(function installScriptSandboxTeachGuards() {
  const fix = "a sandboxed script keeps no state between runs - compute and return the value; store durable data with the platform (memory_set / create_asset) from the agent side";
  const teach = (api) => new Error(api + " is unavailable inside the script sandbox - " + fix);
  const denyStore = (prop) => {
    try {
      Object.defineProperty(window, prop, { configurable: true, get: () => { throw teach(prop); } });
    } catch { /* surface already defined by a caller */ }
  };
  const denyApi = (prop, methods) => {
    try {
      Object.defineProperty(window, prop, {
        configurable: true,
        get: () => {
          const o = {};
          for (const m of methods) o[m] = () => { throw teach(prop + "." + m); };
          return o;
        },
      });
    } catch { /* surface already defined by a caller */ }
  };
  denyStore("localStorage");
  denyStore("sessionStorage");
  denyApi("indexedDB", ["open", "deleteDatabase"]);
  denyApi("caches", ["open", "keys", "delete", "match", "has"]);
  try {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: () => { throw teach("document.cookie"); },
    });
  } catch { /* surface already defined by a caller */ }
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      navigator.storage.getDirectory = () => Promise.reject(teach("navigator.storage.getDirectory (OPFS)"));
    }
  } catch { /* storage manager absent */ }
})();

const JS_MODULE_NAME_RE = /^[a-z0-9_@/-]+$/i;

function validateJsModuleName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("Module name must be a non-empty string");
  }
  const trimmed = name.trim();
  if (trimmed.includes("..") || trimmed.startsWith("/") || !JS_MODULE_NAME_RE.test(trimmed)) {
    throw new Error(`Invalid module name: "${name}" (use alphanumeric, @, _, -, /)`);
  }
  return trimmed;
}

// Pure synchronous SHA-256 implementation (matches pure.js createSha256)
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function compressBlock(H, w, block) {
  for (let i = 0; i < 16; i++) {
    const offset = i * 4;
    w[i] = ((block[offset] << 24) | (block[offset + 1] << 16) | (block[offset + 2] << 8) | block[offset + 3]) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const s0 = (((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3)) >>> 0;
    const s1 = (((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10)) >>> 0;
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
    const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const temp2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
  }
  H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
  H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
}

function computeModuleDigest(bytes) {
  const H = new Uint32Array(SHA256_H0);
  const w = new Uint32Array(64);
  const pending = new Uint8Array(64);
  let used = 0, length = 0n;
  const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  length = BigInt(uint8.byteLength);
  let offset = 0;
  for (; offset + 64 <= uint8.length; offset += 64) {
    compressBlock(H, w, uint8.subarray(offset, offset + 64));
  }
  if (offset < uint8.length) {
    pending.set(uint8.subarray(offset), 0);
    used = uint8.length - offset;
  }
  const tail = new Uint8Array(used < 56 ? 64 : 128);
  tail.set(pending.subarray(0, used));
  tail[used] = 0x80;
  const bitLength = length * 8n;
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  view.setBigUint64(tail.length - 8, bitLength, false);
  for (let i = 0; i < tail.length; i += 64) {
    compressBlock(H, w, tail.subarray(i, i + 64));
  }
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += H[i].toString(16).padStart(8, "0");
  }
  return hex;
}

function prepareScriptModuleSource(source) {
  if (typeof source !== "string") {
    return { isExplicitModule: false, hasImports: false, source: "" };
  }
  if (/^\s*export\s+(default|const|let|var|function|class|\{)/m.test(source)) {
    return { isExplicitModule: true, hasImports: true, source };
  }
  const importRegex = /^\s*import\s+(?:[\s\S]*?from\s+)?["\x27][^"\x27]+["\x27]\s*;?/gm;
  const imports = [];
  let hasImports = false;
  const body = source.replace(importRegex, (match) => {
    hasImports = true;
    imports.push(match.trim());
    return "";
  });

  if (!hasImports) {
    return { isExplicitModule: false, hasImports: false, source };
  }

  const moduleText = imports.join("\n") +
    "\nexport default async function() {\n" +
    body +
    "\n};\n";
  return { isExplicitModule: true, hasImports: true, source: moduleText };
}

function runScript(source, runId, nonce, rawModules = []) {
  const post = (type, extra) => {
    try { window.parent.postMessage({ type, runId, nonce, ...extra }, "*"); } catch { /* parent gone */ }
  };
  const pending = {};
  const call = (kind, payload) => new Promise((resolve, reject) => {
    const callId = Math.random().toString(36).slice(2);
    pending[callId] = { resolve, reject };
    post("cap:script-call", { callId, kind, payload: payload || {} });
  });

  // The controlled api as globals (shadow the natives — the page has no network
  // of its own, so this is the script's only fetch + log).
  window.fetch = (url, opts) => call("fetch", { url: String(url ?? ""), opts: opts || {} });
  window.log = (...args) => post("cap:script-log", { text: args.map((x) => String(x)).join(" ") });

  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent) return;
    const d = ev.data;
    if (!d || d.runId !== runId || d.type !== "cap:script-call-result") return;
    const p = pending[d.callId];
    if (!p) return;
    delete pending[d.callId];
    d.ok ? p.resolve(d.value) : p.reject(new Error(d.error || "call failed"));
  });

  const createdBlobUrls = [];
  const cleanup = () => {
    for (const url of createdBlobUrls) {
      try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
    }
  };

  // Phase 1: Module verification and Import Map injection
  const verifiedModules = [];
  if (Array.isArray(rawModules) && rawModules.length > 0) {
    for (const mod of rawModules) {
      if (!mod || typeof mod !== "object") continue;
      let name;
      try {
        name = validateJsModuleName(mod.name);
      } catch (err) {
        post("cap:script-error", { error: `invalid_module_name: ${err.message}`, code: "invalid_module_name" });
        return;
      }
      const claimedDigest = String(mod.digest ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/i.test(claimedDigest)) {
        post("cap:script-error", { error: `invalid_module_digest: ${claimedDigest}`, code: "invalid_digest" });
        return;
      }
      let uint8;
      if (typeof mod.source === "string") {
        uint8 = new TextEncoder().encode(mod.source);
      } else if (mod.bytes instanceof Uint8Array) {
        uint8 = mod.bytes;
      } else if (mod.bytes instanceof ArrayBuffer) {
        uint8 = new Uint8Array(mod.bytes);
      } else if (Array.isArray(mod.bytes)) {
        uint8 = new Uint8Array(mod.bytes);
      } else {
        post("cap:script-error", { error: `missing_module_content: module "${name}" has no source or bytes`, code: "missing_content" });
        return;
      }

      // Pre-execution cryptographic re-hash
      const computed = computeModuleDigest(uint8);
      if (computed !== claimedDigest) {
        post("cap:script-error", {
          error: `module_digest_mismatch for "${name}": expected ${claimedDigest}, computed ${computed}`,
          code: "digest_mismatch",
          moduleName: name,
          expected: claimedDigest,
          computed,
        });
        return; // createBlobUrl is NEVER called on mismatch
      }
      verifiedModules.push({ name, uint8 });
    }

    const imports = {};
    for (const mod of verifiedModules) {
      const blob = new Blob([mod.uint8], { type: "text/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      createdBlobUrls.push(blobUrl);
      imports[mod.name] = blobUrl;
    }

    if (Object.keys(imports).length > 0) {
      try {
        const mapEl = document.createElement("script");
        mapEl.type = "importmap";
        mapEl.textContent = JSON.stringify({ imports });
        document.head.appendChild(mapEl);
      } catch (err) {
        cleanup();
        post("cap:script-error", { error: `import_map_injection_failed: ${err.message}` });
        return;
      }
    }
  }

  // Phase 2: Script execution
  const prep = prepareScriptModuleSource(source);
  if (prep.isExplicitModule) {
    // Execute as ES module via Blob URL
    (async () => {
      try {
        const scriptBlob = new Blob([prep.source], { type: "text/javascript" });
        const scriptBlobUrl = URL.createObjectURL(scriptBlob);
        createdBlobUrls.push(scriptBlobUrl);

        const mod = await import(scriptBlobUrl);
        let result;
        if (typeof mod.default === "function") {
          result = await mod.default();
        } else if (mod.default !== undefined) {
          result = mod.default;
        } else if (mod.result !== undefined) {
          result = mod.result;
        }
        post("cap:script-result", { ok: true, result });
      } catch (err) {
        post("cap:script-error", { error: String(err && err.message ? err.message : err) });
      } finally {
        cleanup();
      }
    })();
  } else {
    // Execute as classic async function body
    let fn;
    try {
      fn = new Function("return (async function(){\n" + source + "\n})();");
    } catch (e) {
      cleanup();
      post("cap:script-error", { error: String(e && e.message ? e.message : e) });
      return;
    }
    Promise.resolve()
      .then(fn)
      .then((result) => post("cap:script-result", { ok: true, result }))
      .catch((err) => post("cap:script-error", { error: String(err && err.message ? err.message : err) }))
      .finally(() => cleanup());
  }
}
