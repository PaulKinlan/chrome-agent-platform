// Cross-process fixture for vk1t's atomic profile admission cap.
import { chromeProfileDir } from "../../scripts/lib/chrome-profile-dir.ts";

try {
  chromeProfileDir("worker", { root: Deno.args[0], maxEntries: Number(Deno.args[1]) });
} catch (e) {
  if (String((e as Error).message).includes("admission cap")) Deno.exit(20);
  throw e;
}
