// sidebar-parity.ts — real-extension regression acceptance for the hub's Tasks /
// Agents sidebar parity. Populates both production lists, drives genuine CDP
// pointer + keyboard interactions, and retains screenshots/geometry outside the
// source tree when SIDEBAR_PARITY_ARTIFACT_DIR is set.

import { fileURLToPath } from "node:url";
import { launchChrome, openCdp } from "./lib/chrome-launch.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const OUT = Deno.env.get("SIDEBAR_PARITY_ARTIFACT_DIR") ||
  await Deno.makeTempDir({ prefix: "cap-sidebar-parity-artifacts-" });
await Deno.mkdir(OUT, { recursive: true });
const profile = await Deno.makeTempDir({
  prefix: "cap-sidebar-parity-profile-",
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;
const assertionNames: string[] = [];
function check(name: string, condition: boolean, detail?: unknown) {
  assertionNames.push(name);
  if (condition) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name} — ${JSON.stringify(detail)}`);
  }
}

// The shared launcher: kernel-assigned port, endpoint read from this child's
// own stderr, honest (bounded) failure when the browser prints none.
const chrome = await launchChrome({
  extension: EXT,
  profile,
  windowSize: "1280,900",
});
const proc = chrome.proc;
const port = chrome.port;
const cdp = await openCdp(chrome.wsUrl);
// Resolves the CDP result directly (the shape this harness reads); a protocol
// error rejects.
async function send(
  method: string,
  params: unknown = {},
  sessionId?: string,
): Promise<any> {
  return (await cdp.send(method, params, sessionId)).result;
}

let extensionId = "";
for (let i = 0; i < 60 && !extensionId; i++) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`))
    .json();
  const worker = targets.find((target: any) =>
    target.type === "service_worker"
  );
  if (worker) extensionId = worker.url.split("/")[2];
  else await sleep(200);
}
if (!extensionId) throw new Error("Extension service worker did not load");
const target = await send("Target.createTarget", {
  url: `chrome-extension://${extensionId}/ntp/ntp.html`,
});
const attached = await send("Target.attachToTarget", {
  targetId: target.targetId,
  flatten: true,
});
const sessionId = attached.sessionId;
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
// Pin the scheme instead of inheriting it. Measured on this box: the ambient
// prefers-color-scheme already resolves DARK, so the run's "expanded-light"
// screenshots and its light-side geometry were dark, and no light/dark
// comparison was possible. theme.css resolves every token through light-dark(),
// so the scheme is the only knob.
await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "light" }],
}, sessionId);
await sleep(2500);
async function evaluate(expression: string) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text,
    );
  }
  return result.result?.value;
}
async function pointer(x: number, y: number, click = false) {
  await send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x, y },
    sessionId,
  );
  if (!click) return;
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  }, sessionId);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  }, sessionId);
}
async function clickSelector(selector: string) {
  const point = await evaluate(
    `(() => { const e = document.querySelector(${
      JSON.stringify(selector)
    }); if (!e) return null; const r = e.getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height }; })()`,
  );
  if (!point || point.w <= 0 || point.h <= 0) return false;
  await pointer(point.x, point.y, true);
  return true;
}

// The hub composer's stable CDP hooks. `<agent-composer id="composer">` renders
// per-instance ids (`composer-input` / `composer-send`), so the ids the harness
// used to type into — `#task-input` / `#run-task` — do not exist; the component
// exposes these two attributes for exactly this purpose (b5q4 measured the same
// drift in another acceptance instrument).
const COMPOSER_INPUT = "#composer [data-composer-input]";
const COMPOSER_SEND = "#composer [data-composer-send]";

/** Click a control the run CANNOT proceed without. `clickSelector` answering
 * false is right for an optional click and wrong here: a null probe is selector
 * drift, not a product state, and reading `.getBoundingClientRect()` off null
 * dies as an uncaught TypeError that names no selector and skips every later
 * check (the probe-null class of 4a44/rfca). Record a named red, then abort. */
async function clickRequired(selector: string, label: string) {
  const point = await evaluate(
    `(() => { const e = document.querySelector(${
      JSON.stringify(selector)
    }); if (!e) return null; const r = e.getBoundingClientRect(); return { x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height }; })()`,
  );
  if (!point || point.w <= 0 || point.h <= 0) {
    check(`${label}: ${selector} is present and sized`, false, { selector, point });
    throw new Error(
      `${label}: ${selector} is missing or zero-sized — selector drift, not a product state`,
    );
  }
  await pointer(point.x, point.y, true);
}
async function screenshot(name: string) {
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  }, sessionId);
  await Deno.writeFile(
    `${OUT}/${name}.png`,
    Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
  );
}
const PROBE = `(() => {
  const rect = (e) => { if (!e) return null; const r=e.getBoundingClientRect(); return {left:+r.left.toFixed(2),right:+r.right.toFixed(2),top:+r.top.toFixed(2),bottom:+r.bottom.toFixed(2),width:+r.width.toFixed(2),height:+r.height.toFixed(2),cx:+(r.left+r.width/2).toFixed(2),cy:+(r.top+r.height/2).toFixed(2)}; };
  const info = (s) => { const e=document.querySelector(s); if(!e)return null; const c=getComputedStyle(e); return {rect:rect(e),clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,overflowX:c.overflowX,overflowY:c.overflowY,scrollbarGutter:c.scrollbarGutter,minInlineSize:c.minInlineSize,minBlockSize:c.minBlockSize,paddingInlineStart:c.paddingInlineStart,paddingInlineEnd:c.paddingInlineEnd,borderRadius:c.borderRadius,background:c.backgroundColor,display:c.display,opacity:c.opacity,outlineStyle:c.outlineStyle}; };
  return {dir:document.documentElement.dir||'ltr',theme:document.documentElement.dataset.theme||'',tasksSection:info('.side-tasks'),agentsSection:info('.side-agents'),tasks:info('#thread-sidebar'),agents:info('#side-agents'),taskAdd:info('#new-task'),agentAdd:info('#new-agent'),task:info('.thread-item'),agent:info('.agent-item'),del:info('.thread-item .t-delete'),active:{tag:document.activeElement?.tagName,cls:document.activeElement?.className},counts:{tasks:document.querySelectorAll('.thread-item').length,agents:document.querySelectorAll('.agent-item').length},copy:{siteEmpty:document.querySelector('#site-agents')?.textContent.trim(),siteStatus:document.querySelector('#webmcp-hub-status')?.textContent.trim(),siteAction:document.querySelector('#discover-page')?.textContent.trim(),rendered:{empty:(document.querySelector('#site-agents')?.getClientRects().length ?? 0) > 0,status:(document.querySelector('#webmcp-hub-status')?.getClientRects().length ?? 0) > 0,action:(document.querySelector('#discover-page')?.getClientRects().length ?? 0) > 0}}};
})()`;

/** The live thread count, read from the RAW reply. The dispatcher answers a
 * throwing handler with `{ok:false,error}` — no `threads` key — so `.threads
 * .length` on it dies as an anonymous TypeError that names neither the route nor
 * the error. Read the reply, name it. */
async function threadCount(label: string) {
  const reply = await evaluate(
    `chrome.runtime.sendMessage({type:'thread.list'}).then(r=>JSON.stringify(r) ?? 'undefined')`,
  );
  const parsed = typeof reply === "string" ? JSON.parse(reply) : reply;
  if (!Array.isArray(parsed?.threads)) {
    check(`${label}: thread.list returned a threads array`, false, {
      reply: String(reply).slice(0, 300),
    });
    throw new Error(
      `${label}: thread.list returned ${String(reply).slice(0, 200)} — no threads array`,
    );
  }
  return parsed.threads.length;
}

let aborted = "";
try {
  await evaluate(
    `(async()=>{const msg=(m)=>chrome.runtime.sendMessage(m); await msg({type:'provider.set',config:{provider:'demo',apiKey:'',baseURL:'',model:''}}); const names=['Research','Release','Accessibility','Security','Documentation','Performance','WebMCP','Prompts','Components','Testing']; for(let i=0;i<names.length;i++) await msg({type:'named-agent.create',id:'parity-agent-'+i,name:names[i]+' agent',role:'Owns '+names[i].toLowerCase()+' work'}); return true;})()`,
  );

  const tasks = [
    "Review release",
    "Audit accessibility",
    "Verify WebMCP",
    "Check security",
    "Update docs",
    "Test components",
    "Review prompts",
    "Validate layout",
    "Inspect scrollbars",
  ];
  for (const task of tasks) {
    const before = await threadCount(`before "${task}"`);
    await clickRequired(COMPOSER_INPUT, "hub composer input");
    await send("Input.insertText", { text: task }, sessionId);
    await clickRequired(COMPOSER_SEND, "hub composer send button");
    let created = false;
    for (let attempt = 0; attempt < 20 && !created; attempt++) {
      await sleep(200);
      created = (await threadCount(`polling "${task}"`)) > before;
    }
    if (!created) {
      throw new Error(`task was not created through the UI: ${task}`);
    }
    await sleep(700);
    await clickSelector("#thread-back");
    await sleep(350);
  }
  await sleep(1500);
  await evaluate("location.reload()");
  await sleep(3000);

  const expanded = await evaluate(PROBE);
  await screenshot("expanded-light");
  check(
    "production data populates both sidebar lists",
    expanded.counts.tasks >= 8 && expanded.counts.agents === 10,
    expanded.counts,
  );
  check(
    "Tasks and Agents panels share the same intrinsic flex layout",
    expanded.tasksSection.display === expanded.agentsSection.display &&
      expanded.tasksSection.minBlockSize === "0px" &&
      expanded.agentsSection.minBlockSize === "0px",
    expanded,
  );
  check(
    "Tasks and Agents lists share overflow and stable symmetric gutters",
    expanded.tasks.overflowY === "auto" &&
      expanded.tasks.overflowY === expanded.agents.overflowY &&
      expanded.tasks.scrollbarGutter === "stable both-edges" &&
      expanded.tasks.scrollbarGutter === expanded.agents.scrollbarGutter,
    expanded,
  );
  check(
    "both populated lists overflow vertically without horizontal overflow",
    expanded.tasks.scrollHeight > expanded.tasks.clientHeight &&
      expanded.agents.scrollHeight > expanded.agents.clientHeight &&
      expanded.tasks.scrollWidth === expanded.tasks.clientWidth &&
      expanded.agents.scrollWidth === expanded.agents.clientWidth,
    expanded,
  );
  check(
    "Tasks and Agents + actions align at inline-end despite scrollbars",
    Math.abs(expanded.taskAdd.rect.right - expanded.agentAdd.rect.right) <= 1,
    expanded,
  );
  check(
    "Tasks and Agents rows share padding, radius, and inline geometry",
    expanded.task.paddingInlineStart === expanded.agent.paddingInlineStart &&
      expanded.task.paddingInlineEnd === expanded.agent.paddingInlineEnd &&
      expanded.task.borderRadius === expanded.agent.borderRadius &&
      Math.abs(expanded.task.rect.left - expanded.agent.rect.left) <= 1 &&
      Math.abs(expanded.task.rect.right - expanded.agent.rect.right) <= 1,
    expanded,
  );
  // The Site tools panel IS rendered once agents are seeded (measured: all three
  // strings have client rects here, and none in an unseeded hub — the discovery
  // banner needs `agent.tool-offers` to report enrollable tabs, ntp.js:629-641).
  // The check this replaces pinned three EXACT strings; the product has since
  // reworded them, and re-anchoring to the new wording would pin a regression,
  // because the three visible lines now state one instruction three ways:
  //   "Find site tools" / "No Site Agents yet. Find tools from an open tab to add
  //   one." / "Open a site and I'll look for tools you can use."
  // So assert the INTENT (one instruction, stated once) rather than the strings:
  // red today as a real product finding, green when the copy is fixed.
  // chrome-agent-platform-o1y1 owns that decision and carries the measurements.
  const siteCopy = [
    expanded.copy.siteAction,
    expanded.copy.siteEmpty,
    expanded.copy.siteStatus,
  ].filter((line): line is string => typeof line === "string" && !!line.trim());
  const imperativeLines = siteCopy.filter((line) =>
    /\b(find|discover|open a site)\b/i.test(line)
  );
  check(
    "the Site tools panel states its one instruction once (no three-voice duplication)",
    expanded.copy.rendered.action === false || imperativeLines.length <= 1,
    { siteCopy, imperativeLines, rendered: expanded.copy.rendered },
  );

  const taskCenter = { x: expanded.task.rect.cx, y: expanded.task.rect.cy };
  await pointer(taskCenter.x, taskCenter.y);
  await sleep(200);
  const hover = await evaluate(PROBE);
  await screenshot("task-hover");
  check(
    "task hover reveals a token-backed 28px delete control",
    hover.del.opacity === "1" && hover.del.rect.width === 28 &&
      hover.del.rect.height === 28 &&
      hover.task.background !== "rgba(0, 0, 0, 0)",
    hover,
  );
  check(
    "task delete control is centered in the hover row",
    Math.abs(hover.del.rect.cy - hover.task.rect.cy) <= 1,
    hover,
  );
  // The row wrapper (.thread-item) is a non-interactive div (nested-interactive
  // fix), so keyboard entry starts at its Open button; Tab then reaches the
  // sibling Delete control (t-meta is a span, not focusable).
  await evaluate("document.querySelector('.thread-item .t-open').focus()");
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  }, sessionId);
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  }, sessionId);
  await sleep(150);
  const focused = await evaluate(PROBE);
  check(
    "real Tab interaction focuses and reveals the task delete control",
    focused.active.cls === "t-delete" && focused.del.opacity === "1" &&
      focused.del.outlineStyle !== "none",
    focused,
  );
  const beforeDelete = focused.counts.tasks;
  await pointer(focused.del.rect.cx, focused.del.rect.cy, true);
  await sleep(600);
  const deleted = await evaluate(PROBE);
  check(
    "real pointer click deletes exactly one production task",
    deleted.counts.tasks === beforeDelete - 1,
    { beforeDelete, after: deleted.counts.tasks },
  );
  await clickSelector("#new-task");
  await sleep(100);
  check(
    "real New task click focuses the composer",
    await evaluate(
      `document.activeElement === document.querySelector(${
        JSON.stringify(COMPOSER_INPUT)
      })`,
    ),
    await evaluate("document.activeElement?.id || document.activeElement?.tagName"),
  );

  await clickSelector("#side-toggle");
  await sleep(450);
  const collapsed = await evaluate(PROBE);
  await screenshot("collapsed-light");
  const collapsedCenters = [
    collapsed.taskAdd.rect.cx,
    collapsed.agentAdd.rect.cx,
    collapsed.task.rect.cx,
    collapsed.agent.rect.cx,
  ];
  check(
    "collapsed Tasks/Agents actions and rows share one rail center",
    Math.max(...collapsedCenters) - Math.min(...collapsedCenters) <= 1,
    collapsedCenters,
  );
  check(
    "collapsed scrollbars consume no inline content space",
    collapsed.tasks.clientWidth === collapsed.tasks.rect.width &&
      collapsed.agents.clientWidth === collapsed.agents.rect.width,
    collapsed,
  );
  check(
    "collapsed panels stay scrollable without horizontal clipping",
    collapsed.tasks.overflowY === "auto" &&
      collapsed.agents.overflowY === "auto" &&
      collapsed.tasks.scrollWidth === collapsed.tasks.clientWidth &&
      collapsed.agents.scrollWidth === collapsed.agents.clientWidth,
    collapsed,
  );
  await pointer(collapsed.task.rect.cx, collapsed.task.rect.cy);
  await sleep(150);
  const collapsedHover = await evaluate(PROBE);
  await screenshot("collapsed-task-hover");
  check(
    "collapsed task X remains centered and visible on hover",
    collapsedHover.del.opacity === "1" &&
      Math.abs(collapsedHover.del.rect.cx - collapsedHover.task.rect.cx) <= 1 &&
      Math.abs(collapsedHover.del.rect.cy - collapsedHover.task.rect.cy) <= 1,
    collapsedHover,
  );

  await clickSelector("#side-toggle");
  await sleep(450);
  await evaluate("document.documentElement.setAttribute('dir','rtl')");
  await sleep(250);
  const rtl = await evaluate(PROBE);
  await screenshot("expanded-rtl");
  check(
    "RTL keeps Tasks/Agents + actions aligned at logical inline-end",
    rtl.dir === "rtl" &&
      Math.abs(rtl.taskAdd.rect.left - rtl.agentAdd.rect.left) <= 1,
    rtl,
  );
  check(
    "RTL keeps both list and row geometries in parity",
    Math.abs(rtl.tasks.rect.left - rtl.agents.rect.left) <= 1 &&
      Math.abs(rtl.tasks.rect.right - rtl.agents.rect.right) <= 1 &&
      Math.abs(rtl.task.rect.left - rtl.agent.rect.left) <= 1 &&
      Math.abs(rtl.task.rect.right - rtl.agent.rect.right) <= 1,
    rtl,
  );

  // The dark identity is the OS scheme preference, not a theme switch: every
  // token in shared/theme.css is declared with light-dark() under
  // `color-scheme: light dark`, NOTHING in the product reads `cap:theme`, and
  // `data-theme` is never set (theme switching was removed at 0.2.301 — beads
  // 5ht / ol11). The step this replaces wrote that dead kv key, reloaded, and
  // asserted `dataset.theme === "midnight"`, so it could not pass; its companion
  // assertion (`tasksSection.background !== white`) could not fail either, the
  // section background being transparent in both schemes. Emulate the preference
  // the product actually resolves and assert the rendered surface IS the dark
  // token.
  const DARK_BODY_BG = "rgb(26, 24, 21)"; // --bg dark half, #1a1815
  const LIGHT_BODY_BG = "rgb(247, 246, 243)"; // --bg light half, #f7f6f3
  const lightBodyBg = await evaluate(
    "getComputedStyle(document.body).backgroundColor",
  );
  await evaluate("document.documentElement.removeAttribute('dir')");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  }, sessionId);
  await sleep(600);
  const darkBase = await evaluate(PROBE);
  await pointer(darkBase.task.rect.cx, darkBase.task.rect.cy);
  await sleep(150);
  const dark = await evaluate(PROBE);
  await screenshot("expanded-dark");
  const darkBodyBg = await evaluate(
    "getComputedStyle(document.body).backgroundColor",
  );
  check(
    "the OS scheme preference renders both design-system surfaces (light-dark(), no data-theme switch)",
    lightBodyBg === LIGHT_BODY_BG && darkBodyBg === DARK_BODY_BG,
    {
      lightBodyBg,
      darkBodyBg,
      expected: { light: LIGHT_BODY_BG, dark: DARK_BODY_BG },
      themeAttr: dark.theme,
    },
  );
  check(
    "dark hover keeps task and agent surfaces on coherent tokens",
    dark.task.background !== "rgba(0, 0, 0, 0)" &&
      dark.taskAdd.display === dark.agentAdd.display,
    dark,
  );

  const geometry = {
    expanded,
    hover,
    focused,
    deleted,
    collapsed,
    collapsedHover,
    rtl,
    dark,
  };
  await Deno.writeTextFile(
    `${OUT}/geometry.json`,
    JSON.stringify(geometry, null, 2),
  );
  await Deno.writeTextFile(
    `${OUT}/assertions.json`,
    JSON.stringify({ passed, failed, assertions: assertionNames }, null, 2),
  );
} catch (error) {
  aborted = error instanceof Error ? error.message : String(error);
} finally {
  cdp.close();
  try {
    proc.kill("SIGKILL");
  } catch { /* already exited */ }
  await proc.status.catch(() => {});
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}
// A thrown precondition still owes a verdict: name it, count it, print the
// summary. An abort that only surfaces as an uncaught stack tells the reader
// nothing about how much of the harness never ran.
if (aborted) {
  failed++;
  console.error(`FAIL: aborted before the remaining checks — ${aborted}`);
}
console.log(
  `SIDEBAR PARITY: ${passed} passed, ${failed} failed; artifacts=${OUT}`,
);
if (failed) Deno.exit(1);
