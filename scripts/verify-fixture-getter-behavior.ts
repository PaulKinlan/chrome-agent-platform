// scripts/verify-fixture-getter-behavior.ts
// Behavioral verification of Chrome 154 Document.prototype.modelContext getter shadowing.
// Generates test-artifacts/webmcp-getter-behavior-evidence.json recording clean page prototype check,
// behavioral RED (bare assignment under injected prototype getter), and behavioral GREEN (real fixture
// Object.defineProperty shadowing under injected prototype getter) in real headless Chrome.

import { fileURLToPath } from "node:url";
import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function cdpConnect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  let id = 0;
  const pend = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id)!; pend.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };
  const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res, rej) => {
    const mid = ++id; pend.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evalIn = async (s: string, expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r?.exceptionDetails) return { __exception: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    return r?.result?.value;
  };
  return { send, evalIn, close: () => ws.close() };
}

async function main() {
  const launched = await launchChrome({
    args: ["--headless=new", "--no-sandbox", "--disable-gpu", "about:blank"],
  });

  const cdp = await cdpConnect(launched.wsUrl);
  const targets = await cdp.send("Target.getTargets");
  const pageTarget = targets.targetInfos.find((t: any) => t.type === "page") || targets.targetInfos[0];
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);

  // 1. Native condition check: Clean about:blank page before any polyfill or injection
  const browserVersion = await cdp.send("Browser.getVersion");
  const nativeProtoCheck = await cdp.evalIn(sessionId, `(() => {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "modelContext");
    return {
      inDocumentProto: "modelContext" in Document.prototype,
      typeofDocMC: typeof document.modelContext,
      desc: desc ? {
        hasGetter: typeof desc.get === "function",
        hasSetter: typeof desc.set === "function",
        configurable: desc.configurable ?? null,
        enumerable: desc.enumerable ?? null,
      } : null,
      assessment: ("modelContext" in Document.prototype)
        ? "native-getter-present"
        : "not-present-on-clean-headless-page (defensive shadowing applies)",
    };
  })()`);

  // 2. Behavioral RED Condition:
  // Inject Document.prototype.modelContext getter-only accessor via Page.addScriptToEvaluateOnNewDocument
  // then load a page with bare assignment (document.modelContext = polyfill) in sloppy mode.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      Object.defineProperty(Document.prototype, "modelContext", {
        get() { return undefined; },
        configurable: true,
        enumerable: true,
      });
    })()`,
  }, sessionId);

  const redHtml = `<!DOCTYPE html><html><body><script>
    // Sloppy-mode bare assignment against prototype getter
    document.modelContext = {
      getTools: async () => [{ name: "unreachable" }],
    };
  </script></body></html>`;
  await cdp.send("Page.navigate", { url: `data:text/html;charset=utf-8,${encodeURIComponent(redHtml)}` }, sessionId);
  await new Promise((r) => setTimeout(r, 600));

  const redResult = await cdp.evalIn(sessionId, `(async () => {
    let tools = [];
    try {
      if (document.modelContext && typeof document.modelContext.getTools === "function") {
        tools = await document.modelContext.getTools();
      }
    } catch {}
    return {
      hasProtoGetter: "modelContext" in Document.prototype,
      modelContextTypeAfterBareAssign: typeof document.modelContext,
      modelContextValue: document.modelContext === undefined ? "undefined" : "defined",
      toolsDiscoveredCount: tools.length,
    };
  })()`);

  // 3. Behavioral GREEN Condition:
  // Under the SAME injected Document.prototype.modelContext getter, navigate to the real fixture
  // fixtures/webmcp-fixture.html which uses Object.defineProperty(document, "modelContext", ...).
  const fixturePath = `${ROOT}fixtures/webmcp-fixture.html`;
  await cdp.send("Page.navigate", { url: `file://${fixturePath}` }, sessionId);
  await new Promise((r) => setTimeout(r, 800));

  const greenResult = await cdp.evalIn(sessionId, `(async () => {
    const hasMC = typeof document.modelContext === "object" && document.modelContext !== null;
    const isOwn = Object.prototype.hasOwnProperty.call(document, "modelContext");
    const desc = Object.getOwnPropertyDescriptor(document, "modelContext");
    let tools = [];
    try {
      if (hasMC && typeof document.modelContext.getTools === "function") {
        tools = await document.modelContext.getTools();
      }
    } catch {}
    return {
      hasProtoGetter: "modelContext" in Document.prototype,
      hasModelContext: hasMC,
      isOwnProperty: isOwn,
      ownDescriptorConfigurable: desc?.configurable ?? false,
      ownDescriptorWritable: desc?.writable ?? false,
      declaredToolCount: tools.length,
      toolNames: tools.map(t => t.name),
    };
  })()`);

  // 4. Also verify fixtures/showcase-shop.html under the injected getter
  const shopPath = `${ROOT}fixtures/showcase-shop.html`;
  await cdp.send("Page.navigate", { url: `file://${shopPath}` }, sessionId);
  await new Promise((r) => setTimeout(r, 800));

  const shopResult = await cdp.evalIn(sessionId, `(async () => {
    const isOwn = Object.prototype.hasOwnProperty.call(document, "modelContext");
    let tools = [];
    try {
      if (document.modelContext && typeof document.modelContext.getTools === "function") {
        tools = await document.modelContext.getTools();
      }
    } catch {}
    return {
      isOwnProperty: isOwn,
      declaredToolCount: tools.length,
      toolNames: tools.map(t => t.name),
    };
  })()`);

  cdp.close();
  try { launched.proc.kill("SIGKILL"); } catch {}

  const evidence = {
    ts: new Date().toISOString(),
    testedAgainst: browserVersion?.product || "Chrome",
    userAgent: browserVersion?.userAgent || "",
    nativeProtoCheck,
    redCondition: {
      mechanism: "Page.addScriptToEvaluateOnNewDocument injected Document.prototype getter + bare assignment (document.modelContext = polyfill)",
      outcome: redResult,
      behaviorVerdict: redResult.modelContextValue === "undefined" && redResult.toolsDiscoveredCount === 0
        ? "PASS_CONFIRMED_RED"
        : "FAIL",
    },
    greenCondition: {
      mechanism: "Page.addScriptToEvaluateOnNewDocument injected Document.prototype getter + real fixture fixtures/webmcp-fixture.html Object.defineProperty shadowing",
      fixture: "fixtures/webmcp-fixture.html",
      outcome: greenResult,
      behaviorVerdict: greenResult.isOwnProperty && greenResult.declaredToolCount === 3
        ? "PASS_CONFIRMED_GREEN"
        : "FAIL",
    },
    showcaseShopFixture: {
      fixture: "fixtures/showcase-shop.html",
      outcome: shopResult,
      behaviorVerdict: shopResult.isOwnProperty && shopResult.declaredToolCount === 5
        ? "PASS_CONFIRMED_GREEN"
        : "FAIL",
    },
  };

  const outPath = `${ROOT}test-artifacts/webmcp-getter-behavior-evidence.json`;
  await Deno.writeTextFile(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log("Wrote browser behavioral evidence to", outPath);
  console.log(JSON.stringify(evidence, null, 2));
}

if (import.meta.main) {
  await main();
}
