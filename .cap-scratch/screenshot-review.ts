import { launchChrome } from "../scripts/lib/chrome-launch.ts";
import { fileURLToPath } from "node:url";

const binary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const worktree = Deno.cwd();
const extPath = `${worktree}/extension`;

try {
  const { proc, wsUrl } = await launchChrome({
    binary,
    extension: extPath,
    args: ["--headless=new", "--window-size=1440,900"],
    lockPath: `${worktree}/.cap-scratch/review.lock`,
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.onopen = resolve);

  let id = 1;
  function send(method: string, params: any = {}) {
    return new Promise<any>((resolve) => {
      const curId = id++;
      const handler = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === curId) {
          ws.removeEventListener("message", handler);
          resolve(msg.result);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

  function sendSession(method: string, params: any = {}) {
    return new Promise<any>((resolve) => {
      const curId = id++;
      const handler = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === curId) {
          ws.removeEventListener("message", handler);
          resolve(msg.result);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id: curId, sessionId, method, params }));
    });
  }

  await sendSession("Page.enable");
  // Find extension ID
  const targets = await send("Target.getTargets");
  const extTarget = targets.targetInfos?.find((t: any) => t.url.startsWith("chrome-extension://"));
  const extId = extTarget ? new URL(extTarget.url).hostname : "";
  console.log("Extension ID:", extId);

  if (extId) {
    const optionsUrl = `chrome-extension://${extId}/options/options.html#agents`;
    await sendSession("Page.navigate", { url: optionsUrl });
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await sendSession("Page.captureScreenshot", { format: "png" });
    await Deno.writeFile(`${worktree}/.cap-scratch/review-settings-agents.png`, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
    console.log("Captured review-settings-agents.png");
  }

  ws.close();
  proc.kill("SIGKILL");
} catch (e) {
  console.error("Failed to capture screenshot:", e);
}
