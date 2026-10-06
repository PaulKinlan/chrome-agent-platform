// scripts/lib/hard-timeout.ts — pure parser for timeout environment variables.

/**
 * Parses an optional timeout string (e.g. from an environment variable), returning
 * a finite positive number in milliseconds or falling back to the specified default.
 */
export function parseHardTimeout(raw?: string | null, fallbackMs = 300_000): number {
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}
