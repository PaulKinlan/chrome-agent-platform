// Search updates the query immediately; rebuilding the gallery waits for the
// last keystroke so a typing burst stages previews only once.
export const SEARCH_SETTLE_MS = 110;

/** @param {() => void} rebuild
 * @param {{ schedule?: (fn: () => void, ms: number) => any, cancel?: (id: any) => void }} [timers]
 */
export function createSearchDebounce(rebuild, {
  schedule = globalThis.setTimeout.bind(globalThis),
  cancel = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  let timer = null;
  const queue = () => {
    if (timer !== null) cancel(timer);
    timer = schedule(() => {
      timer = null;
      rebuild();
    }, SEARCH_SETTLE_MS);
  };
  queue.cancel = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  return queue;
}
