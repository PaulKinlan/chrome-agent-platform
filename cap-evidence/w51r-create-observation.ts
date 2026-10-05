// Off-source, observation only. No product imports, gates, input, focus or navigation.
const LIMIT = 16;
const SOURCES = ["ntp/ntp.js", "shared/components.js", "lib/messages.js", "lib/cap-perf.js", "lib/navigation-controller.js", "shared/diagnostics-client.js"];
const KINDS = ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "DOMException"];

// Self-contained so the actual function can run in the target realm or bounded offline fakes.
export function observePage(action: string, point: any = null, env: any = globalThis): any {
  const key = "__cap18ugCreateObservation";
  const limit = 16, countLimit = 1000000;
  if (action === "install" || action === "capture") {
    if (Object.hasOwn(env, key)) throw new Error("observer already installed");
    const doc = env.document;
    const state: any = {samples: 0, droppedRecords: 0, overflow: false, incomplete: false, records: [], preclick: null,
      clicks: {count: 0, trusted: 0, pathMatch: 0, trustedPathMatch: 0}, transitions: {open: 0, close: 0}};
    const number = (n: any) => {
      if (typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10000000) return n;
      state.incomplete = true; return null;
    };
    const rect = (el: any) => { const r = el?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(number) : null; };
    const visible = (el: any, r: any) => {
      if (!el || !r || r.some((n: any) => n === null) || r[2] <= 0 || r[3] <= 0) return false;
      const s = env.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse" && Number(s.opacity) > 0;
    };
    const increment = (owner: any, name: string) => {
      if (owner[name] < countLimit) owner[name]++; else state.overflow = true;
    };
    const sample = () => {
      try {
        increment(state, "samples");
        const hosts = doc.querySelectorAll("agent-dialog");
        const row: any = {hosts: Math.min(hosts.length, countLimit), overflow: hosts.length > 8, items: []};
        for (let index = 0; index < Math.min(hosts.length, 8); index++) {
          const host = hosts[index];
          const inner = host.shadowRoot?.querySelector("dialog");
          const r = rect(inner);
          const labelNodes = host.querySelectorAll("label");
          const labels = Array.from({length:Math.min(labelNodes.length,64)}, (_, i) => labelNodes[i]) as any[];
          const field = (name: string) => labels.some(l => l.firstElementChild?.textContent === name && !!l.querySelector("input,textarea"));
          const buttonNodes = host.querySelectorAll("button");
          const buttons = Array.from({length:Math.min(buttonNodes.length,64)}, (_, i) => buttonNodes[i]) as any[];
          row.items.push({createTitle: host.getAttribute("title") === "Create an agent",
            createForm: field("Name") && field("What it does") && buttons.some(b => b.textContent.trim() === "Create agent"),
            upgraded: !!env.customElements?.get("agent-dialog") && typeof host.show === "function",
            publicOpen: host.open === true, nativePresent: !!inner, nativeOpen: inner?.open === true,
            modal: !!inner?.matches(":modal"), visible: visible(inner, r), rect: r});
          if (host.querySelectorAll("label").length > 64 || host.querySelectorAll("button").length > 64) row.overflow = true;
        }
        if (row.overflow) state.overflow = true;
        if (JSON.stringify(row) !== JSON.stringify(state.records.at(-1))) {
          if (state.records.length === limit) { state.records.shift(); increment(state, "droppedRecords"); state.overflow = true; }
          state.records.push(row);
        }
      } catch { state.incomplete = true; }
    };
    const event = (e: any) => {
      try {
        if (e.type === "click") {
          increment(state.clicks, "count");
          if (e.isTrusted === true) increment(state.clicks, "trusted");
          const button = doc.getElementById("new-agent");
          if (button && e.composedPath().includes(button)) {
            increment(state.clicks, "pathMatch");
            if (e.isTrusted === true) increment(state.clicks, "trustedPathMatch");
          }
        } else if (e.target?.localName === "agent-dialog") {
          increment(state.transitions, e.type); sample();
        }
      } catch { state.incomplete = true; }
    };
    for (const type of ["click", "open", "close"]) doc.addEventListener(type, event, true);
    env[key] = {state, sample, doc, event, rect, visible, expectedHost: point?.extensionId};
    sample();
  }
  const installed = env[key];
  if (!installed) throw new Error("observer unavailable");
  const {state, doc} = installed;
  if (action === "preclick") {
    try {
      const button = doc.getElementById("new-agent");
      const r = installed.rect(button);
      const hit = doc.elementFromPoint(point.x, point.y);
      const readyState = doc.readyState, visibility = doc.visibilityState;
      state.preclick = {documentMatches: env.location.pathname === "/ntp/ntp.html" && env.location.protocol === "chrome-extension:" && env.location.hostname === installed.expectedHost,
        readyState: ["loading", "interactive", "complete"].includes(readyState) ? readyState : "unknown",
        bootMeasured: env.performance.getEntriesByName("cap:ntp:boot_composer-ready", "measure").length > 0,
        focused: doc.hasFocus() === true, visibility: ["visible", "hidden"].includes(visibility) ? visibility : "unknown",
        componentDefined: !!env.customElements?.get("agent-dialog"), nativeSupported: typeof env.HTMLDialogElement === "function",
        present: !!button, connected: button?.isConnected === true, enabled: !!button && !button.disabled,
        inert: !!button?.closest("[inert]"), visible: installed.visible(button, r), rect: r,
        hit: !hit ? "none" : hit === button ? "button" : button?.contains(hit) ? "descendant" : "other"};
    } catch { state.incomplete = true; }
  }
  if (action === "sample" || action === "stop" || action === "capture") installed.sample();
  if (action === "stop" || action === "capture") {
    for (const type of ["click", "open", "close"]) doc.removeEventListener(type, installed.event, true);
    delete env[key];
  }
  return state;
}

// Copy only the fixed diagnostic vocabulary; never serialize a returned DTO or error.
export function safePage(raw: any): any {
  const bool = (v: any) => { if (typeof v !== "boolean") throw new Error("invalid observation"); return v; };
  const num = (v: any) => { if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 10000000) throw new Error("invalid observation"); return v; };
  const rect = (v: any) => v === null ? null : (Array.isArray(v) && v.length === 4 ? [0,1,2,3].map(i => v[i] === null ? null : num(v[i])) : (() => {throw new Error("invalid observation");})());
  const flags = (v: any, names: string[]) => Object.fromEntries(names.map(k => [k, bool(v[k])]));
  const counts = (v: any, names: string[]) => Object.fromEntries(names.map(k => { const n = num(v[k]); if (!Number.isInteger(n) || n < 0 || n > 1000000) throw new Error("invalid observation"); return [k,n]; }));
  const pick = (v: any, values: string[]) => { if (!values.includes(v)) throw new Error("invalid observation"); return v; };
  try {
    const list = raw.records, length = list?.length;
    if (!Array.isArray(list) || !Number.isInteger(length) || length < 0 || length > LIMIT) return null;
    const records = Array.from({length}, (_, index) => {
      const r = list[index], items = r.items, length = items?.length;
      if (!Array.isArray(items) || !Number.isInteger(length) || length < 0 || length > 8) throw new Error("invalid observation");
      return {...counts(r,["hosts"]), overflow: bool(r.overflow), items: Array.from({length}, (_, index) => {
        const i = items[index];
        return {...flags(i,["createTitle","createForm","upgraded","publicOpen","nativePresent","nativeOpen","modal","visible"]), rect: rect(i.rect)};
      })};
    });
    const p = raw.preclick;
    return {...counts(raw,["samples","droppedRecords"]), ...flags(raw,["overflow","incomplete"]), records,
      clicks: counts(raw.clicks,["count","trusted","pathMatch","trustedPathMatch"]), transitions: counts(raw.transitions,["open","close"]),
      preclick: p === null ? null : {...flags(p,["documentMatches","bootMeasured","focused","componentDefined","nativeSupported","present","connected","enabled","inert","visible"]),
        readyState: pick(p.readyState,["loading","interactive","complete","unknown"]), visibility: pick(p.visibility,["visible","hidden","unknown"]),
        hit: pick(p.hit,["button","descendant","other","none"]), rect: rect(p.rect)}};
  } catch { return null; }
}

export function safeError(params: any, extensionId: string) {
  try {
    const d = params.exceptionDetails;
    const rawFrames = d.stackTrace?.callFrames;
    const frameCount = Array.isArray(rawFrames) ? rawFrames.length : 0;
    if (!Number.isInteger(frameCount) || frameCount < 0) throw new Error("invalid observation");
    const frames = Array.from({length:Math.min(frameCount,8)}, (_, i) => rawFrames[i]);
    const location = [d, ...frames].find(x => SOURCES.some(s => x.url === `chrome-extension://${extensionId}/${s}`));
    const coordinate = (v: any) => Number.isInteger(v) && v >= 0 && v <= 1000000 ? v : null;
    const kind = d.exception?.className;
    return {kind: KINDS.includes(kind) ? kind : "Other",
      source: location ? SOURCES.find(s => location.url === `chrome-extension://${extensionId}/${s}`)! : null,
      line: coordinate(location?.lineNumber), column: coordinate(location?.columnNumber), unreadable: false, framesTruncated: frameCount > 8};
  } catch { return {kind:"Other",source:null,line:null,column:null,unreadable:true,framesTruncated:false}; }
}

export function observationExitCode(code: number, complete: boolean | null) {
  return code === 0 && complete === false ? 1 : code;
}

export function createObservation(client: any, extensionId: string,
  write: (name: string, value: unknown) => Promise<void>, png: (bytes: Uint8Array) => Promise<void>) {
  let session: string | null = null, targetId: string | null = null, page: any = null, incomplete = false, stopped = false;
  let errorCount = 0, errorOverflow = false;
  const errors: {session: unknown; value: ReturnType<typeof safeError>}[] = [];
  let off = () => {};
  try { off = client.on("Runtime.exceptionThrown", (params: any, id: unknown) => {
    errorCount = Math.min(1000000, errorCount + 1);
    const value = safeError(params,extensionId);
    if (value.unreadable || value.framesTruncated) incomplete = true;
    if (errors.length < LIMIT) errors.push({session:id,value}); else errorOverflow = true;
  }); } catch { incomplete = true; }
  const call = async (action: string, point: any = null) => {
    try {
      const raw = await client.eval(session, `(${observePage.toString()})(${JSON.stringify(action)},${JSON.stringify(point)})`);
      const projected = safePage(raw);
      if (projected) { page = projected; return true; }
      incomplete = true;
    } catch { incomplete = true; }
    return false;
  };
  const record = async (name: string, value: unknown) => { try { await write(name,value); return true; } catch { incomplete = true; return false; } };
  return {
    async bind(id: string, target: string) {
      session = id; targetId = typeof target === "string" && /^[A-Fa-f0-9]{32}$/.test(target) ? target : null;
      if (!targetId) incomplete = true;
      await call("install", {extensionId});
    },
    async sample() { await call("sample"); },
    async endCreate() { await call("stop"); stopped = true; },
    async beforeClick(point: {x:number;y:number}) {
      try {
      const {x,y} = point;
      const valid = [x,y].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10000000);
      if (valid) await call("preclick", {x,y}); else incomplete = true;
      await record("observation-preclick.json", {targetId, expectedPath:"ntp/ntp.html", page,
        intendedInputs: valid ? ["mousePressed","mouseReleased"].map(type => ({type,x,y,button:"left",clickCount:1})) : null});
      } catch { incomplete = true; }
    },
    async finish(behaviorFailed: boolean, persistOriginal: () => Promise<void>) {
      await persistOriginal(); // ORIGINAL outcome first; observation cannot invent or replace it.
      let finalSampleValid = false;
      if (session && !stopped) finalSampleValid = await call("stop"); else if (!session) incomplete = true;
      const createPage = page;
      if (behaviorFailed && stopped) finalSampleValid = await call("capture", {extensionId});
      try { off(); } catch { incomplete = true; }
      const captured = await record("observation-state.json", {targetId, createPage, failurePage:behaviorFailed && finalSampleValid ? page : null,
        errors: errors.filter(e => e.session === session).map(e => e.value), errorCount, errorOverflow,
        earlyEventsMayBeMissed:true, timingMayBePerturbed:true});
      let screenshot: "not-requested" | "saved" | "failed" = "not-requested";
      if (behaviorFailed) {
        screenshot = "failed";
        try {
          // ONE targeted capture. No safeCaptureScreenshot activation/wake/retry fallback.
          if (!session) throw new Error("capture unavailable");
          const response = await client.send("Page.captureScreenshot", {format:"png"}, session);
          const b64 = response?.result?.data;
          if (typeof b64 !== "string" || b64.length > 14000000) throw new Error("capture unavailable");
          const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          if (bytes.length < 24 || ![137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)) throw new Error("capture unavailable");
          await png(bytes); screenshot = "saved";
        } catch { incomplete = true; }
      }
      const pageIncomplete = createPage?.incomplete || page?.incomplete;
      const pageOverflow = createPage?.overflow || page?.overflow;
      let complete = captured && !incomplete && !!page && !pageIncomplete && !pageOverflow && !errorOverflow;
      const reasons = [!captured ? "projection-write" : null, incomplete ? "observation-incomplete" : null,
        !page ? "page-unavailable" : null, pageIncomplete ? "page-incomplete" : null,
        pageOverflow || errorOverflow ? "bounded-overflow" : null, screenshot === "failed" ? "screenshot" : null]
        .filter((reason): reason is string => reason !== null);
      const receipt = {complete, reasons, projectionSaved:captured, screenshot, activationAttempted:false, screenshotIsLaterState:true};
      if (!await record("observation-capture.json", receipt)) { complete = false; reasons.push("capture-receipt-write"); }
      return {complete, reasons};
    },
  };
}
