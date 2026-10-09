// The thread-sidebar rows' rendered-content signature. renderTaskRows uses it
// to skip a full DOM rebuild (and the failed-runs / board section re-fetches)
// when a render would produce byte-identical rows — e.g. openThread, where
// only the aria-current highlight moves. Pure: the dot projection is injected
// so the module stays testable without the run registry.

import { timeAgo } from "./pure.js";

/** The rows renderTaskRows would build for `threads` (bounded to the first 40,
 *  like the render itself), reduced to one string: id, name, preview, the
 *  RENDERED relative time, and the run-state dot. Anything that changes what a
 *  row shows changes the digest; anything else (a heartbeat revision bump, a
 *  route change that keeps the same list) does not. */
export function threadRowsDigest(threads, dotOf = () => "") {
  const list = Array.isArray(threads) ? threads : [];
  const max = Math.min(list.length, 40);
  const parts = new Array(max);
  for (let i = 0; i < max; i += 1) {
    const t = list[i];
    parts[i] = [
      String(t?.id ?? ""),
      typeof t?.name === "string" ? t.name : "",
      typeof t?.preview === "string" ? t.preview : "",
      timeAgo(t?.updatedAt),
      String(dotOf?.(t) ?? ""),
      String(t?.tabCount ?? 0),
    ].join("\u0000");
  }
  return parts.join("|");
}
