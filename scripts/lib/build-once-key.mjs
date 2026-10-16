// A build-once record names the exact published dist.complete marker, not just
// the indexed source that produced it. The reader must still validate the live
// marker before it may trust the record: a matching key is never a verdict.
import { createHash } from "node:crypto";

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** The marker text is already read by the fixture or by the publishing build. */
export function buildOnceKeyFromMarkerText(markerText) {
  if (typeof markerText !== "string") return null;
  try {
    const marker = JSON.parse(markerText);
    const commit = marker?.commit;
    const digest = marker?.source?.digest;
    if (!COMMIT.test(commit) || !DIGEST.test(digest)) return null;
    const markerHash = createHash("sha256").update(markerText, "utf8").digest("hex");
    return `${commit}-${digest}-${markerHash}`;
  } catch {
    return null;
  }
}
