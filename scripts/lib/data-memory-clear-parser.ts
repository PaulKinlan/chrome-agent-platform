// scripts/lib/data-memory-clear-parser.ts
// Shared helper for parsing key count labels in Data & memory explorer.
// CAP-FB-20261015-9EPN11-DATA-CLEAR-PARSER-01

/**
 * Parses the key count from a memory explorer label, e.g.
 * 'clear-fixture.example (5)' -> 5
 * 'clear-fixture.example (500+)' -> 500
 *
 * @param text The full text content of the memory explorer element.
 * @param targetOrigin The origin to match within the explorer text.
 * @returns The numeric count (capped or exact), or -1 if not matched.
 */
export function parseMemoryClearLabelCount(
  text: string,
  targetOrigin: string = "clear-fixture.example",
): number {
  if (!text) return -1;
  const escaped = targetOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped} \\((\\d+)\\+?\\)`);
  const m = String(text).match(re);
  return m ? Number(m[1]) : -1;
}
