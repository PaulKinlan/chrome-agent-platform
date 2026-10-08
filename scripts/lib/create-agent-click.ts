// w51r: fail before a coordinate click if the Create button is not a real hit
// target. A hidden #new-agent has a (0,0) rectangle; sending CDP input there
// otherwise looks like a 20-second Create-dialog timeout rather than a miss.
import { waitForAppReady } from "./app-readiness.ts";
export function createAgentClickTarget(doc: any = (globalThis as any).document):
  | { ok: true; x: number; y: number }
  | { ok: false; reason: string } {
  const button = doc.querySelector("#new-agent");
  if (!button) return { ok: false, reason: "missing #new-agent" };
  const style = doc.defaultView!.getComputedStyle(button);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) <= 0) {
    return { ok: false, reason: "hidden #new-agent" };
  }
  if (button.hasAttribute("disabled") || button.closest("[inert]")) {
    return { ok: false, reason: "disabled or inert #new-agent" };
  }
  button.scrollIntoView({ block: "center", inline: "center" });
  const rect = button.getBoundingClientRect();
  if (!rect.width || !rect.height) return { ok: false, reason: "zero-size #new-agent" };
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const hit = doc.elementFromPoint(x, y);
  if (!hit || (hit !== button && !button.contains(hit))) {
    return { ok: false, reason: "occluded #new-agent" };
  }
  return { ok: true, x, y };
}

/** Real CDP mouse input, never a scripted DOM click. Evaluation only measures
 * the hit target; a refusal dispatches ZERO mouse events. */
export async function clickVisibleCreateAgent(
  cdp: { send: (method: string, params: any, session: string) => Promise<any> },
  session: string,
  evaluate: (expression: string) => Promise<any>,
  options?: { waitForReady?: boolean; timeoutMs?: number },
): Promise<void> {
  if (options?.waitForReady) {
    await waitForAppReady(evaluate, { surfaceName: "Create agent dialog", timeoutMs: options.timeoutMs });
  }
  const target = await evaluate(`(${createAgentClickTarget.toString()})()`);
  if (!target?.ok) throw new Error(`Create dialog click refused: ${target?.reason ?? "unreadable #new-agent"}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x: target.x, y: target.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
    }, session);
  }
}
