// sidebar-parity.ts — real-extension regression acceptance for the hub's Tasks /
// Agents sidebar parity. Populates both production lists, drives genuine CDP
// pointer + keyboard interactions, and retains screenshots/geometry outside the
// source tree when SIDEBAR_PARITY_ARTIFACT_DIR is set.

import { launchChrome, openCdp } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
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
  return {dir:document.documentElement.dir||'ltr',theme:document.documentElement.dataset.theme||'',tasksSection:info('.side-tasks'),agentsSection:info('.side-agents'),tasks:info('#thread-sidebar'),agents:info('#side-agents'),taskAdd:info('#new-task'),agentAdd:info('#new-agent'),task:info('.thread-item'),agent:info('.agent-item'),del:info('.thread-item .t-delete'),active:{tag:document.activeElement?.tagName,cls:document.activeElement?.className},counts:{tasks:document.querySelectorAll('.thread-item').length,agents:document.querySelectorAll('.agent-item').length},copy:{siteEmpty:document.querySelector('#site-agents')?.textContent.trim(),siteStatus:document.querySelector('#webmcp-hub-status')?.textContent.trim(),siteAction:document.querySelector('#discover-page')?.textContent.trim()}};
})()`;

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
    const before = await evaluate(
      `chrome.runtime.sendMessage({type:'thread.list'}).then(r=>r.threads.length)`,
    );
    const input = await evaluate(
      `(() => { const r=document.querySelector('#task-input').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
    );
    await pointer(input.x, input.y, true);
    await send("Input.insertText", { text: task }, sessionId);
    await clickSelector("#run-task");
    let created = false;
    for (let attempt = 0; attempt < 20 && !created; attempt++) {
      await sleep(200);
      const count = await evaluate(
        `chrome.runtime.sendMessage({type:'thread.list'}).then(r=>r.threads.length)`,
      );
      created = count > before;
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
  check(
    "empty Site tools copy is concise and non-duplicated",
    expanded.copy.siteEmpty === "No site agents yet." &&
      expanded.copy.siteStatus === "Discovery has not run yet." &&
      expanded.copy.siteAction === "Discover this page",
    expanded.copy,
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
    await evaluate("document.activeElement?.id === 'task-input'"),
    await evaluate("document.activeElement?.id"),
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

  await evaluate(
    `(async()=>{document.documentElement.removeAttribute('dir'); await chrome.runtime.sendMessage({type:'kv.set',values:{'cap:theme':'midnight'}}); location.reload();})()`,
  );
  await sleep(3000);
  const darkBase = await evaluate(PROBE);
  await pointer(darkBase.task.rect.cx, darkBase.task.rect.cy);
  await sleep(150);
  const dark = await evaluate(PROBE);
  await screenshot("expanded-dark");
  check(
    "dark theme exercises the real midnight tokens",
    dark.theme === "midnight" &&
      dark.tasksSection.background !== "rgb(255, 255, 255)",
    dark,
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
  console.log(
    `SIDEBAR PARITY: ${passed} passed, ${failed} failed; artifacts=${OUT}`,
  );
} finally {
  cdp.close();
  try {
    proc.kill("SIGKILL");
  } catch { /* already exited */ }
  await proc.status.catch(() => {});
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}
if (failed) Deno.exit(1);
